// What a scan came back with, and the pure helpers that render it.
//
// **This module is bundled into the webview.** It carries no `vscode` import, no
// `node:` import and no import of `scanProvider.ts` — the results tab renders
// these types, `shared/protocol/` carries them across the bridge, and the seam
// must never be dragged along for the ride. One stray `import * as path` here
// breaks the webview build with a message that reads like an esbuild fault;
// `npm run typecheck:web` is what catches it.
//
// The shapes are BFAST's, not SonarQube's. `sonarResults.ts` maps one onto the
// other and is the only file that knows what a `componentKey` is, which is what
// keeps a second scan tool from having to speak SonarQube.

/** What the tool concluded. `none` means no quality gate is attached. */
export type QualityGateStatus = 'ok' | 'warn' | 'error' | 'none';

/** One quality-gate condition, already rendered into strings. */
export interface GateCondition {
	/** The metric's key, e.g. `new_coverage`. */
	metric: string;
	/** Human-readable — `Coverage on New Code`. Falls back to the key. */
	label: string;
	/** As reported. A string because SonarQube reports them as strings. */
	actual: string;
	/** The threshold that was breached, when the tool gave one. */
	threshold?: string;
	/** `LT`, `GT` — as reported. */
	comparator?: string;
	ok: boolean;
}

/**
 * One headline number. `value` is `undefined` when the project has no data for
 * the metric — a project with no tests must render `—`, never `0`, because "0%
 * coverage" would be a lie about code nobody measured.
 */
export interface ScanMeasure {
	metric: string;
	label: string;
	value?: string;
	/** `%` for a ratio; absent for a count. */
	unit?: string;
}

/** How bad one issue is. Ordered worst-first by `severityRank`. */
export type IssueSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

/** Which kind of quality an issue is about. */
export type IssueQuality = 'security' | 'reliability' | 'maintainability' | 'other';

export interface ScanIssue {
	/** The tool's own id, so a row is stable across a re-render. */
	key: string;
	severity: IssueSeverity;
	quality: IssueQuality;
	/** The rule that fired, e.g. `typescript:S1854`. */
	rule: string;
	message: string;
	/**
	 * Repo-relative path, already resolved from whatever the tool reported.
	 * Never absolute: the host joins it onto the run's own directory and refuses
	 * a result that escapes, because this string arrived over the network.
	 */
	file?: string;
	line?: number;
}

export interface ScanReport {
	gate: QualityGateStatus;
	conditions: GateCondition[];
	measures: ScanMeasure[];
	issues: ScanIssue[];
	/** How many issues the tool actually has, when more than `issues` holds. */
	totalIssues?: number;
	/** True when `issues` was capped — the tab says so rather than implying it is all. */
	truncated: boolean;
	/** The tool's own page for this analysis, built by BFAST, never taken from the tool. */
	dashboardUrl?: string;
	/** Set when the analysis ran without SCM data, which makes "new code" meaningless. */
	scmDisabled?: boolean;
}

/** What one run was pointed at. Small enough to ride on a webview message. */
export interface ScanTargetRef {
	/** The ticket the run was started from; absent for a whole-workspace scan. */
	ticketId?: string;
	/** That ticket's local segment, for a tab title. */
	ticketKey?: string;
	projectKey: string;
	/** The project's display name, when something said one. */
	projectName?: string;
	/**
	 * Where `projectKey` came from, so the setup screen can say "from
	 * sonar-project.properties" rather than leaving the user to guess why the
	 * key in settings was not used.
	 */
	projectKeySource?: ScanProjectKeySource;
	/** Absolute path of the directory analysed. */
	directory: string;
	/** True when `directory` is an environment worktree rather than the workspace. */
	worktree?: boolean;
}

/**
 * Which of the three places the project key was read from, in priority order:
 * the checkout's own properties file, the `scan.projectKey` setting, the
 * workspace folder's name.
 */
export type ScanProjectKeySource = 'properties' | 'settings' | 'folder';

/** The screens the results tab moves through, in order. */
export type ScanPhase = 'setup' | 'preparing' | 'scanning' | 'importing' | 'report';

/** How one run ended. One member per row of the outcome table in docs/scan/README.md. */
export type ScanOutcome =
	| 'passed'
	| 'warn'
	| 'no-gate'
	| 'failed'
	| 'ce-failed'
	| 'scanner-failed'
	| 'timeout'
	| 'unreachable'
	| 'unauthorized'
	| 'cancelled';

/** True for the outcomes that carry a report worth rendering. */
export function hasReport(outcome: ScanOutcome): boolean {
	return outcome === 'passed' || outcome === 'warn' || outcome === 'no-gate' || outcome === 'failed';
}

/** Worst first — the order the issues table and the sidebar's run rows use. */
const SEVERITY_ORDER: readonly IssueSeverity[] = ['blocker', 'high', 'medium', 'low', 'info'];

export function severityRank(severity: IssueSeverity): number {
	const rank = SEVERITY_ORDER.indexOf(severity);
	// An unrecognised severity sorts last rather than first: a tool that grows a
	// new level must not push everything real below it.
	return rank === -1 ? SEVERITY_ORDER.length : rank;
}

export function gateLabel(gate: QualityGateStatus): string {
	switch (gate) {
		case 'ok':
			return 'Passed';
		case 'warn':
			return 'Passed with warnings';
		case 'error':
			return 'Failed';
		case 'none':
			return 'No quality gate';
	}
}

/** The outcome a gate maps to, before any failure overrides it. */
export function outcomeForGate(gate: QualityGateStatus): ScanOutcome {
	switch (gate) {
		case 'ok':
			return 'passed';
		case 'warn':
			return 'warn';
		case 'error':
			return 'failed';
		case 'none':
			return 'no-gate';
	}
}

/**
 * The one-line summary that goes in a ticket's history and in the notification.
 *
 * Built here rather than in the runner so the exact sentence is unit-testable
 * without a store — docs/scan/README.md's outcome table is what it must match.
 */
export function summariseReport(report: ScanReport): string {
	if (report.gate === 'error') {
		const failed = report.conditions.filter((condition) => !condition.ok);
		const shown = failed.slice(0, MAX_SUMMARISED_CONDITIONS).map(conditionSentence);
		const rest = failed.length - shown.length;
		const detail = shown.length > 0 ? shown.join('; ') : 'no condition was reported';
		return `quality gate **ERROR** — ${detail}${rest > 0 ? `; +${rest} more` : ''}.`;
	}
	if (report.gate === 'none') {
		const count = report.totalIssues ?? report.issues.length;
		return `no quality gate is attached; ${count} open ${count === 1 ? 'issue' : 'issues'}.`;
	}
	const headline = report.measures
		.filter((measure) => measure.value !== undefined)
		.map((measure) => `${measure.value}${measure.unit ?? ''} ${measure.label.toLowerCase()}`)
		.join(', ');
	const gate = report.gate === 'warn' ? 'WARN' : 'OK';
	return `quality gate **${gate}**${headline.length > 0 ? ` — ${headline}` : ''}.`;
}

/** Five is enough to act on; a wall of them is what the dashboard is for. */
export const MAX_SUMMARISED_CONDITIONS = 5;

function conditionSentence(condition: GateCondition): string {
	const comparison =
		condition.comparator && condition.threshold
			? ` ${condition.comparator} ${condition.threshold}`
			: '';
	return `${condition.metric} ${condition.actual}${comparison}`;
}
