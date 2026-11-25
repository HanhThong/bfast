import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import { settingsTrackerContext } from '../data/trackerContext';
import { SettingsService } from '../settings/settingsService';
import { buildTree } from '../data/ticketTree';

/**
 * The glue `activate()` relies on: settings are read asynchronously, so the
 * store has to resolve the tracker folder on every call rather than capturing it
 * at construction. This suite builds the store *first*, exactly as `activate()`
 * does, and only then points settings at a folder.
 *
 * It writes a real `.vscode/bfast.json`, so it restores whatever was there
 * before — leaving one behind would flip `bfast.configured` for other suites.
 */
suite('Extension wiring', () => {
	const workspace = vscode.workspace.workspaceFolders![0].uri;
	const settingsUri = vscode.Uri.joinPath(workspace, '.vscode', 'bfast.json');
	const trackerUri = vscode.Uri.joinPath(workspace, '.tracker-wiring');

	let previous: Uint8Array | undefined;

	suiteSetup(async () => {
		try {
			previous = await vscode.workspace.fs.readFile(settingsUri);
		} catch {
			previous = undefined;
		}
	});

	suiteTeardown(async () => {
		for (const uri of [trackerUri, settingsUri]) {
			try {
				await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
			} catch {
				// Already gone.
			}
		}
		if (previous) {
			await vscode.workspace.fs.writeFile(settingsUri, previous);
		}
	});

	test('the store follows the configured tracker folder, read after it was built', async () => {
		const settings = new SettingsService();
		// Built before settings exist, which is the order `activate()` uses.
		const store = new FileTicketStore(settingsTrackerContext(settings));

		try {
			// Unconfigured: an empty tree, which is what lets the welcome view show.
			assert.deepStrictEqual(await store.listSummaries(), []);

			await settings.write({ trackerFolder: '.tracker-wiring', userName: 'Wiring Test' });
			store.invalidate();

			const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
			const story = await store.createTicket({
				parentId: epic.id,
				type: 'story',
				title: 'Sign in'
			});

			// The folders landed under the configured directory, not somewhere else.
			const entries = await vscode.workspace.fs.readDirectory(trackerUri);
			assert.deepStrictEqual(entries.map(([name]) => name), ['EP-1-Auth']);

			// And the author came from the settings file, not a hard-coded default.
			const detail = await store.getDetail(story.id);
			assert.strictEqual(detail?.history[0].author, 'Wiring Test');

			const roots = buildTree(await store.listSummaries());
			assert.deepStrictEqual(roots.map((node) => node.ticket.id), ['EP-1']);
			assert.deepStrictEqual(roots[0].children.map((node) => node.ticket.id), ['ST-1.1']);
		} finally {
			store.dispose();
			settings.dispose();
		}
	});
});
