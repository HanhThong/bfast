// The AI assistant's share of activation: the provider, the agents on disk,
// the window's run slots, and the commands that manage credentials and agents.

import * as vscode from 'vscode';
import { AGENTS_FOLDER } from '../ai/agent';
import { AgentStore } from '../ai/agentStore';
import { AI_API_KEY_SECRET, AI_OAUTH_TOKEN_SECRET, bfastAiContext } from '../ai/aiContext';
import type { AiProvider } from '../ai/aiProvider';
import { configuredAiProvider } from '../ai/providerRegistry';
import { TICKET_TYPES } from '../data/types';
import { errorMessage } from '../platform/errors';
import { sharedLimiter, type SharedLimiter } from '../platform/semaphore';
import { aiConcurrency } from '../settings/aiSettings';
import type { CoreServices, FeatureModule } from './core';

export interface AiModuleDeps {
	/** Every open board repaints its AI button — a credential or an agent moved. */
	onAvailabilityChanged: () => Promise<void>;
	/** The ticket-type quick pick the settings form uses too. */
	pickTicketTypes: typeof import('../settings/settingsPanel').pickTicketTypes;
}

export interface AiModule extends FeatureModule {
	/** Both implementations live behind this; the `ai.provider` setting picks one. */
	provider: AiProvider;
	agents: AgentStore;
	/**
	 * One cap per window, not one per tab. `ai.concurrency` is a spend and
	 * rate-limit dial, so a dial that multiplied by the number of open tabs would
	 * not be a dial. The limit is a getter for the usual reason settings are read
	 * at call time, and because a shared cap cannot be snapshotted by one of the
	 * batches sharing it.
	 */
	slots: SharedLimiter;
}

export function activateAi(core: CoreServices, deps: AiModuleDeps): AiModule {
	const { extension, settings, workspace } = core;
	const provider = configuredAiProvider(bfastAiContext(settings, extension.secrets));
	const agents = new AgentStore(() => workspace.folder(), extension.extensionUri);
	const slots = sharedLimiter(() => aiConcurrency(workspace.block('ai')));

	// An agent is a file, so it can be edited in an ordinary editor tab, by a
	// `git pull`, or by another window. Every open board's picker follows.
	//
	// The glob reaches the whole tree, not just `*.md` at the top: a skill lives
	// at `<agent>/<skill>/SKILL.md` with examples under `resources/`, and editing
	// either has to reach the board.
	const agentWatcher = vscode.workspace.createFileSystemWatcher(`**/${AGENTS_FOLDER}/**`);
	const onAgentsChanged = () => void deps.onAvailabilityChanged();

	/**
	 * Puts a credential in the OS keychain. Deliberately not a settings field:
	 * `.vscode/bfast.json` is committed to git.
	 */
	async function storeSecret(key: string, title: string, placeholder: string): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: `BFAST — ${title}`,
			prompt: 'Leave it empty to clear the stored value.',
			placeHolder: placeholder,
			password: true,
			ignoreFocusOut: true
		});

		if (value === undefined) {
			return;
		}

		const trimmed = value.trim();
		if (trimmed.length > 0) {
			await extension.secrets.store(key, trimmed);
		} else {
			await extension.secrets.delete(key);
		}

		// Every open board repaints its button, rather than staying greyed out
		// until the next reload.
		await deps.onAvailabilityChanged();
	}

	const openInEditor = async (uri: vscode.Uri): Promise<void> => {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
			preview: false
		});
	};

	return {
		provider,
		agents,
		slots,
		disposables: [
			provider,
			agentWatcher,
			agentWatcher.onDidCreate(onAgentsChanged),
			agentWatcher.onDidChange(onAgentsChanged),
			agentWatcher.onDidDelete(onAgentsChanged),

			vscode.commands.registerCommand('bfast.setAiApiKey', () =>
				storeSecret(
					AI_API_KEY_SECRET,
					'Anthropic API key',
					'sk-ant-…  — stored in the OS keychain, never in bfast.json'
				)
			),

			vscode.commands.registerCommand('bfast.setAiOauthToken', () =>
				storeSecret(
					AI_OAUTH_TOKEN_SECRET,
					'Claude Code OAuth token',
					'From `claude setup-token` — stored in the OS keychain, never in bfast.json'
				)
			),

			vscode.commands.registerCommand('bfast.clearAiCredentials', async () => {
				await extension.secrets.delete(AI_API_KEY_SECRET);
				await extension.secrets.delete(AI_OAUTH_TOKEN_SECRET);
				await deps.onAvailabilityChanged();
				void vscode.window.showInformationMessage('BFAST cleared its stored AI credentials.');
			}),

			vscode.commands.registerCommand('bfast.newAgent', async () => {
				const name = await vscode.window.showInputBox({
					title: 'BFAST — new agent',
					prompt: 'What is this agent called?',
					placeHolder: 'e.g. QA Engineer',
					ignoreFocusOut: true,
					validateInput: (value) => (value.trim().length > 0 ? undefined : 'Enter a name.')
				});

				// Escaping the box must not leave a stray agent behind.
				if (!name) {
					return;
				}

				const types = await deps.pickTicketTypes('BFAST — new agent', TICKET_TYPES, true);
				if (types.length === 0) {
					return;
				}

				try {
					await openInEditor(await agents.create(name, types));
				} catch (failure) {
					void vscode.window.showErrorMessage(
						errorMessage(failure, 'The agent could not be created.')
					);
				}
			}),

			vscode.commands.registerCommand('bfast.openAgents', async () => {
				// Listing first, so a workspace that has never used the assistant gets
				// its built-in agents written before the picker claims there are none.
				const available = await agents.list();
				const picked = await vscode.window.showQuickPick(
					available.map((agent) => ({
						label: agent.name,
						description: agent.types.join(', '),
						detail: agent.description,
						slug: agent.slug
					})),
					{ title: 'BFAST agents', placeHolder: 'Pick an agent to edit' }
				);

				const uri = picked && agents.uriFor(picked.slug);
				if (uri) {
					await openInEditor(uri);
				}
			})
		]
	};
}
