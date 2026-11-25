// The scan results tab.
//
// Five screens in one document — setup, preparing, scanning, importing, report —
// rather than a notification, because the middle three have to show minutes of
// log while the last one is a table. `phase` is owned by the host, exactly as the
// generate tab's is: it is the flow, not the view, that knows which step it is
// on, so the tab cannot show a Stop button for a run that already finished.
//
// It shares the generate tab's two-column layout and its log pane wholesale —
// they are the same kind of document, and a second set of rules for "a live log
// beside some controls" would only drift.

import { useEffect, useRef, useState } from 'react';
import type { ScanServerStatus } from '../../scan/scanProvider';
import {
	gateLabel,
	severityRank,
	type ScanIssue,
	type ScanOutcome,
	type ScanPhase,
	type ScanProjectKeySource,
	type ScanReport,
	type ScanTargetRef
} from '../../scan/scanReport';
import type { ScanMode } from '../../settings/scanSettings';
import { channel, getState, setState } from '../vscodeApi';
import type { ScanToHost, HostToScan } from '../../shared/protocol';

const { onMessage, postMessage } = channel<ScanToHost, HostToScan>();

interface Context {
	target: ScanTargetRef;
	toolLabel: string;
	mode: ScanMode;
	serverStatus: ScanServerStatus;
	serverUrl?: string;
	available: boolean;
	unavailable?: string;
}

const PHASE_LABEL: Record<ScanPhase, string> = {
	setup: 'Ready',
	preparing: 'Preparing the server',
	scanning: 'Scanning',
	importing: 'Processing the analysis',
	report: 'Done'
};

const KEY_SOURCE_LABEL: Record<ScanProjectKeySource, string> = {
	properties: 'from sonar-project.properties',
	settings: 'from the BFAST settings',
	folder: 'from the folder name'
};

const STATUS_LABEL: Record<ScanServerStatus, string> = {
	absent: 'not deployed',
	deploying: 'deploying',
	stopped: 'stopped',
	starting: 'starting',
	provisioning: 'provisioning',
	running: 'running',
	stopping: 'stopping',
	removing: 'removing',
	error: 'error',
	unknown: 'unknown',
	external: 'external'
};

/** The most a log pane holds. Beyond this the oldest go; the channel has them all. */
const MAX_LOG_LINES = 500;

export function ScanApp() {
	const [context, setContext] = useState<Context | undefined>(undefined);
	const [phase, setPhase] = useState<ScanPhase>('setup');
	const [log, setLog] = useState<string[]>([]);
	const [report, setReport] = useState<ScanReport | undefined>(undefined);
	const [done, setDone] = useState<{ message: string; outcome: ScanOutcome } | undefined>(
		undefined
	);
	const [error, setError] = useState<string | undefined>(undefined);
	/**
	 * Stop is up before the host has spoken.
	 *
	 * `phase` is the host's and does not arrive until after an availability probe
	 * and a store read, so the tab flips the button itself on the click and hands
	 * authority back on the first `scanPhase`.
	 */
	const [starting, setStarting] = useState(false);

	const logRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const unsubscribe = onMessage((message) => {
			switch (message.type) {
				case 'scanContext':
					setContext({
						target: message.target,
						toolLabel: message.toolLabel,
						mode: message.mode,
						serverStatus: message.serverStatus,
						...(message.serverUrl ? { serverUrl: message.serverUrl } : {}),
						available: message.available,
						...(message.unavailable ? { unavailable: message.unavailable } : {})
					});
					// So a reloaded tab comes back to the right target. A run is never
					// restored — see the panel's `revive`.
					setState({ ...getState(), scanTarget: message.target });
					break;
				case 'scanPhase':
					setStarting(false);
					setPhase(message.phase);
					if (message.phase === 'setup') {
						setLog([]);
						setReport(undefined);
						setDone(undefined);
						setError(undefined);
					}
					break;
				case 'scanLog':
					setLog((lines) => [...lines, message.line].slice(-MAX_LOG_LINES));
					break;
				case 'scanReport':
					setReport(message.report);
					break;
				case 'scanDone':
					setStarting(false);
					setDone({ message: message.message, outcome: message.outcome });
					break;
				case 'scanError':
					setStarting(false);
					setError(message.message);
					break;
			}
		});

		postMessage({ type: 'scanReady', ...(getState().scanTarget ? { target: getState().scanTarget } : {}) });
		return unsubscribe;
	}, []);

	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [log]);

	const running = starting || (phase !== 'setup' && phase !== 'report');
	const finished = phase === 'report' || done !== undefined;

	if (!context) {
		return <div className="generate empty">Loading…</div>;
	}

	const start = () => {
		setStarting(true);
		setLog([]);
		setReport(undefined);
		setDone(undefined);
		setError(undefined);
		postMessage({ type: 'scanStart' });
	};

	return (
		<div className="generate">
			<header className="generate-header">
				<h1 className="generate-title">
					Scan — {context.target.ticketKey ?? context.target.ticketId ?? context.target.projectKey}
				</h1>
				<p className="generate-subtitle">
					{context.toolLabel} · project <code>{context.target.projectKey}</code> ·{' '}
					{context.mode === 'external' ? 'external server' : 'server deployed by BFAST'} (
					{STATUS_LABEL[context.serverStatus]})
				</p>
			</header>

			<div className="generate-columns">
				<div className="generate-main">
					<section className="generate-section">
						<h2 className="generate-heading">What will be analysed</h2>
						<p className="settings-hint">
							Project <code>{context.target.projectKey}</code>
							{context.target.projectName && context.target.projectName !== context.target.projectKey
								? ` (${context.target.projectName})`
								: ''}
							{context.target.projectKeySource
								? `, ${KEY_SOURCE_LABEL[context.target.projectKeySource]}`
								: ''}
							.
						</p>
						{context.target.directory.length === 0 ? (
							<p className="settings-error">
								{context.target.ticketId ?? 'This ticket'} has no environment to scan. Create and
								start one from the Environments section, or use Scan Workspace.
							</p>
						) : null}
						<p className="settings-hint">
							<code>{context.target.directory}</code>
							{context.target.worktree ? (
								<>
									{' '}
									— this ticket's environment worktree, so the branch the work is on. SCM data is
									not available inside a worktree, which makes SonarQube's “new code” measures
									meaningless.
								</>
							) : null}
						</p>
						{!context.available && (
							<p className="settings-error">{context.unavailable ?? 'Scanning is not available.'}</p>
						)}
					</section>

					<div className="generate-actions">
						{running ? (
							<button
								type="button"
								className="button danger"
								onClick={() => postMessage({ type: 'scanCancel' })}
							>
								Stop
							</button>
						) : (
							<button
								type="button"
								className="button"
								disabled={!context.available || context.target.directory.length === 0}
								onClick={start}
							>
								{finished ? 'Scan again' : 'Scan'}
							</button>
						)}
						{finished && !running && (
							<button
								type="button"
								className="button secondary"
								onClick={() => postMessage({ type: 'scanReset' })}
							>
								Reset
							</button>
						)}
						<span className="generate-status">{PHASE_LABEL[phase]}</span>
					</div>

					{error && <p className="settings-error settings-error-banner">{error}</p>}

					{done && !error && (
						<p className={done.outcome === 'failed' ? 'settings-error' : 'generate-status'}>
							{done.message}
						</p>
					)}

					{report && <Report report={report} />}
				</div>

				<div className="generate-side">
					<section className="generate-section">
						<h2 className="generate-heading">
							Activity <span className="generate-count">{log.length}</span>
						</h2>
						<div className="generate-log" ref={logRef}>
							{log.length === 0 ? (
								<p className="generate-idle">
									Nothing yet. A first boot pulls about a gigabyte of images and takes several
									minutes — this is where it says so.
								</p>
							) : (
								log.map((line, index) => (
									<div className="generate-log-line" key={index}>
										{line}
									</div>
								))
							)}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}

function Report({ report }: { report: ScanReport }) {
	const failing = report.conditions.filter((condition) => !condition.ok);
	const issues = [...report.issues].sort(
		(a, b) => severityRank(a.severity) - severityRank(b.severity)
	);

	return (
		<>
			<section className="generate-section">
				<h2 className="generate-heading">Quality gate</h2>
				<p className={report.gate === 'error' ? 'settings-error' : 'generate-status'}>
					{gateLabel(report.gate)}
				</p>
				{failing.length > 0 && (
					<ul className="scan-conditions">
						{failing.map((condition) => (
							<li key={condition.metric}>
								<span className="scan-metric">{condition.label}</span>{' '}
								<strong>{condition.actual}</strong>
								{condition.comparator && condition.threshold ? (
									<>
										{' '}
										{condition.comparator} {condition.threshold}
									</>
								) : null}
							</li>
						))}
					</ul>
				)}
				{report.scmDisabled && (
					<p className="settings-hint">
						⚠ Analysed without SCM data, so “new code” measures are not meaningful.
					</p>
				)}
			</section>

			<section className="generate-section">
				<h2 className="generate-heading">Measures</h2>
				<div className="scan-measures">
					{report.measures.map((measure) => (
						<div className="scan-measure" key={measure.metric}>
							{/* A metric with no data shows an em dash, never 0: "0% coverage"
							    would be a lie about code nobody measured. */}
							<span className="scan-measure-value">
								{measure.value === undefined ? '—' : `${measure.value}${measure.unit ?? ''}`}
							</span>
							<span className="scan-measure-label">{measure.label}</span>
						</div>
					))}
				</div>
			</section>

			<section className="generate-section">
				<h2 className="generate-heading">
					Issues <span className="generate-count">{report.totalIssues ?? issues.length}</span>
				</h2>
				{issues.length === 0 ? (
					<p className="generate-idle">No open issues.</p>
				) : (
					<ul className="scan-issues">
						{issues.map((issue) => (
							<Issue issue={issue} key={issue.key} />
						))}
					</ul>
				)}
				{report.truncated && (
					<p className="settings-hint">
						Showing {issues.length} of {report.totalIssues ?? issues.length}. The dashboard has the
						rest — this list is for triage.
					</p>
				)}
				{report.dashboardUrl && (
					<div className="generate-actions">
						<button
							type="button"
							className="button secondary"
							onClick={() =>
								postMessage({ type: 'openScanUrl', url: report.dashboardUrl as string })
							}
						>
							Open in SonarQube
						</button>
					</div>
				)}
			</section>
		</>
	);
}

function Issue({ issue }: { issue: ScanIssue }) {
	const location = issue.file
		? `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}`
		: undefined;
	return (
		<li className={`scan-issue severity-${issue.severity}`}>
			<span className="scan-severity">{issue.severity}</span>
			<div className="scan-issue-body">
				<span className="scan-issue-message">{issue.message}</span>
				<span className="scan-issue-meta">
					{location ? (
						<button
							type="button"
							className="scan-issue-location"
							onClick={() =>
								postMessage({
									type: 'openScanIssue',
									file: issue.file as string,
									...(issue.line === undefined ? {} : { line: issue.line })
								})
							}
						>
							{location}
						</button>
					) : null}
					<code>{issue.rule}</code>
				</span>
			</div>
		</li>
	);
}
