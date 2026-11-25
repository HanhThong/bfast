// The Implement feature's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `environmentSettings.ts`: no `vscode` import (the host
// validates before writing, the settings webview validates as you type),
// reading is forgiving while writing is strict, and `parseImplementSettings`
// returns `undefined` — not an empty object — when nothing survived, so a
// workspace that never uses Implement keeps `bfast.json` byte-identical.
//
// One flat list of agents rather than an agent plus a "surface" axis: a CLI
// entry is its own destination with its own handoff (a file and a fixed line,
// never the prompt on the shell), and the two Claude Code agents share not a
// line of that code. docs/implement/configuration.md is the spec.

/** Which coding agent `Implement…` hands the prompt to. */
export type ImplementAgentId =
	| 'claude-code'
	| 'claude-code-cli'
	| 'codex'
	| 'codex-cli'
	| 'opencode'
	| 'opencode-cli'
	| 'cursor'
	| 'github-copilot';

export const IMPLEMENT_AGENT_IDS: readonly ImplementAgentId[] = [
	'claude-code',
	'claude-code-cli',
	'codex',
	'codex-cli',
	'opencode',
	'opencode-cli',
	'cursor',
	'github-copilot'
];

/**
 * The Claude Code extension ships first, the CLI beside it; the rest are
 * registered stubs that fail with "coming soon" — the `k8s` posture, so a
 * value committed ahead of its implementation is a sentence, never a crash.
 */
export const DEFAULT_IMPLEMENT_AGENT: ImplementAgentId = 'claude-code';

export interface ImplementSettings {
	/** Absent means `claude-code`. */
	agent?: ImplementAgentId;
}

/**
 * Reads the `implement` block out of whatever `JSON.parse` produced.
 *
 * Never throws. An unknown agent is dropped, not kept, so the default applies;
 * `undefined` when nothing usable survived, so a workspace that has never used
 * Implement writes no `implement` key.
 */
export function parseImplementSettings(raw: unknown): ImplementSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof ImplementSettings, unknown>>;

	const agent = IMPLEMENT_AGENT_IDS.includes(source.agent as ImplementAgentId)
		? (source.agent as ImplementAgentId)
		: undefined;

	// Every field is named here, or it is silently dropped on every write.
	const settings: ImplementSettings = {
		...(agent ? { agent } : {})
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeImplementSettings(
	implement: ImplementSettings | undefined
): ImplementSettings | undefined {
	return implement === undefined ? undefined : parseImplementSettings(implement);
}

/**
 * Returns an error message, or `undefined` when the whole block is usable.
 *
 * A coming-soon agent is **valid**: the form disables it, but a hand-edited
 * file naming one must still save, and Implement says "coming soon" at the
 * click — refusing here would make a pulled file open the form pre-invalid.
 */
export function validateImplementSettings(
	implement: ImplementSettings | undefined
): string | undefined {
	if (implement === undefined) {
		return undefined;
	}
	if (implement.agent !== undefined && !IMPLEMENT_AGENT_IDS.includes(implement.agent)) {
		return 'Pick a coding agent from the list.';
	}
	return undefined;
}

export function implementAgentId(implement: ImplementSettings | undefined): ImplementAgentId {
	return implement?.agent ?? DEFAULT_IMPLEMENT_AGENT;
}
