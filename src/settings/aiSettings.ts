// The AI assistant's slice of `.vscode/bfast.json`.
//
// Like `bfastSettings.ts` this module has no `vscode` import: the host validates
// with it before writing, and the settings webview validates with it as you
// type, so the two halves can never disagree on what a valid value is.
//
// One rule shapes everything here: a workspace that never touches the assistant
// must keep `bfast.json` byte-identical. That is why `parseAiSettings` returns
// `undefined` — not an empty object — when nothing survived, and why
// `normalizeSettings` then omits the `ai` key entirely.
//
// The one field that leans the other way is `language`: it says *what tongue*
// the answer is written in, not how it is shaped, and a team picks it once
// rather than editing every agent file — mechanical enough to belong here.
//
// What is deliberately **not** here: how an agent writes. Those instructions
// live in `.bfast/agents/*.md` (see `ai/agent.ts`) because they are long prose
// that belongs in an editor and in a readable git diff, not in a JSON string.

import { LANGUAGE_CODES, languageName } from './languages';
import { isModelId, MAX_MODEL_ID_LENGTH, sanitizeModelId } from './models';

/** Which implementation of `AiProvider` runs a generation. */
export type AiProviderId = 'claude-cli' | 'claude-agent-sdk';

export const AI_PROVIDER_IDS: readonly AiProviderId[] = ['claude-cli', 'claude-agent-sdk'];

/**
 * The CLI is the default: it has no runtime dependency, uses the `claude` the
 * user already installed and logged in, and sidesteps the Agent SDK's
 * per-platform binary — a VSIX built on one OS carries no binary for the others.
 */
export const DEFAULT_AI_PROVIDER: AiProviderId = 'claude-cli';

export interface AiSettings {
	provider?: AiProviderId;
	/**
	 * The workspace's default model — an alias (`opus`) or an id
	 * (`claude-opus-5`), see `models.ts` — passed straight through to the
	 * provider. Absent means the provider's own default. Every picker can
	 * override it for one tab's runs; `aiModel` is where that precedence lives.
	 */
	model?: string;
	/**
	 * Path to the `claude` executable. For the CLI provider it is the binary to
	 * spawn; for the SDK provider it becomes `pathToClaudeCodeExecutable`. The
	 * escape hatch for a platform the bundled binary does not cover.
	 */
	executablePath?: string;
	maxTurns?: number;
	/**
	 * ISO 639-1 code of the language generated descriptions are written in.
	 * Absent means no preference — the agent writes in whatever the ticket
	 * suggests, exactly as it did before this setting existed.
	 */
	language?: string;
	/**
	 * How many agents the generate tab runs at once when writing a ticket's
	 * children.
	 *
	 * Each one is a separate provider run — a child process for the CLI — so this
	 * is a spend and rate-limit dial as much as a speed one. It applies only to
	 * that fan-out: the board still runs exactly one at a time, because there is
	 * only one description to write.
	 */
	concurrency?: number;
	/**
	 * How long a run may produce **no output at all** before it is stopped, in
	 * **seconds**.
	 *
	 * Seconds rather than milliseconds because a form field asking for 180000 is
	 * hostile. It is an idle window, not a ceiling on the work: a run that keeps
	 * reporting progress is never stopped, however long it takes. Absent means
	 * `DEFAULT_IDLE_SECONDS`.
	 */
	idleTimeout?: number;
}

export const MIN_TURNS = 1;
export const MAX_TURNS = 50;
export const DEFAULT_TURNS = 12;

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
/**
 * Three at once: enough that a breakdown of six stories finishes in roughly the
 * time two used to take, low enough that a mistyped instruction cannot spawn a
 * dozen processes before anyone reaches Cancel.
 */
export const DEFAULT_CONCURRENCY = 3;

export const MIN_IDLE_SECONDS = 30;
export const MAX_IDLE_SECONDS = 1800;
/**
 * Three minutes of silence.
 *
 * Declared here rather than imported from `idleWatchdog.ts`: this module is
 * bundled into the settings webview, which has no Node types and no use for a
 * watchdog. It has to agree with `DEFAULT_IDLE_TIMEOUT_MS` — the window a
 * provider falls back to — and a test pins the two together, which is cheaper
 * than dragging the host half across the bundle boundary.
 */
export const DEFAULT_IDLE_SECONDS = 180;

/** What a fresh form starts from. */
export const EMPTY_AI_SETTINGS: AiSettings = {};

/**
 * Reads the `ai` block out of whatever `JSON.parse` produced.
 *
 * Never throws. Returns `undefined` when nothing usable survived, so a workspace
 * that has never used the assistant writes no `ai` key at all.
 */
export function parseAiSettings(raw: unknown): AiSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof AiSettings, unknown>>;

	const provider = AI_PROVIDER_IDS.includes(source.provider as AiProviderId)
		? (source.provider as AiProviderId)
		: undefined;

	const settings: AiSettings = {
		...(provider ? { provider } : {}),
		...optionalText('model', source.model),
		...optionalText('executablePath', source.executablePath),
		...optionalTurns(source.maxTurns),
		...optionalLanguage(source.language),
		...optionalConcurrency(source.concurrency),
		...optionalIdleTimeout(source.idleTimeout)
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Trims and drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeAiSettings(ai: AiSettings | undefined): AiSettings | undefined {
	return ai === undefined ? undefined : parseAiSettings(ai);
}

/** Returns an error message, or `undefined` when the whole block is usable. */
export function validateAiSettings(ai: AiSettings | undefined): string | undefined {
	if (ai?.maxTurns !== undefined && optionalTurns(ai.maxTurns).maxTurns === undefined) {
		return `Turns must be a whole number between ${MIN_TURNS} and ${MAX_TURNS}.`;
	}
	if (ai?.language !== undefined && ai.language.trim().length > 0 && languageName(ai.language) === undefined) {
		return 'Pick a language from the list.';
	}
	// A format rule, not a membership test: an id the list does not know is a
	// model that shipped after the extension did, and Claude Code is the one to
	// refuse it — at the first request.
	if (ai?.model !== undefined && ai.model.trim().length > 0 && !isModelId(ai.model.trim())) {
		return `Model must be one token — no spaces — of at most ${MAX_MODEL_ID_LENGTH} characters.`;
	}
	if (
		ai?.concurrency !== undefined &&
		optionalConcurrency(ai.concurrency).concurrency === undefined
	) {
		return `Agents at once must be a whole number between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}.`;
	}
	if (
		ai?.idleTimeout !== undefined &&
		optionalIdleTimeout(ai.idleTimeout).idleTimeout === undefined
	) {
		return `Idle timeout must be a whole number of seconds between ${MIN_IDLE_SECONDS} and ${MAX_IDLE_SECONDS}.`;
	}
	return undefined;
}

export function aiProviderId(ai: AiSettings | undefined): AiProviderId {
	return ai?.provider ?? DEFAULT_AI_PROVIDER;
}

export function aiMaxTurns(ai: AiSettings | undefined): number {
	return ai?.maxTurns ?? DEFAULT_TURNS;
}

/**
 * The model a run goes to: a tab's own pick when it passes the format rule,
 * else the workspace setting, else `undefined` for the provider's default.
 *
 * The single address for that precedence, so the board, the generate tab and
 * anything after them cannot rank the two differently. The pick arrived from a
 * webview and becomes an argv element, which is why it is sanitised here and
 * never passed through on trust; one that fails is ignored rather than
 * refused, since the setting is what the picker showed as the fallback.
 */
export function aiModel(ai: AiSettings | undefined, pick?: string): string | undefined {
	return sanitizeModelId(pick) ?? ai?.model;
}

/** How many children the generate tab writes at once. Never zero. */
export function aiConcurrency(ai: AiSettings | undefined): number {
	return ai?.concurrency ?? DEFAULT_CONCURRENCY;
}

/**
 * How long a run may say nothing before a provider stops it, in milliseconds.
 *
 * The single address for the seconds → milliseconds conversion, so no caller
 * has to remember which unit it is holding.
 */
export function aiIdleTimeoutMs(ai: AiSettings | undefined): number {
	return (ai?.idleTimeout ?? DEFAULT_IDLE_SECONDS) * 1000;
}

/**
 * The English name to put in the prompt, or `undefined` when no language was
 * chosen. The code is what gets stored; a model needs the name, so this is the
 * single address for that translation.
 */
export function aiLanguageName(ai: AiSettings | undefined): string | undefined {
	return languageName(ai?.language);
}

/** `{ model: 'x' }` for a usable string, `{}` otherwise, so it spreads into a literal. */
function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/**
 * Reading is forgiving — an out-of-range value is dropped so a hand-edited file
 * still loads — while `validateAiSettings` refuses the same value on the way
 * out, which is the house rule everywhere else in the tracker.
 */
function optionalTurns(value: unknown): { maxTurns?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_TURNS && value <= MAX_TURNS ? { maxTurns: value } : {};
}

/** Same rule as `optionalTurns`, for the generate tab's fan-out. */
function optionalConcurrency(value: unknown): { concurrency?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_CONCURRENCY && value <= MAX_CONCURRENCY ? { concurrency: value } : {};
}

/**
 * Same rule again, in seconds.
 *
 * The floor matters more here than elsewhere: a window short enough to fire
 * between two heartbeats would reintroduce exactly the bug this replaced, so
 * anything under `MIN_IDLE_SECONDS` is refused rather than obeyed.
 */
function optionalIdleTimeout(value: unknown): { idleTimeout?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_IDLE_SECONDS && value <= MAX_IDLE_SECONDS ? { idleTimeout: value } : {};
}

/** Same rule: a code that is not ISO 639-1 is dropped rather than refused. */
function optionalLanguage(value: unknown): { language?: string } {
	if (typeof value !== 'string') {
		return {};
	}
	const code = value.trim().toLowerCase();
	return LANGUAGE_CODES.has(code) ? { language: code } : {};
}
