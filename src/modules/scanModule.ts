// Code Quality's share of activation: one shared server per workspace, the
// runs against it, the sidebar section, and the results tab.

import * as os from 'os';
import * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import { outputProgress } from '../host/outputProgress';
import { pollWhileVisible } from '../host/pollWhileVisible';
import { registerRevivable } from '../host/revivable';
import type { McpActionReport } from '../mcp/mcpTools';
import { ScanPanel } from '../scan/scanPanel';
import { bfastScanContext, type ScanContext } from '../scan/scanContext';
import { configuredScanProvider } from '../scan/scanRegistry';
import type { ScanTargetRef } from '../scan/scanReport';
import { resolveScope } from '../scan/scanRunner';
import { ScanServerStore } from '../scan/scanServerStore';
import { scanRunDeps, type ScanServices } from '../scan/scanServices';
import { registerScanCommands } from '../scan/scanCommands';
import { ScanTreeProvider } from '../scan/scanTreeProvider';
import type { CoreServices, FeatureModule } from './core';

/**
 * How often the section re-reads its server while it is on screen. Slower than
 * Environments': this is one server whose status changes far less often than a
 * set of stacks.
 */
const POLL_MS = 20_000;

export interface ScanModuleDeps {
	store: WritableTicketStore;
	/**
	 * The one and only coupling between Code Quality and Environments: a scan
	 * started from a ticket analyses that ticket's environment worktree — the
	 * checkout of the branch the work is actually on — and nothing else, and
	 * `scanRunner` never learns environments exist.
	 */
	resolveDirectory: (ticketId: string) => Promise<string | undefined>;
}

export interface ScanModule extends FeatureModule {
	/**
	 * Starts a scan in its tab and answers at once — what a caller with no
	 * window of its own (the MCP server) needs. Throws, in words, when there is
	 * nothing to scan; answers `started: false` when that target is already
	 * being scanned.
	 */
	start(ticketId: string | undefined): Promise<McpActionReport>;
}

export function activateScan(core: CoreServices, deps: ScanModuleDeps): ScanModule {
	const { extension, settings, workspace } = core;

	// Every tool sits behind the registry; the store owns the server's existence
	// and the results tab owns a run.
	const context = bfastScanContext(settings, extension.secrets, () => os.tmpdir());
	const provider = configuredScanProvider({
		context,
		extensionRoot: extension.extensionUri.fsPath,
		// Node's global `fetch` ignores HTTP_PROXY, so a configured proxy is named
		// in the error rather than surfacing as a bare `TypeError: fetch failed`.
		proxy: () => vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined
	});
	const output = vscode.window.createOutputChannel('BFAST Code Quality');
	const servers = new ScanServerStore({
		context,
		provider,
		onProgress: outputProgress(output)
	});
	const tree = new ScanTreeProvider({ servers, toolLabel: () => provider.label });
	const view = vscode.window.createTreeView('bfast.scan', { treeDataProvider: tree });

	// Everything the Code Quality section and the results tab need.
	const services: ScanServices = {
		provider,
		servers,
		store: deps.store,
		settings: () => workspace.block('scan'),
		workspaceRoot: () => workspace.root(),
		workspaceName: () => workspace.name(),
		resolveDirectory: deps.resolveDirectory,
		output,
		refresh: () => tree.refresh(),
		...credentialDialogs(context)
	};

	return {
		async start(ticketId) {
			const availability = await provider.availability();
			if (!availability.ok) {
				throw new Error(availability.message ?? 'Code scanning is not available in this workspace.');
			}
			// A ticket with no environment has nothing of its own to scan. The
			// tab would say so to a person; a caller only ever sees this answer.
			const { target, problem } = await resolveScope(
				scanRunDeps(services),
				services.settings(),
				ticketId
			);
			if (problem !== undefined) {
				throw new Error(problem);
			}
			// A scan runs in its tab, which is what stops a retry producing a
			// second analysis of one project key — see `ScanPanel.requestStart`.
			const started = ScanPanel.show(extension.extensionUri, services, target).requestStart();
			return started
				? {
						started: true,
						message: ticketId
							? `Started a ${target.projectKey} scan of ${ticketId}'s environment; it opens in a BFAST tab in the editor and takes a few minutes. The verdict is recorded in ${ticketId}'s history — read it back with get_ticket.`
							: `Started a ${target.projectKey} scan of the workspace; it opens in a BFAST tab in the editor and takes a few minutes. A workspace scan belongs to no ticket, so its verdict is shown in that tab only and is not recorded in any ticket's history.`
					}
				: {
						started: false,
						message: `A scan of ${target.projectKey} is already running. Nothing was started a second time.`
					};
		},
		onSettingsApplied(current) {
			tree.setConfigured(current !== undefined);
			tree.refresh();
		},
		disposables: [
			view,
			tree,
			provider,
			servers,
			output,
			// The scan home is in the OS temp folder, and a container can be stopped
			// from a terminal — so the Environments shape, on a slower timer.
			pollWhileVisible(view, POLL_MS, () => tree.refresh()),
			{ dispose: servers.onDidChange(() => tree.refresh()) },

			...registerScanCommands(services, (target) => {
				ScanPanel.show(extension.extensionUri, services, target);
			}),

			// A run was a child process this session owned, so the tab comes back on
			// its setup screen — a log that never advances again would be a lie
			// about a run that is not happening.
			registerRevivable(ScanPanel.viewType, (panel, state) => {
				const saved = state as { scanTarget?: ScanTargetRef } | undefined;
				if (!saved?.scanTarget) {
					return false;
				}
				ScanPanel.revive(panel, extension.extensionUri, services, saved.scanTarget);
				return true;
			})
		]
	};
}

/**
 * The four credential gestures of the Code Quality section. Dialogs rather
 * than settings fields because every one of these values is a secret, and
 * `bfast.json` is committed to git.
 */
function credentialDialogs(
	context: ScanContext
): Pick<ScanServices, 'setToken' | 'showAdminPassword' | 'copyCredential' | 'clearCredentials'> {
	return {
		setToken: async () => {
			const value = await vscode.window.showInputBox({
				title: 'BFAST — SonarQube token',
				prompt: 'Leave it empty to clear the stored token.',
				placeHolder: 'A **user** token — an analysis token cannot read results back',
				password: true,
				ignoreFocusOut: true
			});
			if (value === undefined) {
				return;
			}
			const token = value.trim();
			// One pasted token does both jobs against an external server. BFAST's
			// own deployment mints two, and provisioning overwrites these.
			await context.storeCredentials({ analysisToken: token, resultsToken: token });
		},
		showAdminPassword: async () => {
			const password = (await context.credentials()).adminPassword;
			if (!password) {
				void vscode.window.showInformationMessage(
					'BFAST has not generated a SonarQube admin password for this workspace.'
				);
				return;
			}
			const choice = await vscode.window.showInformationMessage(
				'BFAST generated this SonarQube admin password for this workspace.',
				{ modal: true, detail: password },
				'Copy'
			);
			if (choice === 'Copy') {
				await vscode.env.clipboard.writeText(password);
			}
		},
		/**
		 * A quick pick of what is actually stored, so the user never has to
		 * remember which of the three there are — and never sees a value on
		 * screen: the choice goes straight to the clipboard.
		 */
		copyCredential: async () => {
			const stored = await context.credentials();
			const items = [
				{
					label: 'Analysis token',
					detail: 'What the scanner uses — safe to paste into a CI job as SONAR_TOKEN.',
					value: stored.analysisToken
				},
				{
					label: 'Results token',
					detail: 'The user token that reads results back over the Web API.',
					value: stored.resultsToken
				},
				{
					label: 'Admin password',
					detail: 'The SonarQube admin password BFAST generated.',
					value: stored.adminPassword
				}
			].filter((item): item is typeof item & { value: string } => Boolean(item.value));
			if (items.length === 0) {
				void vscode.window.showInformationMessage(
					'No scan credentials are stored for this workspace yet. Deploy the server, or run BFAST: Set SonarQube Token.'
				);
				return;
			}
			// One pasted token does both jobs against an external server; do not
			// list it twice.
			const distinct = items.filter(
				(item, index) => items.findIndex((other) => other.value === item.value) === index
			);
			const choice =
				distinct.length === 1
					? distinct[0]
					: await vscode.window.showQuickPick(distinct, {
							title: 'BFAST — copy a scan credential',
							placeHolder: 'Which one goes to the clipboard?'
						});
			if (!choice) {
				return;
			}
			await vscode.env.clipboard.writeText(choice.value);
			void vscode.window.showInformationMessage(`${choice.label} copied to the clipboard.`);
		},
		clearCredentials: () => context.clearCredentials()
	};
}
