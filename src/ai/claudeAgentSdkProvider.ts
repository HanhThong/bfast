// `AiProvider` backed by `@anthropic-ai/claude-agent-sdk`.
//
// The alternative to `ClaudeCliProvider`, for anyone who would rather the
// extension carried the agent than depend on a `claude` being on the PATH. Both
// map the same message stream through `messageStream.ts`, so what they produce
// cannot drift apart; the differences are all in how the agent is started.
//
// This one costs the project its first runtime dependency, and the SDK ships
// its binary through per-platform `optionalDependencies` — so a VSIX built on
// one operating system carries none for the others. That is exactly what
// `availability()` is for: it degrades to a greyed-out button with a reason,
// and the rest of BFAST never notices.

import { agentEnvironment, type AiContext } from './aiContext';
import {
	AiCancelledError,
	AiError,
	type AiAvailability,
	type AiProgressListener,
	type AiProvider,
	type AiRequest,
	type AiResult,
	type AiRun
} from './aiProvider';
import { loadClaudeSdk, type SdkLoader, type SdkOptions } from './claudeSdkModule';
import { ALLOWED_TOOLS } from './claudeCliProvider';
import { AgentStream, type AgentMessage } from './messageStream';
import { DEFAULT_IDLE_TIMEOUT_MS, IdleWatchdog, idleTimeoutMessage } from '../platform/idleWatchdog';
import { systemPromptFor } from './systemPrompt';
import { errorMessage } from '../platform/errors';

export class ClaudeAgentSdkProvider implements AiProvider {
	readonly id = 'claude-agent-sdk';
	readonly label = 'Claude Agent SDK';

	private readonly live = new Set<AbortController>();

	constructor(
		private readonly context: AiContext,
		/** Injected in tests, so none of this needs the SDK to be installed. */
		private readonly load: SdkLoader = loadClaudeSdk
	) {}

	/** Cheapest checks first, so a common misconfiguration never pays for a module load. */
	async availability(): Promise<AiAvailability> {
		if (!this.context.workingDirectory()) {
			return {
				ok: false,
				reason: 'not-configured',
				message: 'Open a folder before using the AI assistant.'
			};
		}

		const { apiKey, oauthToken } = await this.context.credentials();
		if (!apiKey && !oauthToken) {
			return {
				ok: false,
				reason: 'no-credentials',
				message:
					'No credentials for the AI assistant. Run “BFAST: Set AI API key” from the ' +
					'command palette.'
			};
		}

		try {
			await this.load();
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				reason: 'not-installed',
				message: errorMessage(error, 'The Claude Agent SDK is unavailable.')
			};
		}
	}

	run(request: AiRequest, onProgress?: AiProgressListener): AiRun {
		const controller = new AbortController();
		this.live.add(controller);

		let cancellation: AiError | undefined;

		// An idle ceiling, not a wall-clock one. Armed here rather than around the
		// loop deliberately: `execute` reads credentials and dynamically imports the
		// SDK before it yields anything, and a module load that never returns is as
		// much a hang as a model that never speaks.
		const idleMs = request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		const watchdog = new IdleWatchdog(idleMs, () => {
			cancellation ??= new AiError('timeout', idleTimeoutMessage(idleMs));
			controller.abort();
		});

		// The run must settle on an abort even if the SDK does not.
		//
		// `execute` only notices `aborted` between two yields, so a `query()` that
		// is wedged mid-message — or one that simply ignores the `abortController`
		// it was handed — would leave the loop parked and the promise pending for
		// ever. That is the failure the user experiences as Stop doing nothing at
		// all, and as an idle timeout that never fires. The CLI provider's settle
		// fallback is the same guarantee by other means.
		const stopped = new Promise<never>((_, reject) => {
			controller.signal.addEventListener(
				'abort',
				() => reject(cancellation ?? new AiCancelledError()),
				{ once: true }
			);
		});

		const work = this.execute(request, controller, watchdog, onProgress);
		// The loser of the race is abandoned, not cancelled, so its eventual
		// rejection has to be claimed here or it surfaces as an unhandled one.
		work.catch(() => undefined);

		const completed = Promise.race([work, stopped])
			.catch((error: unknown) => {
				// An abort surfaces however the SDK chose to report it, so the reason
				// we recorded is what decides between cancelled and timed out.
				throw controller.signal.aborted ? (cancellation ?? new AiCancelledError()) : error;
			})
			.finally(() => {
				watchdog.stop();
				this.live.delete(controller);
			});

		return {
			runId: `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			completed,
			cancel: (reason) => {
				cancellation ??= new AiCancelledError(reason);
				controller.abort();
			}
		};
	}

	dispose(): void {
		for (const controller of this.live) {
			controller.abort();
		}
		this.live.clear();
	}

	private async execute(
		request: AiRequest,
		controller: AbortController,
		watchdog: IdleWatchdog,
		onProgress: AiProgressListener | undefined
	): Promise<AiResult> {
		const credentials = await this.context.credentials();
		if (!credentials.apiKey && !credentials.oauthToken) {
			// Checked before the module is touched, so a missing key is a clear
			// message rather than an install error.
			throw new AiError('no-credentials', 'No credentials for the AI assistant.');
		}

		const { query } = await this.load();
		const stream = new AgentStream();

		for await (const message of query({
			prompt: request.prompt,
			options: this.options(request, controller, credentials)
		})) {
			// Every message counts, including the ones the mapper ignores: the
			// watchdog asks whether anything is happening, not whether it was
			// interesting. `thinking_tokens` arrives here too, so a run that is only
			// reasoning is as alive to this as one that is talking.
			watchdog.touch();
			if (controller.signal.aborted) {
				break;
			}
			// The SDK's union is wider than what is mapped, and deliberately read
			// loosely: an unknown message kind must be ignored, never fatal.
			stream.accept(message as unknown as AgentMessage, onProgress);
		}

		if (controller.signal.aborted) {
			throw new AiCancelledError();
		}

		return stream.result();
	}

	private options(
		request: AiRequest,
		controller: AbortController,
		credentials: { apiKey?: string; oauthToken?: string }
	): SdkOptions {
		return {
			// BFAST's own prompt, not the `claude_code` preset — see systemPrompt.ts.
			systemPrompt: systemPromptFor(request),

			// Read-only by default, hard-coded, and shared with the CLI provider so
			// the two cannot disagree about what a run is allowed to do. A board run
			// that may edit other tickets adds `Edit`, bounded by the rules in the
			// settings file it was handed — see `trackerEdits.ts`.
			allowedTools: [...ALLOWED_TOOLS],
			...(request.edits
				? {
						tools: [...request.edits.tools],
						// A path, so a rule survives a comma in a folder name.
						settings: request.edits.settingsFile
					}
				: {}),

			// Deny whatever is not allowed, and never ask: a headless webview has
			// nowhere to answer. Not `bypassPermissions` — that approves everything
			// regardless of the allow-list (and demands a flag this never set), so
			// the allow-list would have been decoration.
			permissionMode: 'dontAsk',

			// Do not load the user's own CLAUDE.md, settings or hooks. A personal
			// hook firing because someone pressed a button in a ticket tracker is
			// both surprising and a hazard, and a templated feature wants
			// determinism.
			settingSources: [],

			cwd: request.workingDirectory,
			maxTurns: request.maxTurns,
			...(request.model ? { model: request.model } : {}),
			// Continue the conversation that id names. `persistSession` is left at
			// its default (on) — it is what makes a later resume possible at all.
			...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
			abortController: controller,

			// The only path credentials take to the child. Never `process.env.X = …`:
			// the extension host is shared with every other extension in the window.
			env: agentEnvironment(credentials) as Record<string, string>,

			...(this.context.settings()?.executablePath
				? { pathToClaudeCodeExecutable: this.context.settings()?.executablePath }
				: {})
		};
	}
}
