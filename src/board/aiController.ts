// A board's AI assistant: one run at a time, into the draft and never onto disk.
//
// The run's answer for the ticket being written goes back to the webview; what
// the run edited in *other* tickets is adopted into the store. Two orderings
// here are load-bearing and easy to break when this code moves:
//
//   - adoption runs on **every** exit of `run` — success, failure, Stop, a
//     closed tab — and before any `stale()` check, or a board open mid-edit on
//     an edited ticket would see no drift and clobber the agent's text;
//   - a design run's session is recorded **before** the `stale()` check that
//     guards the reply, since the conversation happened whether or not the tab
//     is still listening.

import * as vscode from 'vscode';
import {
	composeInstruction,
	resolveAgent,
	resolveSkill,
	type AgentDefinition
} from '../ai/agent';
import { AiCancelledError, AiError, type AiResult, type AiRun } from '../ai/aiProvider';
import { editProvenance, provenance, sanitizeAiDescription } from '../ai/aiResult';
import { designSessionKey, START_FRESH_HINT, usableSession } from '../ai/aiSessions';
import { buildPrompt } from '../ai/promptTemplate';
import { ensureMermaidFence, resolveStyle } from '../design/designDocument';
import { errorMessage } from '../platform/errors';
import { unhandled } from '../platform/exhaustive';
import {
	aiIdleTimeoutMs,
	aiLanguageName,
	aiMaxTurns,
	aiModel
} from '../settings/aiSettings';
import type { AiEditedTicket, AiToHost } from '../shared/protocol';
import { adoptTrackerEdits, prepareRunEdits, trackerEditLog } from '../ai/trackerAdoption';
import type { BoardHost } from './boardHost';
import type { AiBoardServices, DesignBoardServices } from './boardServices';

export class AiController {
	/**
	 * The AI run this board has in flight, if any. One at a time: the webview
	 * disables the button while it runs, and a second request is refused here
	 * anyway — the same belt-and-braces posture as re-checking posted base64.
	 */
	private activeRun: { requestId: string; ticketId: string; run: AiRun } | undefined;

	constructor(
		private readonly host: BoardHost,
		/** Absent means the assistant is not offered at all: no button, no runs. */
		private readonly ai: AiBoardServices | undefined,
		private readonly designs: DesignBoardServices | undefined
	) {}

	/**
	 * Before the tab goes: a provider owns a child process, and without this the
	 * agent would outlive the board that asked for it.
	 */
	dispose(): void {
		this.activeRun?.run.cancel('the board was closed');
		this.activeRun = undefined;
	}

	/**
	 * The board is showing `id`. A result landing in a pane that has moved on to
	 * a different ticket has nowhere to go, so stop paying for it — the same case
	 * `app.tsx` already handles for a late image.
	 */
	onTicketShown(id: string): void {
		if (this.activeRun && this.activeRun.ticketId !== id) {
			this.activeRun.run.cancel('the board moved to another ticket');
			this.activeRun = undefined;
		}
	}

	async handle(message: AiToHost): Promise<void> {
		switch (message.type) {
			case 'aiGenerate':
				void this.host.pin();
				await this.runAi(
					message.requestId,
					message.id,
					message.instruction,
					message.agent,
					message.design,
					message.continueSession,
					message.model
				);
				break;

			case 'aiCancel':
				if (this.activeRun?.requestId === message.requestId) {
					this.activeRun.run.cancel('cancelled from the board');
				}
				break;

			default:
				unhandled(message);
		}
	}

	/** Re-sends whether the assistant can run, and why not when it cannot. */
	async postAiAvailability(): Promise<void> {
		const ai = this.ai?.provider;
		if (!ai) {
			this.host.post({ type: 'aiAvailability', available: false });
			return;
		}

		const availability = await ai.availability();
		this.host.post({
			type: 'aiAvailability',
			available: availability.ok,
			label: ai.label,
			message: availability.message,
			agents: await this.ai?.agents(),
			// So the picker can say what "Default" is; re-sent on every settings
			// save, since `onDidChange` refreshes every board's availability.
			model: this.ai?.settings()?.model
		});
	}

	/**
	 * Runs the assistant for one ticket and hands the text back to the board.
	 *
	 * It deliberately does **not** write: the result goes into the draft and the
	 * user's own Save does the `updatedAt` check. Holding a `baseUpdatedAt`
	 * across a run this long would turn every ticket touched meanwhile into a
	 * guaranteed conflict that throws the generated text away.
	 */
	private async runAi(
		requestId: string,
		id: string,
		instruction: string,
		agentSlug?: string,
		designId?: string,
		continueSession?: boolean,
		modelPick?: string
	): Promise<void> {
		const ai = this.ai?.provider;
		if (!ai) {
			this.host.post({ type: 'aiFailed', requestId, message: 'The AI assistant is not available.' });
			return;
		}

		if (this.activeRun) {
			this.host.post({ type: 'aiFailed', requestId, message: 'An AI run is already in progress.' });
			return;
		}

		// Read fresh rather than off the cached scan: the prompt carries the
		// description, and a stale one wastes the whole run.
		const ticket = await this.host.store.getDetail(id);
		if (!ticket) {
			this.host.post({
				type: 'aiFailed',
				requestId,
				message: `Ticket ${id} is no longer in the tracker folder.`
			});
			return;
		}

		// Read fresh, and resolved here rather than in the webview: the picker's
		// choice can be stale, and the host must not take a prompt from the
		// webview — only the name of one.
		const agents = (await this.ai?.agents()) ?? [];
		const agent = resolveAgent(agents, ticket.type, agentSlug);
		if (!agent) {
			this.host.post({
				type: 'aiFailed',
				requestId,
				message:
					`No agent writes a ${ticket.type}. Add one in .bfast/agents, or give an ` +
					'existing one that type.'
			});
			return;
		}

		// A design run is the same machinery with two things swapped: which skill
		// shapes the answer, and which draft it lands in.
		const design = designId ? await this.designs?.store.get(id, designId) : undefined;
		if (designId && !design) {
			this.host.post({
				type: 'aiFailed',
				requestId,
				message: `Design ${designId} is no longer on this ticket.`
			});
			return;
		}

		// The role says how this agent writes; the skill says how it shapes this
		// kind of ticket. An agent with no *write* skill still runs on its role
		// alone — but a design skill is not optional that way, because the skill is
		// where the "exactly one mermaid fence" contract lives.
		const style = design
			? resolveStyle((await this.designs?.styles()) ?? [], design.prefix)
			: undefined;
		const skill = design
			? await this.designSkillFor(agent, style!.id)
			: resolveSkill(agent, ticket.type);

		if (design && !skill) {
			this.host.post({
				type: 'aiFailed',
				requestId,
				message:
					`No design skill for “${style!.label}”. Copy a shipped one to ` +
					`.bfast/agents/${agent.slug}/design-${style!.id} and set its style.`
			});
			return;
		}

		// The conversation this run continues, when the user asked for it and there
		// is one. Only ever a design run's: a description run has nothing to refine
		// across presses, since its whole text goes in the prompt every time.
		//
		// The provider has to match — a session id is the CLI's or the SDK's own,
		// and one handed to the other resolves to nothing. There is deliberately no
		// fallback to a fresh conversation when a resume fails: guessing whether a
		// session file still exists is a second place for that answer to be wrong,
		// so the run reports and the user unticks, exactly as the generate tab does.
		const sessionKey = designId ? designSessionKey(id, designId) : undefined;
		const remembered = usableSession(
			sessionKey ? this.ai?.sessions?.get(sessionKey) : undefined,
			ai.id
		);
		const resumeSessionId = continueSession && remembered ? remembered.sessionId : undefined;

		const settings = this.ai?.settings();
		const context = {
			id: ticket.id,
			type: ticket.type,
			title: ticket.title,
			status: ticket.status,
			description: ticket.description
		};

		// What this run may edit besides its own draft: one `Edit` rule per ticket
		// that exists right now, in a settings file the provider is handed. Absent
		// — no tracker folder, no workspace, or nothing on disk — the run is
		// read-only, exactly as every run was before this existed.
		const cwd = this.ai?.workingDirectory();
		const trackerFolder = this.ai?.trackerFolder();
		const edits =
			cwd && trackerFolder
				? await prepareRunEdits(this.host.store, vscode.Uri.file(cwd), trackerFolder, {
						id: ticket.id,
						parentId: ticket.parentId
					}).catch((failure: unknown) => {
						this.host.post({
							type: 'aiProgress',
							requestId,
							tool: `Read-only run: ${errorMessage(failure, 'the edit rules could not be built')}`
						});
						return undefined;
					})
				: undefined;
		const log = edits && cwd && trackerFolder ? trackerEditLog(this.host.store, cwd, trackerFolder) : undefined;

		const run = ai.run(
			{
				instruction,
				prompt: buildPrompt(composeInstruction(agent, skill), context, instruction, {
					language: aiLanguageName(settings),
					// The document goes in whether or not the conversation is being
					// resumed. A session remembers what it was told, not what the file
					// says now: it may have been edited by hand, or by another window,
					// since the last run spoke — and the body on disk is the truth the
					// answer has to replace.
					...(design && style
						? {
								design: {
									title: design.title,
									style: style.label.toLowerCase(),
									body: design.body
								}
							}
						: {}),
					...(edits ? { edits: edits.policy } : {})
				}),
				ticket: context,
				workingDirectory: cwd,
				// The tab's pick over the setting — sanitised, since it arrived from
				// the webview and becomes an argv element.
				model: aiModel(settings, modelPick),
				maxTurns: aiMaxTurns(settings),
				idleTimeoutMs: aiIdleTimeoutMs(settings),
				...(edits ? { edits: edits.request } : {}),
				...(resumeSessionId ? { resumeSessionId } : {})
			},
			(progress) => {
				// The log sees every event, whether or not the board is still
				// listening: a file the agent edited is edited either way.
				if (progress.kind === 'tool' && progress.id) {
					log?.observe({
						kind: 'use',
						id: progress.id,
						name: progress.name,
						filePath: progress.filePath,
						edit: progress.edit
					});
				} else if (progress.kind === 'tool-result') {
					log?.observe({ kind: 'result', id: progress.id, error: progress.error });
				}

				if (this.activeRun?.requestId !== requestId) {
					return;
				}
				switch (progress.kind) {
					case 'started':
						// Which model actually answered — the setting or the pick may
						// have been an alias, and this is the first place it is known.
						// The same line the generate tab's lanes show.
						this.host.post({
							type: 'aiProgress',
							requestId,
							tool: progress.model ? `Started — ${progress.model}` : 'Started'
						});
						break;
					case 'text':
						this.host.post({ type: 'aiProgress', requestId, text: progress.text });
						break;
					case 'thinking':
						this.host.post({
							type: 'aiProgress',
							requestId,
							thinking: progress.text,
							thinkingTokens: progress.tokens
						});
						break;
					case 'tool':
						this.host.post({
							type: 'aiProgress',
							requestId,
							tool: progress.detail ? `${progress.name} ${progress.detail}` : progress.name
						});
						break;
					case 'denied':
						this.host.post({
							type: 'aiProgress',
							requestId,
							tool: `Denied: ${progress.tool}${progress.filePath ? ` ${progress.filePath}` : ''}`
						});
						break;
				}
			}
		);

		this.activeRun = { requestId, ticketId: id, run };
		this.host.post({ type: 'aiStarted', requestId, label: ai.label });

		// The run's outcome is settled first and reported second, because what
		// it did to *other* tickets has to be recorded on every exit — success,
		// failure, Stop, a closed tab — and reported alongside the answer.
		let outcome: { ok: true; result: AiResult } | { ok: false; error: unknown };
		try {
			outcome = { ok: true, result: await run.completed };
		} catch (error) {
			outcome = { ok: false, error };
		}

		// Remembered before the reply is posted, and outside the `stale` check that
		// guards it: the conversation happened whether or not this tab is still
		// listening, and the next press on that document should be offered it.
		if (sessionKey && outcome.ok && outcome.result.meta?.sessionId) {
			await this.ai?.sessions?.set(sessionKey, {
				sessionId: outcome.result.meta.sessionId,
				provider: ai.id,
				at: new Date().toISOString()
			});
		}
		if (designId) {
			this.postAiSession(id, designId);
		}

		let edited: AiEditedTicket[] = [];
		try {
			if (log) {
				const meta = outcome.ok ? outcome.result.meta : undefined;
				edited = await adoptTrackerEdits(
					log,
					this.host.store,
					ticket.id,
					editProvenance(agent.name, skill?.name, ai.label, meta, instruction, ticket.id)
				);
				if (edited.some((entry) => entry.adopted)) {
					// The sidebar and every other board learn about the edited tickets
					// the way they learn about a save.
					this.host.onChanged();
				}
			}
		} catch (failure) {
			edited = [
				{
					id: ticket.id,
					title: errorMessage(failure, 'adoption failed'),
					adopted: false,
					reason: 'unknown-ticket'
				}
			];
		} finally {
			await edits?.dispose();
		}

		try {
			if (this.stale(requestId)) {
				return;
			}
			if (!outcome.ok) {
				if (outcome.error instanceof AiCancelledError) {
					// The user did this, so there is nothing to report — the convention
					// `imageFailed` uses for a cancelled file dialog.
					this.host.post({ type: 'aiFailed', requestId, ...(edited.length ? { edited } : {}) });
					return;
				}
				// A resumed run that failed may have failed *because* the session is
				// gone, so the way back out is named rather than guessed at: there is
				// deliberately no automatic retry without the resume.
				const failure =
					errorMessage(outcome.error, 'The AI assistant failed.');
				this.host.post({
					type: 'aiFailed',
					requestId,
					message: resumeSessionId ? `${failure} ${START_FRESH_HINT}` : failure,
					code: outcome.error instanceof AiError ? outcome.error.code : undefined,
					...(edited.length ? { edited } : {})
				});
				return;
			}

			const { result } = outcome;
			// Sanitised here rather than in the provider, so every implementation gets
			// the same cleanup instead of each having to remember it. A design run
			// sanitises against the *document's* title — otherwise a `# Login flow`
			// heading survives and duplicates the tab label — and then gets the one
			// piece of forgiveness `sanitizeAiDescription` cannot give it: an answer
			// wrapped in ```markdown keeps its wrapper, because the mid-fence guard
			// sees the mermaid block inside, and nothing renders.
			const text = design
				? ensureMermaidFence(sanitizeAiDescription(result.text, design.title))
				: sanitizeAiDescription(result.text, ticket.title);

			this.host.post({
				type: 'aiResult',
				requestId,
				text,
				note: provenance(agent.name, skill?.name, ai.label, result.meta, instruction),
				...(designId ? { design: designId } : {}),
				...(edited.length ? { edited } : {})
			});
		} finally {
			if (this.activeRun?.requestId === requestId) {
				this.activeRun = undefined;
			}
		}
	}

	/**
	 * Whether the next run on this design document could continue a conversation
	 * — the fact alone, never the id, so the webview asks with a boolean and the
	 * host stays the one that resolves what to resume.
	 *
	 * Sent when the document opens and after every run on it, because a run may
	 * just have started one. Only for the provider that ran it: a session id is
	 * the CLI's or the SDK's own, and offering another's would offer a resume
	 * that cannot work.
	 */
	postAiSession(id: string, design: string): void {
		const session = usableSession(
			this.ai?.sessions?.get(designSessionKey(id, design)),
			this.ai?.provider.id
		);
		this.host.post({
			type: 'aiSession',
			id,
			design,
			...(session ? { previous: { at: session.at } } : {})
		});
	}

	/** True when this reply belongs to a run the panel has already moved past. */
	private stale(requestId: string): boolean {
		return this.host.isDisposed() || this.activeRun?.requestId !== requestId;
	}

	/**
	 * The design skill for a style, through the store so the bundled fallback
	 * applies — `.bfast/agents` is seeded only when it has never existed, so a
	 * shipped skill reaches an older workspace by no other route.
	 */
	private async designSkillFor(agent: AgentDefinition, style: string) {
		return this.ai?.designSkill(agent, style);
	}
}
