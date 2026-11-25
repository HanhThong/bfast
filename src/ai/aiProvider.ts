// The seam the AI assistant sits behind.
//
// Structured like `src/data/ticketStore.ts`: the interface, its request/result
// types and its error classes in one `vscode`-free module, with no
// implementation. `BfastPanel`, the protocol and the webview only ever see this
// file, so swapping `ClaudeCliProvider` for `ClaudeAgentSdkProvider` — or for
// something else entirely — is one line in `activate()`.

import type { TicketStatus, TicketType } from '../data/types';

/**
 * Everything the board needs from an AI backend.
 *
 * `availability()` and `run()` are split deliberately: the board has to paint a
 * correct button *before* anyone presses it, and a disabled button needs a
 * reason for its tooltip. It is also the graceful-degradation seam — a missing
 * `claude` binary becomes a greyed-out button rather than an exception at click
 * time, and nothing else in BFAST notices.
 */
export interface AiProvider {
	/** Stable machine id, e.g. `'claude-cli'`. Never shown to the user. */
	readonly id: string;
	/** User-visible name, e.g. `'Claude Code CLI'`. The panel must not hard-code this. */
	readonly label: string;

	availability(): Promise<AiAvailability>;

	/**
	 * Starts a generation. Synchronous, returning a handle rather than a promise,
	 * because a run has three interesting moments — it starts, it emits progress,
	 * it finishes — and the caller needs a cancel token for the middle one.
	 */
	run(request: AiRequest, onProgress?: AiProgressListener): AiRun;

	/** Cancels every live run. The provider owns child processes. */
	dispose(): void;
}

/**
 * A single generation in flight. `cancel()` lives here rather than on the
 * provider so there is no registry keyed by run id to keep in step — the same
 * reasoning that makes `BfastPanel.panels` a `Set` and not a map.
 */
export interface AiRun {
	readonly runId: string;
	readonly completed: Promise<AiResult>;
	/** Idempotent, and safe to call after the run has already finished. */
	cancel(reason?: string): void;
}

export interface AiRequest {
	/** Free text the user typed on the board. May be empty. */
	instruction: string;
	/**
	 * The full prompt, **already rendered** by the caller from the template and
	 * the ticket. The provider knows nothing about templates, so a second
	 * implementation never has to reimplement that policy.
	 */
	prompt: string;
	/** Carried for labelling and logging; the content is all in `prompt`. */
	ticket: AiTicketContext;
	/** Where file tools resolve. Absent means the agent gets no filesystem. */
	workingDirectory?: string;
	/**
	 * How long a run may produce **nothing at all** before the provider stops it.
	 *
	 * An idle window, not a wall-clock ceiling: a generation may take as long as
	 * it takes so long as it keeps reporting. Absent means
	 * `DEFAULT_IDLE_TIMEOUT_MS`.
	 */
	idleTimeoutMs?: number;
	model?: string;
	maxTurns?: number;
	/**
	 * Continue an earlier run's conversation instead of starting one.
	 *
	 * A Claude Code session id, exactly as `AiResultMeta.sessionId` reported it.
	 * It is machine-local and bound to `workingDirectory` — the CLI files a
	 * session under a folder derived from the cwd — which is why the flow keeps
	 * it in `workspaceState` and never in anything committed. Absent means a
	 * fresh conversation.
	 */
	resumeSessionId?: string;
	/**
	 * What this run may change on disk. **Absent means read-only**, which is
	 * every run but a board's.
	 *
	 * `settingsFile` is a Claude Code settings file the host wrote for this run,
	 * holding one `Edit(<path>)` allow rule per content file that existed when
	 * the run started and a deny rule for the writing tools and the ticket being
	 * written — see `trackerEdits.ts`. A file rather than arguments because a
	 * rule survives a comma or a parenthesis in a folder name there and not on
	 * the command line. `tools` is the closed set of built-in tools the run may
	 * have at all.
	 */
	edits?: { settingsFile: string; tools: readonly string[] };
}

export interface AiTicketContext {
	id: string;
	type: TicketType;
	title: string;
	status: TicketStatus;
	description: string;
}

/**
 * What a run is doing while it runs.
 *
 * `thinking` is what proves the agent is alive rather than hung. It arrives two
 * ways and both matter: `tokens` is a running counter the CLI emits several
 * times a second from the first moment, long before there is anything to read,
 * and `text` is a reasoning block once it is complete. The counter is the
 * heartbeat; the text is the explanation.
 */
export type AiProgress =
	| { kind: 'started'; model?: string }
	| { kind: 'thinking'; text?: string; tokens?: number }
	| { kind: 'text'; text: string }
	/**
	 * A tool call as the agent announced it. `detail` is the file or pattern for
	 * the log; `id`, `filePath` and `edit` are the raw facts adoption needs, so it
	 * never parses a display string.
	 */
	| {
			kind: 'tool';
			name: string;
			detail?: string;
			id?: string;
			filePath?: string;
			edit?: { oldString: string; newString: string; replaceAll: boolean };
	  }
	/** The answer to a tool call. Only the result says whether an edit happened. */
	| { kind: 'tool-result'; id: string; error: boolean }
	/** A tool call refused by the run's permissions, before it ran. */
	| { kind: 'denied'; tool: string; filePath?: string; reason?: string }
	| { kind: 'turn'; index: number };

export type AiProgressListener = (progress: AiProgress) => void;

export interface AiResult {
	/**
	 * The generated description, raw. `sanitizeAiDescription` is applied by the
	 * caller rather than here, so every implementation — including a test fake —
	 * goes through the same cleanup instead of each having to remember it.
	 */
	text: string;
	meta?: AiResultMeta;
}

export interface AiResultMeta {
	model?: string;
	turns?: number;
	costUsd?: number;
	sessionId?: string;
	/** Tool calls the run's permissions refused — the authoritative list, from the result. */
	denials?: { tool: string; filePath?: string }[];
}

export interface AiAvailability {
	ok: boolean;
	reason?: AiErrorCode;
	/** The disabled button's tooltip. Must never contain credentials. */
	message?: string;
}

export type AiErrorCode =
	/** The binary or the SDK module could not be loaded. */
	| 'not-installed'
	| 'no-credentials'
	/** No workspace folder, so there is nowhere to run. */
	| 'not-configured'
	| 'cancelled'
	| 'timeout'
	| 'empty-result'
	/** The backend ran and reported a failure of its own. */
	| 'provider-error';

/**
 * Carries a code because the panel switches on it to decide what to tell the
 * user. `message` must never interpolate the options object — that object holds
 * the API key.
 */
export class AiError extends Error {
	constructor(
		readonly code: AiErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'AiError';
	}
}

export class AiCancelledError extends AiError {
	constructor(reason = 'The run was cancelled.') {
		super('cancelled', reason);
		this.name = 'AiCancelledError';
	}
}
