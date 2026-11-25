// The composition root.
//
// Each feature builds itself in `src/modules/`; this file only says which
// features there are, what each needs of the others, and what happens when the
// settings are read. A dependency between two features is an argument below —
// if it is not written here, it does not exist.

import * as vscode from 'vscode';
import { workspaceContext } from './host/workspaceContext';
import { activateAi } from './modules/aiModule';
import { activateBoard } from './modules/boardModule';
import { activateCommit } from './modules/commitModule';
import type { CoreServices, FeatureModule } from './modules/core';
import { activateEnvironments } from './modules/environmentsModule';
import { activateImplement } from './modules/implementModule';
import { activateMcp } from './modules/mcpModule';
import { activateScan } from './modules/scanModule';
import { activateTests } from './modules/testsModule';
import { activateTracker } from './modules/trackerModule';
import { BfastPanel } from './board/bfastPanel';
import { pickTicketTypes } from './settings/settingsPanel';
import type { BfastSettings } from './settings/bfastSettings';
import { SettingsService } from './settings/settingsService';

export function activate(context: vscode.ExtensionContext) {
	const settings = new SettingsService();
	const core: CoreServices = {
		extension: context,
		settings,
		workspace: workspaceContext(settings)
	};

	const reloadBoards = (): Promise<void> => BfastPanel.reloadAll();

	const ai = activateAi(core, {
		onAvailabilityChanged: () => BfastPanel.refreshAiAvailability(),
		pickTicketTypes
	});

	const tracker = activateTracker(core, {
		agents: ai.agents,
		reloadBoards,
		// Environments are built after the tracker they list tickets from, so
		// this is read at call time — the `TrackerContext` posture.
		hasEnvironment: async (id) => (await environments.store.find(id)) !== undefined,
		// The commit feature is built later; read at call time, like the line above.
		onDidRefresh: () => commit.refreshMarks()
	});

	const environments = activateEnvironments(core, { tickets: tracker.store });

	const tests = activateTests(core, {
		store: tracker.store,
		refresh: tracker.refresh,
		reloadBoards,
		// The master environment: its stack variables reach every test command,
		// and a service's compose services are brought up in it.
		findEnvironment: (id) => environments.store.find(id)
	});

	const scan = activateScan(core, {
		store: tracker.store,
		resolveDirectory: async (ticketId) => (await environments.store.find(ticketId))?.worktreePath
	});

	const implement = activateImplement(core, { store: tracker.store, designs: tracker.designs });

	const commit = activateCommit(core, { store: tracker.store });

	const mcp = activateMcp(core, {
		store: tracker.store,
		designs: tracker.designs,
		batches: tests.batches,
		environments: environments.store,
		onDidWrite: tracker.refresh,
		startScan: (ticketId) => scan.start(ticketId)
	});

	const board = activateBoard(core, {
		tracker,
		ai,
		tests,
		implementPrompts: implement.prompts,
		mcpPanel: mcp.panel
	});

	// In this order on every settings read: `onSettingsApplied` runs down it.
	const modules: FeatureModule[] = [
		tracker,
		environments,
		scan,
		tests,
		ai,
		implement,
		commit,
		mcp,
		board
	];

	/**
	 * Both halves of the setup gate, then every module's own reaction: the
	 * context key drives the `viewsWelcome` "Init settings" button and the title
	 * bar buttons in package.json; each tree empties itself so that welcome view
	 * can show at all.
	 */
	const applyConfigured = (current: BfastSettings | undefined): void => {
		void vscode.commands.executeCommand('setContext', 'bfast.configured', current !== undefined);
		for (const module of modules) {
			module.onSettingsApplied?.(current);
		}
	};

	context.subscriptions.push(
		settings,
		...modules.flatMap((module) => module.disposables),

		settings.onDidChange((current) => {
			applyConfigured(current);
			void BfastPanel.refreshAiAvailability();
		}),

		vscode.commands.registerCommand('bfast.refreshTickets', async () => {
			// Re-read the settings file too, so deleting or restoring bfast.json by
			// hand is picked up without reloading the window.
			applyConfigured(await settings.read());
		})
	);

	// The sidebar starts out gated; this flips it as soon as the file is read.
	// A worktree window then announces its story: the marker was written at
	// create time, the checkout carries the committed `bfast.json`, so the board
	// can open.
	void settings
		.read()
		.then(applyConfigured)
		.then(() => environments.openWorktreeBoard());
}

export function deactivate() {}
