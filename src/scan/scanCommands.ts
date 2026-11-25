// The "Code Quality" command half — see docs/scan/ for the contract.
//
// Every decision lives in `scan/scanServerStore.ts` and `scan/scanRunner.ts`;
// this handler only translates the gesture. Server operations get the
// `environmentCommands.operate` shape — a cancellable `withProgress`
// notification, the "BFAST Code Quality" output channel the store streams into, and
// an error offering "Show Log". A *scan* gets a tab instead, because a verdict is
// a table.

import * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import type { ScanTargetRef } from './scanReport';
import { scanRunDeps, type ScanServices } from './scanServices';
import { ScanCancelledError, ScanError, type ScanProvider } from './scanProvider';
import { resolveTarget, type ScanRunDeps } from './scanRunner';
import type { ScanServerStore } from './scanServerStore';
import { scanMode, type ScanSettings } from '../settings/scanSettings';
import type { EnvironmentTreeNode } from '../environments/environmentTreeProvider';
import type { ScanTreeNode } from './scanTreeProvider';
import { errorMessage } from '../platform/errors';

/**
 * `showScan` opens the results tab for a target. Passed in rather than
 * imported, so the command half does not depend on the panel that depends on
 * these services.
 */
export function registerScanCommands(
	services: ScanServices,
	showScan: (target: ScanTargetRef) => void
): vscode.Disposable[] {
	const { servers, output, refresh } = services;

	const showWithLog = async (
		show: (message: string, ...items: string[]) => Thenable<string | undefined>,
		message: string,
		...extra: string[]
	): Promise<string | undefined> => {
		const choice = await show(message, ...extra, 'Show Log');
		if (choice === 'Show Log') {
			output.show(true);
		}
		return choice;
	};

	/** One long store call under a cancellable notification. */
	const operate = async (title: string, work: () => Promise<unknown>): Promise<void> => {
		try {
			output.appendLine(`— ${title}`);
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title, cancellable: true },
				async (_progress, token) => {
					token.onCancellationRequested(() => servers.cancel());
					await work();
				}
			);
		} catch (error) {
			if (error instanceof ScanCancelledError) {
				return;
			}
			const message =
				errorMessage(error, 'The scan server operation failed.');
			output.appendLine(`— ${message}`);
			const choice = await showWithLog(
				vscode.window.showErrorMessage,
				message,
				...(error instanceof ScanError && error.code === 'unauthorized' ? ['Set Token'] : []),
				...(error instanceof ScanError && error.code === 'not-configured'
					? ['Open Settings']
					: [])
			);
			if (choice === 'Set Token') {
				await services.setToken();
			} else if (choice === 'Open Settings') {
				void vscode.commands.executeCommand('bfast.openSettings');
			}
		} finally {
			refresh();
		}
	};

	/**
	 * The graceful-degradation gate the provider seam promises: a missing docker,
	 * or an unconfigured external url, refuses with its reason before anything is
	 * deployed.
	 */
	const available = async (): Promise<boolean> => {
		const availability = await services.provider.availability();
		if (!availability.ok) {
			const choice = await vscode.window.showWarningMessage(
				availability.message ?? 'Code scanning is not available.',
				'Open Settings'
			);
			if (choice === 'Open Settings') {
				void vscode.commands.executeCommand('bfast.openSettings');
			}
			return false;
		}
		return true;
	};

	/** Opens the results tab for a target, resolving what will actually be scanned. */
	const openScan = async (ticketId?: string): Promise<void> => {
		if (!(await available())) {
			return;
		}
		const target = await resolveTarget(scanRunDeps(services), services.settings(), ticketId);
		showScan(target);
	};

	return [
		// A scan is of an **environment** — the worktree on the branch the work is
		// actually on — and the gesture lives on its row in the Environments
		// section, in every settled state: the worktree is there whether the
		// stack is running or not, and a scan reads source, not containers. The
		// transitional states are left out only because the row is mid-operation
		// and the queue would make the click wait. The verdict is recorded on
		// the environment's ticket. A ticket with no environment has nothing of
		// its own to scan; Scan Workspace is the whole-repo answer.
		vscode.commands.registerCommand('bfast.runScan', async (node?: EnvironmentTreeNode) => {
			// Unreachable from the menu, whose `when` clause requires an environment
			// row; it guards a keybinding or a palette invocation.
			if (node?.kind !== 'environment') {
				void vscode.window.showWarningMessage(
					'Right-click an environment in the Environments section to scan it.'
				);
				return;
			}
			// The master environment's folder is the workspace, so scanning it
			// is Scan Workspace — the default project key, and no ticket to
			// record the verdict on. Spelled out rather than left to
			// `ticketId` being `undefined`, which nobody would read as "the
			// workspace".
			if (node.environment.scope === 'master') {
				await openScan();
				return;
			}
			await openScan(node.environment.id);
		}),

		vscode.commands.registerCommand('bfast.scanWorkspace', () => openScan()),

		vscode.commands.registerCommand('bfast.openScanResults', async (node?: ScanTreeNode) => {
			if (node?.kind === 'run') {
				showScan(node.run.target);
			} else {
				await openScan();
			}
		}),

		// Deploy and Start are one gesture underneath: `setup()` deploys what is
		// absent, starts what is stopped and provisions what is missing, and skips
		// whatever is already done. A user who presses either wants the state in
		// which Scan works, not a stopped server to go and start next.
		vscode.commands.registerCommand('bfast.deployScanServer', async () => {
			if (await available()) {
				await operate('BFAST: setting up the scan server…', () => servers.setup());
			}
		}),

		vscode.commands.registerCommand('bfast.startScanServer', () =>
			operate('BFAST: starting the scan server…', () => servers.setup())
		),

		vscode.commands.registerCommand('bfast.stopScanServer', () =>
			operate('BFAST: stopping the scan server…', () => servers.stop())
		),

		vscode.commands.registerCommand('bfast.provisionScanServer', () =>
			operate('BFAST: checking the scan credentials…', () => servers.provision())
		),

		vscode.commands.registerCommand('bfast.removeScanServer', async () => {
			// Naming what goes is the point: "Remove" does not obviously mean "and
			// every analysis you have ever run".
			const choice = await vscode.window.showWarningMessage(
				'Remove the scan server? Its containers, volumes, analysis history and the credentials BFAST generated are all deleted.',
				{ modal: true },
				'Remove'
			);
			if (choice === 'Remove') {
				await operate('BFAST: removing the scan server…', () => servers.remove());
			}
		}),

		vscode.commands.registerCommand('bfast.openScanServer', async (node?: ScanTreeNode) => {
			const url =
				node?.kind === 'endpoint' ? node.url : (await servers.get()).endpoint?.url;
			if (url === undefined) {
				void vscode.window.showInformationMessage(
					'There is no scan server to open yet. Deploy one, or set its URL in the BFAST settings.'
				);
				return;
			}
			try {
				// The built-in Simple Browser keeps the page inside the editor — and
				// in a remote window it is also what triggers port forwarding.
				await vscode.commands.executeCommand('simpleBrowser.show', url);
			} catch {
				await vscode.env.openExternal(vscode.Uri.parse(url));
			}
		}),

		vscode.commands.registerCommand('bfast.setSonarQubeToken', async () => {
			await services.setToken();
			refresh();
		}),

		vscode.commands.registerCommand('bfast.showSonarQubeAdminPassword', () =>
			services.showAdminPassword()
		),

		vscode.commands.registerCommand('bfast.copyScanCredential', () => services.copyCredential()),

		vscode.commands.registerCommand('bfast.clearScanCredentials', async () => {
			await services.clearCredentials();
			refresh();
			void vscode.window.showInformationMessage(
				'BFAST cleared the stored scan credentials for this workspace.'
			);
		}),

		vscode.commands.registerCommand('bfast.revealScanFolder', async () => {
			const server = await servers.get();
			if (scanMode(services.settings()) === 'external' || server.home.length === 0) {
				void vscode.window.showInformationMessage(
					'This workspace points at a SonarQube BFAST does not manage, so there is no scan folder.'
				);
				return;
			}
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(server.home));
		}),

		vscode.commands.registerCommand('bfast.refreshScan', () => refresh())
	];
}
