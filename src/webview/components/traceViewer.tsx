// A Playwright trace on the Tests tab: the row for a `.zip` among a run's
// files, and the viewer it opens into.
//
// The viewer is three parts — a filmstrip of the page's screencast frames
// across the top, the actions down the left, the selected action's detail on
// the right (its screenshots before and after, its error, the console, the
// network and the source, the last three filtered to the action's window) —
// which is the shape Playwright's own viewer has, minus what needs a DOM
// snapshot. Everything shown is the host's `TraceReport`; a frame's bytes are
// asked for as its `<img>` mounts and arrive base64 (`testsTraceFrame`), so
// the archive itself never crosses the bridge and a person browsing ten
// actions costs twenty small JPEGs, not a 7 MB zip.
//
// Which action and which tab are selected is this component's own state: the
// pane unmounts on a tab switch and the default — the first failed action, on
// its screenshots — is what a fresh look wants.

import { useEffect, useMemo, useState } from 'react';
import type { TestRunFile } from '../../data/types';
import {
	actionAt,
	actionDetail,
	eventsFor,
	filmstripFrames,
	formatTraceDuration,
	formatTraceTime,
	frameAfter,
	frameBefore,
	requestsFor,
	type TraceAction,
	type TraceEvent,
	type TraceFrame,
	type TraceReport,
	type TraceStackFrame
} from '../../shared/playwrightTrace';
import { formatBytes } from '../../testing/testReport';
import type { TestsState } from '../app';

export type TraceViewerMode = TestsState['traceViewer'];

/** What "Open in Playwright Trace Viewer" will do, for the button's tooltip. */
export function traceViewerTitle(mode: TraceViewerMode): string {
	switch (mode) {
		case 'command':
			return 'Runs the "Open evidence with" command from the settings';
		case 'playwright':
			return 'Runs the Playwright installed in this workspace';
		case 'none':
			return 'Needs Playwright in the workspace, or an "Open evidence with" command in the settings';
	}
}

export function TraceFigure({
	file,
	url,
	traceKey,
	entry,
	frames,
	traceViewer,
	onLoad,
	onLoadFrame,
	onOpenViewer,
	onOpenSource,
	onReveal
}: {
	file: TestRunFile;
	/** Present when the file is on disk under a name BFAST would write. */
	url: string | undefined;
	/** `<testCase>/<run>/<file>` — what the app keys this trace and its frames under. */
	traceKey: string;
	entry: TestsState['traces'][string] | undefined;
	frames: TestsState['traceFrames'];
	traceViewer: TraceViewerMode;
	onLoad: () => void;
	onLoadFrame: (frame: string) => void;
	onOpenViewer: () => void;
	onOpenSource: (file: string, line: number, column?: number) => void;
	onReveal: () => void;
}) {
	const [open, setOpen] = useState(false);
	const loaded = entry && 'trace' in entry ? entry.trace : undefined;
	const notATrace = entry && 'error' in entry && entry.notATrace === true;
	useEffect(() => {
		if (open && entry === undefined) {
			onLoad();
		}
	}, [open, entry, onLoad]);

	const present = !file.missing && url !== undefined;
	return (
		<div className={`test-trace${file.missing ? ' is-missing' : ''}`}>
			<div className="test-run-file">
				<span className="test-run-file-name">{file.name}</span>
				{file.size !== undefined && <span className="test-run-meta">{formatBytes(file.size)}</span>}
				{loaded && (
					<span className="test-run-meta">
						Playwright trace
						{loaded.browserName ? ` · ${loaded.browserName}` : ''}
						{loaded.playwrightVersion ? ` · ${loaded.playwrightVersion}` : ''}
					</span>
				)}
				{file.missing ? (
					<span className="test-run-meta">not on this machine</span>
				) : (
					<>
						{present && !notATrace && (
							<button
								type="button"
								className="scan-issue-location"
								aria-expanded={open}
								onClick={() => setOpen((value) => !value)}
							>
								{open ? 'Hide trace' : 'Show trace'}
							</button>
						)}
						{present && (
							<button
								type="button"
								className="scan-issue-location"
								title={traceViewerTitle(traceViewer)}
								onClick={onOpenViewer}
							>
								{notATrace ? 'Open' : 'Open in Playwright Trace Viewer'}
							</button>
						)}
						<button type="button" className="scan-issue-location" onClick={onReveal}>
							Reveal
						</button>
					</>
				)}
			</div>
			{open && present && (
				<div className="test-trace-body">
					{loaded ? (
						<TraceViewer
							trace={loaded}
							frames={frames}
							frameKey={(frame) => `${traceKey}#${frame}`}
							onLoadFrame={onLoadFrame}
							onOpenSource={onOpenSource}
						/>
					) : entry !== undefined && 'error' in entry ? (
						<p className={notATrace ? 'test-run-none' : 'detail-error'}>
							{notATrace ? 'This zip is not a Playwright trace. ' : ''}
							{entry.error}
						</p>
					) : (
						<p className="generate-idle">Reading the trace…</p>
					)}
				</div>
			)}
		</div>
	);
}

type DetailTab = 'screenshots' | 'errors' | 'console' | 'network' | 'source';

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
	{ id: 'screenshots', label: 'Screenshots' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'console', label: 'Console' },
	{ id: 'network', label: 'Network' },
	{ id: 'source', label: 'Source' }
];

interface FrameProps {
	frames: TestsState['traceFrames'];
	/** The key a frame's bytes are stored under in `frames`: `<testCase>/<run>/<file>#<frame>`. */
	frameKey: (frame: string) => string;
	onLoadFrame: (frame: string) => void;
}

export function TraceViewer({
	trace,
	frames,
	frameKey,
	onLoadFrame,
	onOpenSource
}: FrameProps & {
	trace: TraceReport;
	onOpenSource: (file: string, line: number, column?: number) => void;
}) {
	const firstFailed = trace.actions.find((action) => action.error !== undefined);
	const [selectedId, setSelectedId] = useState<string | undefined>(firstFailed?.callId);
	const [tab, setTab] = useState<DetailTab>('screenshots');
	const selected = selectedId !== undefined ? trace.actions.find((action) => action.callId === selectedId) : undefined;
	const strip = useMemo(() => filmstripFrames(trace), [trace]);
	const events = eventsFor(trace, selected);
	const requests = requestsFor(trace, selected);
	const errorCount = selected ? (selected.error ? 1 : 0) : trace.errors.length;
	const duration = trace.endTime - trace.startTime;

	return (
		<div className="test-trace-viewer">
			<div className="test-trace-summary">
				{trace.title && <strong>{trace.title}</strong>}
				<span className="test-run-meta">{trace.actions.length} actions</span>
				<span className="test-run-meta">{formatTraceDuration(duration)}</span>
				{trace.errors.length > 0 && (
					<span className="test-run-meta test-trace-error-count">
						{trace.errors.length} {trace.errors.length === 1 ? 'error' : 'errors'}
					</span>
				)}
				{trace.frameCount > 0 && <span className="test-run-meta">{trace.frameCount} frames</span>}
				{trace.viewport && (
					<span className="test-run-meta">
						{trace.viewport.width}×{trace.viewport.height}
					</span>
				)}
			</div>
			{trace.warnings.length > 0 && (
				<ul className="test-run-warnings">
					{trace.warnings.map((warning, index) => (
						<li key={index}>⚠ {warning}</li>
					))}
				</ul>
			)}
			{strip.length > 0 && (
				<Filmstrip
					trace={trace}
					strip={strip}
					selected={selected}
					frames={frames}
					frameKey={frameKey}
					onLoadFrame={onLoadFrame}
					onPick={(frame) => {
						const action = actionAt(trace, frame.timestamp);
						setSelectedId(action?.callId);
					}}
				/>
			)}
			<div className="test-trace-columns">
				<div className="test-trace-actions" role="listbox" aria-label="Actions">
					<button
						type="button"
						className="test-trace-action is-whole"
						role="option"
						aria-selected={selected === undefined}
						aria-pressed={selected === undefined}
						onClick={() => setSelectedId(undefined)}
					>
						<span className="test-trace-action-title">Whole trace</span>
						<span className="test-trace-action-time">{formatTraceDuration(duration)}</span>
					</button>
					{trace.actions.map((action) => (
						<ActionRow
							key={action.callId}
							trace={trace}
							action={action}
							selected={action.callId === selectedId}
							onSelect={() => setSelectedId(action.callId)}
						/>
					))}
				</div>
				<div className="test-trace-detail">
					{selected ? (
						<div className="test-trace-detail-head">
							<span className={`generate-run ${selected.error ? 'is-failed' : selected.unfinished ? 'is-running' : 'is-done'}`}>
								<span className="generate-run-mark" aria-hidden="true">
									{selected.error ? '⚠' : selected.unfinished ? '◍' : '●'}
								</span>{' '}
								<strong>{selected.title}</strong>
							</span>
							{actionDetail(selected) && <code className="test-trace-detail-arg">{actionDetail(selected)}</code>}
							<span className="test-run-meta">at {formatTraceTime(selected.startTime, trace.startTime)}</span>
							{selected.endTime !== undefined && (
								<span className="test-run-meta">{formatTraceDuration(selected.endTime - selected.startTime)}</span>
							)}
							{selected.unfinished && <span className="test-run-meta">did not finish</span>}
							{selected.error && <p className="detail-error test-trace-detail-error">{selected.error.message}</p>}
						</div>
					) : (
						<div className="test-trace-detail-head">
							<strong>Whole trace</strong>
							<span className="test-run-meta">every event, request and error</span>
						</div>
					)}
					<div className="tabs test-trace-tabs" role="tablist">
						{DETAIL_TABS.map((item) => {
							const count =
								item.id === 'errors'
									? errorCount
									: item.id === 'console'
										? events.length
										: item.id === 'network'
											? requests.length
											: undefined;
							return (
								<button
									key={item.id}
									type="button"
									role="tab"
									className={`tab${tab === item.id ? ' active' : ''}`}
									aria-selected={tab === item.id}
									onClick={() => setTab(item.id)}
								>
									{item.label}
									{count !== undefined && count > 0 && <span className="tab-count"> {count}</span>}
								</button>
							);
						})}
					</div>
					<div className="test-trace-pane">
						{tab === 'screenshots' && (
							<Screenshots trace={trace} action={selected} frames={frames} frameKey={frameKey} onLoadFrame={onLoadFrame} />
						)}
						{tab === 'errors' && <Errors trace={trace} action={selected} onOpenSource={onOpenSource} />}
						{tab === 'console' && <Console trace={trace} events={events} />}
						{tab === 'network' && <Network trace={trace} requests={requests} />}
						{tab === 'source' && <Source trace={trace} action={selected} onOpenSource={onOpenSource} />}
					</div>
				</div>
			</div>
		</div>
	);
}

function ActionRow({
	trace,
	action,
	selected,
	onSelect
}: {
	trace: TraceReport;
	action: TraceAction;
	selected: boolean;
	onSelect: () => void;
}) {
	const detail = actionDetail(action);
	const mark = action.error ? { mark: '⚠', className: 'is-failed' } : action.unfinished ? { mark: '◍', className: 'is-running' } : { mark: '●', className: 'is-done' };
	return (
		<button
			type="button"
			className={`test-trace-action generate-run ${mark.className}${action.origin === 'testRunner' ? ' is-step' : ''}`}
			role="option"
			aria-selected={selected}
			aria-pressed={selected}
			style={{ paddingLeft: `${8 + action.depth * 14}px` }}
			title={`${action.title}${detail ? ` ${detail}` : ''} · ${formatTraceTime(action.startTime, trace.startTime)}`}
			onClick={onSelect}
		>
			<span className="generate-run-mark" aria-hidden="true">
				{mark.mark}
			</span>
			<span className="test-trace-action-title">
				{action.title}
				{detail && <span className="test-trace-action-detail"> {detail}</span>}
			</span>
			<span className="test-trace-action-time">
				{action.endTime !== undefined ? formatTraceDuration(action.endTime - action.startTime) : '…'}
			</span>
		</button>
	);
}

function Filmstrip({
	trace,
	strip,
	selected,
	frames,
	frameKey,
	onLoadFrame,
	onPick
}: FrameProps & {
	trace: TraceReport;
	strip: TraceFrame[];
	selected: TraceAction | undefined;
	onPick: (frame: TraceFrame) => void;
}) {
	const start = selected?.startTime;
	const end = selected ? (selected.endTime ?? Number.POSITIVE_INFINITY) : undefined;
	return (
		<div className="test-trace-filmstrip" role="list" aria-label="Screencast frames">
			{strip.map((frame) => {
				const inside = start !== undefined && end !== undefined && frame.timestamp >= start && frame.timestamp <= end;
				return (
					<button
						key={frame.name}
						type="button"
						role="listitem"
						className={`test-trace-thumb${inside ? ' is-inside' : ''}`}
						title={formatTraceTime(frame.timestamp, trace.startTime)}
						onClick={() => onPick(frame)}
					>
						<FrameImage frame={frame} frames={frames} frameKey={frameKey} onLoadFrame={onLoadFrame} thumbnail />
					</button>
				);
			})}
		</div>
	);
}

/** One screencast frame, asked for from the host as it mounts. */
function FrameImage({
	frame,
	frames,
	frameKey,
	onLoadFrame,
	thumbnail,
	point
}: FrameProps & {
	frame: TraceFrame;
	thumbnail?: boolean;
	/** Where a click landed, in frame pixels, drawn over the image. */
	point?: { x: number; y: number };
}) {
	const key = frameKey(frame.name);
	const entry = frames[key];
	useEffect(() => {
		if (entry === undefined) {
			onLoadFrame(frame.name);
		}
	}, [entry, frame.name, onLoadFrame]);

	const ratio = frame.width > 0 && frame.height > 0 ? `${frame.width} / ${frame.height}` : '16 / 9';
	if (entry === undefined) {
		return <span className={`test-trace-frame is-loading${thumbnail ? ' is-thumb' : ''}`} style={{ aspectRatio: ratio }} />;
	}
	if ('error' in entry) {
		return (
			<span className={`test-trace-frame is-error${thumbnail ? ' is-thumb' : ''}`} style={{ aspectRatio: ratio }} title={entry.error}>
				{thumbnail ? '' : entry.error}
			</span>
		);
	}
	return (
		<span className={`test-trace-frame${thumbnail ? ' is-thumb' : ''}`} style={{ aspectRatio: ratio }}>
			<img src={`data:${entry.mime};base64,${entry.data}`} alt={frame.name} />
			{point && frame.width > 0 && frame.height > 0 && (
				<span
					className="test-trace-point"
					aria-hidden="true"
					style={{ left: `${(point.x / frame.width) * 100}%`, top: `${(point.y / frame.height) * 100}%` }}
				/>
			)}
		</span>
	);
}

function Screenshots({
	trace,
	action,
	frames,
	frameKey,
	onLoadFrame
}: FrameProps & { trace: TraceReport; action: TraceAction | undefined }) {
	if (trace.frameCount === 0) {
		return <p className="test-run-none">The trace has no screenshots: it was recorded with `screenshots: false`.</p>;
	}
	if (!action) {
		const last = trace.pages.flatMap((page) => page.frames).sort((a, b) => b.timestamp - a.timestamp)[0];
		return last ? (
			<div className="test-trace-shots">
				<figure className="test-trace-shot">
					<FrameImage frame={last} frames={frames} frameKey={frameKey} onLoadFrame={onLoadFrame} />
					<figcaption>last frame · {formatTraceTime(last.timestamp, trace.startTime)}</figcaption>
				</figure>
			</div>
		) : null;
	}
	const before = frameBefore(trace, action);
	const after = frameAfter(trace, action);
	return (
		<div className="test-trace-shots">
			{before && (
				<figure className="test-trace-shot">
					<FrameImage frame={before.frame} frames={frames} frameKey={frameKey} onLoadFrame={onLoadFrame} point={action.point} />
					<figcaption>
						before · {formatTraceTime(before.frame.timestamp, trace.startTime)}
						{before.closest ? ' · first frame, nothing was drawn earlier' : ''}
					</figcaption>
				</figure>
			)}
			{after && (
				<figure className="test-trace-shot">
					<FrameImage frame={after.frame} frames={frames} frameKey={frameKey} onLoadFrame={onLoadFrame} />
					<figcaption>
						after · {formatTraceTime(after.frame.timestamp, trace.startTime)}
						{after.frame === before?.frame ? ' · no new frame during the action' : ''}
					</figcaption>
				</figure>
			)}
		</div>
	);
}

function StackFrames({
	frames,
	onOpenSource
}: {
	frames: TraceStackFrame[];
	onOpenSource: (file: string, line: number, column?: number) => void;
}) {
	return (
		<ul className="test-trace-stack">
			{frames.map((frame, index) => (
				<li key={index}>
					{frame.function && <span className="test-trace-fn">{frame.function} </span>}
					<button
						type="button"
						className="scan-issue-location"
						title="Open in an editor"
						onClick={() => onOpenSource(frame.file, frame.line, frame.column)}
					>
						{shortPath(frame.file)}:{frame.line}:{frame.column}
					</button>
				</li>
			))}
		</ul>
	);
}

function Errors({
	trace,
	action,
	onOpenSource
}: {
	trace: TraceReport;
	action: TraceAction | undefined;
	onOpenSource: (file: string, line: number, column?: number) => void;
}) {
	if (action) {
		return (
			<div className="test-trace-errors">
				{action.error ? (
					<>
						<p className="detail-error">{action.error.message}</p>
						{action.error.stack && <pre className="test-run-output-text">{action.error.stack}</pre>}
						{action.stack && <StackFrames frames={action.stack} onOpenSource={onOpenSource} />}
					</>
				) : (
					<p className="test-run-none">This action did not fail.</p>
				)}
				{action.log.length > 0 && (
					<details className="test-run-output" open={action.error !== undefined}>
						<summary>Log · {action.log.length}</summary>
						<pre className="test-run-output-text">
							{action.log.map((line) => `${formatTraceTime(line.time, trace.startTime)}  ${line.message}`).join('\n')}
						</pre>
					</details>
				)}
			</div>
		);
	}
	if (trace.errors.length === 0) {
		return <p className="test-run-none">No errors in this trace.</p>;
	}
	return (
		<div className="test-trace-errors">
			{trace.errors.map((error, index) => (
				<div key={index} className="test-trace-error">
					<p className="detail-error">{error.message}</p>
					{error.stack && <StackFrames frames={error.stack} onOpenSource={onOpenSource} />}
				</div>
			))}
		</div>
	);
}

function Console({ trace, events }: { trace: TraceReport; events: TraceEvent[] }) {
	if (events.length === 0) {
		return <p className="test-run-none">Nothing on the console in this window.</p>;
	}
	return (
		<ul className="test-trace-console">
			{events.map((event, index) => {
				const level =
					event.kind === 'console' ? event.level : event.kind === 'pageerror' ? 'pageerror' : event.kind;
				const text = event.kind === 'console' ? event.text : event.kind === 'pageerror' ? event.message : event.text;
				const severe = event.kind === 'pageerror' || (event.kind === 'console' && (event.level === 'error' || event.level === 'assert'));
				const warn = event.kind === 'console' && event.level === 'warning';
				return (
					<li key={index} className={`test-trace-console-line${severe ? ' is-error' : warn ? ' is-warning' : ''}`}>
						<span className="test-trace-time">{formatTraceTime(event.time, trace.startTime)}</span>
						<span className="test-trace-level">{level}</span>
						<span className="test-trace-text">{text}</span>
						{event.kind === 'console' && event.location && (
							<span className="test-run-meta">
								{shortPath(event.location.url)}:{event.location.line}
							</span>
						)}
						{event.kind === 'pageerror' && event.stack && <pre className="test-run-output-text">{event.stack}</pre>}
					</li>
				);
			})}
		</ul>
	);
}

function Network({ trace, requests }: { trace: TraceReport; requests: TraceReport['network'] }) {
	if (requests.length === 0) {
		return <p className="test-run-none">No requests started in this window.</p>;
	}
	return (
		<div className="test-trace-network-wrap">
			<table className="test-trace-network">
				<thead>
					<tr>
						<th>At</th>
						<th>Method</th>
						<th>Status</th>
						<th>URL</th>
						<th>Type</th>
						<th>Size</th>
						<th>Time</th>
					</tr>
				</thead>
				<tbody>
					{requests.map((request) => {
						const failed = request.status === undefined || request.status >= 400;
						return (
							<tr key={request.id} className={failed ? 'is-error' : ''}>
								<td className="test-trace-time">{formatTraceTime(request.startTime, trace.startTime)}</td>
								<td>{request.method}</td>
								<td className="test-trace-status">{request.status ?? '—'}</td>
								<td className="test-trace-url" title={request.url}>
									{splitUrl(request.url).map((part, index) => (
										<span key={index} className={index === 0 ? 'test-trace-host' : undefined}>
											{part}
										</span>
									))}
								</td>
								<td>{request.mimeType ?? ''}</td>
								<td>{request.size !== undefined ? formatBytes(request.size) : request.transferSize !== undefined ? formatBytes(request.transferSize) : '—'}</td>
								<td>{request.duration !== undefined ? formatTraceDuration(request.duration) : '—'}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function Source({
	trace,
	action,
	onOpenSource
}: {
	trace: TraceReport;
	action: TraceAction | undefined;
	onOpenSource: (file: string, line: number, column?: number) => void;
}) {
	if (action) {
		return action.stack && action.stack.length > 0 ? (
			<StackFrames frames={action.stack} onOpenSource={onOpenSource} />
		) : (
			<p className="test-run-none">
				The trace has no source location for this action. Playwright records them for test steps and, with
				`trace: 'on'` in the test runner, for the calls under them.
			</p>
		);
	}
	if (trace.sources.length === 0) {
		return <p className="test-run-none">The trace names no source files.</p>;
	}
	return (
		<ul className="test-trace-stack">
			{trace.sources.map((file) => (
				<li key={file}>
					<button type="button" className="scan-issue-location" title={file} onClick={() => onOpenSource(file, 1)}>
						{shortPath(file)}
					</button>
				</li>
			))}
		</ul>
	);
}

/** `/ci/e2e/login.spec.ts` → `e2e/login.spec.ts`: the last two segments, enough to recognise a file. */
function shortPath(file: string): string {
	const segments = file.split(/[\\/]+/).filter((segment) => segment.length > 0);
	return segments.length <= 2 ? file : segments.slice(-2).join('/');
}

/** Host and path apart, so the row reads by its path with the host dimmed. */
function splitUrl(url: string): [string, string] {
	const match = /^(\w+:\/\/[^/]+)(.*)$/.exec(url);
	return match ? [match[1], match[2] || '/'] : ['', url];
}
