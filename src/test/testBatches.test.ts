// The batches seam — "a test case belongs to at most one running batch",
// held across both surfaces, driven here against a real store and a scripted
// runner exactly as `testRunner.test.ts` drives the runner.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import { createTestBatches, type TestBatches } from '../testing/testBatches';
import type { TestBatchProgress } from '../testing/testReport';
import { TestResultsStore } from '../testing/testResultsStore';
import { FakeProcessRunner } from './fakeProcessRunner';

const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-batches');
const context: TrackerContext = { rootUri: () => ROOT, author: () => 'Test Runner' };
const RESULTS = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-batches-results');
const results = new TestResultsStore({ rootUri: () => RESULTS, author: () => 'Test Runner' });
const WORKSPACE_ROOT = vscode.workspace.workspaceFolders![0].uri.fsPath;

async function settled(until: () => boolean, ticks = 200): Promise<void> {
	for (let attempt = 0; attempt < ticks && !until(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function reset(): Promise<void> {
	for (const folder of [ROOT, RESULTS]) {
		try {
			await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
		} catch {
			// Never existed.
		}
	}
}

suite('Test batches', () => {
	let store: FileTicketStore;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		await store.createTicket({ parentId: story.id, type: 'testcase', title: 'Smoke' });
		const other = await store.createTicket({ type: 'epic', title: 'Billing' });
		const otherStory = await store.createTicket({ parentId: other.id, type: 'story', title: 'Pay' });
		await store.createTicket({ parentId: otherStory.id, type: 'testcase', title: 'Card' });
	});

	suiteTeardown(reset);

	/** An empty command means the feature is unconfigured. */
	function batches(fake: FakeProcessRunner, command = 'run {{id}}'): TestBatches {
		return createTestBatches({
			store,
			results,
			runner: fake.runner,
			settings: () => (command === '' ? undefined : { command }),
			workspaceRoot: () => WORKSPACE_ROOT
		});
	}

	function collect(under: TestBatches): { root: string; event: TestBatchProgress }[] {
		const events: { root: string; event: TestBatchProgress }[] = [];
		under.onDidProgress((root, event) => events.push({ root, event }));
		return events;
	}

	test('an unconfigured command is refused with the settings answer', async () => {
		const started = await batches(new FakeProcessRunner(), '').start('EP-1');
		assert.ok(started.kind === 'refused' && started.reason === 'unconfigured');
	});

	test('a batch runs to done, and every event carries its root', async () => {
		const under = batches(new FakeProcessRunner({ failAt: [1] }));
		const events = collect(under);

		const started = await under.start('EP-1');
		assert.ok(started.kind === 'started');
		assert.strictEqual(under.batchFor('EP-1'), 'EP-1');
		assert.strictEqual(under.batchFor('TC-1.1.1.1'), 'EP-1', 'a test case is in its root’s batch');
		assert.strictEqual(under.batchFor('TC-2.1.1'), undefined);

		const summary = await started.completed;
		assert.strictEqual(summary?.passed, 1);
		assert.strictEqual(summary?.failed, 1);
		assert.ok(events.every((entry) => entry.root === 'EP-1'));
		// The failing run streams its stderr; the lifecycle around it is what is pinned.
		assert.deepStrictEqual(
			events.map((entry) => entry.event.kind).filter((kind) => kind !== 'output'),
			['scope', 'started', 'result', 'started', 'result', 'done']
		);
		const done = events[events.length - 1].event;
		assert.ok(done.kind === 'done' && done.message === 'Tests: 1 passed, 1 failed.');
		assert.strictEqual(under.batchFor('EP-1'), undefined, 'gone once done');
	});

	test('a second start on a running root is refused; a disjoint root is not', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);

		const first = await under.start('EP-1');
		assert.ok(first.kind === 'started');
		const again = await under.start('EP-1');
		assert.ok(again.kind === 'refused' && again.reason === 'running');
		assert.ok(again.kind === 'refused' && again.message.includes('EP-1'));

		const disjoint = await under.start('EP-2');
		assert.ok(disjoint.kind === 'started');

		under.cancel('EP-1');
		under.cancel('EP-2');
		await first.completed;
		await disjoint.completed;
	});

	test('a root whose test cases are in a running batch is refused, naming that batch', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);

		const story = await under.start('ST-1.1');
		assert.ok(story.kind === 'started');
		// The AC's only test case is running as part of the story.
		const ac = await under.start('AC-1.1.1');
		assert.ok(ac.kind === 'refused' && ac.reason === 'overlap');
		assert.strictEqual(ac.kind === 'refused' && ac.message, 'TC-1.1.1.1 is already running as part of ST-1.1.');
		// And so is the epic above it.
		const epic = await under.start('EP-1');
		assert.ok(epic.kind === 'refused' && epic.reason === 'overlap');

		under.cancel('ST-1.1');
		await story.completed;
		// Free again once it is over.
		const after = await under.start('AC-1.1.1');
		assert.ok(after.kind === 'started');
		under.cancel('AC-1.1.1');
		await after.completed;
	});

	test('a ticket that is not there is refused as not-found', async () => {
		const started = await batches(new FakeProcessRunner()).start('EP-9');
		assert.ok(started.kind === 'refused' && started.reason === 'not-found');
	});

	test('cancel before the first spawn is remembered and spent', async () => {
		const fake = new FakeProcessRunner();
		const under = batches(fake);
		const events = collect(under);
		// Cancel the instant it is claimed, before the runner has a handle.
		const starting = under.start('EP-1');
		under.cancel('EP-1');
		const started = await starting;
		assert.ok(started.kind === 'started');
		const summary = await started.completed;
		assert.strictEqual(summary?.cancelled, true);
		assert.strictEqual(fake.requests.length, 0);
		assert.ok(events.some((entry) => entry.event.kind === 'done'));
	});

	test('cancel mid-batch reaches the live run from either surface', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);
		const started = await under.start('EP-1');
		assert.ok(started.kind === 'started');
		await settled(() => fake.hanging.length === 1);
		// A board on the test case cancels the batch it is in — the root's.
		under.cancel(under.batchFor('TC-1.1.1.1') ?? 'TC-1.1.1.1');
		const summary = await started.completed;
		assert.strictEqual(summary?.cancelled, true);
		assert.strictEqual(fake.cancelled, 1);
	});

	test('a runner that throws still ends the batch, with done and no summary', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);
		const events = collect(under);
		const started = await under.start('TC-1.1.1');
		assert.ok(started.kind === 'started');
		await settled(() => fake.hanging.length === 1);
		// Not a ProcessError: the runner rethrows, which is a programming error.
		fake.hanging[0].rejectNow(new Error('boom'));
		const summary = await started.completed;
		assert.strictEqual(summary, undefined);
		const done = events[events.length - 1].event;
		assert.ok(done.kind === 'done' && done.summary === undefined && done.message === 'boom');
		assert.strictEqual(under.batchFor('TC-1.1.1'), undefined);
	});

	test('a runner that throws takes the rest of its batch down with it', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);
		const started = await under.start('EP-1');
		assert.ok(started.kind === 'started');
		await settled(() => fake.hanging.length === 1);
		fake.hanging[0].rejectNow(new Error('boom'));
		const summary = await started.completed;
		assert.strictEqual(summary, undefined);
		// The second test case was queued behind the first; it never spawned.
		assert.strictEqual(fake.requests.length, 1);
		assert.strictEqual(under.batchFor('TC-1.1.1'), undefined);
	});

	test('a snapshot shows a late subscriber where the batch has got to', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const under = batches(fake);
		const started = await under.start('ST-1.1');
		assert.ok(started.kind === 'started');
		await settled(() => fake.hanging.length === 1);
		fake.hanging[0].emit({ stdout: 'first line\nsecond', stderr: '' });

		const snapshot = under.snapshot('ST-1.1');
		assert.ok(snapshot);
		assert.strictEqual(snapshot?.root, 'ST-1.1');
		assert.strictEqual(snapshot?.lanes['TC-1.1.1.1'].status, 'running');
		assert.strictEqual(snapshot?.lanes['TC-1.1.1'].status, 'waiting');
		// Whole lines only: the unfinished one waits for its newline.
		assert.deepStrictEqual(snapshot?.log, [{ testCase: 'TC-1.1.1.1', text: 'first line' }]);
		assert.strictEqual(under.snapshot('EP-2'), undefined);

		under.cancel('ST-1.1');
		await started.completed;
	});
});
