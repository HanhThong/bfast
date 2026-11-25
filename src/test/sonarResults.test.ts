// SonarQube's JSON → BFAST's `ScanReport`.
//
// The payloads below are trimmed from SonarQube's own published response
// examples, so what this pins is the real shape rather than one invented to fit
// the parser. Everything here must be total: junk maps to an empty report and
// never throws, the `parseComposeLs` rule.

import * as assert from 'assert';
import { severityRank, summariseReport } from '../scan/scanReport';
import {
	buildReport,
	dashboardUrl,
	MAX_ISSUES,
	parseCeTask,
	parseIssues,
	parseMeasures,
	parseQualityGate,
	parseReportTask,
	SUMMARY_METRICS
} from '../scan/sonarqube/sonarResults';

const REPORT_TASK = `projectKey=my-app
serverUrl=http://sonarqube:9000
serverVersion=25.9.0.112764
dashboardUrl=http://sonarqube:9000/dashboard?id=my-app
ceTaskId=AVKJ_h9DIK5ABR5tIoQ_
ceTaskUrl=http://sonarqube:9000/api/ce/task?id=AVKJ_h9DIK5ABR5tIoQ_
`;

suite('SonarQube results', () => {
	test('report-task.txt yields the task id and nothing that would build a url', () => {
		const task = parseReportTask(REPORT_TASK);
		assert.deepStrictEqual(task, { ceTaskId: 'AVKJ_h9DIK5ABR5tIoQ_', projectKey: 'my-app' });
	});

	test('a value containing = survives, and comments and blanks are skipped', () => {
		const task = parseReportTask(
			['# a comment', '', 'ceTaskId=abc', 'dashboardUrl=http://x/y?id=a=b'].join('\n')
		);
		assert.strictEqual(task?.ceTaskId, 'abc');
	});

	test('a report-task.txt with no task id is undefined, not a half answer', () => {
		assert.strictEqual(parseReportTask(''), undefined);
		assert.strictEqual(parseReportTask('projectKey=my-app'), undefined);
		assert.strictEqual(parseReportTask('ceTaskId='), undefined);
	});

	test('the dashboard url is built, never taken from the file', () => {
		// The url inside report-task.txt is the container's view — meaningless in
		// a browser, and it would 404 every "Open in SonarQube" click.
		assert.strictEqual(
			dashboardUrl('http://localhost:9000/', 'acme:my app'),
			'http://localhost:9000/dashboard?id=acme%3Amy%20app'
		);
	});

	test('a compute-engine task is read down to its status and analysis id', () => {
		const task = parseCeTask({
			task: {
				id: 'AYhSC2',
				status: 'SUCCESS',
				analysisId: 'AYhSC3WDE6ILQDIMAPIp',
				warnings: ['Missing blame information for 3 files.']
			}
		});
		assert.strictEqual(task.status, 'SUCCESS');
		assert.strictEqual(task.analysisId, 'AYhSC3WDE6ILQDIMAPIp');
		assert.deepStrictEqual(task.warnings, ['Missing blame information for 3 files.']);
	});

	test('a task still queued has no analysis id, and that is not an error', () => {
		const task = parseCeTask({ task: { status: 'PENDING' } });
		assert.strictEqual(task.status, 'PENDING');
		assert.strictEqual(task.analysisId, undefined);
	});

	test('a failed task carries the server own message', () => {
		const task = parseCeTask({ task: { status: 'FAILED', errorMessage: 'Out of memory' } });
		assert.strictEqual(task.status, 'FAILED');
		assert.strictEqual(task.errorMessage, 'Out of memory');
	});

	test('junk maps to an unknown task rather than throwing', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { task: null }, { task: 'x' }]) {
			const task = parseCeTask(raw);
			assert.strictEqual(task.status, 'UNKNOWN', JSON.stringify(raw));
			assert.deepStrictEqual(task.warnings, []);
		}
	});

	test('the quality gate keeps every condition, threshold or not', () => {
		const { gate, conditions } = parseQualityGate({
			projectStatus: {
				status: 'ERROR',
				conditions: [
					{
						status: 'ERROR',
						metricKey: 'new_coverage',
						comparator: 'LT',
						errorThreshold: '85',
						actualValue: '82.50562381034781'
					},
					// No `errorThreshold` — genuinely absent on some conditions.
					{ status: 'OK', metricKey: 'reopened_issues', comparator: 'GT', actualValue: '0' }
				]
			}
		});
		assert.strictEqual(gate, 'error');
		assert.strictEqual(conditions.length, 2);
		assert.deepStrictEqual(conditions[0], {
			metric: 'new_coverage',
			label: 'new_coverage',
			actual: '82.50562381034781',
			threshold: '85',
			comparator: 'LT',
			ok: false
		});
		assert.strictEqual(conditions[1].threshold, undefined);
		assert.strictEqual(conditions[1].ok, true);
	});

	test('every gate status maps, and anything else is none', () => {
		const of = (status: unknown) => parseQualityGate({ projectStatus: { status } }).gate;
		assert.strictEqual(of('OK'), 'ok');
		assert.strictEqual(of('ERROR'), 'error');
		assert.strictEqual(of('WARN'), 'warn');
		assert.strictEqual(of('NONE'), 'none');
		assert.strictEqual(of('surprise'), 'none');
		assert.strictEqual(parseQualityGate(undefined).gate, 'none');
		assert.deepStrictEqual(parseQualityGate('nonsense').conditions, []);
	});

	test('a metric with no data is absent, never zero', () => {
		// A project with no tests reporting "0% coverage" would be a lie about
		// code nobody measured.
		const measures = parseMeasures({
			component: {
				measures: [
					{ metric: 'ncloc', value: '114' },
					{ metric: 'coverage', value: '82.50562381034781' }
				]
			}
		});
		assert.deepStrictEqual(
			measures.map((measure) => measure.metric),
			[...SUMMARY_METRICS]
		);

		const byMetric = new Map(measures.map((measure) => [measure.metric, measure]));
		assert.strictEqual(byMetric.get('ncloc')?.value, '114');
		// Rounded for reading; the unit is carried separately.
		assert.strictEqual(byMetric.get('coverage')?.value, '82.5');
		assert.strictEqual(byMetric.get('coverage')?.unit, '%');
		assert.strictEqual(byMetric.get('bugs')?.value, undefined);
		assert.strictEqual(byMetric.get('bugs')?.unit, undefined);
	});

	test('measures are looked up by name, never by index', () => {
		// The order the server answers in is not the order BFAST asks in.
		const measures = parseMeasures({
			component: { measures: [{ metric: 'code_smells', value: '41' }] }
		});
		const smells = measures.find((measure) => measure.metric === 'code_smells');
		assert.strictEqual(smells?.value, '41');
		assert.strictEqual(smells?.label, 'code smells');
	});

	test('an issue component key becomes a readable path', () => {
		const { issues, total } = parseIssues({
			paging: { pageIndex: 1, pageSize: 100, total: 1 },
			issues: [
				{
					key: '01fc972e',
					rule: 'java:S1144',
					component: 'com.github:http-request:src/main/java/HttpRequest.java',
					line: 81,
					message: 'Remove this unused private "getKee" method.',
					impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'HIGH' }]
				}
			],
			components: [
				{
					key: 'com.github:http-request:src/main/java/HttpRequest.java',
					qualifier: 'FIL',
					path: 'src/main/java/HttpRequest.java'
				}
			]
		});

		assert.strictEqual(total, 1);
		assert.deepStrictEqual(issues[0], {
			key: '01fc972e',
			severity: 'high',
			quality: 'maintainability',
			rule: 'java:S1144',
			message: 'Remove this unused private "getKee" method.',
			// The component was a key; the path came from the sibling array.
			file: 'src/main/java/HttpRequest.java',
			line: 81
		});
	});

	test('impacts win, and the legacy severity is the fallback', () => {
		// One parser has to work against a 9.9 LTS and a 2026 Community Build.
		const modern = parseIssues({
			issues: [
				{
					key: 'a',
					rule: 'r',
					message: 'm',
					severity: 'MINOR',
					type: 'CODE_SMELL',
					impacts: [{ softwareQuality: 'SECURITY', severity: 'BLOCKER' }]
				}
			]
		});
		assert.strictEqual(modern.issues[0].severity, 'blocker');
		assert.strictEqual(modern.issues[0].quality, 'security');

		const legacy = parseIssues({
			issues: [{ key: 'a', rule: 'r', message: 'm', severity: 'CRITICAL', type: 'BUG' }]
		});
		assert.strictEqual(legacy.issues[0].severity, 'high');
		assert.strictEqual(legacy.issues[0].quality, 'reliability');
	});

	test('an issue missing what it needs is dropped, not half-rendered', () => {
		const { issues } = parseIssues({
			issues: [
				{ key: 'a', rule: 'r', message: 'm' },
				{ rule: 'r', message: 'm' },
				{ key: 'b', message: 'm' },
				'nonsense',
				null
			]
		});
		assert.deepStrictEqual(
			issues.map((issue) => issue.key),
			['a']
		);
		// And a component key with no matching path leaves the file absent rather
		// than showing `com.foo:bar:src/x.ts`, which nobody can find.
		assert.strictEqual(issues[0].file, undefined);
	});

	test('junk maps to no issues rather than throwing', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { issues: 'x' }]) {
			assert.deepStrictEqual(parseIssues(raw).issues, [], JSON.stringify(raw));
		}
	});

	test('severity sorts worst first, and an unknown level sorts last', () => {
		const order = ['info', 'low', 'medium', 'high', 'blocker'] as const;
		const sorted = [...order].sort((a, b) => severityRank(a) - severityRank(b));
		assert.deepStrictEqual(sorted, ['blocker', 'high', 'medium', 'low', 'info']);
		// A tool that grows a new level must not push everything real below it.
		assert.ok(severityRank('surprise' as never) > severityRank('info'));
	});

	test('the report caps its issues and says so', () => {
		const many = Array.from({ length: MAX_ISSUES + 50 }, (_, index) => ({
			key: `k${index}`,
			severity: 'low' as const,
			quality: 'other' as const,
			rule: 'r',
			message: 'm'
		}));
		const report = buildReport({
			gate: 'ok',
			conditions: [],
			measures: [],
			issues: many,
			total: many.length
		});
		assert.strictEqual(report.issues.length, MAX_ISSUES);
		assert.strictEqual(report.totalIssues, MAX_ISSUES + 50);
		assert.strictEqual(report.truncated, true);

		const small = buildReport({ gate: 'ok', conditions: [], measures: [], issues: [], total: 0 });
		assert.strictEqual(small.truncated, false);
	});

	test('the summary sentence matches the outcome table', () => {
		// docs/scan/README.md is what this must keep matching.
		const failed = summariseReport(
			buildReport({
				gate: 'error',
				conditions: [
					{
						metric: 'new_coverage',
						label: 'new_coverage',
						actual: '82.5',
						threshold: '85',
						comparator: 'LT',
						ok: false
					},
					{
						metric: 'new_blocker_violations',
						label: 'new_blocker_violations',
						actual: '14',
						threshold: '0',
						comparator: 'GT',
						ok: false
					},
					{ metric: 'coverage', label: 'coverage', actual: '90', ok: true }
				],
				measures: [],
				issues: []
			})
		);
		assert.strictEqual(
			failed,
			'quality gate **ERROR** — new_coverage 82.5 LT 85; new_blocker_violations 14 GT 0.'
		);

		const passed = summariseReport(
			buildReport({
				gate: 'ok',
				conditions: [],
				measures: [
					{ metric: 'bugs', label: 'bugs', value: '0' },
					{ metric: 'coverage', label: 'coverage', value: '78.2', unit: '%' },
					// No value: it must not appear in the sentence at all.
					{ metric: 'code_smells', label: 'code smells' }
				],
				issues: []
			})
		);
		assert.strictEqual(passed, 'quality gate **OK** — 0 bugs, 78.2% coverage.');

		const none = summariseReport(
			buildReport({ gate: 'none', conditions: [], measures: [], issues: [], total: 43 })
		);
		assert.strictEqual(none, 'no quality gate is attached; 43 open issues.');
	});

	test('a long list of failing conditions is capped with a count', () => {
		const conditions = Array.from({ length: 8 }, (_, index) => ({
			metric: `m${index}`,
			label: `m${index}`,
			actual: '1',
			threshold: '0',
			comparator: 'GT',
			ok: false
		}));
		const summary = summariseReport(
			buildReport({ gate: 'error', conditions, measures: [], issues: [] })
		);
		assert.ok(summary.includes('+3 more'), summary);
		assert.ok(summary.includes('m0 1 GT 0'), summary);
		assert.ok(!summary.includes('m5'), summary);
	});
});
