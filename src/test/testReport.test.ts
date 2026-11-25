import * as assert from 'assert';
import type { TestRunRecord } from '../data/types';
import {
	aggregateSentence,
	caseAggregate,
	defaultTestCase,
	evidenceCaption,
	evidenceKind,
	formatBytes,
	formatDuration,
	isRed,
	NEVER_RUN_LABEL,
	runHistory,
	sortEvidenceFiles,
	summarySentence,
	testRunComment,
	type TestReport,
	type TestReportCase,
	type TestReportNode,
	type TestRunSummary
} from '../testing/testReport';

const run = (extra: Partial<TestRunRecord> = {}): TestRunRecord => ({
	id: '2026-09-05T10-22-33.123Z',
	outcome: 'passed',
	files: [],
	hasOutput: true,
	...extra
});

suite('Test report', () => {
	// The outcome table in docs/tests/README.md, verbatim: the comment names the
	// run and nothing the run folder already records — no file list, no pattern.
	test('the status comment names the run, or says why there is none', () => {
		const base = { line: 'run TC-1', outcome: 'passed' as const, exitCode: 0, idleSeconds: 300 };
		assert.strictEqual(
			testRunComment({ ...base, run: run({ files: [{ name: 'TC-1.webm' }, { name: 'TC-1.zip' }] }) }),
			'Test run `2026-09-05T10-22-33.123Z` passed: `run TC-1` exited 0.'
		);
		assert.strictEqual(
			testRunComment({ ...base, run: run({ evidencePattern: 'e2e/**/TC-1.*' }) }),
			'Test run `2026-09-05T10-22-33.123Z` passed: `run TC-1` exited 0.'
		);
		assert.strictEqual(
			testRunComment({ ...base, recordError: 'disk full' }),
			'Test run passed: `run TC-1` exited 0. The run could not be recorded: disk full.'
		);
	});

	test('the failed and timeout sentences keep their shape', () => {
		assert.strictEqual(
			testRunComment({ line: 'run', outcome: 'failed', exitCode: 1, idleSeconds: 300, run: run() }),
			'Test run `2026-09-05T10-22-33.123Z` failed: `run` exited 1.'
		);
		assert.strictEqual(
			testRunComment({ line: 'run', outcome: 'timeout', idleSeconds: 300, run: run() }),
			'Test run `2026-09-05T10-22-33.123Z` was stopped: `run` produced no output for 300s.'
		);
	});

	test('the summary sentence is the one every surface shows', () => {
		const summary = (extra: Partial<TestRunSummary>): TestRunSummary => ({
			results: [],
			passed: 0,
			failed: 0,
			errors: 0,
			cancelled: false,
			...extra
		});
		assert.strictEqual(summarySentence('EP-1', summary({})), 'EP-1 has no test cases.');
		assert.strictEqual(
			summarySentence('EP-1', summary({ results: [{} as never], passed: 2, failed: 1, errors: 1, cancelled: true })),
			'Tests: 2 passed, 1 failed. 1 could not be run or recorded. Cancelled the rest.'
		);
		assert.strictEqual(
			summarySentence('EP-1', summary({ passed: 1, abortedWith: { code: 'bad-cwd', message: 'No cwd.' } })),
			'No cwd. 1 passed and 0 failed before it stopped; those statuses stay.'
		);
		assert.strictEqual(
			summarySentence('EP-1', summary({ abortedWith: { code: 'not-found', message: 'Gone.' } })),
			'Gone.'
		);
	});

	test('files sort videos first, the plain name before its second tab, numbers as numbers', () => {
		const sorted = sortEvidenceFiles([
			{ name: 'TC-1.zip' },
			{ name: 'TC-1.page-2.webm' },
			{ name: 'shot-10.png' },
			{ name: 'TC-1.webm' },
			{ name: 'shot-9.png' },
			{ name: 'notes.txt' }
		]).map((file) => file.name);
		assert.deepStrictEqual(sorted, [
			'TC-1.webm',
			'TC-1.page-2.webm',
			'shot-9.png',
			'shot-10.png',
			'notes.txt',
			'TC-1.zip'
		]);
	});

	test('kinds, captions, sizes and durations render as the tab shows them', () => {
		assert.strictEqual(evidenceKind('a.WEBM'), 'video');
		assert.strictEqual(evidenceKind('a.png'), 'image');
		assert.strictEqual(evidenceKind('output.log'), 'text');
		assert.strictEqual(evidenceKind('trace.zip'), 'archive');
		assert.strictEqual(evidenceKind('report.tar.gz'), 'other');
		assert.strictEqual(evidenceCaption('TC-1.page-2.webm'), 'tab 2');
		assert.strictEqual(evidenceCaption('TC-1.page-3.retry-1.webm'), 'tab 3, retry 1');
		assert.strictEqual(evidenceCaption('TC-1.webm'), undefined);
		assert.strictEqual(formatBytes(512), '512 B');
		assert.strictEqual(formatBytes(264931), '259 KB');
		assert.strictEqual(formatBytes(4711002), '4.5 MB');
		assert.strictEqual(formatDuration('2026-09-05T10:22:33.000Z', '2026-09-05T10:23:45.000Z'), '1m 12s');
		assert.strictEqual(formatDuration('2026-09-05T10:22:33.000Z', '2026-09-05T10:22:33.400Z'), '0.4s');
		assert.strictEqual(formatDuration(undefined, '2026-09-05T10:22:33.400Z'), undefined);
	});

	// The two-column tab: the hierarchy's counts, the default selection, the history.

	test('a hierarchy row counts the test cases below it by their latest run', () => {
		const node = (
			id: string,
			type: TestReportNode['type'],
			children: TestReportNode[] = []
		): TestReportNode => ({ id, key: id, title: id, type, status: 'todo', children });
		const tree = node('ST-1', 'story', [
			node('AC-1', 'ac', [node('TC-1', 'testcase'), node('TC-2', 'testcase')]),
			node('AC-2', 'ac'),
			node('TC-3', 'testcase'),
			node('TC-4', 'testcase'),
			node('TC-5', 'testcase')
		]);
		const testCase = (id: string, latest?: TestRunRecord): TestReportCase => ({
			id,
			key: id,
			title: id,
			status: 'todo',
			runCount: latest ? 1 : 0,
			...(latest ? { latest } : {})
		});
		const byId = new Map<string, TestReportCase>([
			['TC-1', testCase('TC-1', run({ outcome: 'passed' }))],
			['TC-2', testCase('TC-2', run({ outcome: 'failed' }))],
			['TC-3', testCase('TC-3', run({ outcome: 'timeout' }))],
			// A folder with no readable record is neither red nor green nor unrun.
			['TC-4', testCase('TC-4', run({ outcome: 'unknown' }))],
			['TC-5', testCase('TC-5')]
		]);

		assert.deepStrictEqual(caseAggregate(tree, byId), { total: 5, passed: 1, failed: 2, notRun: 1 });
		assert.deepStrictEqual(caseAggregate(tree.children[0], byId), { total: 2, passed: 1, failed: 1, notRun: 0 });
		assert.deepStrictEqual(caseAggregate(tree.children[1], byId), { total: 0, passed: 0, failed: 0, notRun: 0 });
		assert.strictEqual(aggregateSentence(caseAggregate(tree, byId)), '1 of 5 passed · 2 failed · 1 not run yet');
		assert.strictEqual(aggregateSentence(caseAggregate(tree.children[0], byId)), '1 of 2 passed · 1 failed');
		assert.strictEqual(aggregateSentence(caseAggregate(tree.children[1], byId)), 'no test cases');
		assert.strictEqual(NEVER_RUN_LABEL, 'Not run yet');
		assert.ok(isRed(run({ outcome: 'failed' })) && isRed(run({ outcome: 'timeout' })));
		assert.ok(!isRed(run({ outcome: 'passed' })) && !isRed(run({ outcome: 'unknown' })) && !isRed(undefined));
	});

	test('the default selection is the first test case in tree order, or none', () => {
		const report = (ids: string[]): TestReport => ({
			ticket: { id: 'EP-1', key: 'EP-1', title: 'Auth', type: 'epic' },
			testCases: ids.map((id) => ({ id, key: id, title: id, status: 'todo', runCount: 0 })),
			tree: [],
			acsWithoutTestCase: 0
		});
		assert.strictEqual(defaultTestCase(report(['TC-1', 'TC-2'])), 'TC-1');
		assert.strictEqual(defaultTestCase(report([])), undefined);
	});

	test('a history lists every run once, newest first, whichever list the latest came from', () => {
		const older = run({ id: '2026-09-05T10-00-00.000Z' });
		const latest = run({ id: '2026-09-05T11-00-00.000Z' });
		const newer = run({ id: '2026-09-05T12-00-00.000Z' });
		const ids = (runs: TestRunRecord[]) => runs.map((item) => item.id);
		assert.deepStrictEqual(ids(runHistory(latest, undefined)), [latest.id]);
		// The fetch lists the latest again; it is not shown twice.
		assert.deepStrictEqual(ids(runHistory(latest, [latest, older])), [latest.id, older.id]);
		// A run that landed between the report and the fetch still sorts on top.
		assert.deepStrictEqual(ids(runHistory(latest, [newer, latest, older])), [newer.id, latest.id, older.id]);
		assert.deepStrictEqual(ids(runHistory(undefined, [older])), [older.id]);
		assert.deepStrictEqual(runHistory(undefined, undefined), []);
	});
});
