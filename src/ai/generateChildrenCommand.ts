// "Generate stories" on an epic, "Generate acceptance criteria" on a story,
// "Generate test cases" on an acceptance criterion.
//
// The `vscode` half of `ai/generateChildren.ts`: the loop that turns each kept
// title into a ticket, plus the seam (`GeneratePrompts`) the surface plugs into.
// The surface itself is `GeneratePanel`, a webview tab — this module opens no
// dialog and shows no notification, because the flow has three moments a modal
// cannot hold at once: a form, minutes of log, and a list to tick through.
//
// A file of its own rather than more of `ticketCommands.ts`, whose deps are
// `{store, refresh}` and whose every command is a plain store write. These need
// the provider, the agents and the settings as well, and folding them in would
// double that module's dependency surface for two commands.
//
// This is the first thing in BFAST that puts AI output **on disk** without a
// human pressing Save, and that is deliberate rather than an exception to the
// board's rule. The board refuses to write because a `baseUpdatedAt` captured
// before a run that takes minutes would be stale by the end, turning a rare
// clobber into a routine one. A ticket that does not exist before the run has no
// `updatedAt` to go stale and no edit to overwrite: a create cannot conflict.

import * as vscode from 'vscode';
import { agentsForType, resolveSkill, type AgentDefinition, type AgentSkill } from './agent';
import { AiCancelledError, type AiProvider, type AiTicketContext } from './aiProvider';
import { MAX_PROPOSED_CHILDREN, titleKey } from './aiResult';
import {
	combineInstruction,
	hasGivenWhenThen,
	planChildren,
	writeChild,
	type ExistingChild,
	type PlannedChildren,
	type RunHooks,
	type WrittenChild
} from './generateChildren';
import { START_FRESH_HINT } from './aiSessions';
import type { GenerateSession, GenerateSessionStore } from './generateSessions';
import { sharedLimiter, type SharedLimiter } from '../platform/semaphore';
import {
	type TicketStore,
	type WritableTicketStore
} from '../data/ticketStore';
import type { TicketNode } from '../data/ticketTree';
import type { TicketSummary, TicketType } from '../data/types';
import type { GenerateLaneStatus } from '../shared/protocol';
import {
	aiConcurrency,
	aiIdleTimeoutMs,
	aiLanguageName,
	aiMaxTurns,
	aiModel,
	type AiSettings
} from '../settings/aiSettings';
import { errorMessage } from '../platform/errors';

/** What each command produces, and what the ticket it hangs under must be. */
const GENERATES: Record<string, { parentType: TicketType; childType: TicketType }> = {
	'bfast.generateStories': { parentType: 'epic', childType: 'story' },
	'bfast.generateAcceptanceCriteria': { parentType: 'story', childType: 'ac' },
	'bfast.generateTestCases': { parentType: 'ac', childType: 'testcase' }
};

const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'epic',
	story: 'story',
	ac: 'acceptance criterion',
	testcase: 'test case'
};

const TYPE_PLURAL: Record<TicketType, string> = {
	epic: 'epics',
	story: 'stories',
	ac: 'acceptance criteria',
	testcase: 'test cases'
};

/**
 * Everything the flow asks a person, and everything it tells them.
 *
 * Injected rather than called directly, for the reason `TrackerContext` exists
 * rather than the store reaching for `SettingsService`: it is what lets
 * `GeneratePanel` render the whole flow in a tab, and a test drive it with no
 * UI at all. Nothing in here may open a dialog — the tab is the only surface.
 * Each ask returns `undefined` when the user backs out, which aborts silently.
 */
export interface GeneratePrompts {
	pickAgent(
		agents: readonly AgentDefinition[],
		childType: TicketType
	): Promise<AgentDefinition | undefined>;
	askInstruction(parent: TicketSummary, childType: TicketType): Promise<string | undefined>;
	/**
	 * Whether to continue the conversation an earlier batch left, when there is
	 * one this provider can resume. Optional, the `created?` way: a surface that
	 * never offers it starts fresh.
	 */
	continueSession?(previous: GenerateSession): Promise<boolean>;
	/**
	 * The model this batch runs on, when the surface offers a pick. Optional the
	 * same way: a surface without a picker runs on the workspace setting. What
	 * comes back is a name the flow sanitises (`aiModel`), never trusts.
	 */
	pickModel?(): Promise<string | undefined>;
	/**
	 * The review screen. `refine` means the list is asked for again in the same
	 * conversation, and this is asked again once it is back; `followUps` are the
	 * ones the list on offer already reflects. `undefined` still backs out.
	 */
	pickChildren(
		titles: readonly string[],
		parent: TicketSummary,
		followUps: readonly string[]
	): Promise<ChildrenChoice | undefined>;
	/**
	 * Wraps one long step.
	 *
	 * `step` rather than only a title, because the surface has to know *which*
	 * screen it is on — the tab shows a log for one and a row per agent for the
	 * other — and reading that back out of a display string would be a parser
	 * nobody would remember to keep in step.
	 */
	withProgress<T>(
		step: GenerateStep,
		title: string,
		task: (report: GenerateReport, token: vscode.CancellationToken) => Promise<T>
	): Promise<T>;
	/** One ticket landed on disk, so the surface can fill in as the run goes. */
	created?(ticket: TicketSummary, described: boolean): void;
	info(message: string): void;
	error(message: string): void;
}

/** What the review screen came back with. */
export type ChildrenChoice =
	| { kind: 'create'; titles: string[] }
	/** Ask the agent again, in the same conversation, and show the new list. */
	| { kind: 'refine'; instruction: string };

/**
 * The long steps: proposing the titles, asking for them again after a
 * follow-up, then writing one description each.
 */
export type GenerateStep = 'planning' | 'refining' | 'writing';

/**
 * How a long step reports what is happening.
 *
 * An object rather than the single `report(line)` callback it started as,
 * because the writing step runs several agents at once: an interleaved stream
 * of their heartbeats with nothing saying which is which reads as noise, and
 * "what is each one doing right now" is a different question from "what has
 * happened", needing a row per child rather than a line per event.
 */
export interface GenerateReport {
	/** A line for the log. `lane` names the child it came from, if any. */
	log(line: string, lane?: number): void;
	/** One child's own row. Called again as it moves through its statuses. */
	lane(lane: number, title: string, status: GenerateLaneStatus, note?: string): void;
}

/** What the flow needs from the extension, minus the surface it runs on. */
export interface GenerateServices {
	store: WritableTicketStore;
	ai?: AiProvider;
	aiSettings?: () => AiSettings | undefined;
	aiAgents?: () => Promise<AgentDefinition[]>;
	/** `AgentStore.planSkill`, which falls back to the bundled plan skill. */
	planSkill?: (agent: AgentDefinition, parentType: TicketType) => Promise<AgentSkill | undefined>;
	aiWorkingDirectory?: () => string | undefined;
	/**
	 * The window's AI slots, shared by every generate tab. Absent — a test
	 * driving the flow directly — means a private cap for that batch alone.
	 */
	slots?: SharedLimiter;
	/** Where a tab's conversation is remembered. Absent — a test — means nothing is. */
	sessions?: GenerateSessionStore;
	refresh: () => void;
}

export interface GenerateChildrenDeps extends GenerateServices {
	prompts: GeneratePrompts;
}

/**
 * One batch per (parent, child type) — the pair `GeneratePanel` keys a tab on.
 *
 * Two batches under *different* parents are simply safe, and refusing them was
 * the bug this replaced: `nextOrdinal` counts siblings within one parent, so
 * generating for ST-1.1 and ST-1.2 at once draws from disjoint id sets, and the
 * store's own queue serialises the writes either way. What must not happen is
 * two batches under the *same* parent, interleaving one id sequence into an
 * order nobody can read — which is all this holds, and all the comment on the
 * module-wide boolean it replaces ever claimed.
 *
 * Held across the review screen too. That is a human-length wait, but it blocks
 * only the tab already parked on it: starting a second batch there would clear
 * the list `pickChildren` is waiting on while its promise never resolved.
 */
const running = new Set<string>();

/**
 * The generate commands. Each opens the generate tab and returns — the flow
 * itself runs from there, so nothing here blocks on a dialog.
 */
export function registerGenerateChildrenCommands(
	/**
	 * Opens the generate tab for a (parent, child type). Passed in rather than
	 * imported: the tab runs `generateChildren` from this module, so importing
	 * it back would be a cycle.
	 */
	open: (parentId: string, childType: TicketType) => void
): vscode.Disposable[] {
	return Object.keys(GENERATES).map((command) =>
		vscode.commands.registerCommand(command, (node?: TicketNode) => {
			const { parentType, childType } = GENERATES[command];
			const parent = node?.ticket;

			if (parent?.type !== parentType) {
				// Unreachable from the menu, whose `when` clause mirrors this; it
				// guards a keybinding or a palette invocation with no node.
				void vscode.window.showWarningMessage(
					`Pick ${article(parentType)} to generate ${TYPE_PLURAL[childType]} for.`
				);
				return;
			}

			open(parent.id, childType);
		})
	);
}

/**
 * The flow itself: plan, choose, write, create.
 *
 * Exported so a test drives it directly. Returns what was created, which is
 * also what a caller needs to know after a cancel — the tickets already on disk
 * stay there.
 */
export async function generateChildren(
	deps: GenerateChildrenDeps,
	parentId: string,
	childType: TicketType
): Promise<TicketSummary[]> {
	const { prompts } = deps;

	// The pair a generate tab is keyed on, so this refuses exactly what
	// `GeneratePanel.show` already makes unreachable — a second batch under one
	// parent — and nothing else.
	const key = `${parentId}:${childType}`;
	if (running.has(key)) {
		prompts.error(
			`BFAST is already generating ${TYPE_PLURAL[childType]} for ${parentId}. ` +
				'Wait for that to finish.'
		);
		return [];
	}

	const ai = deps.ai;
	if (!ai) {
		prompts.error('The AI assistant is not available.');
		return [];
	}

	// Read fresh rather than off the cached scan: the prompt carries the parent's
	// description, and a stale one wastes the whole run.
	const parent = await deps.store.getDetail(parentId);
	if (!parent) {
		prompts.error(`Ticket ${parentId} is no longer in the tracker folder.`);
		return [];
	}

	// A test case's preconditions, steps and expected result are the criterion's
	// Given, When and Then. Without them the agent would have to invent what the
	// criterion never said, so nothing runs until the criterion is written.
	if (parent.type === 'ac' && !hasGivenWhenThen(parent.description)) {
		prompts.error(
			`${parent.id} has no Given / When / Then yet, so there is nothing to turn into ` +
				`${TYPE_PLURAL[childType]}. Write the criterion on its board first.`
		);
		return [];
	}

	// The agents that can *write* the child, not the ones that happen to own a
	// plan skill: `planSkill` falls back to the bundled one, so having a plan
	// skill is never what makes an agent eligible.
	const agents = agentsForType((await deps.aiAgents?.()) ?? [], childType);
	if (agents.length === 0) {
		prompts.error(
			`No agent writes ${article(childType)}. Add one in .bfast/agents, or give an ` +
				'existing one that type.'
		);
		return [];
	}

	const agent = agents.length === 1 ? agents[0] : await prompts.pickAgent(agents, childType);
	if (!agent) {
		return [];
	}

	const instruction = await prompts.askInstruction(parent, childType);
	if (instruction === undefined) {
		return [];
	}

	// One pick for the whole batch: the plan, every refine and every write ride
	// on the same `shared` below, so a follow-up is never answered by a model the
	// user did not choose.
	const modelPick = await prompts.pickModel?.();

	// A conversation an earlier batch left, offered only when it is this
	// provider's: a session id is the CLI's or the SDK's own, and one handed to
	// the other resolves to nothing.
	const remembered = deps.sessions?.get(parentId, childType);
	const resumable = remembered?.provider === ai.id ? remembered : undefined;
	const continued =
		resumable !== undefined && (await prompts.continueSession?.(resumable)) === true;

	running.add(key);
	try {
		const availability = await ai.availability();
		if (!availability.ok) {
			prompts.error(availability.message ?? 'The AI assistant is not available.');
			return [];
		}

		const settings = deps.aiSettings?.();
		const shared = {
			agent,
			instruction,
			workingDirectory: deps.aiWorkingDirectory?.(),
			model: aiModel(settings, modelPick),
			maxTurns: aiMaxTurns(settings),
			language: aiLanguageName(settings),
			idleTimeoutMs: aiIdleTimeoutMs(settings)
		};
		const context = ticketContext(parent);
		// A criterion is one Given / When / Then and seldom says which screen or
		// which user it concerns — the story it belongs to does, so both passes
		// get it. A story or an epic carries its own context, so only a
		// criterion's parent is read.
		const above =
			parent.type === 'ac' && parent.parentId
				? await deps.store.getDetail(parent.parentId)
				: undefined;
		const grandparent = above ? ticketContext(above) : undefined;
		// Resolved before the run: the bundled fallback is a file read, and doing
		// it inside the progress task would put it under the cancel button.
		const planSkill = await deps.planSkill?.(agent, parent.type);
		const plan = {
			...shared,
			parent: context,
			grandparent,
			planSkill,
			max: MAX_PROPOSED_CHILDREN
		};

		// The conversation this batch is in: set by the first run that reports
		// one, carried into every ask after it, and remembered as it goes so the
		// next opening of this tab can offer to continue it.
		let sessionId = continued && resumable ? resumable.sessionId : undefined;
		const followUps: string[] = [];
		const remember = async (planned: PlannedChildren): Promise<void> => {
			if (planned.sessionId) {
				sessionId = planned.sessionId;
				await deps.sessions?.set(parentId, childType, {
					sessionId,
					provider: ai.id,
					at: new Date().toISOString()
				});
			}
		};
		// What already hangs under the parent, so no run proposes it a second
		// time — and what a continued conversation is told became a ticket.
		const existing = await siblings(deps.store, parent.id, childType);

		// Pass 1. Its own step, which has to be over before the review opens: a
		// live "Proposing…" behind the list would sit there for as long as the
		// user takes to read it.
		let titles: string[];
		try {
			const session = sessionId;
			titles = await prompts.withProgress(
				'planning',
				`Proposing ${TYPE_PLURAL[childType]} for ${parent.key}`,
				async (report, token) => {
					const planned = await planChildren(
						ai,
						{
							...plan,
							// A continued conversation is told what exists and asked for
							// the rest, with the form's instruction as its follow-up.
							resume: session
								? { sessionId: session, existing, followUp: instruction || undefined }
								: undefined
						},
						// No lane: this is the flow itself, not one of its children.
						hooks((line) => report.log(line), token)
					);
					await remember(planned);
					return dropExisting(planned.titles, existing, report);
				}
			);
		} catch (error) {
			reportFailure(
				prompts,
				error,
				`${TYPE_PLURAL[childType]} could not be proposed.`,
				continued ? START_FRESH_HINT : undefined
			);
			return [];
		}

		if (titles.length === 0) {
			// "New" whenever siblings exist: every title may have been one of them,
			// and "proposed no test cases" would read as a run that said nothing.
			const none = `The agent proposed no ${
				continued || existing.length > 0 ? 'new ' : ''
			}${TYPE_PLURAL[childType]}.`;
			prompts.error(
				continued
					? `${none} ${START_FRESH_HINT}`
					: `${none} Try again, or add an instruction saying what to focus on.`
			);
			return [];
		}

		// Review — and as many rounds of it as the user wants. A follow-up asks
		// the same conversation again and the list is replaced; a stopped or
		// failed one leaves the list the user had, and the review comes straight
		// back. Nothing is written until a round ends in `create`.
		let choice: ChildrenChoice | undefined;
		for (;;) {
			choice = await prompts.pickChildren(titles, parent, followUps);
			if (choice === undefined || choice.kind === 'create') {
				break;
			}
			const ask = choice.instruction;
			const session = sessionId;

			try {
				const next = await prompts.withProgress(
					'refining',
					`Updating the list for ${parent.key}`,
					async (report, token) => {
						if (!session) {
							// No conversation to continue — the provider reported none — so
							// the follow-ups ride on the instruction and the plan starts over.
							report.log('No conversation to continue; planning again from the instruction.');
						}
						try {
							const planned = await planChildren(
								ai,
								session
									? { ...plan, resume: { sessionId: session, followUp: ask } }
									: {
											...plan,
											instruction: combineInstruction(instruction, [...followUps, ask])
										},
								hooks((line) => report.log(line), token)
							);
							await remember(planned);
							return dropExisting(planned.titles, existing, report);
						} catch (error) {
							if (error instanceof AiCancelledError) {
								report.log('Stopped — the list you had stands.');
							}
							throw error;
						}
					}
				);

				if (next.length === 0) {
					prompts.error('The agent returned no titles for that. The list you had stands.');
					continue;
				}
				followUps.push(ask);
				titles = next;
			} catch (error) {
				reportFailure(prompts, error, 'The list could not be updated.', 'The list you had stands.');
			}
		}

		if (choice?.kind !== 'create' || choice.titles.length === 0) {
			return [];
		}
		const chosen = choice.titles;

		// Pass 2: one run per kept title, several at once.
		//
		// Two things are held apart here, and conflating them is the bug this
		// shape exists to avoid. The **runs** fan out, up to `ai.concurrency` at a
		// time, because they are independent — each writes one description from a
		// title and the parent, and nothing about one informs another. The
		// **creates** stay strictly in the proposed order, because `nextOrdinal`
		// hands out ids in the order it is asked: letting them race would make
		// ST-1 whichever agent happened to finish first, throwing away the order
		// the agent said to build them in.
		const writeSkill = resolveSkill(agent, childType);
		// The conversation reaches pass 2 only this way: each write runs fresh,
		// from a title and the parent, so the follow-ups that shaped the list ride
		// on the instruction — and into `provenance`, so the history says what the
		// descriptions were steered by.
		const writing = { ...shared, instruction: combineInstruction(instruction, followUps) };
		const created: TicketSummary[] = [];
		/** Created, but with no description — a failed write, not a failed create. */
		const empty: string[] = [];
		let cancelled = false;

		await prompts.withProgress(
			'writing',
			`Writing ${TYPE_PLURAL[childType]} for ${parent.key}`,
			async (report, token) => {
				// The window's slots, not this batch's: `ai.concurrency` is a spend
				// and rate-limit dial, and one that multiplied by the number of open
				// generate tabs would not be a dial. The fallback is a private cap
				// for this batch alone, which is what a direct caller — a test — gets.
				const slots =
					deps.slots ?? sharedLimiter(() => Math.max(1, aiConcurrency(settings)));
				// This batch's turn-taking handle, so its writes alternate with
				// another ticket's rather than queueing behind them.
				const group = {};

				// Every title is announced up front. With a limit of three and eight
				// titles, five have not started — and a row that is simply missing
				// reads as one that was dropped.
				chosen.forEach((title, index) => report.lane(index, title, 'waiting'));

				// Started together; the limiter is what bounds how many actually run,
				// and it is shared with every other tab. Each settles to an outcome
				// rather than rejecting — they are awaited in order below, so a later
				// rejection would go unhandled while an earlier one is still being
				// waited on — and the outcome is tagged rather than read off a shared
				// `cancelled` flag, which the consumer would see set by a *different*
				// child that finished first.
				const writes = chosen.map(async (title, index): Promise<WriteOutcome> => {
					const release = await slots.acquire(group);
					try {
						if (token.isCancellationRequested) {
							return { kind: 'cancelled' };
						}

						report.lane(index, title, 'running');
						return {
							kind: 'written',
							value: await writeChild(
								ai,
								{
									...writing,
									parent: context,
									grandparent,
									childType,
									writeSkill,
									label: ai.label
								},
								title,
								hooks(
									(line) => {
										report.log(line, index);
										report.lane(index, title, 'running', line);
									},
									token
								)
							)
						};
					} catch (error) {
						if (error instanceof AiCancelledError) {
							return { kind: 'cancelled' };
						}
						// One bad run must not discard the rest. The title was the
						// user's choice, so the ticket is still what they asked for —
						// it simply arrives empty, ready to generate from the board.
						report.log(
							`${title} — ${errorMessage(error, 'failed')}`,
							index
						);
						return { kind: 'failed' };
					} finally {
						release();
					}
				});

				// In order, so the ids follow the agent's build order. Awaiting index
				// `i` does not hold the others up: they are already running.
				for (const [index, title] of chosen.entries()) {
					const outcome = await writes[index];

					if (outcome.kind === 'cancelled') {
						cancelled = true;
						report.lane(index, title, 'failed', 'cancelled');
						continue;
					}

					const written = outcome.kind === 'written' ? outcome.value : undefined;
					if (!written) {
						empty.push(title);
					}

					try {
						const ticket = await deps.store.createTicket({
							parentId: parent.id,
							type: childType,
							title,
							description: written?.description ?? '',
							...(written ? { comment: written.note } : {})
						});
						created.push(ticket);
						report.lane(index, title, written ? 'done' : 'failed', ticket.key);
						// One at a time, so the tab's list grows with the run rather
						// than appearing whole at the end.
						prompts.created?.(ticket, written !== undefined);
					} catch (error) {
						// The ticket does not exist, so it is not one of the empty
						// ones — and unlike a failed run, this is reported as it
						// happens: a tracker that cannot be written to will fail for
						// every remaining title too.
						if (!written) {
							empty.pop();
						}
						report.lane(index, title, 'failed');
						reportFailure(prompts, error, `“${title}” could not be created.`);
					}

					deps.refresh();
				}
			}
		);

		deps.refresh();
		prompts.info(summary(created.length, chosen.length, childType, empty, cancelled));
		return created;
	} finally {
		running.delete(key);
	}
}

function ticketContext(ticket: {
	id: string;
	type: TicketType;
	title: string;
	status: TicketSummary['status'];
	description: string;
}): AiTicketContext {
	return {
		id: ticket.id,
		type: ticket.type,
		title: ticket.title,
		status: ticket.status,
		description: ticket.description
	};
}

/** What one child's run came to. Tagged, so the consumer reads no shared flag. */
type WriteOutcome =
	| { kind: 'written'; value: WrittenChild }
	| { kind: 'failed' }
	| { kind: 'cancelled' };

/** Bridges a `CancellationToken` onto the run handle `RunHooks` hands back. */
function hooks(
	report: (message: string) => void,
	token: vscode.CancellationToken
): RunHooks {
	return {
		report,
		onCancel: (cancel) => {
			// The × can be pressed before the child process has even spawned, so the
			// already-requested case is checked rather than only subscribed to.
			if (token.isCancellationRequested) {
				cancel('cancelled before the run started');
				return;
			}
			token.onCancellationRequested(() => cancel('cancelled from the notification'));
		}
	};
}

function summary(
	createdCount: number,
	askedFor: number,
	childType: TicketType,
	empty: readonly string[],
	cancelled: boolean
): string {
	const what = createdCount === 1 ? TYPE_LABEL[childType] : TYPE_PLURAL[childType];
	const head =
		createdCount === askedFor && !cancelled
			? `Created ${createdCount} ${what}.`
			: `Created ${createdCount} of ${askedFor} ${TYPE_PLURAL[childType]}.` +
				(cancelled ? ' Cancelled the rest.' : '');

	return empty.length > 0
		? `${head} No description was written for ${empty.map((title) => `“${title}”`).join(', ')}.`
		: head;
}

/** The children already under the parent, of the type being generated. */
async function siblings(
	store: TicketStore,
	parentId: string,
	childType: TicketType
): Promise<ExistingChild[]> {
	return (await store.listChildren(parentId))
		.filter((ticket) => ticket.type === childType)
		.map((ticket) => ({ id: ticket.id, title: ticket.title }));
}

/**
 * Titles that are already a child, taken out — and said so, since a silently
 * shorter list reads as a model that miscounted. Runs on every plan result: a
 * proposal that duplicates a sibling is never wanted, continued conversation
 * or not, and one code path is one place for the rule.
 */
function dropExisting(
	titles: readonly string[],
	existing: readonly ExistingChild[],
	report: GenerateReport
): string[] {
	if (existing.length === 0) {
		return [...titles];
	}
	const taken = new Map(existing.map((child) => [titleKey(child.title), child.id]));
	return titles.filter((title) => {
		const id = taken.get(titleKey(title));
		if (id === undefined) {
			return true;
		}
		report.log(`“${title}” already exists as ${id} — dropped`);
		return false;
	});
}

function reportFailure(
	prompts: GeneratePrompts,
	error: unknown,
	fallback: string,
	hint?: string
): void {
	if (error instanceof AiCancelledError) {
		// The user did this; there is nothing to report.
		return;
	}
	const message = errorMessage(error, fallback);
	prompts.error(hint ? `${message} ${hint}` : message);
}

function article(type: TicketType): string {
	const label = TYPE_LABEL[type];
	return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
}
