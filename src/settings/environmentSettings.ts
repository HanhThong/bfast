// The environments feature's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `aiSettings.ts`: no `vscode` import (the host validates
// before writing, the settings webview validates as you type), reading is
// forgiving while writing is strict, and `parseEnvironmentsSettings` returns
// `undefined` — not an empty object — when nothing survived, so a workspace
// that never uses environments keeps `bfast.json` byte-identical.
//
// `portVariables` is deliberately **semantics-free**: BFAST has no notion of
// frontend, backend or database. It allocates one free port per name and hands
// them to the stack as environment variables; what the names mean is entirely
// the stack's business (see docs/environments/configuration.md). The one name
// BFAST singles out is the **main port** — the first in the list, or the one
// `mainPort` names — the environment's front door.

/** Which implementation of `EnvironmentProvider` runs a stack. */
export type EnvironmentProviderId = 'docker-compose' | 'k8s';

export const ENVIRONMENT_PROVIDER_IDS: readonly EnvironmentProviderId[] = [
	'docker-compose',
	'k8s'
];

/** Docker Compose ships first; `k8s` is registered but not implemented yet. */
export const DEFAULT_ENVIRONMENT_PROVIDER: EnvironmentProviderId = 'docker-compose';

export interface EnvironmentsSettings {
	provider?: EnvironmentProviderId;
	/**
	 * Where the worktrees BFAST creates are kept — the **parent** folder, not
	 * this workspace's own: `<workspace-slug>` is always appended beneath it.
	 * Absolute, or `~`-relative; absent means `<os temp>/bfast-worktrees`.
	 */
	worktreesFolder?: string;
	portRangeStart?: number;
	portRangeEnd?: number;
	/**
	 * Environment-variable names the stack consumes, one allocated port each.
	 * The names are the user's own — no role is baked in.
	 */
	portVariables?: string[];
	/**
	 * Which of `portVariables` is the environment's main port — the URL a
	 * developer opens. Absent means the first entry.
	 */
	mainPort?: string;
	/** Worktree-relative compose file path (docker-compose provider only). */
	composeFile?: string;
	/**
	 * Additional compose files layered over `composeFile`, in order — each
	 * becomes one more `--file` flag, and later files override earlier ones
	 * (standard compose merging). Worktree-relative, like `composeFile`.
	 */
	composeOverrides?: string[];
	/**
	 * How many lines of existing history a container's log tab fetches when it
	 * starts following. `0` starts from the next line the container prints.
	 */
	logTail?: number;
}

export const DEFAULT_PORT_RANGE_START = 20000;
export const DEFAULT_PORT_RANGE_END = 20999;
export const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
/**
 * Enough to hold a service's whole startup, which is where a failure usually
 * explains itself, without dragging a week of a long-lived container's chatter
 * across the bridge the moment a tab opens.
 */
export const DEFAULT_LOG_TAIL = 1000;
export const MAX_LOG_TAIL = 100000;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/**
 * Variables BFAST itself sets on every stack command (`BFAST_TICKET_ID`,
 * `BFAST_PROJECT_NAME`), so a port variable may not claim the prefix.
 */
export const RESERVED_VARIABLE_PREFIX = 'BFAST_';

/** What an environment variable name must look like. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Characters Windows rejects in a path; same rule as `validateTrackerFolder`. */
const INVALID_PATH_CHARS = /[*?"<>|]/;

/**
 * An absolute path, or one starting at the home folder. The exact inverse of
 * the rule `composeFile` follows, read the other way round and for the same
 * reason: a compose file must stay inside the repository, and a worktree must
 * stay out of it — a second checkout inside the first would turn up in every
 * search, every watcher and every `git status`.
 *
 * `~` is accepted because `bfast.json` is committed to git: it is the one
 * shape a Windows and a macOS teammate can share. Expanding it needs
 * `os.homedir()`, so that happens in `environmentContext.ts` — this module is
 * bundled by the settings webview and stays Node-free.
 */
const ABSOLUTE_PATH = /^(~(\/|$)|\/|[a-zA-Z]:\/)/;

/**
 * Reads the `environments` block out of whatever `JSON.parse` produced.
 *
 * Never throws. Returns `undefined` when nothing usable survived, so a
 * workspace that has never used environments writes no `environments` key.
 */
export function parseEnvironmentsSettings(raw: unknown): EnvironmentsSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof EnvironmentsSettings, unknown>>;

	const provider = ENVIRONMENT_PROVIDER_IDS.includes(source.provider as EnvironmentProviderId)
		? (source.provider as EnvironmentProviderId)
		: undefined;

	const portVariables = parsePortVariables(source.portVariables);

	// A main port that does not name one of the variables is dropped, not kept:
	// the accessor's first-entry fallback is better than a dangling name.
	const mainPort =
		typeof source.mainPort === 'string' && portVariables.includes(source.mainPort.trim())
			? source.mainPort.trim()
			: undefined;

	const composeOverrides = Array.isArray(source.composeOverrides)
		? source.composeOverrides
				.map((entry) => (typeof entry === 'string' ? usableRelativePath(entry) : undefined))
				.filter((entry): entry is string => entry !== undefined)
		: [];

	const settings: EnvironmentsSettings = {
		...(provider ? { provider } : {}),
		...optionalWorktreesFolder(source.worktreesFolder),
		...optionalPort('portRangeStart', source.portRangeStart),
		...optionalPort('portRangeEnd', source.portRangeEnd),
		...(portVariables.length > 0 ? { portVariables } : {}),
		...(mainPort ? { mainPort } : {}),
		...optionalPath('composeFile', source.composeFile),
		...(composeOverrides.length > 0 ? { composeOverrides } : {}),
		...optionalLogTail(source.logTail)
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Trims and drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeEnvironmentsSettings(
	environments: EnvironmentsSettings | undefined
): EnvironmentsSettings | undefined {
	return environments === undefined ? undefined : parseEnvironmentsSettings(environments);
}

/** Returns an error message, or `undefined` when the whole block is usable. */
export function validateEnvironmentsSettings(
	environments: EnvironmentsSettings | undefined
): string | undefined {
	if (environments === undefined) {
		return undefined;
	}

	const { start, end } = environmentPortRange(environments);
	if (!isPort(start) || !isPort(end)) {
		return `Ports must be whole numbers between ${MIN_PORT} and ${MAX_PORT}.`;
	}
	if (end < start) {
		return 'The end of the port range must not be below its start.';
	}

	const names = environments.portVariables ?? [];
	for (const name of names) {
		if (!VARIABLE_NAME.test(name)) {
			return `“${name}” is not a usable variable name (letters, digits and _ only).`;
		}
		if (isReservedVariable(name)) {
			return `The ${RESERVED_VARIABLE_PREFIX} prefix is reserved for BFAST's own variables.`;
		}
	}
	if (new Set(names.map((name) => name.toUpperCase())).size !== names.length) {
		return 'Port variable names must be unique.';
	}
	if (end - start + 1 < names.length) {
		return 'The port range is smaller than the number of port variables.';
	}

	if (environments.mainPort !== undefined && !names.includes(environments.mainPort)) {
		return 'The main port must be one of the port variables.';
	}

	if (
		environments.logTail !== undefined &&
		(!Number.isInteger(environments.logTail) || !isLogTail(environments.logTail))
	) {
		return `Log history must be a whole number of lines between 0 and ${MAX_LOG_TAIL}.`;
	}

	if (environments.worktreesFolder !== undefined) {
		const error = validateWorktreesFolder(environments.worktreesFolder);
		if (error) {
			return error;
		}
	}

	if (environments.composeFile !== undefined) {
		const error = validateComposePath(environments.composeFile);
		if (error) {
			return error;
		}
	}
	for (const override of environments.composeOverrides ?? []) {
		// An empty row in the form is dropped on save, never refused.
		if (normalizeRelativePath(override).length > 0) {
			const error = validateComposePath(override);
			if (error) {
				return error;
			}
		}
	}

	return undefined;
}

/**
 * Validates the normalized form, the `validateTrackerFolder` order — on the
 * raw string a backslash path like `..\shared\x.yml` is one '/'-segment and
 * would sail past the '..' check.
 */
function validateComposePath(value: string): string | undefined {
	const file = normalizeRelativePath(value);
	if (file.startsWith('/') || /^[a-zA-Z]:/.test(file)) {
		return 'Use a compose file path relative to the repository, not an absolute one.';
	}
	if (file.split('/').includes('..')) {
		return 'The compose file must stay inside the repository.';
	}
	if (INVALID_PATH_CHARS.test(file)) {
		return 'The compose file path contains characters that are not allowed.';
	}
	return undefined;
}

/**
 * The strict half of `optionalWorktreesFolder`, exported for the settings
 * form: the parse silently drops an unusable value so a hand-edited file still
 * loads, and without this the same typo would save fine and only surface at
 * the next Create Environment, quietly pointing at the default folder.
 *
 * An empty string is not an error — the form clears the field that way, and
 * the parse drops it back to the default.
 */
export function validateWorktreesFolder(value: string): string | undefined {
	const folder = normalizeRelativePath(value);
	if (folder.length === 0) {
		return undefined;
	}
	if (!ABSOLUTE_PATH.test(folder)) {
		return 'The worktrees folder must be an absolute path, or start with ~ for your home folder.';
	}
	if (folder.split('/').includes('..')) {
		return 'The worktrees folder may not contain .. segments.';
	}
	if (INVALID_PATH_CHARS.test(folder)) {
		return 'The worktrees folder path contains characters that are not allowed.';
	}
	return undefined;
}

/**
 * The shape the file stores: trimmed, forward-slashed, no trailing slash.
 * Exported for the settings form's folder picker, so what the field shows
 * after a Browse is byte-identical to what the next save writes.
 */
export function normalizeWorktreesFolder(value: string): string {
	return normalizeRelativePath(value);
}

export function environmentProviderId(
	environments: EnvironmentsSettings | undefined
): EnvironmentProviderId {
	return environments?.provider ?? DEFAULT_ENVIRONMENT_PROVIDER;
}

/**
 * The configured worktrees home, or `undefined` for the default. Deliberately
 * not defaulted here: the default is `<os temp>/bfast-worktrees`, and naming
 * it would drag `os` into a module the settings webview bundles.
 * `worktreesHome` in `environmentContext.ts` is the one address for that.
 */
export function environmentWorktreesFolder(
	environments: EnvironmentsSettings | undefined
): string | undefined {
	return environments?.worktreesFolder;
}

export function environmentPortRange(environments: EnvironmentsSettings | undefined): {
	start: number;
	end: number;
} {
	return {
		start: environments?.portRangeStart ?? DEFAULT_PORT_RANGE_START,
		end: environments?.portRangeEnd ?? DEFAULT_PORT_RANGE_END
	};
}

export function environmentPortVariables(
	environments: EnvironmentsSettings | undefined
): string[] {
	return environments?.portVariables ?? [];
}

/**
 * The main port's variable name, or `undefined` when no variables are
 * configured. Explicit `mainPort` wins; the first entry is the default.
 */
export function environmentMainPort(
	environments: EnvironmentsSettings | undefined
): string | undefined {
	return environments?.mainPort ?? environmentPortVariables(environments)[0];
}

export function environmentComposeFile(
	environments: EnvironmentsSettings | undefined
): string {
	return environments?.composeFile ?? DEFAULT_COMPOSE_FILE;
}

/**
 * The full `--file` chain: the base file, then every override in order.
 * The docker provider consumes this, never the two fields separately.
 */
export function environmentComposeFiles(
	environments: EnvironmentsSettings | undefined
): string[] {
	return [environmentComposeFile(environments), ...(environments?.composeOverrides ?? [])];
}

/**
 * How many lines of history a log follow starts with. `0` is a real answer —
 * "only what happens from now on" — so the `??` and not a falsy check.
 */
export function environmentLogTail(environments: EnvironmentsSettings | undefined): number {
	return environments?.logTail ?? DEFAULT_LOG_TAIL;
}

/**
 * `"WEB_PORT, DB_PORT"` → `['WEB_PORT', 'DB_PORT']` — the settings form's text
 * input and the parser share this one reading, so they cannot disagree.
 * Unusable names are dropped; duplicates (case-insensitive) keep the first.
 */
export function parsePortVariableList(text: string): string[] {
	return dedupeNames(
		text
			.split(/[\s,]+/)
			.map((name) => name.trim())
			.filter((name) => VARIABLE_NAME.test(name) && !isReservedVariable(name))
	);
}

/**
 * The strict half of `parsePortVariableList`, for the settings form: the parse
 * silently drops an unusable token, so without this a typo would save fine and
 * only surface minutes later as a compose substitution error at Start.
 */
export function validatePortVariableText(text: string): string | undefined {
	for (const token of text.split(/[\s,]+/).filter((name) => name.length > 0)) {
		if (!VARIABLE_NAME.test(token)) {
			return `“${token}” is not a usable variable name (letters, digits and _ only).`;
		}
		if (isReservedVariable(token)) {
			return `The ${RESERVED_VARIABLE_PREFIX} prefix is reserved for BFAST's own variables.`;
		}
	}
	return undefined;
}

function parsePortVariables(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return dedupeNames(
		value
			.filter((name): name is string => typeof name === 'string')
			.map((name) => name.trim())
			.filter((name) => VARIABLE_NAME.test(name) && !isReservedVariable(name))
	);
}

function dedupeNames(names: string[]): string[] {
	const seen = new Set<string>();
	return names.filter((name) => {
		// Case-insensitive: environment variables collide on Windows either way.
		const key = name.toUpperCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function isReservedVariable(name: string): boolean {
	return name.toUpperCase().startsWith(RESERVED_VARIABLE_PREFIX);
}

/**
 * Reading is forgiving — an out-of-range port is dropped so a hand-edited file
 * still loads — while `validateEnvironmentsSettings` refuses the same value on
 * the way out, the house rule everywhere else in the tracker.
 */
function optionalPort<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
	if (typeof value !== 'number' || !Number.isInteger(value) || !isPort(value)) {
		return {};
	}
	return { [key]: value } as Record<K, number>;
}

function isPort(value: number): boolean {
	return value >= MIN_PORT && value <= MAX_PORT;
}

/**
 * Forgiving on the way in, the `optionalPort` rule — an out-of-range value in a
 * hand-edited or pulled file is dropped so the default applies, and
 * `validateEnvironmentsSettings` refuses the same value on the way out.
 */
function optionalLogTail(value: unknown): { logTail?: number } {
	return typeof value === 'number' && Number.isInteger(value) && isLogTail(value)
		? { logTail: value }
		: {};
}

function isLogTail(value: number): boolean {
	return value >= 0 && value <= MAX_LOG_TAIL;
}

/**
 * Trimmed, forward-slashed, and only kept when it stays inside the repo — an
 * absolute or `..`-escaping value from a hand-edited (or pulled) file is
 * dropped so the default applies, never handed to `path.join` against the
 * worktree, where the `..` segments would resolve right back out of it.
 */
function optionalPath<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const file = usableRelativePath(value);
	return file === undefined ? {} : ({ [key]: file } as Record<K, string>);
}

/**
 * Forgiving on the way in, the `optionalPath` rule: a relative or malformed
 * value in a hand-edited (or pulled) file is dropped so the default applies,
 * never joined against a workspace path where it would put a worktree inside
 * the repository.
 */
function optionalWorktreesFolder(value: unknown): { worktreesFolder?: string } {
	if (typeof value !== 'string') {
		return {};
	}
	const folder = normalizeRelativePath(value);
	return folder.length > 0 && validateWorktreesFolder(folder) === undefined
		? { worktreesFolder: folder }
		: {};
}

/** The normalized path, or `undefined` when it is empty or escapes the repo. */
function usableRelativePath(value: string): string | undefined {
	const file = normalizeRelativePath(value);
	if (
		file.length === 0 ||
		file.startsWith('/') ||
		/^[a-zA-Z]:/.test(file) ||
		file.split('/').includes('..') ||
		INVALID_PATH_CHARS.test(file)
	) {
		return undefined;
	}
	return file;
}

function normalizeRelativePath(value: string): string {
	let file = value.trim().replace(/\\/g, '/');
	while (file.startsWith('./')) {
		file = file.slice(2);
	}
	while (file.endsWith('/')) {
		file = file.slice(0, -1);
	}
	return file;
}
