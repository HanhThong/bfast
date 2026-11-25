// The code-scan feature's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `testsSettings.ts`: no `vscode` and no `node:` import (the
// host validates before writing, the settings webview validates as you type),
// reading is forgiving while writing is strict, and `parseScanSettings` returns
// `undefined` — not an empty object — when nothing survived, so a workspace that
// never scans keeps `bfast.json` byte-identical.
//
// The contract these fields configure lives in docs/scan/. Two rules there are
// enforced here rather than documented and hoped for:
//
//   - **Nothing in this block is ever a credential.** The file is committed to
//     git, so there is deliberately no field a token could be typed into, a
//     `hostUrl` carrying userinfo is refused rather than trimmed, and a
//     user-supplied analysis property whose key reads like a secret is dropped.
//   - **The block is flat**, tool-specific fields and all — the shape
//     `environments` already uses, where `composeFile` sits beside `provider`.
//     A second tool adds fields beside these and the flat keys keep reading as
//     sonarqube's, the same backward-compatible posture as `SkillKind` being
//     omitted when it is `write`. Do not nest for a tool that does not exist.

import { substituteCommand, unknownPlaceholders } from './commandTemplate';

/** Which scan tool runs. One today; the field is what makes the next one a settings value. */
export type ScanToolId = 'sonarqube';

export const SCAN_TOOL_IDS: readonly ScanToolId[] = ['sonarqube'];

export const DEFAULT_SCAN_TOOL: ScanToolId = 'sonarqube';

/** Whether BFAST owns the server or talks to one that already exists. */
export type ScanMode = 'auto' | 'external';

export const SCAN_MODES: readonly ScanMode[] = ['auto', 'external'];

export const DEFAULT_SCAN_MODE: ScanMode = 'auto';

/** How the analysis itself is launched. */
export type ScannerMode = 'docker' | 'command';

export const SCANNER_MODES: readonly ScannerMode[] = ['docker', 'command'];

export const DEFAULT_SCANNER_MODE: ScannerMode = 'docker';

/** One extra `-D` analysis property. A row, not a map, so the form can edit it. */
export interface ScanProperty {
	key: string;
	value: string;
}

export interface ScanSettings {
	tool?: ScanToolId;
	mode?: ScanMode;
	/** `external` only. An http/https URL with no userinfo. */
	hostUrl?: string;
	/** SonarQube Cloud only, where it is mandatory. */
	organization?: string;
	/** The project every scan in this workspace files under. */
	projectKey?: string;
	/** Workspace-relative directory to analyse. Absent means the workspace root. */
	cwd?: string;
	/** `sonar.sources`, sent only when set so a committed properties file keeps its own. */
	sources?: string;
	/** `sonar.exclusions`, same rule. */
	exclusions?: string;
	/** Extra `-D` properties. Never a credential; see `isReservedProperty`. */
	properties?: ScanProperty[];
	scannerMode?: ScannerMode;
	/** `docker` scanner mode only. */
	scannerImage?: string;
	/** `docker` scanner mode only — the escape hatch for a loopback-bound external server. */
	scannerNetwork?: string;
	/** `command` scanner mode only. A shell line; see `SCAN_PLACEHOLDERS`. */
	command?: string;
	/** `auto` mode only. Replaces the compose file BFAST ships. */
	composeFile?: string;
	/** `auto` mode only. Layered over `composeFile`, in order. */
	composeOverrides?: string[];
	portRangeStart?: number;
	portRangeEnd?: number;
	/**
	 * `auto` mode only. Whether BFAST changes the factory admin password and mints
	 * its own tokens. `true` is the default and is never written to the file — a
	 * default-valued flag must not be what creates a `scan` block.
	 */
	autoProvision?: boolean;
	/**
	 * How long the scanner or a server boot may produce **no output at all**
	 * before it is stopped, in **seconds**. An idle window, not a ceiling.
	 */
	idleTimeout?: number;
}

/** The tokens `scan.command` may use; anything else is left in the line. */
export const SCAN_PLACEHOLDERS: readonly string[] = [
	'projectKey',
	'hostUrl',
	'folder',
	'id',
	'key'
];

export const MIN_SCAN_PORT = 1024;
export const MAX_SCAN_PORT = 65535;
export const DEFAULT_SCAN_PORT_RANGE_START = 9000;
export const DEFAULT_SCAN_PORT_RANGE_END = 9099;

export const DEFAULT_SCANNER_IMAGE = 'sonarsource/sonar-scanner-cli';

export const MIN_SCAN_IDLE_SECONDS = 60;
export const MAX_SCAN_IDLE_SECONDS = 3600;
/**
 * Ten minutes of silence — longer than the test runner's five, because a cold
 * SonarQube boot pulls a gigabyte of images and then builds Elasticsearch
 * indices, and none of that prints continuously. Declared here rather than
 * beside the runner for the reason `DEFAULT_IDLE_SECONDS` lives in
 * `aiSettings.ts`: this module is bundled into the settings webview, which needs
 * the number for the form's placeholder.
 */
export const DEFAULT_SCAN_IDLE_SECONDS = 600;

/** SonarQube's own limit on a project key. */
export const MAX_PROJECT_KEY_LENGTH = 400;

/** What SonarQube accepts as a project key. */
const PROJECT_KEY = /^[A-Za-z0-9._:-]+$/;

/** SonarQube Cloud's organization keys. */
const ORGANIZATION_KEY = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Characters Windows rejects in a path; same rule as `validateTrackerFolder`. */
const INVALID_PATH_CHARS = /[*?"<>|]/;

/** A docker reference: no whitespace, no shell metacharacter, no quote. */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/** A docker network name, or the special `host`. */
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Analysis properties BFAST refuses to carry.
 *
 * Two kinds, both refused on the way in and on the way out. Anything that reads
 * like a credential, because this file is committed to git and a `sonar.token`
 * row would put one there with the user's blessing and no warning. And the four
 * BFAST owns, because a user-set `sonar.host.url` would silently point the
 * scanner somewhere other than the server the sidebar is reporting on.
 */
const CREDENTIAL_LIKE = /token|login|password|secret/i;

const BFAST_OWNED_PROPERTIES: readonly string[] = [
	'sonar.host.url',
	'sonar.projectKey',
	'sonar.organization',
	'sonar.projectBaseDir'
];

/** True when the property may not be set by hand. */
export function isReservedProperty(key: string): boolean {
	const name = key.trim();
	return (
		CREDENTIAL_LIKE.test(name) ||
		BFAST_OWNED_PROPERTIES.some((owned) => owned.toLowerCase() === name.toLowerCase())
	);
}

/**
 * Reads the `scan` block out of whatever `JSON.parse` produced.
 *
 * Never throws. Returns `undefined` when nothing usable survived, so a workspace
 * that has never scanned writes no `scan` key at all.
 */
export function parseScanSettings(raw: unknown): ScanSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof ScanSettings, unknown>>;

	const tool = SCAN_TOOL_IDS.includes(source.tool as ScanToolId)
		? (source.tool as ScanToolId)
		: undefined;
	const mode = SCAN_MODES.includes(source.mode as ScanMode)
		? (source.mode as ScanMode)
		: undefined;
	const scannerMode = SCANNER_MODES.includes(source.scannerMode as ScannerMode)
		? (source.scannerMode as ScannerMode)
		: undefined;

	const composeOverrides = Array.isArray(source.composeOverrides)
		? source.composeOverrides
				.map((entry) => (typeof entry === 'string' ? usableRelativePath(entry) : undefined))
				.filter((entry): entry is string => entry !== undefined)
		: [];

	const properties = parseProperties(source.properties);

	const settings: ScanSettings = {
		...(tool ? { tool } : {}),
		...(mode ? { mode } : {}),
		...optionalHostUrl(source.hostUrl),
		...optionalOrganization(source.organization),
		...optionalProjectKey(source.projectKey),
		...optionalPath('cwd', source.cwd),
		...optionalText('sources', source.sources),
		...optionalText('exclusions', source.exclusions),
		...(properties.length > 0 ? { properties } : {}),
		...(scannerMode ? { scannerMode } : {}),
		...optionalPattern('scannerImage', source.scannerImage, IMAGE_REFERENCE),
		...optionalPattern('scannerNetwork', source.scannerNetwork, NETWORK_NAME),
		...optionalText('command', source.command),
		...optionalPath('composeFile', source.composeFile),
		...(composeOverrides.length > 0 ? { composeOverrides } : {}),
		...optionalPort('portRangeStart', source.portRangeStart),
		...optionalPort('portRangeEnd', source.portRangeEnd),
		// Only `false` survives: `true` is the default, and a default-valued flag
		// must never be what creates a block in an otherwise-untouched file.
		...(source.autoProvision === false ? { autoProvision: false } : {}),
		...optionalIdleTimeout(source.idleTimeout)
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Trims and drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeScanSettings(scan: ScanSettings | undefined): ScanSettings | undefined {
	return scan === undefined ? undefined : parseScanSettings(scan);
}

/** Returns an error message, or `undefined` when the whole block is usable. */
export function validateScanSettings(scan: ScanSettings | undefined): string | undefined {
	if (scan === undefined) {
		return undefined;
	}

	// An unconfigured block is not an invalid one — a pulled file that names only
	// `mode` must open the form clean, not pre-invalid.
	if (scan.hostUrl !== undefined && scan.hostUrl.trim().length > 0) {
		const error = validateHostUrl(scan.hostUrl);
		if (error) {
			return error;
		}
	}

	if (scan.organization !== undefined && scan.organization.trim().length > 0) {
		if (!ORGANIZATION_KEY.test(scan.organization.trim().toLowerCase())) {
			return 'An organization key is 2–64 characters of lower-case letters, digits and hyphens.';
		}
	}

	if (scan.projectKey !== undefined && scan.projectKey.trim().length > 0) {
		const error = validateProjectKey(scan.projectKey);
		if (error) {
			return error;
		}
	}

	for (const [field, label] of [
		['cwd', 'working directory'],
		['composeFile', 'compose file']
	] as const) {
		const value = scan[field];
		if (value !== undefined) {
			const error = validateRelativePath(value, label);
			if (error) {
				return error;
			}
		}
	}
	for (const override of scan.composeOverrides ?? []) {
		// An empty row in the form is dropped on save, never refused.
		if (normalizeRelativePath(override).length > 0) {
			const error = validateRelativePath(override, 'compose file');
			if (error) {
				return error;
			}
		}
	}

	if (
		scan.scannerImage !== undefined &&
		scan.scannerImage.trim().length > 0 &&
		!IMAGE_REFERENCE.test(scan.scannerImage.trim())
	) {
		return 'The scanner image must be a plain image reference — no spaces or quotes.';
	}
	if (
		scan.scannerNetwork !== undefined &&
		scan.scannerNetwork.trim().length > 0 &&
		!NETWORK_NAME.test(scan.scannerNetwork.trim())
	) {
		return 'The scanner network must be a docker network name.';
	}

	const propertyError = validateProperties(scan.properties);
	if (propertyError) {
		return propertyError;
	}

	const { start, end } = scanPortRange(scan);
	if (!isPort(start) || !isPort(end)) {
		return `Ports must be whole numbers between ${MIN_SCAN_PORT} and ${MAX_SCAN_PORT}.`;
	}
	if (end < start) {
		return 'The end of the port range must not be below its start.';
	}

	if (scan.idleTimeout !== undefined && optionalIdleTimeout(scan.idleTimeout).idleTimeout === undefined) {
		return `Idle timeout must be a whole number of seconds between ${MIN_SCAN_IDLE_SECONDS} and ${MAX_SCAN_IDLE_SECONDS}.`;
	}

	return undefined;
}

/** Returns an error message, or `undefined` when the URL is usable. Exported for the form. */
export function validateHostUrl(value: string): string | undefined {
	const text = value.trim();
	if (text.length === 0) {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return 'Enter a full URL, including http:// or https://.';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'The server URL must use http or https.';
	}
	// The one rule this file exists to enforce: `bfast.json` is committed to git.
	if (url.username.length > 0 || url.password.length > 0) {
		return 'Do not put credentials in the URL — this file is committed to git. Use BFAST: Set SonarQube Token.';
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		return 'The server URL must not carry a query string or a fragment.';
	}
	return undefined;
}

/** Returns an error message, or `undefined` when the key is usable. Exported for the form. */
export function validateProjectKey(value: string): string | undefined {
	const key = value.trim();
	if (key.length === 0) {
		return undefined;
	}
	if (!PROJECT_KEY.test(key)) {
		return 'A project key may contain letters, digits and . _ : - only.';
	}
	if (key.length > MAX_PROJECT_KEY_LENGTH) {
		return `A project key may be at most ${MAX_PROJECT_KEY_LENGTH} characters.`;
	}
	// SonarQube refuses an all-digit key; catching it here beats a 400 later.
	if (/^\d+$/.test(key)) {
		return 'A project key may not be all digits.';
	}
	return undefined;
}

/**
 * The `{{token}}`s in a scan command that BFAST does not substitute.
 *
 * Advisory only, never a refusal — the same policy `tests.command` follows, and
 * for the same reason: an unknown token reaches the shell as written, and a
 * pulled `bfast.json` must not open the form pre-invalid.
 */
export function unknownScanPlaceholders(command: string): string[] {
	return unknownPlaceholders(command, SCAN_PLACEHOLDERS);
}

export { substituteCommand };

// ------------------------------------------------------------------ accessors

export function scanToolId(scan: ScanSettings | undefined): ScanToolId {
	return scan?.tool ?? DEFAULT_SCAN_TOOL;
}

export function scanMode(scan: ScanSettings | undefined): ScanMode {
	return scan?.mode ?? DEFAULT_SCAN_MODE;
}

export function scannerMode(scan: ScanSettings | undefined): ScannerMode {
	return scan?.scannerMode ?? DEFAULT_SCANNER_MODE;
}

export function scannerImage(scan: ScanSettings | undefined): string {
	return scan?.scannerImage ?? DEFAULT_SCANNER_IMAGE;
}

/** The configured shell line, or `undefined` when `command` mode is unconfigured. */
export function scanCommand(scan: ScanSettings | undefined): string | undefined {
	const command = scan?.command?.trim();
	return command !== undefined && command.length > 0 ? command : undefined;
}

/** The workspace-relative directory to analyse, or `undefined` for the root. */
export function scanCwd(scan: ScanSettings | undefined): string | undefined {
	const cwd = scan?.cwd === undefined ? undefined : normalizeRelativePath(scan.cwd);
	return cwd !== undefined && cwd.length > 0 ? cwd : undefined;
}

export function scanPortRange(scan: ScanSettings | undefined): { start: number; end: number } {
	return {
		start: scan?.portRangeStart ?? DEFAULT_SCAN_PORT_RANGE_START,
		end: scan?.portRangeEnd ?? DEFAULT_SCAN_PORT_RANGE_END
	};
}

export function scanAutoProvision(scan: ScanSettings | undefined): boolean {
	return scan?.autoProvision ?? true;
}

/**
 * How long a scan step may say nothing before it is stopped, in milliseconds.
 * The single address for the seconds → milliseconds conversion.
 */
export function scanIdleTimeoutMs(scan: ScanSettings | undefined): number {
	return (scan?.idleTimeout ?? DEFAULT_SCAN_IDLE_SECONDS) * 1000;
}

/**
 * The full `--file` chain for the deployed stack: the base file then every
 * override in order. `undefined` for the base means BFAST's own shipped file,
 * whose absolute path only the host can resolve — so this returns what the user
 * configured and the provider prepends the default.
 */
export function scanComposeOverrides(scan: ScanSettings | undefined): string[] {
	return scan?.composeOverrides ?? [];
}

/**
 * The extra `-D` properties, already filtered.
 *
 * Empty in `command` mode: BFAST appends nothing to a line the user wrote. The
 * one address for that rule, so no caller has to remember it.
 */
export function scanProperties(scan: ScanSettings | undefined): ScanProperty[] {
	if (scannerMode(scan) === 'command') {
		return [];
	}
	return scan?.properties ?? [];
}

/**
 * `'My App'` → `'my-app'` — the project key a workspace gets when none is set.
 *
 * Lower-case and hyphenated like `slugifyAgentName`, then forced to satisfy
 * `PROJECT_KEY`: an all-digit folder name gets a prefix, because SonarQube
 * refuses those, and an empty result gets a name rather than failing at 400.
 */
export function defaultProjectKey(workspaceName: string): string {
	const slug = workspaceName
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._:-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_PROJECT_KEY_LENGTH);
	if (slug.length === 0) {
		return 'bfast-project';
	}
	return /^\d+$/.test(slug) ? `project-${slug}` : slug;
}

// -------------------------------------------------------------------- private

function parseProperties(value: unknown): ScanProperty[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const properties: ScanProperty[] = [];
	for (const entry of value) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const row = entry as { key?: unknown; value?: unknown };
		if (typeof row.key !== 'string' || typeof row.value !== 'string') {
			continue;
		}
		const key = row.key.trim();
		const text = row.value.trim();
		// A newline would let one row become two `-D` flags.
		if (key.length === 0 || isReservedProperty(key) || /[\r\n]/.test(text)) {
			continue;
		}
		const lower = key.toLowerCase();
		if (seen.has(lower)) {
			continue;
		}
		seen.add(lower);
		properties.push({ key, value: text });
	}
	return properties;
}

function validateProperties(properties: readonly ScanProperty[] | undefined): string | undefined {
	const seen = new Set<string>();
	for (const property of properties ?? []) {
		const key = property.key.trim();
		// A wholly empty row is what an unfilled form row looks like; it is
		// dropped on save, never refused.
		if (key.length === 0 && property.value.trim().length === 0) {
			continue;
		}
		if (key.length === 0) {
			return 'An analysis property needs a name.';
		}
		if (isReservedProperty(key)) {
			return `“${key}” cannot be set here — BFAST owns it, or it looks like a credential and this file is committed to git.`;
		}
		if (/[\r\n]/.test(property.value)) {
			return `The value of “${key}” may not contain a line break.`;
		}
		const lower = key.toLowerCase();
		if (seen.has(lower)) {
			return `“${key}” is set more than once.`;
		}
		seen.add(lower);
	}
	return undefined;
}

/**
 * Validates the normalized form, the `validateComposePath` order — on the raw
 * string a backslash path like `..\shared\web` is one '/'-segment and would sail
 * past the '..' check.
 */
function validateRelativePath(value: string, label: string): string | undefined {
	const folder = normalizeRelativePath(value);
	if (folder.length === 0) {
		return undefined;
	}
	if (folder.startsWith('/') || /^[a-zA-Z]:/.test(folder)) {
		return `Use a ${label} relative to the workspace, not an absolute one.`;
	}
	if (folder.split('/').includes('..')) {
		return `The ${label} must stay inside the workspace.`;
	}
	if (INVALID_PATH_CHARS.test(folder)) {
		return `The ${label} contains characters that are not allowed in a path.`;
	}
	return undefined;
}

/** `{ sources: 'src' }` for a usable string, `{}` otherwise, so it spreads into a literal. */
function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/** Same, but only when the trimmed value also satisfies `pattern`. */
function optionalPattern<K extends string>(
	key: K,
	value: unknown,
	pattern: RegExp
): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const trimmed = value.trim();
	return trimmed.length > 0 && pattern.test(trimmed)
		? ({ [key]: trimmed } as Record<K, string>)
		: {};
}

/**
 * Trimmed, forward-slashed, and only kept when it stays inside the workspace —
 * an absolute or `..`-escaping value from a hand-edited (or pulled) file is
 * dropped so the default applies, never resolved against the workspace root.
 */
function optionalPath<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const folder = usableRelativePath(value);
	return folder === undefined ? {} : ({ [key]: folder } as Record<K, string>);
}

/** The normalized path, or `undefined` when it is empty or escapes the workspace. */
function usableRelativePath(value: string): string | undefined {
	const folder = normalizeRelativePath(value);
	if (folder.length === 0 || validateRelativePath(folder, 'path') !== undefined) {
		return undefined;
	}
	return folder;
}

function optionalHostUrl(value: unknown): { hostUrl?: string } {
	if (typeof value !== 'string') {
		return {};
	}
	const text = value.trim();
	if (text.length === 0 || validateHostUrl(text) !== undefined) {
		return {};
	}
	// Through `URL` so the host is lower-cased and a trailing slash goes, while a
	// port and a path prefix survive — a reverse-proxied `/sonar` is common.
	const url = new URL(text);
	const path = url.pathname.replace(/\/+$/, '');
	return { hostUrl: `${url.protocol}//${url.host}${path}` };
}

function optionalOrganization(value: unknown): { organization?: string } {
	if (typeof value !== 'string') {
		return {};
	}
	const key = value.trim().toLowerCase();
	return ORGANIZATION_KEY.test(key) ? { organization: key } : {};
}

function optionalProjectKey(value: unknown): { projectKey?: string } {
	if (typeof value !== 'string') {
		return {};
	}
	const key = value.trim();
	return key.length > 0 && validateProjectKey(key) === undefined ? { projectKey: key } : {};
}

/**
 * Reading is forgiving — an out-of-range port is dropped so a hand-edited file
 * still loads — while `validateScanSettings` refuses the same value on the way
 * out, the house rule everywhere else in the tracker.
 */
function optionalPort<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
	if (typeof value !== 'number' || !Number.isInteger(value) || !isPort(value)) {
		return {};
	}
	return { [key]: value } as Record<K, number>;
}

function isPort(value: number): boolean {
	return value >= MIN_SCAN_PORT && value <= MAX_SCAN_PORT;
}

/** Same rule, in seconds; the floor keeps the window wider than any output gap. */
function optionalIdleTimeout(value: unknown): { idleTimeout?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_SCAN_IDLE_SECONDS && value <= MAX_SCAN_IDLE_SECONDS
		? { idleTimeout: value }
		: {};
}

function normalizeRelativePath(value: string): string {
	let folder = value.trim().replace(/\\/g, '/');
	while (folder.startsWith('./')) {
		folder = folder.slice(2);
	}
	while (folder.endsWith('/')) {
		folder = folder.slice(0, -1);
	}
	return folder;
}
