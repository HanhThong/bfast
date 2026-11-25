// The MCP server's share of activation: one HTTP endpoint other tools reach
// this workspace through, and what the settings tab reads it through.
//
// Off until `mcp.enabled` says otherwise, and its whole lifecycle is the
// settings file — saving starts it, restarts it, or stops it. See docs/mcp/.

import * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import type { DesignStore } from '../design/designStore';
import type { EnvironmentStore } from '../environments/environmentStore';
import { saveMcpClientConfig } from '../mcp/mcpClientFiles';
import { mcpClient, mcpClientSnippet } from '../mcp/mcpClients';
import { bfastMcpContext } from '../mcp/mcpContext';
import { McpServer } from '../mcp/mcpServer';
import type { McpActionReport } from '../mcp/mcpTools';
import type { McpPanelServices } from '../settings/settingsPanel';
import { readComposeServices, settingsRefusal } from '../settings/settingsChecks';
import type { TestBatches } from '../testing/testBatches';
import type { CoreServices, FeatureModule } from './core';

export interface McpModuleDeps {
	store: WritableTicketStore;
	designs: DesignStore;
	batches: TestBatches;
	environments: EnvironmentStore;
	/**
	 * A write over MCP is one nobody in this window asked for, so the window has
	 * to be told.
	 */
	onDidWrite: () => void;
	startScan: (ticketId: string | undefined) => Promise<McpActionReport>;
}

export interface McpModule extends FeatureModule {
	/**
	 * What the settings tab reads the server through: its status, a subscription
	 * so the tab follows it, and the clipboard. The address copied is the
	 * listening server's, never one the webview sent back.
	 */
	panel: McpPanelServices;
}

export function activateMcp(core: CoreServices, deps: McpModuleDeps): McpModule {
	const { extension, workspace, settings } = core;
	const output = vscode.window.createOutputChannel('BFAST MCP');
	const log = (line: string): void => output.appendLine(line);
	const server = new McpServer({
		settings: () => workspace.block('mcp'),
		version: extension.extension.packageJSON.version ?? '0.0.0',
		log,
		context: bfastMcpContext({
			store: deps.store,
			designs: deps.designs,
			batches: deps.batches,
			environments: deps.environments,
			log,
			onDidWrite: deps.onDidWrite,
			startScan: deps.startScan,
			settings: {
				current: () => settings.current,
				write: (candidate) => settings.write(candidate),
				refusal: (candidate) => settingsRefusal(settings.workspaceFolder, candidate),
				composeServices: (environments) => readComposeServices(settings.workspaceFolder, environments),
				notify: (message) => void vscode.window.showInformationMessage(message)
			}
		})
	});

	/**
	 * The `mcp` block the server is running under, so a save that did not
	 * touch it leaves the server — and every session — alone. That matters
	 * since the settings tools: a client's own `update_test_settings` saves the
	 * file, and a restart would drop the very session that asked, mid-answer.
	 */
	let appliedMcp: string | undefined;

	/** The listening server's address, or a warning and `undefined` when it is not running. */
	const addressOrWarn = (): string | undefined => {
		const address = server.status.address;
		if (!address) {
			void vscode.window.showWarningMessage('The BFAST MCP server is not running.');
		}
		return address;
	};

	return {
		panel: {
			status: () => server.status,
			onDidChangeStatus: (listener) => server.onDidChangeStatus(listener),
			copyAddress: async () => {
				const address = addressOrWarn();
				if (!address) {
					return;
				}
				await vscode.env.clipboard.writeText(address);
				void vscode.window.showInformationMessage(`Copied ${address} to the clipboard.`);
			},
			copyClientSnippet: async (client) => {
				const address = addressOrWarn();
				if (!address) {
					return;
				}
				await vscode.env.clipboard.writeText(mcpClientSnippet(client, address));
				void vscode.window.showInformationMessage(
					`Copied the ${mcpClient(client).label} connection snippet to the clipboard.`
				);
			},
			saveClientConfig: async (client) => {
				const address = server.status.address;
				const folder = workspace.folder();
				if (!address) {
					throw new Error('The BFAST MCP server is not running, so there is no address to save.');
				}
				if (!folder) {
					throw new Error('Open a folder to save a connection config into it.');
				}
				const path = await saveMcpClientConfig(folder.uri, client, address);
				void vscode.window.showInformationMessage(
					`Saved the BFAST server into ${path}. Commit it and ${mcpClient(client).label} offers the server to everyone who pulls.`
				);
				return path;
			}
		},
		onSettingsApplied(current) {
			// Saving is the server's whole lifecycle — start, restart on the new
			// settings, or stop. A full restart whenever the `mcp` block moved, even
			// when only the function list did: a client that had already listed the
			// tools has to be disconnected, or it goes on believing a switched-off
			// function is there. A save that left the block as it was — another
			// tab's field, or a settings tool's own write — changes nothing a client
			// was told, so a running server is left running; one that is stopped or
			// failed (a port that was taken) is tried again.
			const wanted = JSON.stringify(current?.mcp ?? null);
			if (wanted === appliedMcp && server.status.state === 'running') {
				return;
			}
			appliedMcp = wanted;
			void server.apply();
		},
		disposables: [server, output]
	};
}
