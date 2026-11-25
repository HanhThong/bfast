// The seam between Implement and the program that receives a ticket's prompt.
//
// Structured like `aiProvider.ts`, `environmentProvider.ts` and
// `scanProvider.ts`: an interface plus its request, availability and error
// types, no implementation and no `vscode` import. The registry
// (`codingAgentRegistry.ts`) reads `implement.agent` at call time and forwards;
// `fakeCodingAgent.ts` under `src/test/` proves satisfying this needs no cast.
//
// An agent is a **destination, not a runner**. `AiProvider` runs a model and
// streams its answer back; a `CodingAgent` hands text to another program and
// is done — so there is no progress listener, no cancel, no result and no
// `dispose`. docs/implement/provider-interface.md is the spec.

import type { ImplementAgentId, ImplementSettings } from '../settings/implementSettings';

export type ImplementErrorCode =
	/** The agent's extension is not installed, or its CLI is not on the PATH. */
	| 'not-installed'
	/** Installed, but no longer offers the entry point BFAST uses. */
	| 'unsupported'
	/** A coming-soon stub. */
	| 'not-implemented'
	/** No workspace folder, no tracker folder, no `bfast.json`. */
	| 'not-configured'
	/** Activation failed, the handoff rejected, or a file could not be written. */
	| 'provider-error';

export interface ImplementRequest {
	/** Which ticket this is about — for a terminal's name. */
	ticketId: string;
	/**
	 * Where the rendered prompt already is, workspace-relative:
	 * `.bfast/implement/prompts/ST-1.2.md`. Written before any agent is asked.
	 */
	handoffPath: string;
	/**
	 * `handoffSentence(handoffPath)` — the one string every agent hands over,
	 * verbatim: into a chat input, or wrapped in `claude "…"` on a terminal
	 * line. The prompt's own text never reaches an agent through this seam.
	 */
	message: string;
}

export interface CodingAgentAvailability {
	ok: boolean;
	reason?: ImplementErrorCode;
	/** The error's text. Must never contain the prompt. */
	message?: string;
}

/**
 * What an agent needs from the world, read **at call time** so construction
 * order in `activate()` does not matter — the `AiContext` posture.
 */
export interface CodingAgentContext {
	settings(): ImplementSettings | undefined;
	/** The workspace folder's path, or `undefined` with no folder open. */
	workspaceFolder(): string | undefined;
}

export interface CodingAgent {
	/** Stable machine id; doubles as the settings value. */
	readonly id: ImplementAgentId;
	/** User-visible name, e.g. `'Claude Code'`. */
	readonly label: string;
	/**
	 * The VS Code extension this agent drives, when it drives one — what the
	 * command layer offers the Marketplace for on `not-installed`. Absent for
	 * a CLI, whose fix is a `PATH`, not an install button.
	 */
	readonly extensionId?: string;

	/**
	 * Cheap. Asked before the prompt is built, so a missing program costs no
	 * tracker read and the error can name the fix.
	 */
	availability(): Promise<CodingAgentAvailability>;

	/**
	 * Hands the prompt over. Resolves when the agent's surface has it — the
	 * input filled, the line typed — and never when the agent has *done*
	 * anything with it. Rejects with `ImplementError`.
	 */
	open(request: ImplementRequest): Promise<void>;
}

/**
 * Carries a code because the command layer switches on it for the action
 * button. `message` must never interpolate the prompt: it reaches a
 * notification.
 */
export class ImplementError extends Error {
	constructor(
		readonly code: ImplementErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'ImplementError';
	}
}

/** An availability that said no, as the error the command layer reports. */
export function unavailable(agent: CodingAgent, availability: CodingAgentAvailability): ImplementError {
	return new ImplementError(
		availability.reason ?? 'provider-error',
		availability.message ?? `${agent.label} is not available.`
	);
}
