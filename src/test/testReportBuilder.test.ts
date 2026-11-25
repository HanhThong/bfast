// The Tests tab's first paint, built against a real store on a scratch
// tracker: the flat scope the runner would use, the hierarchy around it, and
// the latest run per test case — driven the way `testBatches.test.ts` drives
// the batches seam.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import type { TestReportNode } from '../testing/testReport';
import { buildTestReport } from '../testing/testReportBuilder';
import { TestResultsStore } from '../testing/testResultsStore';
import type { NewTestRun } from '../testing/testRunFile';

const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-report');
const context: TrackerContext = { rootUri: () => ROOT, author: () => 'Test Runner' };
// Runs live outside the tracker; a second scratch under the same ignore glob.
const RESULTS = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-report-results');
const results = new TestResultsStore({ rootUri: () => RESULTS, author: () => 'Test Runner' });

async function reset(): Promise<void> {
	for (const folder of [ROOT, RESULTS]) {
		try {
			await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
		} catch {
			// Never existed.
		}
	}
}

/** `[id, children]` pairs — the shape alone, without titles and statuses. */
function shape(nodes: TestReportNode[]): unknown[] {
	return nodes.map((node) => [node.id, shape(node.children)]);
}

/** The test cases in the tree, depth first — what the flat list must equal. */
function leaves(nodes: TestReportNode[]): string[] {
	return nodes.flatMap((node) => (node.type === 'testcase' ? [node.id] : leaves(node.children)));
}

function run(startedAt: string, extra: Partial<NewTestRun> = {}): NewTestRun {
	return {
		startedAt,
		finishedAt: startedAt,
		outcome: 'passed' as const,
		exitCode: 0,
		command: 'run TC',
		output: 'ok\n',
		files: [],
		...extra
	};
}

suite('Test report builder', () => {
	let store: FileTicketStore;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		// AC-1.1.1 with TC-1.1.1.1 under it; AC-1.1.2 with none; TC-1.1.1 covering the story.
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		await store.createTicket({ parentId: story.id, type: 'ac', title: 'Locked out' });
		await store.createTicket({ parentId: story.id, type: 'testcase', title: 'Smoke' });
		const other = await store.createTicket({ type: 'epic', title: 'Billing' });
		const otherStory = await store.createTicket({ parentId: other.id, type: 'story', title: 'Pay' });
		await store.createTicket({ parentId: otherStory.id, type: 'testcase', title: 'Card' });
	});

	suiteTeardown(reset);

	test('an epic carries its stories, their criteria and test cases, and nothing from another', async () => {
		const report = await buildTestReport(store, results, 'EP-1');
		assert.ok(report);
		assert.deepStrictEqual(report.ticket, { id: 'EP-1', key: 'EP-1', title: 'Auth', type: 'epic' });
		// Criteria before the story's own test case: the store's sibling order.
		assert.deepStrictEqual(shape(report.tree), [
			['ST-1.1', [['AC-1.1.1', [['TC-1.1.1.1', []]]], ['AC-1.1.2', []], ['TC-1.1.1', []]]]
		]);
		// The flat list is the tree's leaves in the same order — the runner's scope.
		assert.deepStrictEqual(report.testCases.map((testCase) => testCase.id), leaves(report.tree));
		assert.deepStrictEqual(report.testCases.map((testCase) => testCase.id), ['TC-1.1.1.1', 'TC-1.1.1']);
		assert.strictEqual(report.acsWithoutTestCase, 1);

		const story = report.tree[0];
		assert.strictEqual(story.type, 'story');
		assert.strictEqual(story.title, 'Sign in');
		assert.strictEqual(story.key, 'ST-1');
		const [withCase, without] = story.children;
		assert.strictEqual(withCase.warning, undefined);
		assert.ok(typeof without.warning === 'string' && without.warning.length > 0);
		// Structure only: no run data on a leaf, and no ancestry on a case.
		for (const leaf of [withCase.children[0], story.children[2]]) {
			assert.ok(!('latest' in leaf) && !('runCount' in leaf));
		}
		for (const testCase of report.testCases) {
			assert.ok(!('parent' in testCase));
		}
	});

	test("a story's tree is its own children; a test case's is empty", async () => {
		const story = await buildTestReport(store, results, 'ST-1.1');
		assert.ok(story);
		assert.deepStrictEqual(shape(story.tree), [
			['AC-1.1.1', [['TC-1.1.1.1', []]]],
			['AC-1.1.2', []],
			['TC-1.1.1', []]
		]);
		assert.deepStrictEqual(story.testCases.map((testCase) => testCase.id), ['TC-1.1.1.1', 'TC-1.1.1']);

		const criterion = await buildTestReport(store, results, 'AC-1.1.1');
		assert.ok(criterion);
		assert.deepStrictEqual(shape(criterion.tree), [['TC-1.1.1.1', []]]);

		const testCase = await buildTestReport(store, results, 'TC-1.1.1.1');
		assert.ok(testCase);
		assert.strictEqual(testCase.ticket.type, 'testcase');
		assert.deepStrictEqual(testCase.tree, []);
		assert.deepStrictEqual(testCase.testCases.map((item) => item.id), ['TC-1.1.1.1']);
		assert.strictEqual(testCase.acsWithoutTestCase, 0);
	});

	test('the latest run rides on the flat list, with the count of every run', async () => {
		await results.addRun('TC-1.1.1.1', run('2026-09-05T10:00:00.000Z'));
		await results.addRun('TC-1.1.1.1', run('2026-09-05T11:00:00.000Z', { outcome: 'failed', exitCode: 1 }));

		const report = await buildTestReport(store, results, 'EP-1');
		assert.ok(report);
		const [nested, direct] = report.testCases;
		assert.strictEqual(nested.id, 'TC-1.1.1.1');
		assert.strictEqual(nested.latest?.id, '2026-09-05T11-00-00.000Z');
		assert.strictEqual(nested.latest?.outcome, 'failed');
		assert.strictEqual(nested.runCount, 2);
		assert.strictEqual(direct.id, 'TC-1.1.1');
		assert.strictEqual(direct.latest, undefined);
		assert.strictEqual(direct.runCount, 0);
	});

	test('a ticket that is not in the tracker yields no report', async () => {
		assert.strictEqual(await buildTestReport(store, results, 'EP-9'), undefined);
		assert.strictEqual(await buildTestReport(store, results, 'garbage'), undefined);
	});
});
