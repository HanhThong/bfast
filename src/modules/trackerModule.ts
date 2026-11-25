// The tracker's share of activation: the ticket store, the design documents
// inside its folders, the sidebar tree over it, and the watcher that keeps
// both honest when the files change underneath.

import * as vscode from 'vscode';
import type { AgentStore } from '../ai/agentStore';
import { FileTicketStore } from '../data/fileTicketStore';
import { settingsTrackerContext } from '../data/trackerContext';
import { isSidecarPath } from '../data/trackerPaths';
import { TrackerWatcher } from '../data/trackerWatcher';
import { DesignStore } from '../design/designStore';
import { registerTicketCommands } from '../data/ticketCommands';
import { showFilterInput } from '../data/ticketFilter';
import { TicketTreeProvider } from '../data/ticketTreeProvider';
import { testServices } from '../settings/testServices';
import type { CoreServices, FeatureModule } from './core';

/** `workspaceState` key for the sidebar's show / hide test cases toggle. */
const TEST_CASES_HIDDEN_KEY = 'bfast.testCasesHidden';

export interface TrackerModuleDeps {
	/** A style is a design skill, so the styles are the agent store's to say. */
	agents: AgentStore;
	/** Open boards follow a refresh: a tab is titled after its ticket. */
	reloadBoards: () => Promise<void>;
	/** Whether a ticket has an environment — a type change is refused while it does. */
	hasEnvironment: (id: string) => Promise<boolean>;
	/** Called after every refresh — the commit feature's marks look again. */
	onDidRefresh?: () => void;
}

export interface TrackerModule extends FeatureModule {
	store: FileTicketStore;
	designs: DesignStore;
	/** Re-reads the tracker: the store's cache, the tree, every open board. */
	refresh(): void;
	/** Selects a ticket in the tree — the tree follows the board. */
	reveal(id: string): void;
	/** The ticket selected in the tree, if any. */
	selectedTicketId(): string | undefined;
}

export function activateTracker(core: CoreServices, deps: TrackerModuleDeps): TrackerModule {
	const { settings, workspace } = core;

	// The store resolves the tracker folder on every call rather than capturing
	// it, so it can be built before settings have been read from disk.
	const store = new FileTicketStore(settingsTrackerContext(settings));

	// Technical design documents live inside the ticket folder, so this store
	// borrows the ticket store's folders and its history. The styles are read at
	// call time, so a skill added under `.bfast/agents` reaches the next "+" menu.
	const designs = new DesignStore(store, {
		styles: () => deps.agents.designStyles(),
		author: () => workspace.author()
	});

	const provider = new TicketTreeProvider(store);
	const view = vscode.window.createTreeView('bfast.sidebar', { treeDataProvider: provider });
	provider.attach(view);

	// Hiding test cases is one person's way of reading the tree, not the team's,
	// so it is remembered per workspace on this machine and never in bfast.json.
	const memory = core.extension.workspaceState;
	const setTestCasesHidden = (hidden: boolean): void => {
		provider.setTestCasesHidden(hidden);
		void memory.update(TEST_CASES_HIDDEN_KEY, hidden);
	};
	provider.setTestCasesHidden(memory.get<boolean>(TEST_CASES_HIDDEN_KEY) ?? false);
	// The context key is false by default, but `setTestCasesHidden(false)` is a
	// no-op, so it is said once here for the title bar's `when`.
	void vscode.commands.executeCommand('setContext', 'bfast.testCasesHidden', provider.hidesTestCases);

	const refresh = (): void => {
		store.invalidate();
		provider.refresh();
		// Open boards follow too. A tab is titled after its ticket, so a rename
		// from the sidebar has to reach it — and the watcher will not carry it,
		// since it stays quiet while the store is the one writing.
		void deps.reloadBoards();
		deps.onDidRefresh?.();
	};

	// Tickets are files in git, so a pull, a branch switch or a save in a normal
	// editor tab all change them with no other signal.
	// `refresh()` already reloads every open board. A ticket's `assets/` never
	// change the tree, so those events are dropped.
	// A design document is written by its own store, so the busy flag is both
	// stores' — otherwise a design save would land as somebody else's change.
	const watcher = new TrackerWatcher(
		() => refresh(),
		() => store.isWriting || designs.isWriting,
		isSidecarPath
	);

	return {
		store,
		designs,
		refresh,
		reveal: (id) => void provider.reveal(id),
		selectedTicketId: () => view.selection[0]?.ticket.id,
		onSettingsApplied(current) {
			provider.setConfigured(current !== undefined);
			// Unconditional, unlike `setConfigured`, which early-returns when the flag
			// has not moved: pointing `trackerFolder` at a different directory leaves
			// the workspace configured either way, and the old tickets have to go.
			refresh();
			watcher.retarget(current ? settings.trackerFolderUri(current) : undefined);
		},
		disposables: [
			view,
			provider,
			store,
			watcher,

			...registerTicketCommands({
				store,
				refresh,
				hasEnvironment: deps.hasEnvironment,
				services: () => testServices(workspace.block('tests'))
			}),

			vscode.commands.registerCommand('bfast.filterTickets', () => {
				showFilterInput(provider);
			}),

			vscode.commands.registerCommand('bfast.clearFilter', () => {
				provider.setFilter('');
			}),

			vscode.commands.registerCommand('bfast.hideTestCases', () => setTestCasesHidden(true)),
			vscode.commands.registerCommand('bfast.showTestCases', () => setTestCasesHidden(false)),

			vscode.commands.registerCommand(
				'bfast.revealTicket',
				async (node?: { ticket: { id: string } }) => {
					const uri = node && (await store.folderUri(node.ticket.id));
					if (uri) {
						await vscode.commands.executeCommand('revealFileInOS', uri);
					}
				}
			)
		]
	};
}
