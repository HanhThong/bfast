// SonarQube's JSON, mapped onto BFAST's own `ScanReport`.
//
// The only file that knows what a `componentKey` is, which is what keeps a
// second scan tool from having to speak SonarQube. Pure and total: junk maps to
// an empty report with `gate: 'none'` and never throws, the `parseComposeLs`
// rule — a server that answered strangely must not take the results tab down.
//
// Four SonarQube facts are encoded here rather than documented and hoped for:
//
//   - `report-task.txt` carries the container's view of the server, so only
//     `ceTaskId` and `projectKey` are read from it and every URL is built by
//     BFAST. This is the single easiest thing in the feature to get wrong.
//   - a metric with no data is **absent** from `measures[]`, so lookups are by
//     name and a missing one renders as `—` rather than `0`.
//   - an issue's `component` is a component *key*, not a path; the readable path
//     is in the sibling `components[]` array and has to be joined.
//   - `impacts[]` is the current severity model and `severity`/`type` the legacy
//     one; reading the first and falling back to the second is what makes one
//     parser work against a 9.9 LTS and a 2026 Community Build alike.

import type {
	GateCondition,
	IssueQuality,
	IssueSeverity,
	QualityGateStatus,
	ScanIssue,
	ScanMeasure,
	ScanReport
} from '../scanReport';

/** What the scanner leaves behind, and where. Relative to the analysed directory. */
export const REPORT_TASK_NAME = 'report-task.txt';
/** The scanner's default working folder, relative to the analysed directory. */
export const SCANNER_WORK_FOLDER = '.scannerwork';
/** Where a scanner left to its defaults writes it — the `command`-mode location. */
export const REPORT_TASK_FILE = `${SCANNER_WORK_FOLDER}/${REPORT_TASK_NAME}`;

export interface ReportTask {
	ceTaskId: string;
	projectKey?: string;
}

/**
 * Reads `report-task.txt`, a Java properties file.
 *
 * Split on the **first** `=` only — a `dashboardUrl` value contains more. Blank
 * lines and `#` comments are skipped. Read as utf8: it is technically
 * ISO-8859-1, but every value BFAST reads is ASCII, and taking on an encoding
 * dependency for that would be absurd — the call `yaml.ts` already makes.
 */
export function parseReportTask(text: string): ReportTask | undefined {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}
		const at = trimmed.indexOf('=');
		if (at <= 0) {
			continue;
		}
		values.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
	}
	const ceTaskId = values.get('ceTaskId');
	if (ceTaskId === undefined || ceTaskId.length === 0) {
		return undefined;
	}
	const projectKey = values.get('projectKey');
	return { ceTaskId, ...(projectKey ? { projectKey } : {}) };
}

/** The metrics BFAST asks for, in the order the tab shows them. */
export const SUMMARY_METRICS: readonly string[] = [
	'bugs',
	'vulnerabilities',
	'security_hotspots',
	'code_smells',
	'coverage',
	'duplicated_lines_density',
	'ncloc'
];

/**
 * The conservative fallback when the full set 400s.
 *
 * An unknown metric key fails the **whole** `measures/component` call rather
 * than returning that one as null, and `bugs`/`vulnerabilities`/`code_smells`
 * are deprecated in favour of the software-quality metrics. So a 400 is retried
 * once with the metric every version has, and the rest is reported as
 * unavailable rather than failing the scan.
 */
export const FALLBACK_METRICS: readonly string[] = ['ncloc'];

const METRIC_LABEL: Record<string, string> = {
	bugs: 'bugs',
	vulnerabilities: 'vulnerabilities',
	security_hotspots: 'security hotspots',
	code_smells: 'code smells',
	coverage: 'coverage',
	duplicated_lines_density: 'duplication',
	ncloc: 'lines'
};

const PERCENT_METRICS = new Set(['coverage', 'duplicated_lines_density']);

/** How many issues the tab holds. Triage, not the dashboard. */
export const MAX_ISSUES = 300;
/** SonarQube's own page-size ceiling. */
export const ISSUE_PAGE_SIZE = 100;

/** `{"task":{"status":"SUCCESS","analysisId":"..."}}` — never throws. */
export interface CeTask {
	status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
	analysisId?: string;
	errorMessage?: string;
	warnings: string[];
}

export function parseCeTask(body: unknown): CeTask {
	const task = readObject(readObject(body)?.task);
	const raw = readString(task, 'status')?.toUpperCase();
	const status: CeTask['status'] =
		raw === 'PENDING' ||
		raw === 'IN_PROGRESS' ||
		raw === 'SUCCESS' ||
		raw === 'FAILED' ||
		raw === 'CANCELED'
			? raw
			: 'UNKNOWN';
	const analysisId = readString(task, 'analysisId');
	const errorMessage = readString(task, 'errorMessage');
	const warnings = Array.isArray(task?.warnings)
		? task.warnings.filter((entry): entry is string => typeof entry === 'string')
		: [];
	return {
		status,
		...(analysisId ? { analysisId } : {}),
		...(errorMessage ? { errorMessage } : {}),
		warnings
	};
}

/** `api/qualitygates/project_status` → the gate and its conditions. */
export function parseQualityGate(body: unknown): {
	gate: QualityGateStatus;
	conditions: GateCondition[];
} {
	const projectStatus = readObject(readObject(body)?.projectStatus);
	const status = readString(projectStatus, 'status')?.toUpperCase();
	const gate: QualityGateStatus =
		status === 'OK' ? 'ok' : status === 'ERROR' ? 'error' : status === 'WARN' ? 'warn' : 'none';

	const raw = Array.isArray(projectStatus?.conditions) ? projectStatus.conditions : [];
	const conditions: GateCondition[] = [];
	for (const entry of raw) {
		const condition = readObject(entry);
		const metric = readString(condition, 'metricKey');
		if (metric === undefined) {
			continue;
		}
		const conditionStatus = readString(condition, 'status')?.toUpperCase();
		// `errorThreshold` is genuinely absent on some conditions; rendering
		// `undefined` beside a real number is worse than rendering nothing.
		const threshold = readString(condition, 'errorThreshold');
		const comparator = readString(condition, 'comparator');
		conditions.push({
			metric,
			label: METRIC_LABEL[metric] ?? metric,
			actual: readString(condition, 'actualValue') ?? '—',
			...(threshold ? { threshold } : {}),
			...(comparator ? { comparator } : {}),
			ok: conditionStatus === 'OK'
		});
	}
	return { gate, conditions };
}

/** `api/measures/component` → the headline numbers, looked up by name. */
export function parseMeasures(body: unknown): ScanMeasure[] {
	const component = readObject(readObject(body)?.component);
	const raw = Array.isArray(component?.measures) ? component.measures : [];

	const byMetric = new Map<string, string>();
	for (const entry of raw) {
		const measure = readObject(entry);
		const metric = readString(measure, 'metric');
		const value = readString(measure, 'value');
		if (metric !== undefined && value !== undefined) {
			byMetric.set(metric, value);
		}
	}

	return SUMMARY_METRICS.map((metric) => {
		const value = byMetric.get(metric);
		return {
			metric,
			label: METRIC_LABEL[metric] ?? metric,
			// Absent, not zero: a project with no tests reporting "0% coverage"
			// would be a lie about code nobody measured.
			...(value === undefined ? {} : { value: formatMeasure(metric, value) }),
			...(PERCENT_METRICS.has(metric) ? { unit: '%' } : {})
		};
	});
}

/** `api/issues/search` → issues with real paths, worst first. */
export function parseIssues(body: unknown): { issues: ScanIssue[]; total?: number } {
	const root = readObject(body);
	const rawIssues = Array.isArray(root?.issues) ? root.issues : [];
	const rawComponents = Array.isArray(root?.components) ? root.components : [];

	// A `component` is a key, not a path; the path is over here.
	const pathByKey = new Map<string, string>();
	for (const entry of rawComponents) {
		const component = readObject(entry);
		const key = readString(component, 'key');
		const filePath = readString(component, 'path') ?? readString(component, 'longName');
		if (key !== undefined && filePath !== undefined) {
			pathByKey.set(key, filePath);
		}
	}

	const issues: ScanIssue[] = [];
	for (const entry of rawIssues) {
		const issue = readObject(entry);
		const key = readString(issue, 'key');
		const rule = readString(issue, 'rule');
		const message = readString(issue, 'message');
		if (key === undefined || rule === undefined || message === undefined) {
			continue;
		}
		const componentKey = readString(issue, 'component');
		const line = readNumber(issue, 'line');
		const impact = firstImpact(issue);
		issues.push({
			key,
			severity: impact.severity,
			quality: impact.quality,
			rule,
			message,
			...(componentKey && pathByKey.has(componentKey)
				? { file: pathByKey.get(componentKey)! }
				: {}),
			...(line === undefined ? {} : { line })
		});
	}

	const paging = readObject(root?.paging);
	const total = readNumber(paging, 'total') ?? readNumber(root, 'total');
	return { issues, ...(total === undefined ? {} : { total }) };
}

/** Assembles the pieces into the one thing the tab and the history entry read. */
export function buildReport(parts: {
	gate: QualityGateStatus;
	conditions: GateCondition[];
	measures: ScanMeasure[];
	issues: ScanIssue[];
	total?: number;
	dashboardUrl?: string;
	scmDisabled?: boolean;
}): ScanReport {
	const capped = parts.issues.slice(0, MAX_ISSUES);
	return {
		gate: parts.gate,
		conditions: parts.conditions,
		measures: parts.measures,
		issues: capped,
		...(parts.total === undefined ? {} : { totalIssues: parts.total }),
		truncated: (parts.total ?? parts.issues.length) > capped.length,
		...(parts.dashboardUrl ? { dashboardUrl: parts.dashboardUrl } : {}),
		...(parts.scmDisabled ? { scmDisabled: true } : {})
	};
}

/**
 * The project's page, built by BFAST.
 *
 * Never taken from `report-task.txt`, whose `dashboardUrl` is the container's
 * view — `http://sonarqube:9000/dashboard?id=…` is meaningless in a browser and
 * would 404 every "Open in SonarQube" click.
 */
export function dashboardUrl(hostUrl: string, projectKey: string): string {
	return `${hostUrl.replace(/\/+$/, '')}/dashboard?id=${encodeURIComponent(projectKey)}`;
}

/** `'82.50562381034781'` → `'82.5'`; a count is left alone. */
function formatMeasure(metric: string, value: string): string {
	if (!PERCENT_METRICS.has(metric)) {
		return value;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? String(Math.round(numeric * 10) / 10) : value;
}

const SEVERITIES: Record<string, IssueSeverity> = {
	BLOCKER: 'blocker',
	CRITICAL: 'high',
	HIGH: 'high',
	MAJOR: 'medium',
	MEDIUM: 'medium',
	MINOR: 'low',
	LOW: 'low',
	INFO: 'info'
};

const QUALITIES: Record<string, IssueQuality> = {
	SECURITY: 'security',
	VULNERABILITY: 'security',
	RELIABILITY: 'reliability',
	BUG: 'reliability',
	MAINTAINABILITY: 'maintainability',
	CODE_SMELL: 'maintainability'
};

/** `impacts[]` first, the legacy `severity`/`type` as the fallback. */
function firstImpact(issue: Record<string, unknown> | undefined): {
	severity: IssueSeverity;
	quality: IssueQuality;
} {
	const impacts = Array.isArray(issue?.impacts) ? issue.impacts : [];
	for (const entry of impacts) {
		const impact = readObject(entry);
		const severity = SEVERITIES[readString(impact, 'severity')?.toUpperCase() ?? ''];
		const quality = QUALITIES[readString(impact, 'softwareQuality')?.toUpperCase() ?? ''];
		if (severity) {
			return { severity, quality: quality ?? 'other' };
		}
	}
	const legacySeverity = SEVERITIES[readString(issue, 'severity')?.toUpperCase() ?? ''];
	const legacyQuality = QUALITIES[readString(issue, 'type')?.toUpperCase() ?? ''];
	return { severity: legacySeverity ?? 'info', quality: legacyQuality ?? 'other' };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = source?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
