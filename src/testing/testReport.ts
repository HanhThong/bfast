// What a test run reports, and the pure helpers that render it.
//
// **This module is bundled into the webview.** It carries no `vscode` import,
// no `node:` import and no import of `testRunner.ts` — the Tests tab renders
// these types, `shared/protocol/` carries them across the bridge, and the
// runner (which imports `fs/promises`) must never be dragged along: the webview
// tsconfig has `types: []`, so even an `import type` from the runner fails
// `npm run typecheck:web`. The `scanReport.ts` rule, applied to Run Tests.
//
// The strings in here are the spec: `testRunComment` writes the sentence a
// status change carries when a run moved the ticket — the outcome table in
// docs/tests/README.md pins it — and `summarySentence` the message every
// surface ends a batch with.

import type { TestRunFile, TestRunOutcome, TestRunRecord, TicketStatus, TicketSummary, TicketType } from '../data/types';

export type TestOutcome = 'passed' | 'failed' | 'timeout' | 'cancelled' | 'skipped' | 'error';

export interface TestCaseResult {
	ticket: TicketSummary;
	outcome: TestOutcome;
	exitCode?: number | null;
	/**
	 * For the log, never history: why an `error` outcome could not be run or
	 * recorded, or why a recorded run's evidence could not be.
	 */
	message?: string;
	/** The run folder written for this result, when one was. */
	run?: TestRunRecord;
	startedAt?: string;
}

/** Everything the runner says while a batch is going. */
export type TestRunProgress =
	/** Once, after the scope is read from disk: every test case that will run, in order. */
	| { kind: 'scope'; testCases: TicketSummary[] }
	/** One command spawned. `line` is the rendered command. */
	| { kind: 'started'; ticket: TicketSummary; line: string; startedAt: string }
	/**
	 * A chunk of a command's output, as it arrived — not line-oriented. `testCase`
	 * is absent for a line of the flow's own (a warning at batch start).
	 */
	| { kind: 'output'; testCase?: string; text: string }
	| { kind: 'result'; result: TestCaseResult; done: number; total: number };

export interface TestRunSummary {
	results: TestCaseResult[];
	passed: number;
	/** `failed` + `timeout` — a hanging test is a failing test. */
	failed: number;
	/** Results that could not be recorded on their ticket. */
	errors: number;
	/** True only when the user cancelled; an abort does not set it. */
	cancelled: boolean;
	/** Set when the batch stopped early for a reason that is not a red test. */
	abortedWith?: { code: 'not-found' | 'bad-cwd' | 'spawn-failed'; message: string };
}

/**
 * What a batch emits: the runner's own events, then exactly one `done`.
 * `summary` is absent when the runner threw rather than returned — a
 * programming error, reported so a surface showing Stop can put Run back.
 */
export type TestBatchProgress =
	| TestRunProgress
	| { kind: 'done'; message: string; summary?: TestRunSummary };

/** A test case on the Tests tab, with its latest run. */
export interface TestReportCase {
	id: string;
	key: string;
	title: string;
	status: TicketStatus;
	warning?: string;
	latest?: TestRunRecord;
	/** How many run folders there are, so the tab can offer the earlier ones. */
	runCount: number;
}

/**
 * One row of the hierarchy a parent's tab draws: the board's stories, their
 * criteria, and the test cases under each. **Structure only** — a test case's
 * runs live on `TestReport.testCases`, which is what a batch's `result`
 * patches, and a leaf here is looked up there by id. A `latest` on the leaf
 * too would be a second place for it to go stale.
 */
export interface TestReportNode {
	id: string;
	key: string;
	title: string;
	type: TicketType;
	status: TicketStatus;
	warning?: string;
	children: TestReportNode[];
}

/** The Tests tab's first paint for one ticket. */
export interface TestReport {
	ticket: { id: string; key: string; title: string; type: TicketType };
	/** The subtree's test cases in tree order — the scope Run Tests would use. */
	testCases: TestReportCase[];
	/**
	 * The board ticket's children, recursively — the board itself is the
	 * header, not a row. `[]` for a test case, which has no children.
	 */
	tree: TestReportNode[];
	/** Criteria under the ticket with no test case, so an empty tab can say why. */
	acsWithoutTestCase: number;
}

/**
 * Where a test case in a live batch got to. The runner's outcomes plus the two
 * states before one: `waiting` is real and worth a row — with a concurrency of
 * one and eight test cases, seven have not started, and a row that is simply
 * absent reads as one that was dropped.
 */
export type TestLaneStatus = 'waiting' | 'running' | TestOutcome;

export interface TestLane {
	status: TestLaneStatus;
	/** The rendered command, once it has started. */
	line?: string;
	startedAt?: string;
	/** A result's message, when it had one. */
	note?: string;
}

/** One line of a batch's log, whole (the runner emits chunks; a surface joins them). */
export interface TestLogLine {
	testCase?: string;
	text: string;
}

/** A batch as a surface that subscribed late needs to see it. */
export interface TestBatchSnapshot {
	root: string;
	lanes: Record<string, TestLane>;
	log: TestLogLine[];
}

/** Most a run's `output.log` holds — the tail of a longer stream. */
export const MAX_RUN_LOG_CHARS = 64_000;
/** Most files one run copies; the rest are named in `warnings`. */
export const MAX_EVIDENCE_FILES = 100;
/** A file over this is named in `warnings` and not copied. */
export const MAX_EVIDENCE_FILE_BYTES = 50 * 1024 * 1024;
/** How deep the evidence walk goes below the pattern's literal prefix. */
export const MAX_EVIDENCE_DEPTH = 8;
/** Most of `output.log` the board is handed at once. */
export const MAX_INLINE_OUTPUT_CHARS = 64_000;
/** A match older than the run's start by more than this is not this run's. */
export const EVIDENCE_MTIME_TOLERANCE_MS = 2_000;

/** The end-of-batch sentence every surface shows. Severity is the caller's, from `abortedWith`. */
export function summarySentence(ticketId: string, summary: TestRunSummary): string {
	if (summary.abortedWith) {
		// A mid-batch abort may follow finished runs whose statuses are already
		// on disk and stay there — the message must not read as "nothing ran".
		const ran = summary.passed + summary.failed;
		return (
			summary.abortedWith.message +
			(ran > 0
				? ` ${summary.passed} passed and ${summary.failed} failed before it stopped; those statuses stay.`
				: '')
		);
	}
	if (summary.results.length === 0) {
		return `${ticketId} has no test cases.`;
	}
	const parts = [`Tests: ${summary.passed} passed, ${summary.failed} failed.`];
	if (summary.errors > 0) {
		parts.push(`${summary.errors} could not be run or recorded.`);
	}
	if (summary.cancelled) {
		parts.push('Cancelled the rest.');
	}
	return parts.join(' ');
}

export interface TestRunCommentInput {
	line: string;
	outcome: 'passed' | 'failed' | 'timeout';
	exitCode?: number | null;
	/** The idle window, for the `timeout` sentence. */
	idleSeconds: number;
	/** The folder written, when it was. */
	run?: TestRunRecord;
	/** Why it was not. */
	recordError?: string;
}

/**
 * The comment a status change carries when a test run moved the ticket — the
 * outcome table's *History entry* column, verbatim. It names the run, so
 * `git log` on the tracker can point at the folder in the results store; it
 * does not repeat what that folder already records (files, warnings, output).
 * A run that changed nothing writes no history at all — the run folder is its
 * record — so this is only ever the provenance of a `done` or a `blocked`.
 */
export function testRunComment(input: TestRunCommentInput): string {
	const run = input.run ? `Test run \`${input.run.id}\`` : 'Test run';
	const verdict =
		input.outcome === 'passed'
			? `${run} passed: \`${input.line}\` exited ${input.exitCode ?? 0}.`
			: input.outcome === 'failed'
				? `${run} failed: \`${input.line}\` exited ${input.exitCode ?? 'unknown'}.`
				: `${run} was stopped: \`${input.line}\` produced no output for ${input.idleSeconds}s.`;
	return input.run
		? verdict
		: `${verdict} The run could not be recorded: ${input.recordError ?? 'unknown error'}.`;
}

/**
 * `archive` is a `.zip` — probably a Playwright trace, which the board shows
 * inline once the host has confirmed it (`traceReader.ts` looks inside; the
 * name alone cannot say), and a plain file row otherwise.
 */
export type EvidenceKind = 'video' | 'image' | 'text' | 'archive' | 'other';

const VIDEO = /\.(webm|mp4|ogg|ogv|mov)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const TEXT = /\.(log|txt|json|md|xml|csv|html|htm|yaml|yml)$/i;
const ARCHIVE = /\.zip$/i;

/** What the board does with a file: play it, show it, open it in an editor, read it as a trace, or hand it over. */
export function evidenceKind(name: string): EvidenceKind {
	if (VIDEO.test(name)) {
		return 'video';
	}
	if (IMAGE.test(name)) {
		return 'image';
	}
	if (TEXT.test(name)) {
		return 'text';
	}
	if (ARCHIVE.test(name)) {
		return 'archive';
	}
	return 'other';
}

/**
 * Videos first, then images, then the rest; within a kind, by name with
 * numbers compared as numbers and fewer dotted parts first — so `TC-1.webm`
 * precedes `TC-1.page-2.webm`, where a plain `localeCompare` would put the
 * second tab's recording before the first's.
 */
export function sortEvidenceFiles(files: readonly TestRunFile[]): TestRunFile[] {
	const rank: Record<EvidenceKind, number> = { video: 0, image: 1, text: 2, archive: 3, other: 4 };
	return [...files].sort((a, b) => {
		const byKind = rank[evidenceKind(a.name)] - rank[evidenceKind(b.name)];
		if (byKind !== 0) {
			return byKind;
		}
		const byParts = a.name.split('.').length - b.name.split('.').length;
		if (byParts !== 0) {
			return byParts;
		}
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});
}

/** `TC-1.page-2.webm` → `tab 2`, `TC-1.retry-1.zip` → `retry 1`; nothing for the plain name. */
export function evidenceCaption(name: string): string | undefined {
	const page = /\.page-(\d+)\./.exec(name);
	const retry = /\.retry-(\d+)\./.exec(name);
	const parts = [page ? `tab ${page[1]}` : undefined, retry ? `retry ${retry[1]}` : undefined];
	const caption = parts.filter((part): part is string => part !== undefined).join(', ');
	return caption === '' ? undefined : caption;
}

export function outcomeLabel(outcome: TestRunOutcome | TestLaneStatus): string {
	switch (outcome) {
		case 'passed':
			return 'Passed';
		case 'failed':
			return 'Failed';
		case 'timeout':
			return 'Stopped: no output';
		case 'unknown':
			return 'Unknown';
		case 'cancelled':
			return 'Cancelled';
		case 'skipped':
			return 'Skipped';
		case 'error':
			return 'Could not run';
		case 'waiting':
			return 'Waiting';
		case 'running':
			return 'Running';
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `1m 12s`, `8s`, `0.4s`; undefined when either end is missing or unparsable. */
export function formatDuration(startedAt?: string, finishedAt?: string): string | undefined {
	if (!startedAt || !finishedAt) {
		return undefined;
	}
	const ms = Date.parse(finishedAt) - Date.parse(startedAt);
	if (Number.isNaN(ms) || ms < 0) {
		return undefined;
	}
	if (ms < 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** What a test case with no recorded run says, wherever the tab names it. */
export const NEVER_RUN_LABEL = 'Not run yet';

/** A red run: the two verdicts that turn a test case `blocked`. `unknown` is neither red nor green. */
export function isRed(run: TestRunRecord | undefined): boolean {
	return run !== undefined && (run.outcome === 'failed' || run.outcome === 'timeout');
}

export interface CaseAggregate {
	total: number;
	passed: number;
	failed: number;
	notRun: number;
}

/**
 * The test cases under one hierarchy row, by their latest run — the count a
 * story's or a criterion's row carries. Reads `latest` off the flat list, so
 * it follows a batch as each `result` lands there.
 */
export function caseAggregate(
	node: TestReportNode,
	byId: ReadonlyMap<string, TestReportCase>
): CaseAggregate {
	const aggregate: CaseAggregate = { total: 0, passed: 0, failed: 0, notRun: 0 };
	const walk = (current: TestReportNode): void => {
		if (current.type === 'testcase') {
			aggregate.total++;
			const latest = byId.get(current.id)?.latest;
			if (!latest) {
				aggregate.notRun++;
			} else if (latest.outcome === 'passed') {
				aggregate.passed++;
			} else if (isRed(latest)) {
				aggregate.failed++;
			}
		}
		for (const child of current.children) {
			walk(child);
		}
	};
	walk(node);
	return aggregate;
}

/** `2 of 3 passed · 1 not run yet`; `no test cases` for a row with none below it. */
export function aggregateSentence(aggregate: CaseAggregate): string {
	if (aggregate.total === 0) {
		return 'no test cases';
	}
	const parts = [`${aggregate.passed} of ${aggregate.total} passed`];
	if (aggregate.failed > 0) {
		parts.push(`${aggregate.failed} failed`);
	}
	if (aggregate.notRun > 0) {
		parts.push(`${aggregate.notRun} ${NEVER_RUN_LABEL.toLowerCase()}`);
	}
	return parts.join(' · ');
}

/**
 * The test case a parent's tab shows before anything is clicked: the first in
 * tree order. One address, so the rule can change without touching the view.
 */
export function defaultTestCase(report: TestReport): string | undefined {
	return report.testCases[0]?.id;
}

/**
 * A test case's history as its board lists it: the latest run the report
 * carried and the runs fetched for it, each once, newest first by the store's
 * own rule — the folder name is the start time, so a descending sort by name
 * is a sort by time, and a run that landed between the report and the fetch
 * still comes out on top.
 */
export function runHistory(
	latest: TestRunRecord | undefined,
	fetched: readonly TestRunRecord[] | undefined
): TestRunRecord[] {
	const seen = new Set<string>();
	const history: TestRunRecord[] = [];
	for (const run of [...(latest ? [latest] : []), ...(fetched ?? [])]) {
		if (!seen.has(run.id)) {
			seen.add(run.id);
			history.push(run);
		}
	}
	return history.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

/**
 * One service a test case may be assigned to, as the board's picker offers it.
 * `runnable` is false when the service has no e2e test case command — offered
 * anyway, and said, since a run would refuse it. docs/tests/services.md.
 */
export interface TestServiceOption {
	id: string;
	label: string;
	runnable: boolean;
}
