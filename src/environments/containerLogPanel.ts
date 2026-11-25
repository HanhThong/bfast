// One container's log, followed live in an editor tab.
//
// An editor tab rather than an Output channel, deliberately: the "BFAST
// Environments" channel is the log of Start/Stop/Delete *operations* and stays
// exactly that. A container's log is a different thing about a different
// subject, and interleaving the two — or making the user pick BFAST's channel
// out of a dropdown that has grown one entry per container — would serve
// neither. docs/environments/container-logs.md is the specification.
//
// Like `ScanPanel` this is a thin translator: the store owns the follow and the
// `logTail` setting, and this only turns its output into messages and the tab's
// lifetime into a cancel.

import * as vscode from 'vscode';
import {
	containerDisplayName,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentOperation
} from './environmentProvider';
import { LogLineBuffer } from './logLines';
import type { EnvironmentStore } from './environmentStore';
import type { HostToContainerLog, ContainerLogToHost } from '../shared/protocol';
import { renderWebviewHtml } from '../host/webviewHtml';
import { errorMessage } from '../platform/errors';

/**
 * How often buffered output is posted. The tab is not a terminal: a batch every
 * tenth of a second reads as live, and a crash-looping container then costs ten
 * messages a second rather than thousands.
 */
const FLUSH_INTERVAL_MS = 100;

/** One tab per container. Its name, not its id — a Start recreates the latter. */
function keyOf(environmentId: string, containerName: string): string {
	return `${environmentId}\n${containerName}`;
}

export class ContainerLogPanel {
	public static readonly viewType = 'bfast.containerLog';

	private static readonly panels = new Set<ContainerLogPanel>();

	private readonly disposables: vscode.Disposable[] = [];
	private readonly buffer = new LogLineBuffer();

	/** The live follow, or `undefined` once the stream has ended. */
	private follow: EnvironmentOperation | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	/** The webview has sent `containerLogReady`, so a post will land. */
	private ready = false;
	private disposed = false;

	/**
	 * Opens the tab for a container, or reveals the one already open for it.
	 *
	 * Asking twice reuses the place rather than doubling it. If that tab's
	 * stream had already ended — a Start swept the container away — the click
	 * starts a fresh follow **in the same tab**, on the container as it is now,
	 * with the history kept and a separator between the two.
	 */
	public static show(
		extensionUri: vscode.Uri,
		environments: EnvironmentStore,
		env: EnvironmentDescriptor,
		container: EnvironmentContainer
	): ContainerLogPanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		for (const open of ContainerLogPanel.panels) {
			if (open.key === keyOf(env.id, container.name)) {
				open.panel.reveal(column);
				open.retarget(env, container);
				return open;
			}
		}

		const panel = vscode.window.createWebviewPanel(
			ContainerLogPanel.viewType,
			titleFor(env, container),
			column,
			ContainerLogPanel.webviewOptions(extensionUri)
		);
		return new ContainerLogPanel(panel, extensionUri, environments, env, container);
	}

	/**
	 * Called by the serializer after a window reload.
	 *
	 * Unlike a generate or a scan tab, this one comes back **following again**.
	 * A run there was a child process that spent money and cannot be resumed;
	 * a log is a view of live state, and re-opening it is exactly what the
	 * person who left the tab open wanted. If the container is gone the tab
	 * says so through the path that already exists for it.
	 */
	public static async revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		environments: EnvironmentStore,
		environmentId: string,
		containerName: string
	): Promise<void> {
		const env = await environments.find(environmentId);
		if (!env) {
			// Nothing to restore it to; an empty log tab is worse than none.
			panel.dispose();
			return;
		}

		const container = await findContainer(environments, env, containerName);
		panel.webview.options = ContainerLogPanel.webviewOptions(extensionUri);
		new ContainerLogPanel(
			panel,
			extensionUri,
			environments,
			env,
			container ?? placeholderFor(containerName)
		);
	}

	private static webviewOptions(
		extensionUri: vscode.Uri
	): vscode.WebviewOptions & vscode.WebviewPanelOptions {
		return {
			enableScripts: true,
			// The log is the whole document: rebuilding the webview on every tab
			// switch would throw away what the container said while you were
			// looking at the code.
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly environments: EnvironmentStore,
		private env: EnvironmentDescriptor,
		private container: EnvironmentContainer
	) {
		ContainerLogPanel.panels.add(this);

		this.panel.webview.html = renderWebviewHtml(
			this.panel.webview,
			extensionUri,
			'containerLog',
			titleFor(env, container)
		);

		this.panel.webview.onDidReceiveMessage(
			(message: ContainerLogToHost) => {
				if (message.type === 'containerLogReady') {
					this.ready = true;
					void this.pin();
					this.start();
				}
			},
			undefined,
			this.disposables
		);
		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	private get key(): string {
		return keyOf(this.env.id, this.container.name);
	}

	/**
	 * Pins the tab if the workbench opened it as a preview one.
	 *
	 * `BfastPanel.pin()`'s mechanism, with the opposite policy: a board *wants*
	 * preview, because clicking down a list of tickets should reuse one tab, and
	 * it pins only once work starts in it. A log tab is the work from the moment
	 * it opens — it holds a stream that is running — so the next click must
	 * never take it away. Watching the api gateway while the worker crashes is
	 * the whole point, and it needs two tabs.
	 *
	 * Done here rather than at construction because the tab has to exist to be
	 * found, and `containerLogReady` is proof the webview is up. `keepEditor`
	 * acts on the active editor, hence the reveal first — the user just clicked
	 * this row, so that is where they already are. The webview knows nothing of
	 * any of it.
	 */
	private async pin(): Promise<void> {
		const tab = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.find(
				(candidate) =>
					candidate.input instanceof vscode.TabInputWebview &&
					// The workbench reports a panel's view type with a prefix of its
					// own (`mainThreadWebview-…`), so this is never an equality test.
					candidate.input.viewType.endsWith(ContainerLogPanel.viewType) &&
					candidate.label === this.panel.title
			);
		if (!tab?.isPreview) {
			return;
		}
		this.panel.reveal(this.panel.viewColumn);
		await vscode.commands.executeCommand('workbench.action.keepEditor');
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		ContainerLogPanel.panels.delete(this);

		// Closing the tab is as clear a stop as any: nothing keeps following
		// behind a tab that is gone.
		this.stopFollow();

		this.panel.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	/**
	 * A second click on a container whose tab is already open. The container's
	 * id may have moved under it — a Start recreates every container while the
	 * name stays — so the newer one is adopted, and a stream that had ended is
	 * started again.
	 */
	private retarget(env: EnvironmentDescriptor, container: EnvironmentContainer): void {
		this.env = env;
		this.container = container;
		if (!this.follow) {
			this.start();
		}
	}

	/** Begins a follow and tells the webview one is beginning. */
	private start(): void {
		if (this.disposed || !this.ready || this.follow) {
			return;
		}

		this.post({
			type: 'containerLog',
			environment: this.env.scope === 'master' ? 'Master' : this.env.id,
			container: containerDisplayName(this.env, this.container),
			service: this.container.service,
			state: this.container.state,
			status: this.container.status,
			environmentId: this.env.id,
			containerName: this.container.name
		});

		if (this.container.id.length === 0) {
			// A revived tab whose container no longer exists: there is nothing to
			// open, and saying so is the same fact as a stream that ended.
			this.post({ type: 'containerLogEnded', reason: 'the container is gone' });
			return;
		}

		const follow = this.environments.logs(this.env, this.container, (progress) => {
			if (progress.kind === 'output') {
				this.buffer.push(progress.text);
			}
		});
		this.follow = follow;
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);

		follow.completed.then(
			() => this.ended('the container is gone'),
			(error: unknown) => this.ended(errorMessage(error, 'the stream stopped'))
		);
	}

	private flush(): void {
		const lines = this.buffer.take();
		if (lines.length > 0) {
			this.post({ type: 'containerLogLines', lines });
		}
	}

	/** The follow settled: drain what is left, including a last unterminated line. */
	private ended(reason: string): void {
		if (this.disposed || !this.follow) {
			return;
		}
		this.stopFollow();

		const lines = this.buffer.takeAll();
		if (lines.length > 0) {
			this.post({ type: 'containerLogLines', lines });
		}
		this.post({ type: 'containerLogEnded', reason });
	}

	private stopFollow(): void {
		if (this.flushTimer !== undefined) {
			clearInterval(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.follow?.cancel();
		this.follow = undefined;
	}

	private post(message: HostToContainerLog): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}

/** `'Log — ST-1.2 web-1'`, the environment then the container's own short name. */
function titleFor(env: EnvironmentDescriptor, container: EnvironmentContainer): string {
	const environment = env.scope === 'master' ? 'Master' : env.id;
	return `Log — ${environment} ${containerDisplayName(env, container)}`;
}

/** The container a revived tab was following, if the stack still has it. */
async function findContainer(
	environments: EnvironmentStore,
	env: EnvironmentDescriptor,
	name: string
): Promise<EnvironmentContainer | undefined> {
	try {
		return (await environments.containers(env)).find((candidate) => candidate.name === name);
	} catch {
		// Docker unreachable at reload; the tab still opens and says the stream
		// is not running, which is the truth it can vouch for.
		return undefined;
	}
}

/**
 * A container that is not there any more, so a revived tab can still name what
 * it was watching. The empty `id` is what `start` reads as "nothing to open".
 */
function placeholderFor(name: string): EnvironmentContainer {
	return { id: '', name, service: name, state: 'unknown', status: '' };
}
