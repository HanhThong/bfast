// Per-workspace BFAST configuration, stored in `.vscode/bfast.json`.
//
// This module has no `vscode` import on purpose: it is imported both by the
// extension host (before writing the file) and by the settings webview (for
// inline validation), so the two halves can never disagree on what a valid
// value is.

import {
	normalizeAiSettings,
	parseAiSettings,
	validateAiSettings,
	type AiSettings
} from './aiSettings';
import {
	normalizeEnvironmentsSettings,
	parseEnvironmentsSettings,
	validateEnvironmentsSettings,
	type EnvironmentsSettings
} from './environmentSettings';
import {
	normalizeGitSettings,
	parseGitSettings,
	validateGitSettings,
	type GitSettings
} from './gitSettings';
import {
	normalizeImplementSettings,
	parseImplementSettings,
	validateImplementSettings,
	type ImplementSettings
} from './implementSettings';
import {
	normalizeMcpSettings,
	parseMcpSettings,
	validateMcpSettings,
	type McpSettings
} from './mcpSettings';
import {
	normalizeScanSettings,
	parseScanSettings,
	validateScanSettings,
	type ScanSettings
} from './scanSettings';
import {
	normalizeTestsSettings,
	parseTestsSettings,
	validateTestsSettings,
	type TestsSettings
} from './testsSettings';

export interface BfastSettings {
	/** Workspace-relative folder holding the tracker store. */
	trackerFolder: string;
	/** Name stamped as the author on ticket history entries. */
	userName: string;
	/**
	 * The AI assistant's configuration.
	 *
	 * Optional, and omitted from the file when empty, so a workspace that never
	 * touches the assistant keeps `bfast.json` exactly as it was. Never holds a
	 * credential — the file is committed to git; see `aiContext.ts`.
	 */
	ai?: AiSettings;
	/**
	 * The per-story environments' configuration. Same posture as `ai`: optional,
	 * omitted when empty, and never a credential.
	 */
	environments?: EnvironmentsSettings;
	/**
	 * The test runner's configuration. Same posture as `ai`: optional, omitted
	 * when empty, and never a credential.
	 */
	tests?: TestsSettings;
	/**
	 * Code scanning's configuration. Same posture as `ai`: optional, omitted when
	 * empty, and never a credential — `scanSettings.ts` refuses a `hostUrl`
	 * carrying userinfo and a property whose key reads like a secret, because this
	 * file is committed to git.
	 */
	scan?: ScanSettings;
	/**
	 * Implement's configuration — which coding agent a ticket's prompt goes to.
	 * Same posture as `ai`: optional, omitted when empty, never a credential.
	 */
	implement?: ImplementSettings;
	/**
	 * The MCP server's configuration — whether it listens, on what port, who may
	 * reach it, and which functions it offers. Same posture as `ai`: optional and
	 * omitted when empty. Never a credential, and not merely because this file is
	 * committed to git: the server has none at all. See docs/mcp/.
	 */
	mcp?: McpSettings;
	/**
	 * Commit Ticket's configuration — the commit message template. Same posture
	 * as `ai`: optional, omitted when empty, never a credential.
	 */
	git?: GitSettings;
}

export const DEFAULT_TRACKER_FOLDER = '.tracker';

/** Workspace-relative path of the settings file. */
export const SETTINGS_FILE = '.vscode/bfast.json';

/** Characters Windows rejects in a path; `:` is left out so `C:` is caught by the absolute-path rule. */
const INVALID_PATH_CHARS = /[*?"<>|]/;

/**
 * One optional block of `bfast.json` — `ai`, `tests`, `mcp`… — as the three
 * things the file's reader, its writer and its validator need from it.
 *
 * Every block follows the same posture: `parse` is forgiving and answers
 * `undefined` when nothing survived, `normalize` does the same on the way out
 * (which is what keeps a block out of a file that never used it), and
 * `validate` is strict.
 */
export interface SettingsBlock<T> {
	parse(raw: unknown): T | undefined;
	normalize(value: T | undefined): T | undefined;
	/**
	 * An error message, or `undefined` when the block is usable. Handed the whole
	 * settings object because a block may be judged against another field —
	 * `tests.resultsFolder` is refused inside the tracker folder.
	 */
	validate(value: T | undefined, settings: BfastSettings): string | undefined;
}

/** The optional blocks: every key of `BfastSettings` that is not a top-level field. */
export type SettingsBlockKey = Exclude<keyof BfastSettings, 'trackerFolder' | 'userName'>;

/**
 * Every optional block, in the order they are written to the file.
 *
 * The **one** place a block is named: `parseSettings`, `normalizeSettings`,
 * `isValid` and `validateSettings` all walk this table. The mapped type is the
 * point — a key added to `BfastSettings` with no entry here does not compile,
 * where it used to be silently dropped on the next write by a
 * `normalizeSettings` that had not been told about it.
 */
export const SETTINGS_BLOCKS: {
	readonly [K in SettingsBlockKey]-?: SettingsBlock<NonNullable<BfastSettings[K]>>;
} = {
	ai: { parse: parseAiSettings, normalize: normalizeAiSettings, validate: validateAiSettings },
	environments: {
		parse: parseEnvironmentsSettings,
		normalize: normalizeEnvironmentsSettings,
		validate: validateEnvironmentsSettings
	},
	tests: {
		parse: parseTestsSettings,
		normalize: normalizeTestsSettings,
		validate: (tests, settings) => validateTestsSettings(tests, settings.trackerFolder)
	},
	scan: {
		parse: parseScanSettings,
		normalize: normalizeScanSettings,
		validate: validateScanSettings
	},
	implement: {
		parse: parseImplementSettings,
		normalize: normalizeImplementSettings,
		validate: validateImplementSettings
	},
	mcp: { parse: parseMcpSettings, normalize: normalizeMcpSettings, validate: validateMcpSettings },
	git: { parse: parseGitSettings, normalize: normalizeGitSettings, validate: validateGitSettings }
};

const BLOCK_KEYS = Object.keys(SETTINGS_BLOCKS) as SettingsBlockKey[];

/**
 * Runs one step of every block and keeps what survived, in table order. A
 * block that came back `undefined` is left out entirely rather than written as
 * an empty key.
 */
function blocks(
	step: <K extends SettingsBlockKey>(key: K) => BfastSettings[K]
): Pick<BfastSettings, SettingsBlockKey> {
	const result: Record<string, unknown> = {};
	for (const key of BLOCK_KEYS) {
		const value = step(key);
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result as Pick<BfastSettings, SettingsBlockKey>;
}

/**
 * Reads settings out of whatever `JSON.parse` produced. Deliberately tolerant:
 * a hand-edited file with a missing or wrong-typed field falls back to the
 * defaults instead of throwing, so a typo can never break activation.
 */
export function parseSettings(raw: unknown): BfastSettings {
	const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
		Record<keyof BfastSettings, unknown>
	>;

	const trackerFolder =
		typeof source.trackerFolder === 'string' && source.trackerFolder.trim().length > 0
			? normalizeTrackerFolder(source.trackerFolder)
			: DEFAULT_TRACKER_FOLDER;

	const userName = typeof source.userName === 'string' ? source.userName.trim() : '';

	return {
		trackerFolder,
		userName,
		...blocks((key) => SETTINGS_BLOCKS[key].parse(source[key]) as BfastSettings[typeof key])
	};
}

/** `.\tracker\` and `./tracker/` both become `.tracker`-style forward-slash paths. */
export function normalizeTrackerFolder(value: string): string {
	let folder = value.trim().replace(/\\/g, '/');
	while (folder.startsWith('./')) {
		folder = folder.slice(2);
	}
	while (folder.endsWith('/')) {
		folder = folder.slice(0, -1);
	}
	return folder;
}

/** Returns an error message, or `undefined` when the folder is usable. */
export function validateTrackerFolder(value: string): string | undefined {
	const folder = normalizeTrackerFolder(value);

	if (folder.length === 0) {
		return 'Enter a folder name.';
	}
	if (folder.startsWith('/') || /^[a-zA-Z]:/.test(folder)) {
		return 'Use a path relative to the workspace, not an absolute one.';
	}
	if (folder.split('/').includes('..')) {
		return 'The folder must stay inside the workspace.';
	}
	if (INVALID_PATH_CHARS.test(folder)) {
		return 'The folder name contains characters that are not allowed in a path.';
	}
	return undefined;
}

/** Returns an error message, or `undefined` when the name is usable. */
export function validateUserName(value: string): string | undefined {
	return value.trim().length === 0 ? 'Enter the name to show in ticket history.' : undefined;
}

/**
 * The first thing wrong with these settings, as a message, or `undefined` when
 * every field is usable. The form's Save and the host's re-check both ask
 * this, so the two can never disagree about which block is at fault.
 */
export function validateSettings(settings: BfastSettings): string | undefined {
	const topLevel =
		validateTrackerFolder(settings.trackerFolder) ?? validateUserName(settings.userName);
	if (topLevel !== undefined) {
		return topLevel;
	}
	for (const key of BLOCK_KEYS) {
		const block = SETTINGS_BLOCKS[key] as SettingsBlock<unknown>;
		const error = block.validate(settings[key], settings);
		if (error !== undefined) {
			return error;
		}
	}
	return undefined;
}

/** True when every field passes validation. */
export function isValid(settings: BfastSettings): boolean {
	return validateSettings(settings) === undefined;
}

/**
 * Trims and normalizes every field, ready to be written to disk.
 *
 * This returns a **fresh literal**, so a field that is not named is dropped on
 * every write. The top-level fields are named here; every optional block comes
 * from `SETTINGS_BLOCKS`, which the compiler holds complete. A block is spread
 * in only when something survived normalization, which is what keeps the file
 * unchanged for workspaces that never use it.
 */
export function normalizeSettings(settings: BfastSettings): BfastSettings {
	return {
		trackerFolder: normalizeTrackerFolder(settings.trackerFolder),
		userName: settings.userName.trim(),
		...blocks(
			(key) =>
				(SETTINGS_BLOCKS[key] as SettingsBlock<unknown>).normalize(
					settings[key]
				) as BfastSettings[typeof key]
		)
	};
}
