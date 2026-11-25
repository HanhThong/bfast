// The scan results tab: one analysis, start to finish.
//
// A webview editor tab rather than a progress notification, for the reason the
// generate tab is one — a first boot is minutes of log that prove it has not
// hung, and a notification cannot be live while anything else has focus — plus
// one of its own: a quality gate and thirty issues are a table, and a table
// cannot be a toast.
//
// Like `GeneratePanel`, it is a thin translator and nothing more: every decision
// still lives in `scanRunner.ts`, and this only turns each report into a message
// and each button into a call. That is what lets the same flow be driven by a
// test with no UI at all.

import * as path from 'path';
import * as vscode from 'vscode';
import type { ScanServices } from './scanServices';
import { runScan } from './scanRunner';
import { scanMode } from '../settings/scanSettings';
import type { ScanPhase, ScanTargetRef } from './scanReport';
import { HostToScan, ScanToHost } from '../shared/protocol';
import { renderWebviewHtml } from '../host/webviewHtml';
import { unhandled } from '../platform/exhaustive';

/** One tab per target. Unlike a board's ticket, this key genuinely cannot change. */
function keyOf(target: ScanTargetRef): string {
	return `${target.projectKey}::${target.ticketId ?? ''}`;
}

export class ScanPanel {
	public static readonly viewType = 'bfast.scan';

	private static readonly panels = new Set<ScanPanel>();

	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	/** Cancels the live run. Replaced per run; `undefined` between them. */
	private cancelRun: (() => void) | undefined;
	/** Stop was pressed while nothing was cancellable yet — see `GeneratePanel`. */
	private stopRequested = false;
	private running = false;
	/** The webview has sent `scanReady`, so a message posted to it will land. */
	private ready = false;
	/** A `requestStart` that arrived before the webview was listening — see there. */
	private startPending = false;

	/**
	 * Opens the tab for a target, or reveals the one already open for it.
	 *
	 * Asking twice reveals rather than starting a second analysis: two runs
	 * against one project key produce two server-side tasks whose measures
	 * overwrite each other, and the verdict you read would belong to a run you
	 * cannot identify.
	 */
	public static show(
		extensionUri: vscode.Uri,
		services: ScanServices,
		target: ScanTargetRef
	): ScanPanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		for (const open of ScanPanel.panels) {
			if (keyOf(open.target) === keyOf(target)) {
				open.panel.reveal(column);
				return open;
			}
		}

		const panel = vscode.window.createWebviewPanel(
			ScanPanel.viewType,
			titleFor(target),
			column,
			ScanPanel.webviewOptions(extensionUri)
		);
		return new ScanPanel(panel, extensionUri, services, target);
	}

	/**
	 * Called by the serializer after a window reload.
	 *
	 * A restored tab comes back on its **setup** screen: a run was a child process
	 * this session owned, so there is nothing to resume, and a log that never
	 * advances again would be a lie.
	 */
	public static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		services: ScanServices,
		target: ScanTargetRef
	): void {
		panel.webview.options = ScanPanel.webviewOptions(extensionUri);
		new ScanPanel(panel, extensionUri, services, target);
	}

	private static webviewOptions(
		extensionUri: vscode.Uri
	): vscode.WebviewOptions & vscode.WebviewPanelOptions {
		return {
			enableScripts: true,
			// A first boot takes minutes and the log is the only proof it is alive;
			// rebuilding the webview on every tab switch would throw it away.
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly services: ScanServices,
		private target: ScanTargetRef
	) {
		ScanPanel.panels.add(this);

		this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'scan.svg');
		this.panel.webview.html = renderWebviewHtml(
			this.panel.webview,
			extensionUri,
			'scan',
			titleFor(target)
		);

		this.panel.webview.onDidReceiveMessage(
			(message: ScanToHost) => this.handleMessage(message),
			undefined,
			this.disposables
		);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	public dispose(): void {
		this.disposed = true;
		ScanPanel.panels.delete(this);

		// Closing the tab is as clear a stop as pressing the button, and the log it
		// was reporting into is gone either way.
		this.cancelRun?.();
		this.cancelRun = undefined;

		this.panel.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleMessage(message: ScanToHost): Promise<void> {
		switch (message.type) {
			case 'scanReady':
				// A revived tab knows its own target before we do; trust it only to
				// name one, never for anything the flow reads.
				if (message.target) {
					this.target = message.target;
					this.panel.title = titleFor(this.target);
				}
				this.ready = true;
				await this.sendContext();
				if (this.startPending) {
					this.startPending = false;
					await this.run();
				}
				break;

			case 'scanStart':
				this.stopRequested = false;
				await this.run();
				break;

			case 'scanCancel':
				this.stopRequested = true;
				this.cancelRun?.();
				break;

			case 'scanReset':
				this.post({ type: 'scanPhase', phase: 'setup' });
				break;

			case 'openScanIssue':
				await this.openIssue(message.file, message.line);
				break;

			case 'openScanUrl':
				await this.openUrl(message.url);
				break;
			default:
				unhandled(message);
		}
	}

	/** What the setup screen needs: the target, the server, and whether a scan can run. */
	private async sendContext(): Promise<void> {
		const availability = await this.services.provider.availability();
		const server = await this.services.servers.get();

		this.post({
			type: 'scanContext',
			target: this.target,
			toolLabel: this.services.provider.label,
			mode: scanMode(this.services.settings()),
			serverStatus: server.status,
			...(server.endpoint ? { serverUrl: server.endpoint.url } : {}),
			available: availability.ok,
			...(availability.message ? { unavailable: availability.message } : {})
		});
	}

	/**
	 * Starts the scan from outside the tab — the MCP server's `run_scan`.
	 *
	 * `false` means one was already going for this target, which is the answer a
	 * client that gave up waiting and retried should get: asking twice against
	 * one project key would produce two server-side analyses whose measures
	 * overwrite each other, and the verdict you read would belong to a run you
	 * cannot identify. Going through the tab rather than calling `runScan`
	 * directly is what reuses that guard — and puts the log and the verdict where
	 * the person watching expects them.
	 *
	 * A freshly created tab has not sent `scanReady` yet, and a run posting into
	 * a webview that is not listening would lose its phases and its log, so the
	 * start waits for it.
	 */
	public requestStart(): boolean {
		if (this.running || this.startPending) {
			return false;
		}
		this.stopRequested = false;
		if (this.ready) {
			void this.run();
		} else {
			this.startPending = true;
		}
		return true;
	}

	private async run(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		try {
			const result = await runScan(
				{
					provider: this.services.provider,
					server: this.services.servers,
					store: this.services.store,
					settings: this.services.settings,
					workspaceRoot: this.services.workspaceRoot,
					workspaceName: this.services.workspaceName,
					...(this.services.resolveDirectory
						? { resolveDirectory: this.services.resolveDirectory }
						: {}),
					onProgress: (event) => {
						if (event.kind === 'output') {
							this.services.output.append(event.text);
							for (const line of event.text.split('\n')) {
								if (line.trim().length > 0) {
									this.post({ type: 'scanLog', line });
								}
							}
						} else if (event.kind === 'phase') {
							this.services.output.appendLine(`— ${event.label}`);
							this.post({ type: 'scanPhase', phase: event.phase });
							this.post({ type: 'scanLog', line: event.label });
						} else {
							this.post({ type: 'scanReport', report: event.report });
						}
					}
				},
				this.target.ticketId,
				{
					onCancel: (cancel) => {
						this.cancelRun = cancel;
						// The button can be pressed before the run reaches its first
						// cancellable step, so the press is remembered and spent here.
						if (this.stopRequested) {
							cancel();
						}
					}
				}
			);

			// The runner resolved the target properly; adopt it so the tab title and
			// a later "open issue" join onto the directory that was actually scanned.
			this.target = result.target;
			this.panel.title = titleFor(this.target);
			this.services.refresh();

			if (result.message) {
				this.post({ type: 'scanError', message: result.message, code: result.outcome });
			}
			if (result.recordError) {
				this.post({
					type: 'scanLog',
					line: `⚠ The verdict could not be written onto the ticket: ${result.recordError}`
				});
			}
			this.post({ type: 'scanDone', message: result.summary, outcome: result.outcome });
		} finally {
			// Whatever happened, the run is over — so the tab must stop showing a
			// Stop button. In a `finally` because the tab shows one optimistically
			// from the moment Scan is pressed.
			this.running = false;
			this.cancelRun = undefined;
		}
	}

	/**
	 * Opens the file an issue is on.
	 *
	 * The path arrived over the network, so it is joined onto the run's own
	 * directory and refused if it escapes — the `safeLinkHref` posture, applied to
	 * a filesystem path.
	 */
	private async openIssue(file: string, line?: number): Promise<void> {
		const root = this.target.directory;
		const resolved = path.resolve(root, file);
		const inside =
			resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
		if (!inside) {
			void vscode.window.showWarningMessage(
				`BFAST will not open \`${file}\` — it is outside the folder that was scanned.`
			);
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
			const at = Math.max(0, (line ?? 1) - 1);
			await vscode.window.showTextDocument(document, {
				preview: false,
				selection: new vscode.Range(at, 0, at, 0)
			});
		} catch {
			void vscode.window.showWarningMessage(`BFAST could not open \`${file}\`.`);
		}
	}

	/** Opens a page on the scan server, and only on the scan server. */
	private async openUrl(url: string): Promise<void> {
		const server = await this.services.servers.get();
		const base = server.endpoint?.url;
		if (base === undefined || !sameOrigin(url, base)) {
			void vscode.window.showWarningMessage(
				'BFAST will only open links on the scan server it is configured for.'
			);
			return;
		}
		try {
			await vscode.commands.executeCommand('simpleBrowser.show', url);
		} catch {
			// Simple Browser is a built-in extension a user can disable.
			await vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}

	private post(message: HostToScan): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}

function titleFor(target: ScanTargetRef): string {
	return `Scan — ${target.ticketKey ?? target.ticketId ?? target.projectKey}`;
}

function sameOrigin(candidate: string, base: string): boolean {
	try {
		return new URL(candidate).origin === new URL(base).origin;
	} catch {
		return false;
	}
}
