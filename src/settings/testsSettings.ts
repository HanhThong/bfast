// The test runner's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `aiSettings.ts`: no `vscode` or Node import (the host
// validates before writing, the settings webview validates as you type), reading
// is forgiving while writing is strict, and `parseTestsSettings` returns
// `undefined` — not an empty object — when nothing survived, so a workspace
// that never runs tests keeps `bfast.json` byte-identical.
//
// The contract these fields configure lives in docs/tests/ — the command is a
// shell line run once per test-case ticket in scope, with `{{id}}`-style
// placeholders substituted; the evidence pattern names what the test tool left
// behind for that test case. Nothing here is ever a credential: the file is
// committed to git, and anything secret belongs in the environment the command
// itself reads.

import {
	DEFAULT_TRACE_FRAME_SOURCE,
	TRACE_FRAME_SOURCES,
	type TraceFrameSource
} from '../shared/playwrightTrace';
import {
	parseTestServices,
	validateTestServices,
	type TestService
} from './testServices';
import {
	substituteCommand as substituteTemplate,
	unknownPlaceholders as unknownTemplatePlaceholders
} from './commandTemplate';

export interface TestsSettings {
	/**
	 * The shell line run once per test case, with `{{id}}`, `{{key}}` and
	 * `{{folder}}` substituted. Absent means the feature is unconfigured — the
	 * Run Tests command says so rather than guessing a command.
	 */
	command?: string;
	/**
	 * Workspace-relative working directory for every run — for monorepos.
	 * Absent means the workspace root.
	 */
	cwd?: string;
	/**
	 * Workspace-relative folder every recorded run is filed under —
	 * `<resultsFolder>/<test case id>/<runId>/` — see `testing/testResultsPaths.ts`.
	 * Absent means `DEFAULT_TEST_RESULTS_FOLDER`. Deliberately **outside the
	 * tracker**: a run is not a change to a ticket, and a video is not something
	 * `history.md` should sit beside. May not be, or sit inside, the tracker folder.
	 */
	resultsFolder?: string;
	/**
	 * A glob, relative to `cwd`, for the files the test tool leaves behind for
	 * one test case — `e2e/evidence/{{id}}.*` — copied into the test case's run
	 * folder after its command exits. `{{id}}` and `{{key}}` only: `{{folder}}`
	 * is absolute, and the pattern must stay inside the workspace. Absent means
	 * only the command's own output is recorded.
	 */
	evidence?: string;
	/**
	 * The shell line the board's Open runs for an evidence file it cannot show
	 * inline (a trace), with `{{file}}` substituted — **already quoted** for the
	 * platform shell, since the path carries a ticket title's punctuation and a
	 * file name that arrived from git. Absent means Open reveals the file.
	 */
	evidenceCommand?: string;
	/**
	 * Where the board's trace viewer takes a trace's screenshots from. Absent
	 * means `auto`: each trace's own format decides — `resources/<sha1>` up to
	 * format 8, the `screencast/…` file the frame names from format 9. `resources`
	 * or `screencast` holds to one layout, for a trace whose format number is
	 * wrong about where its frames are.
	 */
	traceFrames?: TraceFrameSource;
	/**
	 * How many test commands run at once.
	 *
	 * Each one is a whole test process, and parallel runs sharing one database
	 * corrupt each other — so unlike the AI fan-out this defaults to sequential,
	 * and raising it is an informed opt-in.
	 */
	concurrency?: number;
	/**
	 * How long a run may produce **no output at all** before it is stopped, in
	 * **seconds**. An idle window, not a ceiling on the work: a suite that keeps
	 * printing is never stopped, however long it takes.
	 */
	idleTimeout?: number;
	/**
	 * An lcov file the project's end-to-end run writes, relative to `cwd` —
	 * one source of the merged coverage. docs/tests/services.md.
	 */
	coverage?: string;
	/**
	 * The repository's services: each a folder with its own unit and e2e
	 * suites, and the target a test case's `service:` names.
	 * See `testServices.ts` and docs/tests/services.md.
	 */
	services?: TestService[];
}

/** The tokens `substituteCommand` replaces in `command`; anything else is left in the line. */
export const TEST_PLACEHOLDERS: readonly string[] = ['id', 'key', 'folder'];
/** The tokens an `evidence` pattern takes — no `{{folder}}`, which is absolute. */
export const EVIDENCE_PLACEHOLDERS: readonly string[] = ['id', 'key'];
/** The one token an `evidenceCommand` takes: the file to open, quoted by BFAST. */
export const EVIDENCE_COMMAND_PLACEHOLDERS: readonly string[] = ['file'];

/**
 * Where runs go when `resultsFolder` is unset. Beside `.bfast/agents`, the
 * extension's own folder in the workspace, and never inside the tracker.
 * Declared here rather than beside the results store for the reason
 * `DEFAULT_TEST_IDLE_SECONDS` is: the settings webview shows it as the field's
 * placeholder and must not drag a `vscode` module across.
 */
export const DEFAULT_TEST_RESULTS_FOLDER = '.bfast/test-results';

export const MIN_TEST_CONCURRENCY = 1;
export const MAX_TEST_CONCURRENCY = 8;
/** Sequential by default — see the field comment. */
export const DEFAULT_TEST_CONCURRENCY = 1;

export const MIN_TEST_IDLE_SECONDS = 30;
export const MAX_TEST_IDLE_SECONDS = 3600;
/**
 * Five minutes of silence — longer than the AI default on purpose: a cold
 * `npm test` compiles quietly for longer than an agent thinks quietly. Declared
 * here rather than beside the runner for the same reason `DEFAULT_IDLE_SECONDS`
 * lives in `aiSettings.ts`: this module is bundled into the settings webview,
 * which needs the number for the form's placeholder.
 */
export const DEFAULT_TEST_IDLE_SECONDS = 300;

/**
 * Reads the `tests` block out of whatever `JSON.parse` produced.
 *
 * Never throws. Returns `undefined` when nothing usable survived, so a
 * workspace that has never run tests writes no `tests` key at all.
 */
export function parseTestsSettings(raw: unknown): TestsSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof TestsSettings, unknown>>;

	// Every field is named here, or it is silently dropped on every write.
	const settings: TestsSettings = {
		...optionalText('command', source.command),
		...optionalPath('cwd', source.cwd),
		...optionalPath('resultsFolder', source.resultsFolder),
		...optionalEvidencePattern('evidence', source.evidence),
		...optionalText('evidenceCommand', source.evidenceCommand),
		...optionalTraceFrames(source.traceFrames),
		...optionalConcurrency(source.concurrency),
		...optionalIdleTimeout(source.idleTimeout),
		...optionalPath('coverage', source.coverage),
		...optionalServices(source.services)
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Trims and drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeTestsSettings(tests: TestsSettings | undefined): TestsSettings | undefined {
	return tests === undefined ? undefined : parseTestsSettings(tests);
}

/**
 * Returns an error message, or `undefined` when the whole block is usable.
 *
 * `trackerFolder` is the one thing outside the block this has to know: a
 * results folder inside the tracker would put `TC-…` folders where the scanner
 * looks for tickets, each loading as one with a warning. The form and the
 * host both pass it; a caller validating the block alone may leave it out.
 */
export function validateTestsSettings(
	tests: TestsSettings | undefined,
	trackerFolder?: string
): string | undefined {
	if (tests?.cwd !== undefined) {
		const error = validateCwdPath(tests.cwd);
		if (error) {
			return error;
		}
	}
	if (tests?.resultsFolder !== undefined) {
		const error = validateResultsFolder(tests.resultsFolder, trackerFolder);
		if (error) {
			return error;
		}
	}
	if (tests?.evidence !== undefined) {
		const error = validateEvidencePattern(tests.evidence);
		if (error) {
			return error;
		}
	}
	if (tests?.coverage !== undefined) {
		const error = validateCwdPath(tests.coverage);
		if (error) {
			return error.replace('working directory', 'project coverage file');
		}
	}
	{
		const error = validateTestServices(tests?.services, trackerFolder);
		if (error) {
			return error;
		}
	}
	if (tests?.traceFrames !== undefined && !isTraceFrameSource(tests.traceFrames)) {
		return `Trace screenshots must be one of ${TRACE_FRAME_SOURCES.join(', ')}.`;
	}
	if (
		tests?.concurrency !== undefined &&
		optionalConcurrency(tests.concurrency).concurrency === undefined
	) {
		return `Tests at once must be a whole number between ${MIN_TEST_CONCURRENCY} and ${MAX_TEST_CONCURRENCY}.`;
	}
	if (
		tests?.idleTimeout !== undefined &&
		optionalIdleTimeout(tests.idleTimeout).idleTimeout === undefined
	) {
		return `Idle timeout must be a whole number of seconds between ${MIN_TEST_IDLE_SECONDS} and ${MAX_TEST_IDLE_SECONDS}.`;
	}
	return undefined;
}

/**
 * The `{{token}}`s in a command that are not in `TEST_PLACEHOLDERS`.
 *
 * Advisory only — the form shows them as a hint, never a refusal, because an
 * unknown token is left in the line untouched at render (the prompt templates'
 * policy) and refusing one here would make a pulled `bfast.json` open the form
 * pre-invalid over a command the user may not own.
 */
export function unknownPlaceholders(command: string): string[] {
	return unknownTemplatePlaceholders(command, TEST_PLACEHOLDERS);
}

/** The same hint for an evidence pattern, whose token set is smaller. */
export function unknownEvidencePlaceholders(pattern: string): string[] {
	return unknownTemplatePlaceholders(pattern, EVIDENCE_PLACEHOLDERS);
}

/** And for the evidence command, which takes `{{file}}` and nothing else. */
export function unknownEvidenceCommandPlaceholders(command: string): string[] {
	return unknownTemplatePlaceholders(command, EVIDENCE_COMMAND_PLACEHOLDERS);
}

/**
 * `{{id}}`-style substitution; an unknown token is left in the line untouched.
 *
 * Re-exported rather than reimplemented: `scan.command` renders through the same
 * grammar, and one address is what keeps the form's warning and the runner's
 * behaviour from drifting apart. Beside the AI's `promptTemplate.renderTemplate`,
 * which follows the same policy for its own typed vars.
 */
export const substituteCommand = substituteTemplate;

/**
 * Whether Run Tests has anything to run with: the project command, or one
 * service's test case command. A tracker whose test cases all run as services
 * needs no project command.
 */
export function testsConfigured(tests: TestsSettings | undefined): boolean {
	return (
		testsCommand(tests) !== undefined ||
		(tests?.services ?? []).some((service) => service.e2e?.testCommand !== undefined)
	);
}

/** The configured command, or `undefined` when the feature is unconfigured. */
export function testsCommand(tests: TestsSettings | undefined): string | undefined {
	return usableText(tests?.command);
}

/** The workspace-relative working directory, or `undefined` for the root. */
export function testsCwd(tests: TestsSettings | undefined): string | undefined {
	const cwd = tests?.cwd === undefined ? undefined : normalizeRelativePath(tests.cwd);
	return cwd !== undefined && cwd.length > 0 ? cwd : undefined;
}

/**
 * The workspace-relative folder runs are filed under — the configured one, or
 * the default. Never `undefined`: every run is recorded somewhere. Reading is
 * forgiving, so a hand-edited value the validator would refuse (one inside the
 * tracker, when `trackerFolder` is given) falls back to the default rather
 * than filing `TC-…` folders where the scanner looks for tickets.
 */
export function testsResultsFolder(tests: TestsSettings | undefined, trackerFolder?: string): string {
	const folder = tests?.resultsFolder === undefined ? '' : normalizeRelativePath(tests.resultsFolder);
	if (folder.length === 0 || validateResultsFolder(folder, trackerFolder) !== undefined) {
		return DEFAULT_TEST_RESULTS_FOLDER;
	}
	return folder;
}

/** The evidence pattern, normalised, or `undefined` when none is configured. */
export function testsEvidence(tests: TestsSettings | undefined): string | undefined {
	const pattern = tests?.evidence === undefined ? undefined : normalizeRelativePath(tests.evidence);
	return pattern !== undefined && pattern.length > 0 ? pattern : undefined;
}

/** The evidence command, or `undefined` when Open should reveal the file instead. */
export function testsEvidenceCommand(tests: TestsSettings | undefined): string | undefined {
	return usableText(tests?.evidenceCommand);
}

/** Where the trace viewer takes screenshots from — the configured source, or `auto`. */
export function testsTraceFrames(tests: TestsSettings | undefined): TraceFrameSource {
	return tests?.traceFrames ?? DEFAULT_TRACE_FRAME_SOURCE;
}

/** How many test commands run at once. Never zero. */
export function testsConcurrency(tests: TestsSettings | undefined): number {
	return tests?.concurrency ?? DEFAULT_TEST_CONCURRENCY;
}

/**
 * How long a run may say nothing before it is stopped, in milliseconds.
 *
 * The single address for the seconds → milliseconds conversion, so no caller
 * has to remember which unit it is holding.
 */
export function testsIdleTimeoutMs(tests: TestsSettings | undefined): number {
	return (tests?.idleTimeout ?? DEFAULT_TEST_IDLE_SECONDS) * 1000;
}

/** Characters Windows rejects in a path; same rule as `validateTrackerFolder`. */
const INVALID_PATH_CHARS = /[*?"<>|]/;
/** The same set minus the glob's own `*` and `?`. */
const INVALID_PATTERN_CHARS = /["<>|]/;

/**
 * Validates the normalized form, the `validateComposePath` order — on the raw
 * string a backslash path like `..\shared\web` is one '/'-segment and would
 * sail past the '..' check. Normalizes exactly once, and an empty value is
 * fine: it means the workspace root, the same way an empty override row is
 * dropped on save.
 */
function validateCwdPath(value: string): string | undefined {
	const folder = normalizeRelativePath(value);
	if (folder.length === 0) {
		return undefined;
	}
	if (folder.startsWith('/') || /^[a-zA-Z]:/.test(folder)) {
		return 'Use a working directory relative to the workspace, not an absolute one.';
	}
	if (folder.split('/').includes('..')) {
		return 'The working directory must stay inside the workspace.';
	}
	if (INVALID_PATH_CHARS.test(folder)) {
		return 'The working directory contains characters that are not allowed in a path.';
	}
	return undefined;
}

/**
 * The cwd rules, plus the one that keeps runs out of the tracker: the folder
 * may neither be the tracker nor sit inside it. Compared segment-wise on the
 * normalized forms, so `.tracker/results` is refused and `.tracker-results`
 * is not.
 */
function validateResultsFolder(value: string, trackerFolder: string | undefined): string | undefined {
	const folder = normalizeRelativePath(value);
	if (folder.length === 0) {
		return undefined;
	}
	const error = validateCwdPath(folder);
	if (error) {
		return error.replace('working directory', 'results folder');
	}
	const tracker = trackerFolder === undefined ? undefined : normalizeRelativePath(trackerFolder);
	if (tracker !== undefined && tracker.length > 0 && (folder === tracker || folder.startsWith(`${tracker}/`))) {
		return 'The test results folder must not be inside the tracker folder.';
	}
	return undefined;
}

/** The cwd rules, minus the refusal of `*` and `?` — those are the glob's. */
function validateEvidencePattern(value: string): string | undefined {
	const pattern = normalizeRelativePath(value);
	if (pattern.length === 0) {
		return undefined;
	}
	if (pattern.startsWith('/') || /^[a-zA-Z]:/.test(pattern)) {
		return 'Use an evidence pattern relative to the working directory, not an absolute one.';
	}
	if (pattern.split('/').includes('..')) {
		return 'The evidence pattern must stay inside the workspace.';
	}
	if (INVALID_PATTERN_CHARS.test(pattern)) {
		return 'The evidence pattern contains characters that are not allowed in a path.';
	}
	return undefined;
}

/** A trimmed non-empty string, or `undefined`. */
function usableText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** `{ command: 'x' }` for a usable string, `{}` otherwise, so it spreads into a literal. */
function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/**
 * Trimmed, forward-slashed, and only kept when it stays inside the workspace —
 * an absolute or `..`-escaping value from a hand-edited (or pulled) file is
 * dropped so the workspace root applies, never resolved against it.
 */
function optionalPath<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const folder = normalizeRelativePath(value);
	if (folder.length === 0 || validateCwdPath(folder) !== undefined) {
		return {};
	}
	return { [key]: folder } as Record<K, string>;
}

/** The same, under the pattern's rules. */
function optionalEvidencePattern<K extends string>(
	key: K,
	value: unknown
): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const pattern = normalizeRelativePath(value);
	if (pattern.length === 0 || validateEvidencePattern(pattern) !== undefined) {
		return {};
	}
	return { [key]: pattern } as Record<K, string>;
}

function optionalServices(value: unknown): { services?: TestService[] } {
	const services = parseTestServices(value);
	return services ? { services } : {};
}

/** The project coverage file, relative to `cwd`, or `undefined`. */
export function testsCoverage(tests: TestsSettings | undefined): string | undefined {
	const file = tests?.coverage === undefined ? undefined : normalizeRelativePath(tests.coverage);
	return file !== undefined && file.length > 0 ? file : undefined;
}

function isTraceFrameSource(value: unknown): value is TraceFrameSource {
	return typeof value === 'string' && (TRACE_FRAME_SOURCES as readonly string[]).includes(value);
}

/**
 * An unknown value is dropped, and so is `auto`: it is what an absent field
 * means, and writing it would change `bfast.json` for a workspace that only
 * opened the form.
 */
function optionalTraceFrames(value: unknown): { traceFrames?: TraceFrameSource } {
	return isTraceFrameSource(value) && value !== DEFAULT_TRACE_FRAME_SOURCE ? { traceFrames: value } : {};
}

/**
 * Reading is forgiving — an out-of-range value is dropped so a hand-edited file
 * still loads — while `validateTestsSettings` refuses the same value on the way
 * out, the house rule everywhere else in the tracker.
 */
function optionalConcurrency(value: unknown): { concurrency?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_TEST_CONCURRENCY && value <= MAX_TEST_CONCURRENCY
		? { concurrency: value }
		: {};
}

/** Same rule, in seconds; the floor keeps the window wider than any output gap. */
function optionalIdleTimeout(value: unknown): { idleTimeout?: number } {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return {};
	}
	return value >= MIN_TEST_IDLE_SECONDS && value <= MAX_TEST_IDLE_SECONDS
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
