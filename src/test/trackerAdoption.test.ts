import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import { TrackerContext } from '../data/trackerContext';
import { adoptTrackerEdits, prepareRunEdits, trackerEditLog } from '../ai/trackerAdoption';

/** A scratch tracker of this suite's own — see `fileTicketStore.test.ts`. */
const WORKSPACE = vscode.workspace.workspaceFolders![0].uri;
const TRACKER = '.tracker-adopt';
const ROOT = vscode.Uri.joinPath(WORKSPACE, TRACKER);

const context: TrackerContext = { rootUri: () => ROOT, author: () => 'Test Runner' };

async function overwrite(text: string, ...parts: string[]): Promise<void> {
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(ROOT, ...parts), new TextEncoder().encode(text));
}

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

suite('Tracker adoption', () => {
	let store: FileTicketStore;
	let epic: string;
	let story: string;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		epic = (await store.createTicket({ type: 'epic', title: 'Authentication', description: 'old epic' })).id;
		story = (await store.createTicket({ parentId: epic, type: 'story', title: 'Sign in', description: 'the story' })).id;
	});

	suiteTeardown(reset);

	// The rules a run is handed: one per file that exists, the run's own ticket
	// denied, and its parent named by path so "update the epic" needs no guess.
	test('names every existing content file, and denies the ticket being written', async () => {
		const edits = await prepareRunEdits(store, WORKSPACE, TRACKER, { id: story, parentId: epic });
		assert.ok(edits);
		try {
			assert.deepStrictEqual([...edits.request.tools], ['Read', 'Glob', 'Grep', 'Edit']);
			const settings = JSON.parse(
				new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(edits.request.settingsFile)))
			);
			assert.deepStrictEqual(settings.permissions.allow, [`Edit(${TRACKER}/EP-1-Authentication/Epic.mdx)`]);
			assert.deepStrictEqual(settings.permissions.deny, [
				'Write',
				'NotebookEdit',
				'MultiEdit',
				`Edit(${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in/Story.mdx)`
			]);
			assert.strictEqual(edits.policy.ownPath, `${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in/Story.mdx`);
			assert.deepStrictEqual(edits.policy.parent, {
				id: epic,
				title: 'Authentication',
				path: `${TRACKER}/EP-1-Authentication/Epic.mdx`
			});
		} finally {
			await edits.dispose();
		}
		await assert.rejects(async () => {
			await vscode.workspace.fs.stat(vscode.Uri.file(edits.request.settingsFile));
		});
	});

	// The whole point: an edit the agent made on disk ends up in the ticket's
	// history, with both sides, and its `updatedAt` moves — while the run's own
	// ticket is left alone whatever the agent did to its file.
	test('records the epic the agent edited, and never the ticket being written', async () => {
		const epicFile = vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'Epic.mdx').fsPath;
		const storyFile = vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'ST-1.1-Sign_in', 'Story.mdx').fsPath;
		const before = (await store.getDetail(epic))!;

		const log = trackerEditLog(store, WORKSPACE.fsPath, TRACKER);
		log.observe({ kind: 'use', id: 'r1', name: 'Read', filePath: epicFile });
		log.observe({ kind: 'result', id: 'r1', error: false });
		log.observe({ kind: 'use', id: 'r2', name: 'Read', filePath: storyFile });
		log.observe({ kind: 'result', id: 'r2', error: false });
		// The snapshot reads are asynchronous; give them the tick they need.
		await new Promise((resolve) => setTimeout(resolve, 20));

		// "The agent" edits both files directly, as the Edit tool does.
		await overwrite('old epic\n\nNon-goals: none.', 'EP-1-Authentication', 'Epic.mdx');
		await overwrite('rewritten story', 'EP-1-Authentication', 'ST-1.1-Sign_in', 'Story.mdx');
		log.observe({
			kind: 'use',
			id: 'e1',
			name: 'Edit',
			filePath: epicFile,
			edit: { oldString: 'old epic', newString: 'old epic\n\nNon-goals: none.', replaceAll: false }
		});
		log.observe({ kind: 'result', id: 'e1', error: false });
		log.observe({
			kind: 'use',
			id: 'e2',
			name: 'Edit',
			filePath: storyFile,
			edit: { oldString: 'the story', newString: 'rewritten story', replaceAll: false }
		});
		log.observe({ kind: 'result', id: 'e2', error: false });

		const edited = await adoptTrackerEdits(log, store, story, 'Edited by an agent while writing ST-1.1.');
		assert.deepStrictEqual(
			edited.map(({ id, adopted, reason }) => ({ id, adopted, reason })),
			[
				{ id: epic, adopted: true, reason: undefined },
				{ id: story, adopted: false, reason: 'own-ticket' }
			]
		);

		const after = (await store.getDetail(epic))!;
		assert.notStrictEqual(after.updatedAt, before.updatedAt);
		const entry = after.history.at(-1)!;
		assert.strictEqual(entry.field, 'description');
		assert.strictEqual(entry.from, 'old epic');
		assert.strictEqual(entry.to, 'old epic\n\nNon-goals: none.');
		assert.strictEqual(entry.comment, 'Edited by an agent while writing ST-1.1.');

		// The story's file changed on disk, but the store recorded nothing for it.
		const storyAfter = (await store.getDetail(story))!;
		assert.strictEqual(storyAfter.history.length, 1);
	});

	// A denied or failed Edit looks like an Edit in the request stream; only the
	// result says it happened. Nothing is adopted for one that did not.
	test('ignores an edit whose result was an error', async () => {
		const epicFile = vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'Epic.mdx').fsPath;
		const log = trackerEditLog(store, WORKSPACE.fsPath, TRACKER);
		log.observe({ kind: 'use', id: 'e1', name: 'Edit', filePath: epicFile, edit: { oldString: 'a', newString: 'b', replaceAll: false } });
		log.observe({ kind: 'result', id: 'e1', error: true });
		assert.deepStrictEqual(await adoptTrackerEdits(log, store, story, 'x'), []);
	});

	// A snapshot taken on the edit itself may already be the edited text; the
	// edit is reversed instead, and history still records both sides.
	test('reconstructs the previous text when the snapshot came too late', async () => {
		const epicFile = vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'Epic.mdx').fsPath;
		await overwrite('old epic and more', 'EP-1-Authentication', 'Epic.mdx');
		const log = trackerEditLog(store, WORKSPACE.fsPath, TRACKER);
		log.observe({ kind: 'use', id: 'e1', name: 'Edit', filePath: epicFile, edit: { oldString: 'old epic', newString: 'old epic and more', replaceAll: false } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		log.observe({ kind: 'result', id: 'e1', error: false });

		const [edited] = await adoptTrackerEdits(log, store, story, 'x');
		assert.strictEqual(edited.adopted, true);
		const entry = (await store.getDetail(epic))!.history.at(-1)!;
		assert.strictEqual(entry.from, 'old epic');
		assert.strictEqual(entry.to, 'old epic and more');
	});
});
