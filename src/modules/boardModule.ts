// The editor-tab half of the tickets: the board (a custom editor per ticket),
// the generate tab that breaks a ticket down, and the settings form.

import * as vscode from 'vscode';
import { DESIGN_SESSIONS_KEY, keyedSessionStore } from '../ai/aiSessions';
import type { TicketType } from '../data/types';
import { registerRevivable } from '../host/revivable';
import type { ImplementPromptStore } from '../implement/implementPromptStore';
import { BfastPanel, type BoardServices } from '../board/bfastPanel';
import { GeneratePanel } from '../ai/generatePanel';
import { SettingsPanel, type McpPanelServices } from '../settings/settingsPanel';
import {
	registerGenerateChildrenCommands,
	type GenerateServices
} from '../ai/generateChildrenCommand';
import { mementoSessionStore } from '../ai/generateSessions';
import type { AiModule } from './aiModule';
import type { CoreServices, FeatureModule } from './core';
import type { TestsModule } from './testsModule';
import type { TrackerModule } from './trackerModule';

export interface BoardModuleDeps {
	tracker: TrackerModule;
	ai: AiModule;
	tests: TestsModule;
	implementPrompts: ImplementPromptStore;
	mcpPanel: McpPanelServices;
}

export function activateBoard(core: CoreServices, deps: BoardModuleDeps): FeatureModule {
	const { extension, settings, workspace } = core;
	// What the settings form's footer names: the version VS Code actually loaded.
	const version: string = extension.extension.packageJSON.version ?? '0.0.0';
	const { tracker, ai, tests } = deps;

	// Everything a board needs, resolved lazily so this can be built before the
	// settings file has been read.
	const board: BoardServices = {
		store: tracker.store,
		designs: {
			store: tracker.designs,
			// A style is a design skill, so the agent store is what lists them.
			styles: () => ai.agents.designStyles()
		},
		ai: {
			provider: ai.provider,
			settings: () => workspace.block('ai'),
			agents: () => ai.agents.list(),
			designSkill: (agent, style) => ai.agents.designSkill(agent, style),
			// `workspaceState`, never the tracker: a Claude session is a file under
			// `~/.claude/projects/<cwd>` on this machine, so a committed id would
			// resolve to nothing on a teammate's.
			sessions: keyedSessionStore(extension.workspaceState, DESIGN_SESSIONS_KEY),
			workingDirectory: () => workspace.root(),
			trackerFolder: () => workspace.trackerFolder()
		},
		onChanged: () => tracker.refresh(),
		// The tree follows the board: opening a ticket, or switching to its tab,
		// selects it in the sidebar.
		onDidShowTicket: (id) => tracker.reveal(id),
		tests: tests.board
	};

	// The same set, plus the plan-skill lookup — only `AgentStore` can reach
	// `templates/` for the bundled fallback — and `refresh` in place of
	// `onChanged`, since a generate run creates tickets rather than editing one.
	const generate: GenerateServices = {
		store: tracker.store,
		ai: ai.provider,
		aiSettings: () => workspace.block('ai'),
		aiAgents: () => ai.agents.list(),
		planSkill: (agent, parentType) => ai.agents.planSkill(agent, parentType),
		aiWorkingDirectory: () => workspace.root(),
		slots: ai.slots,
		// Where a tab's conversation is remembered between openings. Workspace
		// state, not the tracker, for the reason the board's `sessions` above gives.
		sessions: mementoSessionStore(extension.workspaceState),
		refresh: () => tracker.refresh()
	};

	return {
		disposables: [
			// The board is a custom editor on `bfast-ticket:/<id>`, so VS Code
			// itself brings every board tab back after a reload — no serializer.
			BfastPanel.register(extension.extensionUri, board),

			vscode.commands.registerCommand('bfast.openBoard', async () => {
				// A board is always some ticket's (there is no blank board): the one
				// the user was last on, else the ticket selected in the tree, pinned.
				if (BfastPanel.revealLast()) {
					return;
				}
				const selected = tracker.selectedTicketId();
				if (selected) {
					await BfastPanel.open(board, selected);
					return;
				}
				void vscode.window.showInformationMessage(
					'Select a ticket in the Tickets view to open its board.'
				);
			}),

			// The programmatic route — a create, a worktree marker, a board's link,
			// MCP — opens pinned; a click in the tree goes through `vscode.open`.
			vscode.commands.registerCommand('bfast.openTicket', (id: string) =>
				BfastPanel.open(board, id)
			),

			...registerGenerateChildrenCommands((parentId, childType) => {
				GeneratePanel.show(extension.extensionUri, generate, parentId, childType);
			}),

			// A run is a child process this session owned, so there is nothing to
			// resume — the generate tab comes back on its form, for the ticket its
			// own `setState` names.
			registerRevivable(GeneratePanel.viewType, (panel, state) => {
				const saved = state as { parentId?: string; childType?: TicketType } | undefined;
				if (!saved?.parentId || !saved.childType) {
					return false;
				}
				GeneratePanel.revive(
					panel,
					extension.extensionUri,
					generate,
					saved.parentId,
					saved.childType
				);
				return true;
			}),

			vscode.commands.registerCommand('bfast.openSettings', () => {
				if (!workspace.folder()) {
					void vscode.window.showWarningMessage('Open a folder before configuring BFAST.');
					return;
				}
				SettingsPanel.createOrShow(
					extension.extensionUri,
					settings,
					ai.agents,
					deps.implementPrompts,
					deps.mcpPanel,
					version
				);
			}),

			// A revived settings form re-reads the file from disk.
			registerRevivable(SettingsPanel.viewType, (panel) => {
				SettingsPanel.revive(
					panel,
					extension.extensionUri,
					settings,
					ai.agents,
					deps.implementPrompts,
					deps.mcpPanel,
					version
				);
				return true;
			})
		]
	};
}
