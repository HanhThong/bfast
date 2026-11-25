import * as assert from 'assert';
import * as vscode from 'vscode';
import { TICKET_STATUSES, TICKET_TYPES } from '../data/types';
import { ticketTabIcon } from '../ticketIcon';

function tabsLabelled(label: string): readonly vscode.Tab[] {
	return vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.label === label);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The tab shows up a tick or two after the command resolves. */
async function waitForTab(label: string): Promise<readonly vscode.Tab[]> {
	for (let attempt = 0; attempt < 100 && tabsLabelled(label).length === 0; attempt++) {
		await delay(20);
	}
	return tabsLabelled(label);
}

suite('BFAST board', () => {
	suiteSetup(async () => {
		// Activation is lazy, so nothing is registered until the extension is
		// woken up by a contributed command or view.
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension, 'the BFAST extension should be installed');
		await extension.activate();
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Opening the settings form lists the agents, which seeds `.bfast/agents`
		// with the built-ins. The fixture workspace is git-tracked, so put it back
		// the way it was found — the `.gitignore` entry only covers a crashed run.
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (root) {
			try {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, '.bfast'), {
					recursive: true,
					useTrash: false
				});
			} catch {
				// It is only there if a test opened the form.
			}
		}
	});

	test('registers its commands', async () => {
		const commands = await vscode.commands.getCommands(true);

		for (const id of [
			'bfast.openBoard',
			'bfast.openTicket',
			'bfast.openSettings',
			'bfast.filterTickets',
			'bfast.clearFilter',
			'bfast.refreshTickets',
			'bfast.setAiApiKey',
			'bfast.setAiOauthToken',
			'bfast.clearAiCredentials',
			'bfast.openAgents',
			'bfast.newAgent',
			'bfast.generateStories',
			'bfast.generateAcceptanceCriteria',
			'bfast.generateTestCases',
			'bfast.runTests',
			'bfast.implement',
			'bfast.commitTicket',
			'bfast.createEnvironment',
			'bfast.newEnvironment',
			'bfast.createMasterEnvironment',
			'bfast.refreshEnvironments',
			'bfast.startEnvironment',
			'bfast.stopEnvironment',
			'bfast.openEnvironmentWindow',
			'bfast.revealEnvironment',
			'bfast.deleteEnvironment',
			'bfast.openEnvironmentPort',
			'bfast.openEnvironmentPortInBrowser',
			'bfast.forwardEnvironmentPorts',
			'bfast.forwardEnvironmentPort',
			'bfast.openContainerLog',
			'bfast.runScan',
			'bfast.scanWorkspace',
			'bfast.openScanResults',
			'bfast.deployScanServer',
			'bfast.startScanServer',
			'bfast.stopScanServer',
			'bfast.provisionScanServer',
			'bfast.removeScanServer',
			'bfast.openScanServer',
			'bfast.setSonarQubeToken',
			'bfast.showSonarQubeAdminPassword',
			'bfast.copyScanCredential',
			'bfast.clearScanCredentials',
			'bfast.revealScanFolder',
			'bfast.refreshScan'
		]) {
			assert.ok(commands.includes(id), `${id} should be registered`);
		}
	});

	test('the scan tab has an icon on disk', async () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension);

		// A tab icon is a file, not a themed glyph — `WebviewPanel.iconPath` needs
		// a `Uri` — so shipping the panel without it would leave the tab blank
		// with nothing to say so. The same reason the ticket icons have a test.
		await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, 'media', 'scan.svg'));
	});

	test('the SonarQube compose template ships with the extension', async () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension);

		// A VSIX missing its own templates seeds nothing — the fault
		// `bundledAgents.test.ts` guards for agents, and a deploy would fail on it.
		const uri = vscode.Uri.joinPath(
			extension.extensionUri,
			'templates',
			'scan',
			'sonarqube',
			'docker-compose.yml'
		);
		const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

		// The three contract points docs/scan/sonarqube.md pins.
		assert.ok(text.includes('${BFAST_SONAR_PORT'), 'the host port must come from the variable');
		assert.ok(!/^\s*container_name:/m.test(text), 'a fixed container name collides across workspaces');
		assert.ok(/^\s{2}sonarqube:/m.test(text), 'the service must be named sonarqube');
	});

	test('every ticket type and status has a tab icon on disk', async () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension);

		// A tab icon is a file, not a themed glyph, so adding a status without
		// adding its icons would leave those tabs blank with nothing to say so.
		for (const type of TICKET_TYPES) {
			for (const status of TICKET_STATUSES) {
				const uri = ticketTabIcon(extension.extensionUri, type, status);
				await vscode.workspace.fs.stat(uri);
			}
		}
	});

	test('bfast.openTicket opens a pinned board tab titled by the id', async () => {
		await vscode.commands.executeCommand('bfast.openTicket', 'EP-1');

		// The tab is titled after its ticket. This workspace has no tracker
		// configured, so the ticket does not resolve and the id is all the title
		// can say — which is exactly the fallback being asserted.
		const [tab] = await waitForTab('EP-1');
		assert.ok(tab, 'the board tab should open');
		// Nobody clicked, so the programmatic route never opens a preview tab.
		assert.strictEqual(tab.isPreview, false);
		assert.ok(tab.input instanceof vscode.TabInputCustom, 'a board is a custom editor');
		assert.strictEqual(tab.input.viewType, 'bfast.board');
	});

	test('a second ticket opens in a second tab', async () => {
		await vscode.commands.executeCommand('bfast.openTicket', 'ST-1.1');

		assert.strictEqual((await waitForTab('ST-1.1')).length, 1);
		assert.strictEqual(tabsLabelled('EP-1').length, 1, 'the first ticket should still be open');
	});

	test('opening a ticket that is already open reveals its tab', async () => {
		await vscode.commands.executeCommand('bfast.openTicket', 'EP-1');
		await delay(200);

		assert.strictEqual(tabsLabelled('EP-1').length, 1);
		assert.strictEqual(tabsLabelled('ST-1.1').length, 1);
	});

	test('Open Board reveals the board the user was last on, never a blank one', async () => {
		const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
		await vscode.commands.executeCommand('bfast.openBoard');
		await delay(200);

		assert.strictEqual(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, before);
		assert.strictEqual(tabsLabelled('BFAST').length, 0, 'there is no blank board any more');
		assert.strictEqual(tabsLabelled('EP-1')[0]?.isActive, true, 'the last-opened board is revealed');
	});

	// The whole flow lives in a tab now, so the command's only job is to open
	// one — and to open the *same* one when asked twice, or a second right-click
	// would start a second run against the same ticket.
	test('generate opens one tab per ticket, and reveals it when asked again', async () => {
		const node = { ticket: { id: 'EP-1', type: 'epic' } };
		// This workspace has no tracker configured, so the ticket does not resolve
		// and the id is all the title can say until `generateContext` lands.
		const label = 'Generate stories — EP-1';

		await vscode.commands.executeCommand('bfast.generateStories', node);
		assert.strictEqual((await waitForTab(label)).length, 1);

		await vscode.commands.executeCommand('bfast.generateStories', node);
		await delay(200);
		assert.strictEqual(tabsLabelled(label).length, 1);

		for (const tab of tabsLabelled(label)) {
			await vscode.window.tabGroups.close(tab);
		}
	});

	test('the settings form opens in its own single tab', async () => {
		await vscode.commands.executeCommand('bfast.openSettings');
		assert.strictEqual((await waitForTab('BFAST Settings')).length, 1);

		await vscode.commands.executeCommand('bfast.openSettings');
		await delay(200);
		assert.strictEqual(tabsLabelled('BFAST Settings').length, 1);
		// The board tabs are separate from the settings tab.
		assert.strictEqual(tabsLabelled('EP-1').length, 1);
	});
});
