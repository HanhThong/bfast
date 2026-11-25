// The "Run Tests" flow, end to end — see docs/tests/ for the contract.
//
// Drives `runTests` against a real `FileTicketStore` and a scripted
// `FakeProcessRunner`, the `generateChildren.test.ts` shape: the tracker is a
// scratch folder reached through a `TrackerContext` rather than through
// `SettingsService`, so nothing here can flip `bfast.configured` or make the
// other suites depend on run order. The `.gitignore` glob
// `src/test/fixtures/workspace/.tracker*/` covers the scratch on a crashed run.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import { ProcessError } from '../platform/runProcess';
import type { TestsSettings } from '../settings/testsSettings';
import type { EvidenceFinder } from '../testing/evidenceGlob';
import { testCaseResultsFolder } from '../testing/testResultsPaths';
import { TestResultsStore } from '../testing/testResultsStore';
import type { NewTestRun } from '../testing/testRunFile';
import { runTests, type TestRunDeps, type TestRunProgress } from '../testing/testRunner';
import { quoteShellArgument } from '../platform/shellCommand';
import { sharedLimiter } from '../platform/semaphore';
import { shellCommand } from '../platform/shellCommand';
import { FakeProcessRunner } from './fakeProcessRunner';

const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-tests');

const context: TrackerContext = {
	rootUri: () => ROOT,
	author: () => 'Test Runner'
};

const WORKSPACE_ROOT = vscode.workspace.workspaceFolders![0].uri.fsPath;

// Runs are filed outside the tracker — a second scratch, under the same
// `.tracker*/` ignore, standing in for `<workspace>/.bfast/test-results`.
const RESULTS = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-results');
const results = new TestResultsStore({ rootUri: () => RESULTS, author: () => 'Test Runner' });

// A scratch source tree the evidence pattern walks — inside the fixture, so
// `tests.cwd` can stay relative, under a name the `.tracker*/` ignore covers.
// (A line comment: that glob would close a block comment early.)
const SOURCE = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-evidence');

async function writeSource(relative: string, content = 'bytes'): Promise<string> {
	const uri = vscode.Uri.joinPath(SOURCE, ...relative.split('/'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	return uri.fsPath;
}

async function listingUnder(root: vscode.Uri, parts: string[]): Promise<string[]> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...parts));
		return entries.map(([name]) => name).sort();
	} catch {
		return [];
	}
}

/** A folder in the tracker. */
const listing = (...parts: string[]) => listingUnder(ROOT, parts);
/** A folder in the results store: a test case's id, then a run id. */
const resultsListing = (...parts: string[]) => listingUnder(RESULTS, parts);

async function readText(...parts: string[]): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(
			await vscode.workspace.fs.readFile(vscode.Uri.joinPath(RESULTS, ...parts))
		);
	} catch {
		return undefined;
	}
}

/** The one run folder a test case has, or undefined. */
async function runFolderOf(testCaseId: string): Promise<string | undefined> {
	const runs = await resultsListing(testCaseResultsFolder(testCaseId));
	return runs[0];
}

const TC_1_1_1 = ['EP-1-Auth', 'ST-1.1-Sign_in', 'TC-1.1.1-Smoke'];
const TC_1_1_1_1 = ['EP-1-Auth', 'ST-1.1-Sign_in', 'AC-1.1.1-Wrong_password', 'TC-1.1.1.1-Same_message'];

/** A finder that answers with what the test says, and remembers what it was asked. */
function scriptedFinder(
	answer: () => Promise<{ path: string; size: number; mtimeMs: number }[]>
): EvidenceFinder & { calls: string[] } {
	const finder = (async (_root: string, pattern: string) => {
		finder.calls.push(pattern);
		return { matches: await answer(), truncated: false };
	}) as EvidenceFinder & { calls: string[] };
	finder.calls = [];
	return finder;
}

/** A finder that holds every answer until the test releases it. */
function heldFinder(): { finder: EvidenceFinder; pending: () => number; release: () => void } {
	const waiting: (() => void)[] = [];
	return {
		finder: (_root, _pattern) =>
			new Promise((resolve) => waiting.push(() => resolve({ matches: [], truncated: false }))),
		pending: () => waiting.length,
		release: () => waiting.shift()?.()
	};
}

/** Waits for a condition the flow reaches on its own microtasks. */
async function settled(until: () => boolean, ticks = 200): Promise<void> {
	for (let attempt = 0; attempt < ticks && !until(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function reset(): Promise<void> {
	for (const folder of [ROOT, SOURCE, RESULTS]) {
		try {
			await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
		} catch {
			// Never existed.
		}
	}
}

/** The rendered line, unwrapped from the platform shell's quoting. */
function lineOf(request: { args: string[] }): string {
	return request.args[request.args.length - 1].replace(/^"|"$/g, '');
}

suite('Test runner', () => {
	let store: FileTicketStore;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		// One TC under an AC and two directly under the story, so scope and order
		// (the AC's first, the direct ones after) are both exercised.
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		await store.createTicket({ parentId: story.id, type: 'testcase', title: 'Smoke' });
		await store.createTicket({ parentId: story.id, type: 'testcase', title: 'Smoke two' });
	});

	suiteTeardown(reset);

	function deps(
		fake: FakeProcessRunner,
		tests: TestsSettings = { command: 'run {{id}}' },
		extra: Partial<TestRunDeps> = {}
	): TestRunDeps {
		return {
			store,
			results,
			runner: fake.runner,
			settings: () => tests,
			workspaceRoot: () => WORKSPACE_ROOT,
			...extra
		};
	}

	test('runs every test case under the ticket, in tree order, and records each result', async () => {
		const fake = new FakeProcessRunner({ failAt: [1] });
		const events: TestRunProgress[] = [];

		const summary = await runTests(deps(fake, { command: 'run {{id}}' }, { onProgress: (p) => events.push(p) }), 'EP-1');

		assert.deepStrictEqual(fake.requests.map(lineOf), [
			'run TC-1.1.1.1',
			'run TC-1.1.1',
			'run TC-1.1.2'
		]);
		assert.strictEqual(summary.passed, 2);
		assert.strictEqual(summary.failed, 1);
		assert.strictEqual(summary.errors, 0);
		assert.strictEqual(summary.cancelled, false);
		assert.strictEqual(summary.abortedWith, undefined);

		// Pass → done, fail → blocked, each naming the run as its provenance.
		const passedTc = await store.getDetail('TC-1.1.1.1');
		assert.strictEqual(passedTc?.status, 'done');
		assert.strictEqual(
			passedTc?.history[passedTc.history.length - 1].comment,
			`Test run \`${summary.results[0].run?.id}\` passed: \`run TC-1.1.1.1\` exited 0.`
		);
		const failedTc = await store.getDetail('TC-1.1.1');
		assert.strictEqual(failedTc?.status, 'blocked');
		assert.strictEqual(
			failedTc?.history[failedTc.history.length - 1].comment,
			`Test run \`${summary.results[1].run?.id}\` failed: \`run TC-1.1.1\` exited 1.`
		);

		// The progress stream carried one result per test case, counted up.
		const results = events.filter(
			(event): event is Extract<TestRunProgress, { kind: 'result' }> => event.kind === 'result'
		);
		assert.strictEqual(results.length, 3);
		assert.strictEqual(results[2].done, 3);
		assert.strictEqual(results[2].total, 3);
	});

	test('a test case ticket runs only itself', async () => {
		const fake = new FakeProcessRunner();
		const summary = await runTests(deps(fake), 'TC-1.1.1');

		assert.deepStrictEqual(fake.requests.map(lineOf), ['run TC-1.1.1']);
		assert.strictEqual(summary.passed, 1);
	});

	test('the snapshot settings reach the spawn: cwd, idle window, retained tail', async () => {
		const fake = new FakeProcessRunner();
		await runTests(deps(fake, { command: 'run {{id}}', idleTimeout: 60 }), 'TC-1.1.1');

		assert.strictEqual(fake.requests[0].cwd, WORKSPACE_ROOT);
		assert.strictEqual(fake.requests[0].idleTimeoutMs, 60_000);
		assert.ok((fake.requests[0].maxBufferedOutput ?? 0) > 0);
	});

	test('a working directory that does not exist aborts before anything spawns', async () => {
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', cwd: 'no-such-folder' }),
			'EP-1'
		);

		assert.strictEqual(summary.abortedWith?.code, 'bad-cwd');
		assert.ok(summary.abortedWith?.message.includes('no-such-folder'));
		assert.strictEqual(fake.requests.length, 0);
	});

	test('a ticket no longer in the tracker aborts with not-found, not "no test cases"', async () => {
		const fake = new FakeProcessRunner();
		const summary = await runTests(deps(fake), 'EP-9');

		assert.strictEqual(summary.abortedWith?.code, 'not-found');
		assert.ok(summary.abortedWith?.message.includes('EP-9'));
		assert.strictEqual(fake.requests.length, 0);
	});

	test('a scope with no test cases comes back empty and unaborted', async () => {
		const fake = new FakeProcessRunner();
		// A fresh epic with no descendants at all.
		await store.createTicket({ type: 'epic', title: 'Empty' });
		const summary = await runTests(deps(fake), 'EP-2');

		assert.deepStrictEqual(summary.results, []);
		assert.strictEqual(summary.abortedWith, undefined);
		assert.strictEqual(fake.requests.length, 0);
	});

	test('a run that goes quiet is recorded as blocked with the window in the comment', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const running = runTests(deps(fake), 'TC-1.1.1');

		await settled(() => fake.hanging.length === 1);
		fake.hanging[0].rejectNow(new ProcessError('timeout', '`cmd.exe` went quiet and was stopped.'));
		const summary = await running;

		assert.strictEqual(summary.failed, 1);
		assert.strictEqual(summary.results[0].outcome, 'timeout');
		const ticket = await store.getDetail('TC-1.1.1');
		assert.strictEqual(ticket?.status, 'blocked');
		assert.strictEqual(
			ticket?.history[ticket.history.length - 1].comment,
			`Test run \`${summary.results[0].run?.id}\` was stopped: \`run TC-1.1.1\` produced no output for 300s.`
		);
	});

	test('a shell that will not start aborts the batch; nothing more spawns or writes', async () => {
		const fake = new FakeProcessRunner({ missingAt: [0] });
		const summary = await runTests(deps(fake), 'EP-1');

		assert.strictEqual(summary.abortedWith?.code, 'spawn-failed');
		assert.strictEqual(fake.requests.length, 1);
		assert.deepStrictEqual(
			summary.results.map((result) => result.outcome),
			['error', 'skipped', 'skipped']
		);
		// An abort is not a cancel — the user pressed nothing.
		assert.strictEqual(summary.cancelled, false);
		// No status moved: the system was broken, not the tests.
		for (const id of ['TC-1.1.1.1', 'TC-1.1.1', 'TC-1.1.2']) {
			assert.strictEqual((await store.getDetail(id))?.status, 'todo');
		}
	});

	test('cancel before the first spawn skips everything', async () => {
		const fake = new FakeProcessRunner();
		const summary = await runTests(deps(fake), 'EP-1', {
			// The bridge calls the handed-back cancel straight away when the token
			// was already cancelled — this is that case.
			onCancel: (cancel) => cancel()
		});

		assert.strictEqual(fake.requests.length, 0);
		assert.strictEqual(summary.cancelled, true);
		assert.deepStrictEqual(
			summary.results.map((result) => result.outcome),
			['skipped', 'skipped', 'skipped']
		);
	});

	test('cancel mid-batch keeps what finished, kills what runs, skips the queue', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 1 });
		let cancelRun: (() => void) | undefined;
		const running = runTests(deps(fake), 'EP-1', { onCancel: (cancel) => (cancelRun = cancel) });

		// The first run resolved; the second hangs; the third waits on the slot.
		await settled(() => fake.hanging.length === 1);
		cancelRun?.();
		const summary = await running;

		assert.deepStrictEqual(
			summary.results.map((result) => result.outcome),
			['passed', 'cancelled', 'skipped']
		);
		assert.strictEqual(summary.cancelled, true);
		assert.strictEqual(fake.requests.length, 2);
		assert.strictEqual(fake.cancelled, 1);
		// The finished status stays; a cancel rolls nothing back.
		assert.strictEqual((await store.getDetail('TC-1.1.1.1'))?.status, 'done');
		assert.strictEqual((await store.getDetail('TC-1.1.1'))?.status, 'todo');
	});

	test('concurrency bounds how many spawn at once; the default is sequential', async () => {
		const sequential = new FakeProcessRunner({ hangFrom: 0 });
		const one = runTests(deps(sequential), 'EP-1');
		for (let index = 0; index < 3; index += 1) {
			await settled(() => sequential.hanging.length === index + 1);
			assert.strictEqual(sequential.requests.length, index + 1, 'the default runs one at a time');
			sequential.hanging[index].resolveNow({ code: 0, stdout: '', stderr: '' });
		}
		await one;

		const parallel = new FakeProcessRunner({ hangFrom: 0 });
		const two = runTests(deps(parallel, { command: 'run {{id}}', concurrency: 2 }), 'EP-1');
		await settled(() => parallel.hanging.length === 2);
		assert.strictEqual(parallel.requests.length, 2, 'two slots, third waits');
		parallel.hanging[0].resolveNow({ code: 0, stdout: '', stderr: '' });
		parallel.hanging[1].resolveNow({ code: 0, stdout: '', stderr: '' });
		await settled(() => parallel.hanging.length === 3);
		parallel.hanging[2].resolveNow({ code: 0, stdout: '', stderr: '' });
		const summary = await two;
		assert.strictEqual(summary.passed, 3);
	});

	test('{{folder}} resolves to the ticket folder on disk', async () => {
		const fake = new FakeProcessRunner();
		await runTests(deps(fake, { command: 'run "{{folder}}"' }), 'TC-1.1.1.1');

		assert.ok(
			lineOf(fake.requests[0]).includes('TC-1.1.1.1-Same_message'),
			`got: ${lineOf(fake.requests[0])}`
		);
	});

	// The cap is the window's, not the batch's — at the default of one, two Run
	// Tests batches must no more overlap than two test cases in one batch do.
	// The databases a suite shares do not care which batch a command came from.
	test('two batches share one concurrency cap', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const slots = sharedLimiter(() => 1);

		const first = runTests(deps(fake, { command: 'run {{id}}', concurrency: 1 }, { slots }), 'TC-1.1.1');
		const second = runTests(deps(fake, { command: 'run {{id}}', concurrency: 1 }, { slots }), 'TC-1.1.2');

		await settled(() => fake.hanging.length > 0);
		assert.strictEqual(fake.hanging.length, 1, 'the second batch waits for the first’s slot');

		fake.hanging[0].resolveNow({ code: 0, stdout: '', stderr: '' });
		await settled(() => fake.hanging.length > 1);
		assert.strictEqual(fake.hanging.length, 2, 'and takes it as soon as it frees');

		fake.hanging[1].resolveNow({ code: 0, stdout: '', stderr: '' });
		assert.strictEqual((await first).passed, 1);
		assert.strictEqual((await second).passed, 1);
	});

	// ------------------------------------------------------------- evidence

	test('a run files its output and its record under <results>/<id>/<runId>/, colour stripped', async () => {
		const fake = new FakeProcessRunner({
			results: [{ stdout: '\x1b[32m✓\x1b[0m 1 passed\n', stderr: '' }]
		});
		const summary = await runTests(deps(fake), 'TC-1.1.1');

		const result = summary.results[0];
		assert.strictEqual(result.outcome, 'passed');
		assert.ok(result.run, 'the run was recorded');
		assert.strictEqual(result.run?.outcome, 'passed');
		assert.strictEqual(result.run?.hasOutput, true);
		assert.deepStrictEqual(result.run?.files, []);
		assert.strictEqual(result.message, undefined);

		const runId = await runFolderOf('TC-1.1.1');
		assert.strictEqual(runId, result.run?.id);
		assert.deepStrictEqual(await resultsListing('TC-1.1.1', runId!), ['output.log', 'run.json']);
		assert.strictEqual(await readText('TC-1.1.1', runId!, 'output.log'), '✓ 1 passed\n');
		const record = JSON.parse((await readText('TC-1.1.1', runId!, 'run.json')) ?? '{}');
		assert.strictEqual(record.command, 'run TC-1.1.1');
		assert.strictEqual(record.author, 'Test Runner');
		// And nothing landed in the tracker but the status.
		assert.deepStrictEqual(await listing(...TC_1_1_1), ['TestCase.mdx', 'history.md', 'metadata.yaml']);
	});

	test('evidence matching the pattern is copied and named in run.json, never in the history', async () => {
		const video = await writeSource('e2e/evidence/EP-1/TC-1.1.1.webm', 'video');
		const trace = await writeSource('e2e/evidence/EP-1/TC-1.1.1.zip', 'trace-bytes');
		const now = Date.now();
		const finder = scriptedFinder(async () => [
			{ path: video, size: 5, mtimeMs: now },
			{ path: trace, size: 11, mtimeMs: now }
		]);
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/evidence/**/{{id}}.*' }, { findEvidence: finder }),
			'TC-1.1.1'
		);

		assert.deepStrictEqual(finder.calls, ['e2e/evidence/**/TC-1.1.1.*']);
		const run = summary.results[0].run;
		assert.deepStrictEqual(run?.files, [
			{ name: 'TC-1.1.1.webm', size: 5 },
			{ name: 'TC-1.1.1.zip', size: 11 }
		]);
		assert.strictEqual(run?.evidencePattern, 'e2e/evidence/**/TC-1.1.1.*');
		assert.deepStrictEqual(await resultsListing('TC-1.1.1', run!.id), [
			'TC-1.1.1.webm',
			'TC-1.1.1.zip',
			'output.log',
			'run.json'
		]);
		assert.strictEqual(await readText('TC-1.1.1', run!.id, 'TC-1.1.1.zip'), 'trace-bytes');
		// The ticket's history names the run and nothing the run folder records.
		const ticket = await store.getDetail('TC-1.1.1');
		assert.strictEqual(
			ticket?.history[ticket.history.length - 1].comment,
			`Test run \`${run!.id}\` passed: \`run TC-1.1.1\` exited 0.`
		);
	});

	test('the real walker finds the files a relative pattern names', async () => {
		await writeSource('e2e/evidence/EP-1/TC-1.1.1.webm');
		await writeSource('e2e/evidence/EP-1/TC-1.1.10.webm');
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', evidence: '.tracker-evidence/e2e/**/{{id}}.*' }),
			'TC-1.1.1'
		);
		assert.deepStrictEqual(
			summary.results[0].run?.files.map((file) => file.name),
			['TC-1.1.1.webm']
		);
	});

	test('a match older than the run is not this run\'s: ignored, counted, and no files matched', async () => {
		const stale = await writeSource('e2e/evidence/EP-1/TC-1.1.1.webm');
		const finder = scriptedFinder(async () => [{ path: stale, size: 5, mtimeMs: Date.now() - 60_000 }]);
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/**/{{id}}.*' }, { findEvidence: finder }),
			'TC-1.1.1'
		);

		const result = summary.results[0];
		assert.deepStrictEqual(result.run?.files, []);
		assert.deepStrictEqual(result.run?.warnings, ['1 older file ignored: written before this run started.']);
		assert.ok(result.message?.includes('older file'), result.message);
		// The pattern that matched nothing is the run's to record, not the ticket's.
		assert.strictEqual(result.run?.evidencePattern, 'e2e/**/TC-1.1.1.*');
	});

	test('a pattern that matches nothing records the run with no warning', async () => {
		const finder = scriptedFinder(async () => []);
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/**/{{id}}.*' }, { findEvidence: finder }),
			'TC-1.1.1'
		);
		assert.strictEqual(summary.results[0].message, undefined);
		assert.deepStrictEqual(summary.results[0].run?.files, []);
		assert.strictEqual(summary.results[0].run?.warnings, undefined);
	});

	test('a finder that throws is a warning on the run, never a lost run', async () => {
		const finder = scriptedFinder(async () => {
			throw new Error('walk exploded');
		});
		const fake = new FakeProcessRunner();
		const summary = await runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/**/{{id}}.*' }, { findEvidence: finder }),
			'TC-1.1.1'
		);
		assert.strictEqual(summary.results[0].outcome, 'passed');
		assert.ok(summary.results[0].run);
		assert.ok(summary.results[0].message?.includes('walk exploded'), summary.results[0].message);
		assert.strictEqual((await store.getDetail('TC-1.1.1'))?.status, 'done');
	});

	test('a record that cannot be written still writes the status, and says so', async () => {
		class FailingResults extends TestResultsStore {
			override addRun(_id: string, _run: NewTestRun): Promise<never> {
				return Promise.reject(new Error('disk full'));
			}
		}
		const failing = new FailingResults({ rootUri: () => RESULTS, author: () => 'Test Runner' });
		const fake = new FakeProcessRunner();
		const summary = await runTests({ ...deps(fake), results: failing }, 'TC-1.1.1');

		const result = summary.results[0];
		assert.strictEqual(result.outcome, 'passed');
		assert.strictEqual(result.run, undefined);
		assert.strictEqual(result.message, 'evidence could not be recorded: disk full');
		const ticket = await store.getDetail('TC-1.1.1');
		assert.strictEqual(ticket?.status, 'done');
		assert.strictEqual(
			ticket?.history[ticket.history.length - 1].comment,
			'Test run passed: `run TC-1.1.1` exited 0. The run could not be recorded: disk full.'
		);
		assert.deepStrictEqual(await listing(...TC_1_1_1), ['TestCase.mdx', 'history.md', 'metadata.yaml']);
		assert.deepStrictEqual(await resultsListing('TC-1.1.1'), []);
	});

	// The two histories are independent: a run that moves nothing writes
	// nothing into the tracker — no entry, no `updatedAt` bump — and the run
	// folder is its only record.
	test('the same verdict again touches the ticket not at all', async () => {
		await runTests(deps(new FakeProcessRunner()), 'TC-1.1.1');
		const first = await store.getDetail('TC-1.1.1');
		assert.strictEqual(first?.status, 'done');
		assert.strictEqual(first?.history[first.history.length - 1].action, 'changed');
		const before = await readText('TC-1.1.1', (await runFolderOf('TC-1.1.1'))!, 'run.json');

		await runTests(deps(new FakeProcessRunner()), 'TC-1.1.1');
		const second = await store.getDetail('TC-1.1.1');
		assert.strictEqual(second?.status, 'done');
		assert.strictEqual(second?.updatedAt, first?.updatedAt);
		assert.deepStrictEqual(second?.history, first?.history);
		assert.ok(!second?.history.some((entry) => entry.action === 'tested'));
		assert.strictEqual((await resultsListing('TC-1.1.1')).length, 2);
		assert.ok(before, 'the first run is still there');

		// A different verdict is a status change again.
		await runTests(deps(new FakeProcessRunner({ failAt: [0] })), 'TC-1.1.1');
		const third = await store.getDetail('TC-1.1.1');
		assert.strictEqual(third?.status, 'blocked');
		assert.strictEqual(third?.history[third.history.length - 1].action, 'changed');
		assert.strictEqual(third?.history.length, (first?.history.length ?? 0) + 1);
	});

	test('scope, then started, precede the first result; output carries its test case', async () => {
		const fake = new FakeProcessRunner({ results: [{ stdout: 'hello\n' }] });
		const events: TestRunProgress[] = [];
		await runTests(deps(fake, undefined, { onProgress: (event) => events.push(event) }), 'TC-1.1.1');

		assert.deepStrictEqual(
			events.map((event) => event.kind),
			['scope', 'started', 'output', 'result']
		);
		const scope = events[0];
		assert.ok(scope.kind === 'scope' && scope.testCases.map((ticket) => ticket.id).join() === 'TC-1.1.1');
		const started = events[1];
		assert.ok(started.kind === 'started' && started.line === 'run TC-1.1.1' && started.startedAt.endsWith('Z'));
		const output = events[2];
		assert.ok(output.kind === 'output' && output.testCase === 'TC-1.1.1' && output.text === 'hello\n');
	});

	test('cancelled and skipped runs write no folder', async () => {
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		let cancelRun: (() => void) | undefined;
		const running = runTests(deps(fake), 'EP-1', { onCancel: (cancel) => (cancelRun = cancel) });
		await settled(() => fake.hanging.length === 1);
		cancelRun?.();
		const summary = await running;

		assert.deepStrictEqual(
			summary.results.map((result) => result.outcome),
			['cancelled', 'skipped', 'skipped']
		);
		assert.deepStrictEqual(await listing(...TC_1_1_1_1), ['TestCase.mdx', 'history.md', 'metadata.yaml']);
		assert.deepStrictEqual(await listing(...TC_1_1_1), ['TestCase.mdx', 'history.md', 'metadata.yaml']);
		assert.deepStrictEqual(await resultsListing(), []);
	});

	test('the evidence is filed before the next slot is taken', async () => {
		const held = heldFinder();
		const fake = new FakeProcessRunner({ hangFrom: 0 });
		const running = runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/**/{{id}}.*' }, { findEvidence: held.finder }),
			'EP-1'
		);
		for (let index = 0; index < 3; index += 1) {
			await settled(() => fake.hanging.length === index + 1);
			fake.hanging[index].resolveNow({ code: 0, stdout: '', stderr: '' });
			await settled(() => held.pending() === 1);
			// The command exited and its evidence is still being collected: the
			// next must not have spawned, or a folder-clearing tool would wipe it.
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.strictEqual(fake.requests.length, index + 1, `run ${index + 1} holds the slot`);
			held.release();
		}
		const summary = await running;
		assert.strictEqual(summary.passed, 3);
	});

	test('an evidence pattern at a concurrency above one gets one warning line, not a refusal', async () => {
		const events: TestRunProgress[] = [];
		const fake = new FakeProcessRunner();
		await runTests(
			deps(fake, { command: 'run {{id}}', evidence: 'e2e/**/{{id}}.*', concurrency: 2 }, {
				onProgress: (event) => events.push(event),
				findEvidence: scriptedFinder(async () => [])
			}),
			'TC-1.1.1'
		);
		const warning = events.find(
			(event) => event.kind === 'output' && event.testCase === undefined && event.text.startsWith('⚠')
		);
		assert.ok(warning, 'the warning line was emitted');
		assert.strictEqual(fake.requests.length, 1);
	});

	// docs/tests/services.md §Assigning a test case to a service.
	suite('services', () => {
		const ORDERS = '.tracker-evidence/orders';
		const withServices: TestsSettings = {
			command: 'run {{id}}',
			services: [
				{
					id: 'orders',
					folder: ORDERS,
					e2e: { testCommand: 'e2e {{id}}', compose: ['orders', 'postgres'] }
				},
				{ id: 'billing', folder: '.tracker-evidence/billing', unit: { command: 'go test' } }
			]
		};

		setup(async () => {
			await writeSource('orders/package.json', '{}');
		});

		test('a test case assigned to a service runs its command in its folder, after its compose services', async () => {
			await store.setService('TC-1.1.1', 'orders');
			const fake = new FakeProcessRunner();
			const composed: string[][] = [];
			const summary = await runTests(
				deps(fake, withServices, {
					composeUp: async (services) => {
						composed.push([...services]);
					},
					stackEnvironment: async () => ({ ORDERS_PORT: '41001' })
				}),
				'ST-1.1'
			);

			assert.deepStrictEqual(fake.requests.map(lineOf), [
				'run TC-1.1.1.1',
				'e2e TC-1.1.1',
				'run TC-1.1.2'
			]);
			assert.strictEqual(fake.requests[1].cwd, vscode.Uri.joinPath(SOURCE, 'orders').fsPath);
			assert.strictEqual(fake.requests[0].cwd, WORKSPACE_ROOT);
			// Once per batch, before anything runs.
			assert.deepStrictEqual(composed, [['orders', 'postgres']]);
			// The master's variables reach every command, project and service alike.
			for (const request of fake.requests) {
				assert.strictEqual(request.env?.ORDERS_PORT, '41001');
			}
			assert.strictEqual(summary.passed, 3);
		});

		test('a service that cannot run its test case is an error, never the project command', async () => {
			await store.setService('TC-1.1.1', 'billing');
			await store.setService('TC-1.1.2', 'gone');
			const fake = new FakeProcessRunner();
			const summary = await runTests(deps(fake, withServices), 'ST-1.1');

			assert.deepStrictEqual(fake.requests.map(lineOf), ['run TC-1.1.1.1']);
			const byId = new Map(summary.results.map((result) => [result.ticket.id, result]));
			assert.strictEqual(byId.get('TC-1.1.1')?.outcome, 'error');
			assert.match(byId.get('TC-1.1.1')?.message ?? '', /no e2e test case command/);
			assert.match(byId.get('TC-1.1.2')?.message ?? '', /not a service in the Tests settings/);
			// An error writes no status.
			assert.strictEqual((await store.getDetail('TC-1.1.1'))?.status, 'todo');
		});

		test('compose services that do not come up fail that service’s test cases, and only those', async () => {
			await store.setService('TC-1.1.1', 'orders');
			const fake = new FakeProcessRunner();
			const summary = await runTests(
				deps(fake, withServices, {
					composeUp: async () => {
						throw new Error('port is already allocated');
					}
				}),
				'ST-1.1'
			);

			assert.deepStrictEqual(fake.requests.map(lineOf), ['run TC-1.1.1.1', 'run TC-1.1.2']);
			const failed = summary.results.find((result) => result.ticket.id === 'TC-1.1.1');
			assert.strictEqual(failed?.outcome, 'error');
			assert.match(failed?.message ?? '', /did not come up: port is already allocated/);
		});

		test('no compose wiring, or a missing folder, is the service’s error', async () => {
			await store.setService('TC-1.1.1', 'orders');
			const noCompose = await runTests(deps(new FakeProcessRunner(), withServices), 'TC-1.1.1');
			assert.match(noCompose.results[0].message ?? '', /cannot start them here/);

			const missing: TestsSettings = {
				services: [{ id: 'orders', folder: 'no/such/folder', e2e: { testCommand: 'e2e {{id}}' } }]
			};
			const summary = await runTests(deps(new FakeProcessRunner(), missing), 'TC-1.1.1');
			assert.match(summary.results[0].message ?? '', /does not exist in this workspace/);
		});

		test('with no project command, a test case without a service is an error and the rest still run', async () => {
			await store.setService('TC-1.1.1', 'orders');
			const onlyServices: TestsSettings = {
				services: [{ id: 'orders', folder: ORDERS, e2e: { testCommand: 'e2e {{id}}' } }]
			};
			const fake = new FakeProcessRunner();
			const summary = await runTests(deps(fake, onlyServices), 'ST-1.1');

			assert.deepStrictEqual(fake.requests.map(lineOf), ['e2e TC-1.1.1']);
			assert.strictEqual(summary.errors, 2);
			assert.match(summary.results[0].message ?? '', /no service and no test command/);
		});
	});
});

suite('Test runner pure helpers', () => {
	// A folder slug keeps a title's apostrophes and dollar signs; the shell
	// must read the path as one literal argument whatever it contains.
	test('quoteShellArgument makes any path one literal argument for the platform shell', () => {
		const posix = quoteShellArgument("/repo/.tracker/AC-1-The_company's_$(list)/x.zip", 'linux');
		assert.strictEqual(posix, "'/repo/.tracker/AC-1-The_company'\\''s_$(list)/x.zip'");
		assert.strictEqual(quoteShellArgument('C:\\repo\\a b.zip', 'win32'), '"C:\\repo\\a b.zip"');
		assert.throws(() => quoteShellArgument('C:\\100%.zip', 'win32'));
	});

	// Both platforms through the explicit parameter — that is why it is one.
	test('shellCommand wraps for each platform', () => {
		const win = shellCommand('npm test -- --grep "TC-1"', 'win32');
		assert.deepStrictEqual(win.args, ['/d', '/s', '/c', '"npm test -- --grep "TC-1""']);
		assert.strictEqual(win.windowsVerbatimArguments, true);
		assert.ok(win.executable.toLowerCase().includes('cmd'));

		const posix = shellCommand('npm test -- --grep "TC-1"', 'linux');
		assert.deepStrictEqual(posix, {
			executable: '/bin/sh',
			args: ['-c', 'npm test -- --grep "TC-1"']
		});
	});
});
