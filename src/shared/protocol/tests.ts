// The board's Tests tab: the report, runs, output, evidence and traces.
//
// One file per webview concern, joined in `index.ts`. See the note there.

// `testReport.ts` is Node-free for the same reason `scanReport.ts` is: the
// runner that produces these events imports `fs`, and even an `import type`
// from it would fail the webview type-check.
import type {
	TestBatchProgress,
	TestBatchSnapshot,
	TestReport,
	TestServiceOption
} from '../../testing/testReport';
import type { TestRunRecord } from '../../data/types';
// Node-free too, and bundled into the board for its pure helpers.
import type { TraceReport } from '../playwrightTrace';

/** What this part of the webview sends to the extension host. */
export type TestsToHost =
	/**
	 * The board's Tests tab.
	 *
	 * `id` is always the board's ticket, so a reply that lands after the board
	 * moved on is dropped — the `requestId` idiom, keyed by ticket. The report
	 * is tiered: the first paint carries each test case's latest run only, plus
	 * the board's subtree as structure; a test case's own board asks for its
	 * earlier runs as the report lands, and a run's output when it is shown.
	 */
	| { type: 'testsReport'; id: string }
	| { type: 'testsRuns'; id: string; testCase: string }
	| { type: 'testsOutput'; id: string; testCase: string; run: string }
	| { type: 'testsRun'; id: string }
	/** `root` is the batch the tab is following; absent while Run is still starting. */
	| { type: 'testsCancel'; id: string; root?: string }
	/**
	 * The bytes of one video, when the inline player could not load it through
	 * the editor's resource loader (which happens over some remote connections).
	 * Base64, the `insertImage` convention in the other direction; the host caps
	 * the size at what it would have copied in the first place. `convert` asks
	 * for the file re-encoded as VP8 WebM first, when the editor has no decoder
	 * for the recording's own codec (the last route of the inline player).
	 */
	| { type: 'testsMedia'; id: string; testCase: string; run: string; file: string; convert?: boolean }
	/**
	 * Open one evidence file, or reveal the run folder when `file` is absent.
	 * Both names came from disk via the report; the host checks each is one
	 * BFAST would have written and that the path resolves inside the ticket's
	 * results folder before it touches anything — the `openScanIssue` posture.
	 */
	| { type: 'openEvidence'; id: string; testCase: string; run: string; file?: string }
	/**
	 * A `.zip` among a run's files: read it as a Playwright trace. The host
	 * checks the names as `openEvidence` does, confirms the archive is a trace
	 * and answers with the report — or with why not, `notATrace` when the zip
	 * is something else and the row should fall back to Open / Reveal.
	 */
	| { type: 'testsTrace'; id: string; testCase: string; run: string; file: string }
	/**
	 * One screencast frame of that trace, by the name the report listed; the
	 * host serves only names it listed, as base64 (the `testsMedia` route).
	 */
	| { type: 'testsTraceFrame'; id: string; testCase: string; run: string; file: string; frame: string }
	/**
	 * Open the trace in Playwright's own viewer: `tests.evidenceCommand` when
	 * set, else the Playwright installed in the workspace.
	 */
	| { type: 'openTraceViewer'; id: string; testCase: string; run: string; file: string }
	/** A source location the trace named — open it in an editor, mapped into the workspace when it is not there. */
	| { type: 'openTraceSource'; id: string; file: string; line: number; column?: number }
	/**
	 * Assign the board's test case to a service, or clear it with `null`. A
	 * service id, never a command: the host checks it against `tests.services`.
	 */
	| { type: 'testsSetService'; id: string; service: string | null };

/** What the extension host sends back. */
export type HostToTests =
	/**
	 * The Tests tab's first paint. `evidenceBases` is each test case's folder in
	 * the **results store** — outside the tracker — as a uri the webview may
	 * load, with a trailing slash: the `assetBase` rule, per test case, since a
	 * story's tab shows other tickets' evidence. `running` is the root of the
	 * batch the board's test cases are in, when one is live, and `batch` where
	 * that batch has got to, for a tab that opened mid-run. The report's `tree`
	 * is the board's subtree, structure only (`TestReportNode`); its runs ride
	 * on the flat `testCases`.
	 */
	| {
			type: 'testsReport';
			id: string;
			report: TestReport;
			evidenceBases: Record<string, string>;
			configured: boolean;
			/** `tests.evidence` is set, so the concurrency warning has something to warn about. */
			evidenceConfigured: boolean;
			/** `tests.evidenceCommand` is set; Open on a file the board cannot show runs it rather than revealing. */
			canOpenEvidence: boolean;
			/** What "Open in Playwright Trace Viewer" will do: the command, the workspace's Playwright, or say neither is there. */
			traceViewer: 'command' | 'playwright' | 'none';
			concurrency: number;
			/** `tests.services`, for a test case board's picker. */
			services: TestServiceOption[];
			running?: string;
			batch?: TestBatchSnapshot;
	  }
	| { type: 'testsRuns'; id: string; testCase: string; runs: TestRunRecord[]; total: number }
	| {
			type: 'testsOutput';
			id: string;
			testCase: string;
			run: string;
			text: string;
			truncated: boolean;
	  }
	/**
	 * One event of a batch the board follows — its own ticket's, or one a parent
	 * started whose scope reaches this board's test cases. `id` is the batch's
	 * root; the event is the runner's own union, so the tab reads what the
	 * output channel reads.
	 */
	| { type: 'testsProgress'; id: string; event: TestBatchProgress }
	| { type: 'testsError'; id: string; message: string }
	/** The reply: standard base64 and a mime, or why not; `converted` echoes the request's `convert`. */
	| {
			type: 'testsMedia';
			id: string;
			testCase: string;
			run: string;
			file: string;
			converted?: boolean;
			data?: string;
			mime?: string;
			error?: string;
	  }
	/** The trace's report, or why not — `notATrace` when the zip is not one and the row should fall back. */
	| {
			type: 'testsTrace';
			id: string;
			testCase: string;
			run: string;
			file: string;
			trace?: TraceReport;
			error?: string;
			notATrace?: boolean;
	  }
	/** One screencast frame: standard base64 and a mime, or why not. */
	| {
			type: 'testsTraceFrame';
			id: string;
			testCase: string;
			run: string;
			file: string;
			frame: string;
			data?: string;
			mime?: string;
			error?: string;
	  };
