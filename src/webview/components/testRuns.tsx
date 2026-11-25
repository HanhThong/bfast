// The board's Tests tab: a ticket's test runs, their evidence, and the batch
// that is running them — in two columns.
//
// A parent's board (an epic, a story, a criterion) draws its hierarchy on the
// left — stories, their criteria, the test cases under each, every test case
// wearing its latest verdict or `Not run yet` — and the selected test case's
// latest run on the right, and only the latest: its own board has the rest. A
// test case's board draws its run history on the left, newest first, and the
// selected run on the right. Which row is selected is the app's (`TestsState`),
// not this pane's, since the pane unmounts on a tab switch; `undefined` there
// is the default, resolved here at render time, so a stale id falls back.
//
// Everything here is data the host handed over — the file names came from
// disk, and the tracker is pulled from git — so a name becomes a url only
// through `evidenceUrl`, which refuses what BFAST would not have written
// itself, and an Open button only when the host can act on it.

import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import type { TestRunFile, TestRunRecord, TicketDetail } from '../../data/types';
import { evidenceUrl } from '../../shared/evidencePath';
import {
	describeMediaFailure,
	FORMAT_ADVICE,
	OPEN_IN_EDITOR_ADVICE,
	PROBE_DECODERS,
	PROBE_TYPES,
	probeSentence,
	probeVerdict,
	REVEAL_ADVICE,
	type MediaFailure,
	type PlayerProbe
} from '../../shared/mediaError';
import { canDecodeHere, WebCodecsPlayer } from './videoPlayer';
import { TraceFigure } from './traceViewer';
import {
	aggregateSentence,
	caseAggregate,
	defaultTestCase,
	evidenceCaption,
	evidenceKind,
	formatBytes,
	formatDuration,
	NEVER_RUN_LABEL,
	outcomeLabel,
	runHistory,
	sortEvidenceFiles,
	type TestLane,
	type TestLaneStatus,
	type TestReport,
	type TestReportCase,
	type TestReportNode,
	type TestServiceOption
} from '../../testing/testReport';
import type { TestsState } from '../app';
import { STATUS_LABEL, TYPE_BADGE } from './labels';
import { errorMessage } from '../../platform/errors';

/** The generate tab's marks and colours, one per lane status. */
const LANE_MARK: Record<TestLaneStatus, { mark: string; className: string }> = {
	waiting: { mark: '○', className: 'is-waiting' },
	running: { mark: '◍', className: 'is-running' },
	passed: { mark: '●', className: 'is-done' },
	failed: { mark: '⚠', className: 'is-failed' },
	timeout: { mark: '⚠', className: 'is-failed' },
	error: { mark: '⚠', className: 'is-failed' },
	cancelled: { mark: '○', className: 'is-waiting' },
	skipped: { mark: '○', className: 'is-waiting' }
};

export const MAX_TEST_LOG_LINES = 500;

/**
 * Appended to a video's media key for the host's VP8 re-encoding of it, so the
 * file's own bytes and the converted ones are two entries, never one
 * overwriting the other.
 */
export const CONVERTED_MEDIA_SUFFIX = '#vp8';

export interface TestsPaneProps {
	ticket: TicketDetail;
	state: TestsState;
	onRun: () => void;
	onCancel: () => void;
	onLoadRuns: (testCase: string) => void;
	onLoadOutput: (testCase: string, run: string) => void;
	onLoadMedia: (testCase: string, run: string, file: string, convert?: boolean) => void;
	onLoadTrace: (testCase: string, run: string, file: string) => void;
	onLoadTraceFrame: (testCase: string, run: string, file: string, frame: string) => void;
	onOpenTraceViewer: (testCase: string, run: string, file: string) => void;
	onOpenTraceSource: (file: string, line: number, column?: number) => void;
	onOpenEvidence: (testCase: string, run: string, file?: string) => void;
	onOpenTicket: (id: string) => void;
	onOpenSettings: () => void;
	/** A test case board's service picker: a service id, or `null` for the project command. */
	onSetService: (service: string | null) => void;
	/** A test case row on a parent's board. */
	onSelectTestCase: (id: string) => void;
	/** A run on a test case's board; `undefined` follows the latest. */
	onSelectRun: (id: string | undefined) => void;
}

/** What a run's detail needs, whichever board shows it. */
interface RunCallbacks {
	onLoadOutput: (testCase: string, run: string) => void;
	onLoadMedia: (testCase: string, run: string, file: string, convert?: boolean) => void;
	onLoadTrace: (testCase: string, run: string, file: string) => void;
	onLoadTraceFrame: (testCase: string, run: string, file: string, frame: string) => void;
	onOpenTraceViewer: (testCase: string, run: string, file: string) => void;
	onOpenTraceSource: (file: string, line: number, column?: number) => void;
	onOpenEvidence: (testCase: string, run: string, file?: string) => void;
}

export function TestsPane({
	ticket,
	state,
	onRun,
	onCancel,
	onLoadRuns,
	onLoadOutput,
	onLoadMedia,
	onLoadTrace,
	onLoadTraceFrame,
	onOpenTraceViewer,
	onOpenTraceSource,
	onOpenEvidence,
	onOpenTicket,
	onOpenSettings,
	onSetService,
	onSelectTestCase,
	onSelectRun
}: TestsPaneProps) {
	const report = state.report;
	const live = state.running !== undefined || state.starting;
	const own = state.running === undefined || state.running === ticket.id;
	// Only the lanes this tab shows: a parent's batch may reach test cases the
	// board does not list, and the status line must count what is on screen.
	const shownLanes = report
		? report.testCases.filter((testCase) => testCase.id in state.lanes).map((testCase) => state.lanes[testCase.id])
		: [];
	const done = shownLanes.filter((lane) => lane.status !== 'waiting' && lane.status !== 'running').length;
	const passed = shownLanes.filter((lane) => lane.status === 'passed').length;

	const status = live
		? state.running === undefined
			? 'Starting…'
			: `Running · ${done} of ${shownLanes.length} done · ${passed} passed` +
				(own ? '' : ` · started from ${state.running}`)
		: state.done ?? (state.loading ? 'Reading test runs…' : undefined);

	// A test case's board lists its whole history, so the earlier runs are asked
	// for as the report lands rather than behind a button. `runs` is reset by
	// every report and dropped for a test case by its `result`, so this fires
	// again exactly when the history may have grown. Primitive deps: the
	// objects are rebuilt on every message.
	const tcBoard = report?.ticket.type === 'testcase';
	const ownCase = tcBoard ? report.testCases[0] : undefined;
	const ownId = ownCase?.id;
	const ownRunCount = ownCase?.runCount ?? 0;
	const fetchedMissing = ownId === undefined || state.runs[ownId] === undefined;
	useEffect(() => {
		if (ownId !== undefined && ownRunCount > 1 && fetchedMissing) {
			onLoadRuns(ownId);
		}
	}, [ownId, ownRunCount, fetchedMissing, onLoadRuns]);

	const byId = useMemo(
		() => new Map((report?.testCases ?? []).map((testCase) => [testCase.id, testCase] as const)),
		[report]
	);

	const runCallbacks: RunCallbacks = {
		onLoadOutput,
		onLoadMedia,
		onLoadTrace,
		onLoadTraceFrame,
		onOpenTraceViewer,
		onOpenTraceSource,
		onOpenEvidence
	};

	return (
		<div className="tests">
			<div className="test-actions">
				{live ? (
					<button
						type="button"
						className="button danger"
						title={own ? undefined : `Stops the whole run started from ${state.running}`}
						onClick={onCancel}
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						className="button"
						disabled={!state.configured || !report || report.testCases.length === 0}
						title={
							!state.configured
								? 'Set a test command in the BFAST settings first'
								: report && report.testCases.length === 0
									? 'Nothing to run: no test cases under this ticket'
									: undefined
						}
						onClick={onRun}
					>
						Run tests
					</button>
				)}
				{status && <span className="generate-status">{status}</span>}
				{ticket.type === 'testcase' && (
					<ServicePicker
						current={ticket.service}
						services={state.services}
						disabled={live}
						onChange={onSetService}
						onOpenSettings={onOpenSettings}
					/>
				)}
			</div>

			{state.error && <p className="detail-error">{state.error}</p>}

			{!state.configured && report && (
				<p className="detail-notice">
					Set a test command in the BFAST settings before running tests. Recorded runs still show
					here.{' '}
					<button type="button" className="scan-issue-location" onClick={onOpenSettings}>
						Open settings
					</button>
				</p>
			)}

			{state.configured && state.evidenceConfigured && state.concurrency > 1 && (
				<p className="settings-hint">
					⚠ Tests at once is {state.concurrency}. A test tool that clears its output folder when a
					run starts will lose evidence when two runs overlap.
				</p>
			)}

			{/* Full width, above the columns: the log is the batch's, not one test case's. */}
			{(live || state.log.length > 0) && report && <BatchLog state={state} />}

			{!report ? (
				<p className="empty">{state.loading ? 'Reading test runs…' : 'No test report yet.'}</p>
			) : tcBoard ? (
				<TestCaseBoard report={report} state={state} onSelectRun={onSelectRun} {...runCallbacks} />
			) : (
				<ParentBoard
					report={report}
					byId={byId}
					state={state}
					onSelectTestCase={onSelectTestCase}
					onOpenTicket={onOpenTicket}
					{...runCallbacks}
				/>
			)}
		</div>
	);
}

/** Why a parent's tab has nothing to run — with the criteria that have no test case counted. */
function noTestCases(report: TestReport): string {
	const count = report.acsWithoutTestCase;
	return (
		'No test cases under this ticket yet' +
		(count > 0 ? ` — ${count} acceptance ${count === 1 ? 'criterion has' : 'criteria have'} none.` : '.')
	);
}

/**
 * A parent's board: the hierarchy on the left, the selected test case's latest
 * run on the right. The tree is drawn even when nothing under it can run — a
 * criterion with no test case is exactly what the row's warning is for.
 */
function ParentBoard({
	report,
	byId,
	state,
	onSelectTestCase,
	onOpenTicket,
	...runCallbacks
}: RunCallbacks & {
	report: TestReport;
	byId: ReadonlyMap<string, TestReportCase>;
	state: TestsState;
	onSelectTestCase: (id: string) => void;
	onOpenTicket: (id: string) => void;
}) {
	if (report.tree.length === 0) {
		return <p className="empty">{noTestCases(report)}</p>;
	}
	// The pick, when it still exists; the default otherwise.
	const selectedId =
		state.selectedTestCase !== undefined && byId.has(state.selectedTestCase)
			? state.selectedTestCase
			: defaultTestCase(report);
	const selected = selectedId !== undefined ? byId.get(selectedId) : undefined;
	return (
		<>
			{report.testCases.length > 0 && <Summary report={report} />}
			<div className="test-columns">
				<nav className="test-nav" aria-label="Test cases">
					<TestTree
						nodes={report.tree}
						byId={byId}
						state={state}
						selectedId={selectedId}
						onSelectTestCase={onSelectTestCase}
						onOpenTicket={onOpenTicket}
					/>
				</nav>
				<div className="test-detail">
					{selected ? (
						<TestCaseDetail
							key={`${selected.id}/${selected.latest?.id ?? 'none'}`}
							testCase={selected}
							state={state}
							onOpenTicket={onOpenTicket}
							{...runCallbacks}
						/>
					) : (
						<p className="empty">
							{report.testCases.length === 0 ? noTestCases(report) : 'Select a test case on the left.'}
						</p>
					)}
				</div>
			</div>
		</>
	);
}

/**
 * A test case's board: its history on the left, the selected run on the right.
 * Nothing pinned follows the latest, so a run landing mid-batch is what shows.
 */
function TestCaseBoard({
	report,
	state,
	onSelectRun,
	...runCallbacks
}: RunCallbacks & {
	report: TestReport;
	state: TestsState;
	onSelectRun: (id: string | undefined) => void;
}) {
	const testCase = report.testCases[0];
	if (!testCase) {
		return <p className="empty">{noTestCases(report)}</p>;
	}
	const fetched = state.runs[testCase.id];
	const history = runHistory(testCase.latest, fetched?.runs);
	const pinned =
		state.selectedRun !== undefined ? history.find((run) => run.id === state.selectedRun) : undefined;
	const selected = pinned ?? history[0];
	const lane = state.running !== undefined ? state.lanes[testCase.id] : undefined;
	if (!selected && !lane) {
		return <p className="empty">This test case has never been run.</p>;
	}
	return (
		<div className="test-columns">
			<nav className="test-nav" aria-label="Run history">
				<RunHistory
					testCase={testCase}
					history={history}
					fetchedMissing={fetched === undefined}
					lane={lane}
					selectedRunId={selected?.id}
					onSelectRun={onSelectRun}
				/>
			</nav>
			<div className="test-detail">
				{selected ? (
					<RunDetail
						key={`${testCase.id}/${selected.id}`}
						testCase={testCase.id}
						run={selected}
						base={state.evidenceBases[testCase.id]}
						state={state}
						{...runCallbacks}
					/>
				) : (
					<p className="empty">The first run is going; its result lands here.</p>
				)}
			</div>
		</div>
	);
}

/** One line over a parent's tree: how many, how many green, when the newest ran. */
function Summary({ report }: { report: TestReport }) {
	const withRun = report.testCases.filter((testCase) => testCase.latest);
	const passed = withRun.filter((testCase) => testCase.latest?.outcome === 'passed').length;
	const failed = withRun.filter(
		(testCase) => testCase.latest?.outcome === 'failed' || testCase.latest?.outcome === 'timeout'
	).length;
	const newest = withRun
		.map((testCase) => testCase.latest?.startedAt)
		.filter((value): value is string => value !== undefined)
		.sort()
		.pop();
	const count = report.testCases.length;
	const notRun = NEVER_RUN_LABEL.toLowerCase();
	return (
		<p className="test-summary">
			{count} test {count === 1 ? 'case' : 'cases'}
			{withRun.length > 0 ? ` · ${passed} passed · ${failed} failed` : ` · ${notRun}`}
			{withRun.length < count && withRun.length > 0 ? ` · ${count - withRun.length} ${notRun}` : ''}
			{newest ? ` · last run ${formatTime(newest)}` : ''}
			{report.acsWithoutTestCase > 0
				? ` · ${report.acsWithoutTestCase} ${report.acsWithoutTestCase === 1 ? 'criterion' : 'criteria'} without a test case`
				: ''}
		</p>
	);
}

/** The batch's log while one touches this ticket, and after, until the next report. */
function BatchLog({ state }: { state: TestsState }) {
	const ref = useRef<HTMLDivElement>(null);
	const follow = state.running !== undefined || state.starting;
	// Follow the tail while it runs; once it stops, leave the scroll where the
	// user put it — they may be reading a failure while others still stream.
	useEffect(() => {
		if (follow && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [state.log, follow]);
	const several = new Set(state.log.map((line) => line.testCase)).size > 1;
	return (
		<section className="generate-section test-live">
			<h2 className="generate-heading">Log</h2>
			<div className="generate-log" ref={ref} aria-live="polite">
				{state.log.length === 0 ? (
					<p className="generate-idle">Output appears here as the command runs.</p>
				) : (
					state.log.map((line, index) => (
						<p className="generate-log-line" key={index}>
							{several && line.testCase && (
								<span className="generate-log-lane">{line.testCase}</span>
							)}
							{line.text}
						</p>
					))
				)}
			</div>
		</section>
	);
}

/** A recorded run's mark: `unknown` (no readable record) wears the skipped ring. */
function runMark(run: TestRunRecord): { mark: string; className: string } {
	return LANE_MARK[run.outcome === 'unknown' ? 'skipped' : run.outcome];
}

/**
 * What a test case's row and its detail header both say: the lane while the
 * batch runs (a parent's batch may not include this one — then no lane, and
 * the latest run shows through); the latest run once it is over, which a
 * `skipped` or `cancelled` lane would otherwise hide; `Not run yet` when
 * there is neither. One function, so the two surfaces cannot disagree.
 */
function caseMark(
	testCase: TestReportCase,
	state: TestsState
): { mark: string; className: string; label: string; time?: string } {
	const lane = state.running !== undefined ? state.lanes[testCase.id] : undefined;
	if (lane) {
		return { ...LANE_MARK[lane.status], label: lane.note ?? outcomeLabel(lane.status) };
	}
	const latest = testCase.latest;
	if (latest) {
		return {
			...runMark(latest),
			label: outcomeLabel(latest.outcome),
			...(latest.startedAt ? { time: formatTime(latest.startedAt) } : {})
		};
	}
	return { ...LANE_MARK.waiting, label: NEVER_RUN_LABEL };
}

/**
 * The hierarchy under a parent: a story or a criterion is a row with its
 * badge, key, title (a link to its own board) and how its test cases stand;
 * a test case is one button that selects it. Never a button inside a button.
 */
function TestTree({
	nodes,
	byId,
	state,
	selectedId,
	onSelectTestCase,
	onOpenTicket
}: {
	nodes: TestReportNode[];
	byId: ReadonlyMap<string, TestReportCase>;
	state: TestsState;
	selectedId: string | undefined;
	onSelectTestCase: (id: string) => void;
	onOpenTicket: (id: string) => void;
}) {
	return (
		<ul className="test-tree">
			{nodes.map((node) =>
				node.type === 'testcase' ? (
					<TreeCase
						key={node.id}
						node={node}
						testCase={byId.get(node.id)}
						state={state}
						selected={node.id === selectedId}
						onSelect={() => onSelectTestCase(node.id)}
					/>
				) : (
					<li key={node.id} className="test-tree-group">
						<div className="test-tree-row">
							<span className={`type-badge type-${node.type}`}>{TYPE_BADGE[node.type]}</span>
							<span className="test-key">{node.key}</span>
							<button
								type="button"
								className="scan-issue-location test-tree-title"
								title={`Open ${node.id}`}
								onClick={() => onOpenTicket(node.id)}
							>
								{node.title}
							</button>
							<span className="test-tree-count">{aggregateSentence(caseAggregate(node, byId))}</span>
							{node.warning && <span className="test-tree-warning">⚠ {node.warning}</span>}
						</div>
						{node.children.length > 0 && (
							<TestTree
								nodes={node.children}
								byId={byId}
								state={state}
								selectedId={selectedId}
								onSelectTestCase={onSelectTestCase}
								onOpenTicket={onOpenTicket}
							/>
						)}
					</li>
				)
			)}
		</ul>
	);
}

function TreeCase({
	node,
	testCase,
	state,
	selected,
	onSelect
}: {
	node: TestReportNode;
	/** Absent only if the tree and the flat list disagree, which one walk cannot produce. */
	testCase: TestReportCase | undefined;
	state: TestsState;
	selected: boolean;
	onSelect: () => void;
}) {
	const mark = testCase ? caseMark(testCase, state) : undefined;
	return (
		<li>
			<button
				type="button"
				className={`test-tree-case generate-run ${mark?.className ?? ''}`}
				aria-pressed={selected}
				onClick={onSelect}
			>
				<span className="generate-run-mark" aria-hidden="true">
					{mark?.mark ?? ''}
				</span>
				<span className="generate-run-title">
					<span className="test-key">{node.key}</span> {node.title}
				</span>
				{mark && (
					<span className="generate-run-note">
						{mark.label}
						{mark.time ? ` · ${mark.time}` : ''}
					</span>
				)}
			</button>
		</li>
	);
}

/**
 * A test case's runs, newest first, each one button. A running lane sits on
 * top while the batch goes, so the tab says a run is coming before its folder
 * exists. Clicking the newest hands the selection back to "the latest", so the
 * next run that lands shows itself.
 */
function RunHistory({
	testCase,
	history,
	fetchedMissing,
	lane,
	selectedRunId,
	onSelectRun
}: {
	testCase: TestReportCase;
	history: TestRunRecord[];
	fetchedMissing: boolean;
	lane: TestLane | undefined;
	selectedRunId: string | undefined;
	onSelectRun: (id: string | undefined) => void;
}) {
	const more = Math.max(0, testCase.runCount - history.length);
	const liveMark = lane && (lane.status === 'waiting' || lane.status === 'running') ? LANE_MARK[lane.status] : undefined;
	return (
		<ul className="test-history">
			{liveMark && lane && (
				<li className={`test-history-live generate-run ${liveMark.className}`}>
					<span className="generate-run-mark" aria-hidden="true">
						{liveMark.mark}
					</span>
					<span className="generate-run-title">{outcomeLabel(lane.status)}</span>
					{lane.line && <span className="generate-run-note">{lane.line}</span>}
				</li>
			)}
			{history.map((run, index) => {
				const mark = runMark(run);
				const meta = [
					formatDuration(run.startedAt, run.finishedAt),
					run.exitCode !== undefined && run.exitCode !== null ? `exit ${run.exitCode}` : undefined,
					run.author
				].filter((part): part is string => part !== undefined);
				return (
					<li key={run.id}>
						<button
							type="button"
							className={`test-history-run generate-run ${mark.className}`}
							aria-pressed={run.id === selectedRunId}
							onClick={() => onSelectRun(index === 0 ? undefined : run.id)}
						>
							<span className="generate-run-mark" aria-hidden="true">
								{mark.mark}
							</span>
							<span className="generate-run-title">
								{outcomeLabel(run.outcome)}
								{run.startedAt ? ` · ${formatTime(run.startedAt)}` : ''}
							</span>
							{meta.length > 0 && <span className="generate-run-note">{meta.join(' · ')}</span>}
						</button>
					</li>
				);
			})}
			{fetchedMissing && more > 0 && (
				<li className="test-history-more">
					Reading {more} earlier {more === 1 ? 'run' : 'runs'}…
				</li>
			)}
		</ul>
	);
}

/**
 * The right column of a parent's board: which test case this is, how it
 * stands, and its latest run in full — only the latest; its own board has the
 * history, and the line under the run says how much there is.
 */
function TestCaseDetail({
	testCase,
	state,
	onOpenTicket,
	...runCallbacks
}: RunCallbacks & {
	testCase: TestReportCase;
	state: TestsState;
	onOpenTicket: (id: string) => void;
}) {
	const mark = caseMark(testCase, state);
	const latest = testCase.latest;
	const earlier = testCase.runCount - (latest ? 1 : 0);
	return (
		<section className="test-detail-case">
			<div className="test-detail-head">
				<span className={`status-pill status-${testCase.status}`}>{STATUS_LABEL[testCase.status]}</span>
				<span className="test-key">{testCase.key}</span>
				<button
					type="button"
					className="scan-issue-location test-detail-title"
					title={`Open ${testCase.id}`}
					onClick={() => onOpenTicket(testCase.id)}
				>
					{testCase.title}
				</button>
				<span className={`test-run-outcome generate-run ${mark.className}`}>
					<span className="generate-run-mark" aria-hidden="true">
						{mark.mark}
					</span>{' '}
					{mark.label}
				</span>
			</div>
			{testCase.warning && <p className="test-tree-warning">⚠ {testCase.warning}</p>}
			{latest ? (
				<RunDetail
					testCase={testCase.id}
					run={latest}
					base={state.evidenceBases[testCase.id]}
					state={state}
					{...runCallbacks}
				/>
			) : (
				<p className="empty">This test case has never been run.</p>
			)}
			{earlier > 0 && (
				<p className="test-detail-earlier">
					{earlier} earlier {earlier === 1 ? 'run' : 'runs'} ·{' '}
					<button type="button" className="scan-issue-location" onClick={() => onOpenTicket(testCase.id)}>
						Open {testCase.id}&apos;s board
					</button>
				</p>
			)}
		</section>
	);
}

interface RunDetailProps extends RunCallbacks {
	testCase: string;
	run: TestRunRecord;
	base?: string;
	state: TestsState;
}

/** One run in full: its header, then everything under it. */
function RunDetail(props: RunDetailProps) {
	const { run } = props;
	const mark = runMark(run);
	const duration = formatDuration(run.startedAt, run.finishedAt);
	return (
		<section className="test-run">
			<div className="test-run-head">
				<span className={`test-run-outcome generate-run ${mark.className}`}>
					<span className="generate-run-mark" aria-hidden="true">
						{mark.mark}
					</span>{' '}
					{outcomeLabel(run.outcome)}
				</span>
				{run.startedAt && (
					<time className="test-run-time" dateTime={run.startedAt}>
						{formatTime(run.startedAt)}
					</time>
				)}
				{duration && <span className="test-run-meta">{duration}</span>}
				{run.exitCode !== undefined && run.exitCode !== null && (
					<span className="test-run-meta">exit {run.exitCode}</span>
				)}
				{run.author && <span className="test-run-meta">{run.author}</span>}
			</div>
			<RunBody {...props} />
		</section>
	);
}

/**
 * Everything under a run's header: its files, its output, its warnings, its
 * folder. The run shown is the one on screen, so its video preloads its first
 * frame and the player shows the page rather than a black box until Play.
 */
function RunBody({
	testCase,
	run,
	base,
	state,
	onLoadOutput,
	onLoadMedia,
	onLoadTrace,
	onLoadTraceFrame,
	onOpenTraceViewer,
	onOpenTraceSource,
	onOpenEvidence
}: RunDetailProps) {
	return (
		<>
			{run.command && <code className="test-run-command">{run.command}</code>}
			<EvidenceFiles
				testCase={testCase}
				run={run}
				base={base}
				eager
				canOpen={state.canOpenEvidence}
				media={state.media}
				traces={state.traces}
				traceFrames={state.traceFrames}
				traceViewer={state.traceViewer}
				onLoadMedia={onLoadMedia}
				onLoadTrace={onLoadTrace}
				onLoadTraceFrame={onLoadTraceFrame}
				onOpenTraceViewer={onOpenTraceViewer}
				onOpenTraceSource={onOpenTraceSource}
				onOpenEvidence={onOpenEvidence}
			/>
			{run.hasOutput && (
				<RunOutput
					testCase={testCase}
					run={run}
					state={state}
					onLoadOutput={onLoadOutput}
					onOpenEvidence={onOpenEvidence}
				/>
			)}
			{run.warnings && run.warnings.length > 0 && (
				<ul className="test-run-warnings">
					{run.warnings.map((warning, index) => (
						<li key={index}>⚠ {warning}</li>
					))}
				</ul>
			)}
			<div className="test-run-actions">
				<button
					type="button"
					className="scan-issue-location"
					onClick={() => onOpenEvidence(testCase, run.id)}
				>
					Reveal folder
				</button>
			</div>
		</>
	);
}

function EvidenceFiles({
	testCase,
	run,
	base,
	eager,
	canOpen,
	media,
	traces,
	traceFrames,
	traceViewer,
	onLoadMedia,
	onLoadTrace,
	onLoadTraceFrame,
	onOpenTraceViewer,
	onOpenTraceSource,
	onOpenEvidence
}: {
	testCase: string;
	run: TestRunRecord;
	base?: string;
	eager: boolean;
	canOpen: boolean;
	media: TestsState['media'];
	traces: TestsState['traces'];
	traceFrames: TestsState['traceFrames'];
	traceViewer: TestsState['traceViewer'];
	onLoadMedia: (testCase: string, run: string, file: string, convert?: boolean) => void;
	onLoadTrace: (testCase: string, run: string, file: string) => void;
	onLoadTraceFrame: (testCase: string, run: string, file: string, frame: string) => void;
	onOpenTraceViewer: (testCase: string, run: string, file: string) => void;
	onOpenTraceSource: (file: string, line: number, column?: number) => void;
	onOpenEvidence: (testCase: string, run: string, file?: string) => void;
}) {
	if (run.files.length === 0) {
		return run.evidencePattern ? (
			<p className="test-run-none">
				No evidence files matched <code>{run.evidencePattern}</code>. Recording off for this run, or the
				folder was cleared by another?
			</p>
		) : null;
	}

	const files = sortEvidenceFiles(run.files);
	const rows: ReactNode[] = [];
	for (const file of files) {
		const kind = evidenceKind(file.name);
		const url = file.missing ? undefined : evidenceUrl(base, run.id, file.name);
		const caption = evidenceCaption(file.name);
		if (kind === 'video' && url) {
			rows.push(
				<VideoFigure
					key={file.name}
					file={file}
					url={url}
					caption={caption}
					eager={eager}
					media={media[`${testCase}/${run.id}/${file.name}`]}
					converted={media[`${testCase}/${run.id}/${file.name}${CONVERTED_MEDIA_SUFFIX}`]}
					onLoadMedia={() => onLoadMedia(testCase, run.id, file.name)}
					onLoadConverted={() => onLoadMedia(testCase, run.id, file.name, true)}
					onOpen={() => onOpenEvidence(testCase, run.id, file.name)}
				/>
			);
		} else if (kind === 'archive') {
			const traceKey = `${testCase}/${run.id}/${file.name}`;
			rows.push(
				<TraceFigure
					key={file.name}
					file={file}
					url={url}
					traceKey={traceKey}
					entry={traces[traceKey]}
					frames={traceFrames}
					traceViewer={traceViewer}
					onLoad={() => onLoadTrace(testCase, run.id, file.name)}
					onLoadFrame={(frame) => onLoadTraceFrame(testCase, run.id, file.name, frame)}
					onOpenViewer={() => onOpenTraceViewer(testCase, run.id, file.name)}
					onOpenSource={onOpenTraceSource}
					onReveal={() => onOpenEvidence(testCase, run.id)}
				/>
			);
		} else if (kind === 'image' && url) {
			rows.push(
				<figure className="test-run-image" key={file.name}>
					<img src={url} alt={file.name} />
					<figcaption>
						{file.name}{' '}
						<button
							type="button"
							className="scan-issue-location"
							onClick={() => onOpenEvidence(testCase, run.id, file.name)}
						>
							Open in editor
						</button>
					</figcaption>
				</figure>
			);
		} else {
			rows.push(
				<FileRow
					key={file.name}
					file={file}
					// Open goes to the host, which opens text in an editor, runs the
					// evidence command for the rest, or reveals when none is configured.
					present={!file.missing}
					canOpen={!file.missing && url !== undefined}
					opensWith={canOpen ? 'the evidence command' : 'the file manager'}
					onOpen={() => onOpenEvidence(testCase, run.id, file.name)}
					onReveal={() => onOpenEvidence(testCase, run.id)}
				/>
			);
		}
	}
	return <div className="test-run-files">{rows}</div>;
}

/**
 * What this player claims to play — asked only once a file delivered in full
 * has failed, when the answer is the one thing that says whether converting
 * the recording would help. `canPlayType` is the media element's own word;
 * WebCodecs is asked too, since it decodes without the editor's demuxer.
 */
async function probePlayer(): Promise<PlayerProbe> {
	const probe: PlayerProbe = { canPlay: {} };
	const element = document.createElement('video');
	for (const { label, type } of PROBE_TYPES) {
		probe.canPlay[label] = element.canPlayType(type) || 'no';
	}
	const decoder = (globalThis as { VideoDecoder?: { isConfigSupported?: (config: { codec: string }) => Promise<{ supported?: boolean }> } }).VideoDecoder;
	if (decoder?.isConfigSupported) {
		probe.decoders = {};
		for (const { label, codec } of PROBE_DECODERS) {
			try {
				probe.decoders[label] = (await decoder.isConfigSupported({ codec })).supported === true;
			} catch {
				probe.decoders[label] = false;
			}
		}
	}
	const agent = navigator.userAgent;
	probe.chromium = /Chrome\/(\d+)/.exec(agent)?.[1];
	probe.platform = /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : undefined;
	return probe;
}

/**
 * Once this editor has refused a WebM blob its own decoder then played, the
 * next video skips the blob and goes straight to the decoder: the refusal is
 * the editor build's, not the file's, and paying it once per video would put
 * two failures and a grey box in front of every recording on the tab.
 */
let editorRefusesWebm = false;

/** The bytes the host posted, back into what a Blob takes. */
function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/**
 * The inline player, and the truth when it fails. A media element that cannot
 * load shows nothing but a grey box, so its failure is read by
 * `describeMediaFailure` and written under it with what to do about it.
 *
 * Three routes, tried in order, each cheaper than the next is capable:
 * 1. `loader` — the editor's own `<video>` on the resource-loader url.
 * 2. `blob` — the same element on the file's bytes, fetched from the
 *    extension host over the message bridge. Over some remote connections
 *    the loader hands the player nothing it can demux
 *    (`DEMUXER_ERROR_COULD_NOT_OPEN`), which reads like a codec problem and
 *    is not; the bytes arriving another way settles it.
 * 3. `decoder` — the board's own player (`videoPlayer.tsx`): WebM demuxed
 *    in JavaScript and decoded with WebCodecs, for an editor whose demuxer
 *    refuses a container its decoders play (VS Code on Windows with VP8 WebM,
 *    microsoft/vscode#195758).
 * 4. `converting` — the editor has no decoder for the codec at all (VS Code
 *    on Windows and VP9, which Playwright records from 1.65), so the host
 *    re-encodes the file as VP8 WebM with ffmpeg and routes 2 and 3 run again
 *    on those bytes. Once only: a converted file that still fails is final.
 * When all of them fail, the file is the problem, and the advice says so — and
 * says that installing codecs cannot help, since the player is the editor's.
 */
function VideoFigure({
	file,
	url,
	caption,
	eager,
	media,
	converted,
	onLoadMedia,
	onLoadConverted,
	onOpen
}: {
	file: TestRunFile;
	url: string;
	caption?: string;
	eager: boolean;
	/** The host's answer to `onLoadMedia`, once there is one. */
	media?: { data: string; mime: string } | { error: string };
	/** The host's answer to `onLoadConverted`: the file re-encoded as VP8 WebM. */
	converted?: { data: string; mime: string } | { error: string };
	onLoadMedia: () => void;
	onLoadConverted: () => void;
	onOpen: () => void;
}) {
	const [failure, setFailure] = useState<MediaFailure | undefined>(undefined);
	const [route, setRoute] = useState<'loader' | 'fetching' | 'blob' | 'decoder' | 'converting' | 'exhausted'>(
		'loader'
	);
	const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
	const bytesRef = useRef<Uint8Array | undefined>(undefined);
	const [probe, setProbe] = useState<PlayerProbe | undefined>(undefined);
	/** The bytes in `bytesRef` are the host's VP8 conversion, not the file's own. */
	const [usingConverted, setUsingConverted] = useState(false);
	/** Why the file's own bytes could not be played — said again if the conversion fails too. */
	const refusalRef = useRef('');
	// What the decoder route is asked about: the converted bytes are WebM whatever the file was.
	const decodeName = usingConverted ? 'converted.webm' : file.name;

	// The bytes landed: make the blob and point the player at it. Or they did
	// not, and the host said why.
	useEffect(() => {
		if (route !== 'fetching' || !media) {
			return;
		}
		if ('error' in media) {
			setRoute('exhausted');
			setFailure({
				kind: 'transport',
				summary: `The file could not be loaded from the extension host either: ${media.error}`,
				advice: [OPEN_IN_EDITOR_ADVICE, REVEAL_ADVICE]
			});
			return;
		}
		let object: string;
		try {
			const bytes = decodeBase64(media.data);
			bytesRef.current = bytes;
			if (editorRefusesWebm && canDecodeHere(file.name)) {
				setRoute('decoder');
				setFailure(undefined);
				return;
			}
			object = URL.createObjectURL(new Blob([bytes], { type: media.mime }));
		} catch (error) {
			setRoute('exhausted');
			setFailure({
				kind: 'unknown',
				summary: `The file arrived but could not be handed to the player: ${errorMessage(error)}`,
				advice: [OPEN_IN_EDITOR_ADVICE]
			});
			return;
		}
		setBlobUrl(object);
		setRoute('blob');
		setFailure(undefined);
	}, [route, media, file.name]);

	// The converted bytes landed: the same two routes again, on those. Or the
	// host could not convert, and that ends it.
	useEffect(() => {
		if (route !== 'converting' || !converted) {
			return;
		}
		if ('error' in converted) {
			setRoute('exhausted');
			setFailure({
				kind: 'format',
				summary: `The editor cannot play this recording (${refusalRef.current}), and converting it to VP8 failed: ${converted.error}`,
				advice: FORMAT_ADVICE
			});
			return;
		}
		let object: string;
		try {
			const bytes = decodeBase64(converted.data);
			bytesRef.current = bytes;
			setUsingConverted(true);
			if (editorRefusesWebm && canDecodeHere('converted.webm')) {
				setRoute('decoder');
				setFailure(undefined);
				return;
			}
			object = URL.createObjectURL(new Blob([bytes], { type: converted.mime }));
		} catch (error) {
			setRoute('exhausted');
			setFailure({
				kind: 'unknown',
				summary: `The converted file arrived but could not be handed to the player: ${errorMessage(error)}`,
				advice: [OPEN_IN_EDITOR_ADVICE]
			});
			return;
		}
		setBlobUrl(object);
		setRoute('blob');
		setFailure(undefined);
	}, [route, converted]);

	/**
	 * The last route: ask the host for a VP8 copy. False when that was already
	 * the route that failed — a conversion is tried once.
	 */
	const convert = (refusal: string): boolean => {
		if (usingConverted) {
			return false;
		}
		refusalRef.current = refusal;
		setFailure(undefined);
		setRoute('converting');
		// The conversion may already be here from an earlier mount of this file.
		if (!converted) {
			onLoadConverted();
		}
		return true;
	};

	// A blob url holds its bytes until revoked; the figure going away is the cue.
	useEffect(() => {
		if (!blobUrl) {
			return;
		}
		return () => URL.revokeObjectURL(blobUrl);
	}, [blobUrl]);

	// Every route is spent: ask the player what it claims to play.
	useEffect(() => {
		if (failure?.kind !== 'format' || probe) {
			return;
		}
		let live = true;
		void probePlayer().then((result) => {
			if (live) {
				setProbe(result);
			}
		});
		return () => {
			live = false;
		};
	}, [failure, probe]);

	const onError = (event: SyntheticEvent<HTMLVideoElement>) => {
		const error = event.currentTarget.error;
		const code = error?.code;
		const message = error?.message ? error.message : undefined;
		if (route === 'loader') {
			const described = describeMediaFailure(code, message, false);
			setFailure(described);
			if (described.kind !== 'aborted') {
				setRoute('fetching');
				// The bytes may already be here from an earlier mount of this file.
				if (!media) {
					onLoadMedia();
				}
			}
			return;
		}
		if (route === 'blob') {
			const described = describeMediaFailure(code, message, true);
			if (described.kind === 'aborted') {
				setFailure(described);
			} else if (bytesRef.current && canDecodeHere(decodeName)) {
				editorRefusesWebm = true;
				setFailure(undefined);
				setRoute('decoder');
			} else if (!convert(message ?? described.summary)) {
				setFailure(described);
				setRoute('exhausted');
			}
		}
	};

	const onDecoderFailure = (reason: string) => {
		if (convert(reason)) {
			return;
		}
		setRoute('exhausted');
		setFailure({
			kind: 'format',
			summary: `The editor’s player refused the file and BFAST’s own decoder could not play it either, even converted to VP8 (${reason}).`,
			advice: FORMAT_ADVICE
		});
	};

	const converting = usingConverted ? ' · converted to VP8 with ffmpeg on the extension host' : '';
	const note =
		route === 'blob'
			? converting || ' · loaded directly from the extension host'
			: route === 'decoder'
				? `${converting} · played by BFAST’s own decoder: the editor’s player refused this file`
				: '';

	return (
		<figure className="test-run-video">
			{route === 'converting' ? (
				<p className="test-run-none" role="status">
					The editor has no decoder for this recording ({refusalRef.current}). Converting it to VP8 with ffmpeg on
					the extension host…
				</p>
			) : route === 'decoder' && bytesRef.current ? (
				<WebCodecsPlayer bytes={bytesRef.current} name={file.name} onFailure={onDecoderFailure} />
			) : (
				<video
					controls
					playsInline
					preload={eager || blobUrl ? 'metadata' : 'none'}
					src={blobUrl ?? url}
					onError={onError}
				/>
			)}
			{failure && (
				<div className="test-run-video-error" role="status">
					<p className="detail-error">{failure.summary}</p>
					<ul className="test-run-video-advice">
						{failure.advice.map((line, index) => (
							<li key={index}>{line}</li>
						))}
					</ul>
					{failure.kind === 'format' && probe && (
						<p className="test-run-video-probe">
							{probeSentence(probe)} {probeVerdict(probe, file.name)}
						</p>
					)}
				</div>
			)}
			<figcaption>
				{file.name}
				{caption ? ` · ${caption}` : ''}
				{file.size !== undefined ? ` · ${formatBytes(file.size)}` : ''}
				{note}{' '}
				<button type="button" className="scan-issue-location" title="Opens with VS Code's media preview" onClick={onOpen}>
					Open in editor
				</button>
			</figcaption>
		</figure>
	);
}

function FileRow({
	file,
	present,
	canOpen,
	opensWith,
	onOpen,
	onReveal
}: {
	file: TestRunFile;
	/** On disk — Reveal works whatever the name; Open needs a name BFAST would write. */
	present: boolean;
	canOpen: boolean;
	opensWith: string;
	onOpen: () => void;
	onReveal: () => void;
}) {
	const text = evidenceKind(file.name) === 'text';
	return (
		<div className={file.missing ? 'test-run-file is-missing' : 'test-run-file'}>
			<span className="test-run-file-name">{file.name}</span>
			{file.size !== undefined && <span className="test-run-meta">{formatBytes(file.size)}</span>}
			{file.missing ? (
				<span className="test-run-meta">not on this machine</span>
			) : (
				<>
					{canOpen && (
						<button
							type="button"
							className="scan-issue-location"
							title={text ? 'Opens in an editor tab' : `Opens with ${opensWith}`}
							onClick={onOpen}
						>
							Open
						</button>
					)}
					{present && (
						<button type="button" className="scan-issue-location" onClick={onReveal}>
							Reveal
						</button>
					)}
				</>
			)}
		</div>
	);
}

function RunOutput({
	testCase,
	run,
	state,
	onLoadOutput,
	onOpenEvidence
}: {
	testCase: string;
	run: TestRunRecord;
	state: TestsState;
	onLoadOutput: (testCase: string, run: string) => void;
	onOpenEvidence: (testCase: string, run: string, file?: string) => void;
}) {
	const key = `${testCase}/${run.id}`;
	const output = state.output[key];
	// Open for a red run, whose failure is the thing to read; closed for a green one.
	const [open, setOpen] = useState(run.outcome !== 'passed');
	const requested = useRef(false);
	useEffect(() => {
		if (open && !output && !requested.current) {
			requested.current = true;
			onLoadOutput(testCase, run.id);
		}
	}, [open, output, onLoadOutput, testCase, run.id]);

	return (
		<details className="test-run-output" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				Output
				{run.outputTruncated && <span className="test-run-meta"> · tail</span>}
				<button
					type="button"
					className="scan-issue-location test-run-output-open"
					onClick={(event) => {
						event.preventDefault();
						onOpenEvidence(testCase, run.id, 'output.log');
					}}
				>
					Open full log
				</button>
			</summary>
			{open &&
				(output ? (
					<pre className="test-run-output-text">
						{output.truncated ? '… ' : ''}
						{output.text.length === 0 ? '(no output)' : output.text}
					</pre>
				) : (
					<p className="generate-idle">Reading…</p>
				))}
		</details>
	);
}

function formatTime(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

/**
 * Which command runs this test case: the project's, or a service's e2e test
 * case command. A service the settings no longer declare stays listed, marked,
 * so the select never silently shows "None" for a ticket that names one.
 */
function ServicePicker({
	current,
	services,
	disabled,
	onChange,
	onOpenSettings
}: {
	current: string | undefined;
	services: TestServiceOption[];
	disabled: boolean;
	onChange: (service: string | null) => void;
	onOpenSettings: () => void;
}) {
	if (services.length === 0 && current === undefined) {
		return null;
	}
	const missing = current !== undefined && !services.some((service) => service.id === current);
	const chosen = services.find((service) => service.id === current);
	return (
		<label className="test-service">
			Service{' '}
			<select
				className="settings-input settings-input-compact"
				value={current ?? ''}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
			>
				<option value="">None — project test command</option>
				{services.map((service) => (
					<option key={service.id} value={service.id}>
						{service.label}
						{service.runnable ? '' : ' (no test case command)'}
					</option>
				))}
				{missing && <option value={current}>{current} (not in the settings)</option>}
			</select>
			{(missing || (chosen !== undefined && !chosen.runnable)) && (
				<button type="button" className="scan-issue-location" onClick={onOpenSettings}>
					Open settings
				</button>
			)}
		</label>
	);
}
