// The environments section's command half.
//
// Every decision lives in `EnvironmentStore`; these handlers only translate
// gestures into store calls and errors into messages. Long operations get a
// `withProgress` notification whose cancel reaches the store, plus the "BFAST
// Environments" output channel the store is already streaming into — the tree
// item's spinner is the third surface, and together they are why no webview
// exists here.

import * as vscode from 'vscode';
import type { TicketNode } from '../data/ticketTree';
import type { TicketStore } from '../data/ticketStore';
import {
	EnvironmentCancelledError,
	MASTER_ENVIRONMENT_ID,
	environmentLabel,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentHandle
} from './environmentProvider';
import type { EnvironmentStore } from './environmentStore';
import type { EnvironmentTreeNode } from './environmentTreeProvider';
import { errorMessage } from '../platform/errors';

export interface EnvironmentServices {
	environments: EnvironmentStore;
	tickets: TicketStore;
	output: vscode.OutputChannel;
	/** Repaints the environments section. */
	refresh: () => void;
	/**
	 * Opens a container's log tab, or reveals the one already open for it.
	 * Injected rather than imported so this module keeps knowing nothing about
	 * webviews — the panel is `extension.ts`'s to wire, as every other one is.
	 */
	openContainerLog: (
		environment: EnvironmentDescriptor,
		container: EnvironmentContainer
	) => void;
}

export function registerEnvironmentCommands(services: EnvironmentServices): vscode.Disposable[] {
	const { environments, tickets, output, refresh, openContainerLog } = services;

	/** One long store call under a cancellable notification. */
	const operate = async (id: string, title: string, work: () => Promise<unknown>) => {
		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title,
					cancellable: true
				},
				async (_progress, token) => {
					token.onCancellationRequested(() => environments.cancel(id));
					await work();
				}
			);
		} catch (error) {
			if (!(error instanceof EnvironmentCancelledError)) {
				const message =
					errorMessage(error, 'The environment operation failed.');
				const choice = await vscode.window.showErrorMessage(message, 'Show Log');
				if (choice === 'Show Log') {
					output.show(true);
				}
			}
		} finally {
			refresh();
		}
	};

	const create = (ticketId: string) =>
		operate(ticketId, `BFAST: creating environment for ${ticketId}…`, () =>
			environments.create(ticketId)
		);

	const createMaster = () =>
		operate(MASTER_ENVIRONMENT_ID, 'BFAST: creating the master environment…', () =>
			environments.createMaster()
		);

	/**
	 * The graceful-degradation gate the provider seam promises: a missing
	 * docker (or the k8s stub) refuses with its reason before anything — a
	 * worktree clone included — is touched.
	 */
	const available = async (): Promise<boolean> => {
		const availability = await environments.availability();
		if (!availability.ok) {
			void vscode.window.showWarningMessage(
				availability.message ?? 'Environments are not available.'
			);
			return false;
		}
		return true;
	};

	return [
		vscode.commands.registerCommand('bfast.createEnvironment', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			// The menu `when` clause makes anything else unreachable.
			if (ticket?.type !== 'story' && ticket?.type !== 'epic') {
				void vscode.window.showWarningMessage(
					'Right-click a story or an epic to create its environment.'
				);
				return;
			}
			if (await available()) {
				void create(ticket.id);
			}
		}),

		vscode.commands.registerCommand('bfast.createMasterEnvironment', async () => {
			if (await available()) {
				void createMaster();
			}
		}),

		vscode.commands.registerCommand('bfast.newEnvironment', async () => {
			if (!(await available())) {
				return;
			}
			const [summaries, existing] = await Promise.all([
				tickets.listSummaries(),
				environments.list()
			]);
			const taken = new Set(existing.map((environment) => environment.id));
			// The master environment heads the pick while there is none — it is
			// the one that needs no ticket, so it is the one a first-time user
			// most likely wants.
			const items: { label: string; description: string; ticketId?: string }[] = [
				...(existing.some((environment) => environment.scope === 'master')
					? []
					: [{ label: 'Master', description: 'the workspace folder itself — no worktree' }]),
				...summaries
					.filter(
						(summary) =>
							(summary.type === 'story' || summary.type === 'epic') && !taken.has(summary.id)
					)
					.map((ticket) => ({ label: ticket.id, description: ticket.title, ticketId: ticket.id }))
			];
			if (items.length === 0) {
				void vscode.window.showInformationMessage(
					'Every story and epic already has an environment, and so does the workspace.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Which story or epic gets an environment — or the workspace itself?'
			});
			if (picked?.ticketId !== undefined) {
				void create(picked.ticketId);
			} else if (picked) {
				void createMaster();
			}
		}),

		vscode.commands.registerCommand('bfast.startEnvironment', async (node?: EnvironmentTreeNode) => {
			const environment = environmentOf(node);
			if (environment && (await available())) {
				void operate(
					environment.id,
					`BFAST: starting ${environmentLabel(environment.id)}…`,
					async () => {
						await environments.start(environment.id);
						// In a remote window the links are dead until the ports are
						// forwarded; a failed start skips this, and a local window
						// is a no-op inside.
						await forwardEnvironmentPorts(environment);
					}
				);
			}
		}),

		vscode.commands.registerCommand(
			'bfast.forwardEnvironmentPorts',
			async (node?: EnvironmentTreeNode) => {
				const environment = environmentOf(node);
				if (!environment) {
					return;
				}
				if (!requireRemote()) {
					return;
				}
				const count = await forwardEnvironmentPorts(environment);
				void vscode.window.showInformationMessage(
					`BFAST forwarded ${count} port${count === 1 ? '' : 's'} for ${environmentLabel(environment.id)}.`
				);
			}
		),

		vscode.commands.registerCommand(
			'bfast.forwardEnvironmentPort',
			async (node?: EnvironmentTreeNode) => {
				if (node?.kind !== 'port' || !requireRemote()) {
					return;
				}
				try {
					await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${node.port}`));
					void vscode.window.showInformationMessage(
						`BFAST forwarded port ${node.port} (${node.name}).`
					);
				} catch (error) {
					void vscode.window.showErrorMessage(
						errorMessage(error, `Port ${node.port} could not be forwarded.`)
					);
				}
			}
		),

		vscode.commands.registerCommand('bfast.stopEnvironment', (node?: EnvironmentTreeNode) => {
			const environment = environmentOf(node);
			if (environment) {
				void operate(
					environment.id,
					`BFAST: stopping ${environmentLabel(environment.id)}…`,
					() => environments.stop(environment.id)
				);
			}
		}),

		vscode.commands.registerCommand('bfast.deleteEnvironment', async (node?: EnvironmentTreeNode) => {
			const environment = environmentOf(node);
			if (!environment) {
				return;
			}
			// Two different promises, and the master one matters: a person who
			// read "the worktree will be removed" about their own workspace
			// folder would be right to be alarmed.
			const choice = await vscode.window.showWarningMessage(
				environment.scope === 'master'
					? 'Delete the master environment? The stack and its volumes will be removed. ' +
							'Your workspace folder is not touched.'
					: `Delete the environment for ${environment.id}? The stack and its volumes ` +
							`will be removed. The branch ${environment.branch} is kept.`,
				{ modal: true },
				'Delete'
			);
			if (choice === 'Delete') {
				void operate(
					environment.id,
					`BFAST: deleting ${environmentLabel(environment.id)}…`,
					() => environments.remove(environment.id)
				);
			}
		}),

		vscode.commands.registerCommand('bfast.openEnvironmentWindow', (node?: EnvironmentTreeNode) => {
			const environment = environmentOf(node);
			// The master environment's folder is the workspace this window already
			// shows; the menu hides the entry, this guards a palette or keybinding.
			if (environment && environment.scope !== 'master') {
				void vscode.commands.executeCommand(
					'vscode.openFolder',
					vscode.Uri.file(environment.worktreePath),
					{ forceNewWindow: true }
				);
			}
		}),

		vscode.commands.registerCommand('bfast.openEnvironmentPort', async (node?: EnvironmentTreeNode) => {
			if (node?.kind !== 'port') {
				return;
			}
			const url = `http://localhost:${node.port}`;
			try {
				// The built-in Simple Browser keeps the page inside the editor —
				// and in a remote/WSL window it is also what triggers VS Code's own
				// port forwarding. It reveals its one view rather than opening a
				// second tab, so pressing this twice reuses the tab.
				await vscode.commands.executeCommand('simpleBrowser.show', url);
			} catch {
				// Simple Browser is a built-in extension a user can disable, and
				// then its command is not registered. Falling back to the external
				// browser silently would make this entry and "Open Port in Browser"
				// the same action, so the two stay told apart: say what happened
				// and offer the other route rather than taking it unasked.
				const choice = await vscode.window.showWarningMessage(
					`VS Code's built-in browser is unavailable, so ${url} cannot be opened here. ` +
						'Open it in your browser instead?',
					'Open in Browser'
				);
				if (choice === 'Open in Browser') {
					await openPortExternally(url);
				}
			}
		}),

		vscode.commands.registerCommand(
			'bfast.openEnvironmentPortInBrowser',
			async (node?: EnvironmentTreeNode) => {
				if (node?.kind !== 'port') {
					return;
				}
				await openPortExternally(`http://localhost:${node.port}`);
			}
		),

		vscode.commands.registerCommand('bfast.revealEnvironment', (node?: EnvironmentTreeNode) => {
			const environment = environmentOf(node);
			if (environment) {
				void vscode.commands.executeCommand(
					'revealFileInOS',
					vscode.Uri.file(environment.worktreePath)
				);
			}
		}),

		vscode.commands.registerCommand(
			'bfast.openContainerLog',
			(node?: EnvironmentTreeNode) => {
				// The row's own click sends this node; the menu entry's `when`
				// makes anything else unreachable.
				if (node?.kind === 'container') {
					openContainerLog(node.environment, node.container);
				}
			}
		),

		vscode.commands.registerCommand('bfast.refreshEnvironments', () => refresh())
	];
}

function environmentOf(node: EnvironmentTreeNode | undefined) {
	return node?.kind === 'environment' ? node.environment : undefined;
}

/**
 * True in a remote window; otherwise says why there is nothing to forward.
 * Deliberately a message rather than a hidden menu entry — a gate that hides
 * the action reads as the feature missing.
 */
function requireRemote(): boolean {
	if (vscode.env.remoteName === undefined) {
		void vscode.window.showInformationMessage(
			'This window is not remote — localhost ports are reachable directly, no forward needed.'
		);
		return false;
	}
	return true;
}

/**
 * Hands the address to the operating system's default browser.
 *
 * In a **remote** window `openExternal` resolves a localhost uri itself — it
 * establishes the forward and opens the tunnel — which is why `asExternalUri`
 * must never be called on a uri that then goes through it. So the remote case
 * needs nothing here, and the address BFAST passes stays `http://localhost:<port>`.
 *
 * A refusal — no default browser, or the OS declining — names the address, so
 * it can be copied by hand rather than leaving the click with no answer at all.
 */
async function openPortExternally(url: string): Promise<void> {
	let reason: string | undefined;
	try {
		if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
			reason = 'no default browser answered';
		}
	} catch (error) {
		reason = errorMessage(error, 'the operating system refused');
	}
	if (reason !== undefined) {
		void vscode.window.showErrorMessage(
			`Could not open ${url} in a browser — ${reason}. Copy the address and open it yourself.`
		);
	}
}

/**
 * Creates the remote window's port forwards for every allocated port.
 * `asExternalUri` is the one stable API for this, and it **reuses an existing
 * forward** rather than duplicating it — which is exactly the "only ports not
 * yet forwarded" rule, for free. A local window needs none: localhost is
 * already localhost.
 */
async function forwardEnvironmentPorts(environment: EnvironmentHandle): Promise<number> {
	if (vscode.env.remoteName === undefined) {
		return 0;
	}
	let forwarded = 0;
	for (const port of Object.values(environment.ports)) {
		try {
			await vscode.env.asExternalUri(vscode.Uri.parse(`http://localhost:${port}`));
			forwarded++;
		} catch {
			// One refused port must not stop the rest; the Ports view is the
			// place to see what actually happened.
		}
	}
	return forwarded;
}
