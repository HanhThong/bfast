// Environments' share of activation: worktrees + stacks per story, the sidebar
// section over them, and the container log tab.

import * as vscode from 'vscode';
import type { TicketStore } from '../data/ticketStore';
import {
	bfastEnvironmentContext,
	resolveWorktreeHome,
	worktreeHomes
} from '../environments/environmentContext';
import { configuredEnvironmentProvider } from '../environments/environmentRegistry';
import { EnvironmentStore } from '../environments/environmentStore';
import { outputProgress } from '../host/outputProgress';
import { pollWhileVisible } from '../host/pollWhileVisible';
import { registerRevivable } from '../host/revivable';
import { ContainerLogPanel } from '../environments/containerLogPanel';
import { registerEnvironmentCommands } from '../environments/environmentCommands';
import { EnvironmentTreeProvider } from '../environments/environmentTreeProvider';
import type { CoreServices, FeatureModule } from './core';

/** How often the section re-reads its stacks while it is on screen. */
const POLL_MS = 10_000;

/** `workspaceState` key: the worktree window has already opened its ticket's board. */
const BOARD_OPENED_KEY = 'bfast.environmentBoardOpened';

export interface EnvironmentsModuleDeps {
	tickets: TicketStore;
}

export interface EnvironmentsModule extends FeatureModule {
	store: EnvironmentStore;
	/**
	 * A worktree window announces its story by opening that ticket's board —
	 * once per workspace, or reopening the window would fight the user over
	 * their tabs. A no-op in any other window.
	 */
	openWorktreeBoard(): Promise<void>;
}

export function activateEnvironments(
	core: CoreServices,
	deps: EnvironmentsModuleDeps
): EnvironmentsModule {
	const { extension, settings, workspace } = core;

	// Both provider implementations sit behind the registry; the store owns
	// everything else.
	const context = bfastEnvironmentContext(settings);
	const provider = configuredEnvironmentProvider(context);
	const output = vscode.window.createOutputChannel('BFAST Environments');
	const store = new EnvironmentStore({
		context,
		provider,
		onProgress: outputProgress(output)
	});
	const tree = new EnvironmentTreeProvider({ environments: store, tickets: deps.tickets });
	const view = vscode.window.createTreeView('bfast.environments', { treeDataProvider: tree });

	return {
		store,
		async openWorktreeBoard() {
			const folder = workspace.folder();
			if (!folder) {
				return;
			}
			// Only a real worktree counts — `resolveWorktreeHome` requires both the
			// worktrees-home location and a readable marker, so a marker accidentally
			// committed to the repo cannot auto-open a stale board in everyone's
			// main working copy.
			const home = resolveWorktreeHome(
				folder.uri.fsPath,
				worktreeHomes(workspace.block('environments'))
			);
			if (!home) {
				return;
			}
			if (extension.workspaceState.get<boolean>(BOARD_OPENED_KEY)) {
				return;
			}
			await extension.workspaceState.update(BOARD_OPENED_KEY, true);
			await vscode.commands.executeCommand('bfast.openTicket', home.marker.ticketId);
		},
		onSettingsApplied(current) {
			tree.setConfigured(current !== undefined);
			tree.refresh();
		},
		disposables: [
			view,
			tree,
			provider,
			store,
			output,
			// The worktrees live outside the workspace, where a `RelativePattern`
			// watcher does not fire reliably — so the section polls instead, and only
			// while it is actually visible. Every command already refreshes
			// explicitly; the timer is what keeps a `docker stop` typed into a
			// terminal from going unnoticed.
			pollWhileVisible(view, POLL_MS, () => tree.refresh()),
			{ dispose: store.onDidChange(() => tree.refresh()) },

			...registerEnvironmentCommands({
				environments: store,
				tickets: deps.tickets,
				output,
				refresh: () => tree.refresh(),
				openContainerLog: (environment, container) => {
					ContainerLogPanel.show(extension.extensionUri, store, environment, container);
				}
			}),

			// The one tab that comes back *live*: a generate or scan run was a child
			// process that session owned, while a log is a view of live state and
			// re-opening it is what the person who left the tab open wanted.
			registerRevivable(ContainerLogPanel.viewType, async (panel, state) => {
				const saved = state as { environmentId?: string; containerName?: string } | undefined;
				if (!saved?.environmentId || !saved.containerName) {
					return false;
				}
				await ContainerLogPanel.revive(
					panel,
					extension.extensionUri,
					store,
					saved.environmentId,
					saved.containerName
				);
				return true;
			})
		]
	};
}
