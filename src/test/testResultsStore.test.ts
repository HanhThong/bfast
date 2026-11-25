// The results store on a scratch folder — the run half that used to live in
// `fileTicketStore.test.ts`, moved with the code: runs are filed outside the
// tracker now, keyed by test case id, and the ticket store knows nothing of
// them.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { TestResultsStore } from '../testing/testResultsStore';
import type { NewTestRun } from '../testing/testRunFile';

// Under the `.tracker*/` ignore, like every other scratch the suites write.
const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-results-store');

async function read(...parts: string[]): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ROOT, ...parts));
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

async function names(...parts: string[]): Promise<string[]> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(ROOT, ...parts));
		return entries.map(([name]) => name).sort();
	} catch {
		return [];
	}
}

async function write(content: string, ...parts: string[]): Promise<void> {
	const uri = vscode.Uri.joinPath(ROOT, ...parts);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet.
	}
}

function run(extra: Partial<NewTestRun> = {}): NewTestRun {
	return {
		startedAt: '2026-09-05T10:22:33.123Z',
		finishedAt: '2026-09-05T10:22:45.600Z',
		outcome: 'passed',
		exitCode: 0,
		command: 'run TC-1.1.1',
		output: 'all good\n',
		files: [],
		...extra
	};
}

const ID = 'TC-1.1.1';

suite('Test results store', () => {
	let store: TestResultsStore;

	setup(async () => {
		await reset();
		store = new TestResultsStore({ rootUri: () => ROOT, author: () => 'Test Runner' });
	});

	suiteTeardown(reset);

	test('the folders are created on demand, and run.json goes in last', async () => {
		assert.deepStrictEqual(await names(), []);
		assert.strictEqual(store.testCaseFolder(ID)?.fsPath, vscode.Uri.joinPath(ROOT, ID).fsPath);

		const record = await store.addRun(ID, run());

		assert.strictEqual(record.id, '2026-09-05T10-22-33.123Z');
		assert.strictEqual(record.outcome, 'passed');
		assert.strictEqual(record.author, 'Test Runner');
		assert.strictEqual(record.hasOutput, true);
		assert.deepStrictEqual(await names(), [ID]);
		assert.deepStrictEqual(await names(ID, record.id), ['output.log', 'run.json']);
		assert.strictEqual(await read(ID, record.id, 'output.log'), 'all good\n');
	});

	test('a ranked id gets a folder the board can still address', async () => {
		const record = await store.addRun('TC-1#2.1.1', run());
		assert.deepStrictEqual(await names(), ['TC-1_2.1.1']);
		assert.strictEqual((await store.listRuns('TC-1#2.1.1')).runs[0]?.id, record.id);
	});

	test('evidence files are copied in, renamed safely, and a clash gets a sibling', async () => {
		await write('video', 'src', 'src video.webm');
		await write('trace', 'src', 'src trace.zip');
		await write('other', 'src', 'trace.zip');
		const source = (name: string) => vscode.Uri.joinPath(ROOT, 'src', name).fsPath;

		const record = await store.addRun(
			ID,
			run({ files: [source('src video.webm'), source('src trace.zip'), source('trace.zip')] })
		);

		assert.deepStrictEqual(record.files, [
			{ name: 'src_trace.zip', size: 5 },
			{ name: 'src_video.webm', size: 5 },
			{ name: 'trace.zip', size: 5 }
		]);
		assert.strictEqual(await read(ID, record.id, 'trace.zip'), 'other');
		assert.strictEqual(await read(ID, record.id, 'src_trace.zip'), 'trace');
	});

	test('a source that vanished is a warning on the run, not a lost run', async () => {
		const record = await store.addRun(ID, run({ files: [vscode.Uri.joinPath(ROOT, 'gone.webm').fsPath] }));
		assert.deepStrictEqual(record.files, []);
		assert.strictEqual(record.warnings?.length, 1);
		assert.ok(record.warnings?.[0].includes('gone.webm'));
	});

	test('runs list newest first, count in full, and read forgivingly', async () => {
		await store.addRun(ID, run({ startedAt: '2026-09-05T10:00:00.000Z' }));
		await store.addRun(ID, run({ startedAt: '2026-09-05T11:00:00.000Z', outcome: 'failed', exitCode: 1 }));
		// A folder made by hand, with a file and no record.
		await write('x', ID, 'by-hand', 'shot.png');
		// Two runs in the same millisecond get numbered siblings.
		await store.addRun(ID, run({ startedAt: '2026-09-05T11:00:00.000Z' }));

		const all = await store.listRuns(ID);
		assert.strictEqual(all.total, 4);
		assert.deepStrictEqual(
			all.runs.map((record) => [record.id, record.outcome]),
			[
				['by-hand', 'unknown'],
				['2026-09-05T11-00-00.000Z-2', 'passed'],
				['2026-09-05T11-00-00.000Z', 'failed'],
				['2026-09-05T10-00-00.000Z', 'passed']
			]
		);
		assert.deepStrictEqual(all.runs[0].files, [{ name: 'shot.png', size: 1 }]);

		const latest = await store.listRuns(ID, 1);
		assert.strictEqual(latest.total, 4);
		assert.strictEqual(latest.runs.length, 1);

		assert.deepStrictEqual(await store.readOutput(ID, '2026-09-05T10-00-00.000Z', 100), {
			text: 'all good\n',
			truncated: false
		});
		assert.deepStrictEqual(await store.readOutput(ID, '2026-09-05T10-00-00.000Z', 4), {
			text: 'ood\n',
			truncated: true
		});
		assert.strictEqual(await store.readOutput(ID, 'by-hand', 100), undefined);
		// A test case that has never run, and a results folder that does not exist.
		assert.deepStrictEqual(await store.listRuns('TC-9.9.9'), { runs: [], total: 0 });
		await reset();
		assert.deepStrictEqual(await store.listRuns(ID), { runs: [], total: 0 });
		assert.strictEqual(await store.readOutput(ID, '2026-09-05T10-00-00.000Z', 100), undefined);
	});

	test('with no workspace there is nothing to list and nowhere to write', async () => {
		const unconfigured = new TestResultsStore({ rootUri: () => undefined, author: () => 'x' });
		assert.strictEqual(unconfigured.testCaseFolder(ID), undefined);
		assert.strictEqual(unconfigured.rootUri(), undefined);
		assert.deepStrictEqual(await unconfigured.listRuns(ID), { runs: [], total: 0 });
		await assert.rejects(() => unconfigured.addRun(ID, run()), /workspace folder/);
	});

	(process.platform === 'win32' ? test.skip : test)(
		"a test case folder that is a symbolic link is neither read nor written through",
		async () => {
			const elsewhere = vscode.Uri.joinPath(ROOT, 'elsewhere');
			await write('x', 'elsewhere', 'by-hand', 'shot.png');
			const fs = await import('fs/promises');
			await fs.symlink(elsewhere.fsPath, vscode.Uri.joinPath(ROOT, ID).fsPath, 'dir');

			assert.deepStrictEqual(await store.listRuns(ID), { runs: [], total: 0 });
			assert.strictEqual(await store.readOutput(ID, 'by-hand', 100), undefined);
			await assert.rejects(() => store.addRun(ID, run()), /symbolic link/);
			assert.deepStrictEqual(await names('elsewhere'), ['by-hand']);
		}
	);
});
