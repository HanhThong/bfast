// The board's tab behaviour — what docs/board/README.md specifies. Driven the
// way VS Code's own tree drives it: `vscode.open` on the ticket's resource,
// `preview: true` for a single click and `preview: false` for a double-click,
// since the headless runner cannot send a double-click itself.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseTicketUri, ticketUri, TICKET_SCHEME } from '../data/ticketUri';

const VIEW_TYPE = 'bfast.board';

interface BoardTab {
	id: string | undefined;
	label: string;
	isPreview: boolean;
	isActive: boolean;
	group: number;
}

function boardTabs(): BoardTab[] {
	return vscode.window.tabGroups.all.flatMap((group) =>
		group.tabs.flatMap((tab) =>
			tab.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE
				? [
						{
							id: parseTicketUri(tab.input.uri),
							label: tab.label,
							isPreview: tab.isPreview,
							isActive: tab.isActive,
							group: group.viewColumn
						}
					]
				: []
		)
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tabs settle a tick or two after the command resolves. */
async function settle(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
		await delay(30);
	}
}

async function open(id: string, preview: boolean): Promise<void> {
	await vscode.commands.executeCommand('vscode.open', ticketUri(id), { preview });
	await delay(150);
}

suite('BFAST board tabs', () => {
	const config = vscode.workspace.getConfiguration();
	let previousEnablePreview: unknown;

	suiteSetup(async () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension, 'the BFAST extension should be installed');
		await extension.activate();

		// The behaviour under test is VS Code's own and follows this setting, so
		// the suite pins it rather than inherit whatever the machine has — and
		// restores the previous value, or it would leak into a developer's setup.
		previousEnablePreview = config.inspect('workbench.editor.enablePreview')?.globalValue;
		await config.update('workbench.editor.enablePreview', true, vscode.ConfigurationTarget.Global);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await delay(200);
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await config.update(
			'workbench.editor.enablePreview',
			previousEnablePreview,
			vscode.ConfigurationTarget.Global
		);
	});

	test('ticketUri carries the id alone and round-trips a rank', () => {
		for (const id of ['EP-1', 'ST-1.2', 'AC-1.2.1', 'TC-1.2.1.1', 'EP-1#2', 'ST-1#2.1']) {
			const uri = ticketUri(id);
			assert.strictEqual(uri.scheme, TICKET_SCHEME);
			assert.strictEqual(uri.fragment, '', `${id}: a rank's # must not become a fragment`);
			assert.strictEqual(parseTicketUri(uri), id);
		}
		assert.strictEqual(parseTicketUri(vscode.Uri.file('/EP-1')), undefined, 'a foreign scheme');
		assert.strictEqual(
			parseTicketUri(vscode.Uri.from({ scheme: TICKET_SCHEME, path: '/EP-1/more' })),
			undefined,
			'a second path segment'
		);
	});

	test('a single click opens a preview tab', async () => {
		await open('EP-1', true);
		await settle(() => boardTabs().length === 1);

		const tabs = boardTabs();
		assert.strictEqual(tabs.length, 1, JSON.stringify(tabs));
		assert.strictEqual(tabs[0].id, 'EP-1');
		assert.strictEqual(tabs[0].isPreview, true);
		// No tracker in this workspace, so the id is the whole label.
		assert.strictEqual(tabs[0].label, 'EP-1');
	});

	test('a single click on another ticket reuses the preview tab', async () => {
		await open('ST-1.1', true);
		await settle(() => boardTabs().some((tab) => tab.id === 'ST-1.1'));

		const tabs = boardTabs();
		assert.strictEqual(tabs.length, 1, JSON.stringify(tabs));
		assert.strictEqual(tabs[0].id, 'ST-1.1');
		assert.strictEqual(tabs[0].isPreview, true);
	});

	test('a double-click pins the preview tab in place', async () => {
		await open('ST-1.1', false);
		await settle(() => boardTabs()[0]?.isPreview === false);

		const tabs = boardTabs();
		assert.strictEqual(tabs.length, 1, 'the same tab, not a second one');
		assert.strictEqual(tabs[0].id, 'ST-1.1');
		assert.strictEqual(tabs[0].isPreview, false);
	});

	test('a pinned tab is left alone by the next single click', async () => {
		await open('AC-1.1.1', true);
		await settle(() => boardTabs().length === 2);

		const tabs = boardTabs();
		assert.strictEqual(tabs.find((tab) => tab.id === 'ST-1.1')?.isPreview, false);
		assert.strictEqual(tabs.find((tab) => tab.id === 'AC-1.1.1')?.isPreview, true);
	});

	test('a double-click on a pinned ticket reveals it and adds nothing', async () => {
		await open('ST-1.1', false);
		await delay(200);

		const tabs = boardTabs();
		assert.strictEqual(tabs.length, 2);
		assert.strictEqual(tabs.filter((tab) => tab.id === 'ST-1.1').length, 1);
		assert.strictEqual(tabs.find((tab) => tab.id === 'ST-1.1')?.isActive, true);
		assert.strictEqual(tabs.find((tab) => tab.id === 'AC-1.1.1')?.isPreview, true, 'untouched');
	});

	test('bfast.openTicket opens pinned, and pins the preview tab when it is that ticket', async () => {
		await vscode.commands.executeCommand('bfast.openTicket', 'AC-1.1.1');
		await settle(() => boardTabs().every((tab) => !tab.isPreview));

		const tabs = boardTabs();
		assert.strictEqual(tabs.length, 2, 'no new tab');
		assert.strictEqual(tabs.find((tab) => tab.id === 'AC-1.1.1')?.isPreview, false);

		await vscode.commands.executeCommand('bfast.openTicket', 'TC-1.1.1.1');
		await settle(() => boardTabs().length === 3);
		assert.strictEqual(boardTabs().find((tab) => tab.id === 'TC-1.1.1.1')?.isPreview, false);
	});

	test('open to the side moves the tab rather than duplicating it', async () => {
		await vscode.commands.executeCommand('vscode.open', ticketUri('ST-1.1'), {
			viewColumn: vscode.ViewColumn.Beside,
			preview: false
		});
		await settle(() => boardTabs().find((tab) => tab.id === 'ST-1.1')?.group === 2);

		const tabs = boardTabs().filter((tab) => tab.id === 'ST-1.1');
		assert.strictEqual(tabs.length, 1, 'one editor per ticket');
		assert.strictEqual(tabs[0].group, 2);
	});

	test('with enablePreview off every open is pinned', async () => {
		await config.update('workbench.editor.enablePreview', false, vscode.ConfigurationTarget.Global);
		await delay(200);

		await open('EP-2', true);
		await settle(() => boardTabs().some((tab) => tab.id === 'EP-2'));
		assert.strictEqual(boardTabs().find((tab) => tab.id === 'EP-2')?.isPreview, false);

		await config.update('workbench.editor.enablePreview', true, vscode.ConfigurationTarget.Global);
	});
});
