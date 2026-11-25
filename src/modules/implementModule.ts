// Implement's share of activation: the prompt templates under
// `.bfast/implement`, the coding agent `implement.agent` names, and the command.

import type { WritableTicketStore } from '../data/ticketStore';
import type { DesignStore } from '../design/designStore';
import { configuredCodingAgent } from '../implement/codingAgentRegistry';
import { buildImplementPrompt } from '../implement/implementContext';
import { ImplementPromptStore } from '../implement/implementPromptStore';
import { registerImplementCommands } from '../implement/implementCommand';
import type { CoreServices, FeatureModule } from './core';

export interface ImplementModuleDeps {
	store: WritableTicketStore;
	designs: DesignStore;
}

export interface ImplementModule extends FeatureModule {
	/** The templates as files — the settings form lists and opens them. */
	prompts: ImplementPromptStore;
}

export function activateImplement(core: CoreServices, deps: ImplementModuleDeps): ImplementModule {
	const { extension, workspace } = core;
	const prompts = new ImplementPromptStore(() => workspace.folder(), extension.extensionUri);
	const agent = configuredCodingAgent({
		settings: () => workspace.block('implement'),
		workspaceFolder: () => workspace.root()
	});

	return {
		prompts,
		disposables: registerImplementCommands({
			agent,
			writeHandoff: (ticketId, prompt) => prompts.writeHandoff(ticketId, prompt),
			buildPrompt: (ticketId) =>
				buildImplementPrompt(
					{
						store: deps.store,
						designs: deps.designs,
						templates: prompts,
						workspaceFolder: () => workspace.folder()?.uri,
						trackerFolder: () => workspace.trackerFolder(),
						tests: () => workspace.block('tests')
					},
					ticketId
				)
		})
	};
}
