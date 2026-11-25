// "Open in Playwright Trace Viewer" without a configured command: the
// Playwright already installed in the workspace, run as `show-trace --stdin`,
// one process per window — the first trace starts it, later ones are written
// to its stdin, and the viewer exits when its window is closed or stdin ends.
// The shape the official VS Code extension uses (`spawnTraceViewer.ts`), since
// Playwright no longer ships an embeddable viewer.
//
// `vscode`-free: the runner, the file probe, the roots, the remote flag and
// the opener are all injected, so `traceViewerLauncher.test.ts` drives the
// whole lifecycle against `FakeProcessRunner`. Two facts about the viewer are
// load-bearing here, both checked against playwright-core 1.59:
// - Each stdin chunk is **one** path, `trim()`med and `statSync`ed — a path
//   that does not exist crashes the viewer, and two paths in one chunk are one
//   bad path. So only real-path-verified files are written, one per write,
//   with a pause between writes so Node cannot coalesce them.
// - `--host`/`--port` make it a server that prints `Listening on <url>` rather
//   than opening a window, which is the only mode that works on a remote.

import * as path from 'path';
import { ProcessError, type ProcessRunner, type RunningProcess } from '../platform/runProcess';
import { errorMessage } from '../platform/errors';

/** Where a workspace's Playwright CLI lives, in the order tried. */
export const PLAYWRIGHT_CLIS = ['playwright-core/cli.js', 'playwright/cli.js', '@playwright/test/cli.js'];

/** How long the server may take to print its url on a remote before the open is given up. */
export const VIEWER_READY_TIMEOUT_MS = 30_000;
/** How long a spawn is watched for `ENOENT` before the first path is written. */
const SPAWN_SETTLE_MS = 400;
/** The pause between two stdin writes — see the module comment. */
const WRITE_GAP_MS = 150;
/** After `dispose` ends stdin, how long the viewer gets to exit on its own. */
const CLOSE_GRACE_MS = 2_000;

export interface TraceViewerDeps {
	runner: ProcessRunner;
	/** Whether a file exists — follows symlinks, as pnpm's `node_modules` need. */
	exists: (file: string) => Promise<boolean>;
	/** The folders a `node_modules` is looked for under: `tests.cwd` first, then the workspace root. */
	roots: () => string[];
	/** A remote window: serve on a port and open the browser instead of a window on the remote. */
	remote: () => boolean;
	/** Opens a url in the user's browser — through `asExternalUri`, so the port is forwarded. */
	openExternal: (url: string) => Promise<void>;
	/** The "BFAST Tests" channel. */
	log: (line: string) => void;
	env?: NodeJS.ProcessEnv;
	/** The editor's own binary, run as node when no `node` is on PATH. */
	execPath?: string;
}

export type TraceViewerOutcome =
	| { kind: 'opened' }
	| { kind: 'reused' }
	| { kind: 'not-found' }
	| { kind: 'failed'; message: string };

export interface PlaywrightCli {
	cli: string;
	/** The folder whose `node_modules` held it — the viewer's working directory. */
	root: string;
}

/** The first Playwright CLI under any root's `node_modules`, in `PLAYWRIGHT_CLIS` order per root. */
export async function findPlaywrightCli(
	roots: readonly string[],
	exists: (file: string) => Promise<boolean>
): Promise<PlaywrightCli | undefined> {
	for (const root of roots) {
		for (const relative of PLAYWRIGHT_CLIS) {
			const cli = path.join(root, 'node_modules', relative);
			if (await exists(cli)) {
				return { cli, root };
			}
		}
	}
	return undefined;
}

interface LiveViewer {
	process: RunningProcess;
	cli: PlaywrightCli;
	/** Writes, one at a time with a gap. */
	queue: Promise<void>;
}

export class TraceViewerLauncher {
	private live: LiveViewer | undefined;
	private disposed = false;

	constructor(private readonly deps: TraceViewerDeps) {}

	/** Whether a click on the button has a Playwright to run. */
	async available(): Promise<boolean> {
		return (await findPlaywrightCli(this.deps.roots(), this.deps.exists)) !== undefined;
	}

	/** Opens `target` — an existing, verified path — in the viewer, starting one if none is live. */
	async open(target: string): Promise<TraceViewerOutcome> {
		if (this.disposed) {
			return { kind: 'failed', message: 'BFAST is shutting down.' };
		}
		const name = path.basename(target);
		if (this.live) {
			const live = this.live;
			this.deps.log(`— Opening ${name} in the running Playwright Trace Viewer.`);
			this.enqueue(live, target);
			return { kind: 'reused' };
		}

		const found = await findPlaywrightCli(this.deps.roots(), this.deps.exists);
		if (!found) {
			return { kind: 'not-found' };
		}
		const remote = this.deps.remote();
		const args = [found.cli, 'show-trace', '--stdin', ...(remote ? ['--host', '127.0.0.1', '--port', '0'] : [])];
		this.deps.log(`— Opening ${name} in Playwright Trace Viewer: node ${args.join(' ')}`);

		let started = await this.spawn('node', args, found, {});
		if (started.kind === 'not-installed' && this.deps.execPath) {
			this.deps.log('— `node` is not on the PATH; running the viewer with the editor’s own runtime.');
			started = await this.spawn(this.deps.execPath, args, found, { ELECTRON_RUN_AS_NODE: '1' });
		}
		if (started.kind === 'not-installed') {
			return { kind: 'failed', message: 'Could not run `node`. Is Node.js installed and on your PATH?' };
		}
		if (started.kind === 'failed') {
			return { kind: 'failed', message: started.message };
		}
		const live = started.live;
		this.live = live;

		if (remote) {
			const url = await started.url;
			if (url === undefined) {
				live.process.cancel('The trace viewer did not report a url.');
				if (this.live === live) {
					this.live = undefined;
				}
				return {
					kind: 'failed',
					message: 'The trace viewer did not say which port it is serving on. See the BFAST Tests log.'
				};
			}
			this.deps.log(`— Trace viewer: ${url}`);
			try {
				await this.deps.openExternal(url);
			} catch (error) {
				this.deps.log(`— Could not open the browser: ${errorMessage(error)}`);
			}
		}
		this.enqueue(live, target);
		return { kind: 'opened' };
	}

	/** Ends the viewer's stdin — it exits on that — and kills it if it lingers. */
	dispose(): void {
		this.disposed = true;
		const live = this.live;
		this.live = undefined;
		if (!live) {
			return;
		}
		live.process.stdin?.end();
		const timer = setTimeout(() => live.process.cancel('BFAST is shutting down.'), CLOSE_GRACE_MS);
		timer.unref();
		void live.process.completed.then(
			() => clearTimeout(timer),
			() => clearTimeout(timer)
		);
	}

	private enqueue(live: LiveViewer, target: string): void {
		live.queue = live.queue.then(async () => {
			if (this.live !== live) {
				return;
			}
			live.process.stdin?.write(`${target}\n`);
			await delay(WRITE_GAP_MS);
		});
	}

	private async spawn(
		executable: string,
		args: string[],
		cli: PlaywrightCli,
		extraEnv: NodeJS.ProcessEnv
	): Promise<
		| { kind: 'not-installed' }
		| { kind: 'failed'; message: string }
		| { kind: 'live'; live: LiveViewer; url: Promise<string | undefined> }
	> {
		let resolveUrl!: (url: string | undefined) => void;
		const url = new Promise<string | undefined>((resolve) => {
			resolveUrl = resolve;
		});
		const process = this.deps.runner({
			executable,
			args,
			cwd: cli.root,
			env: { ...this.deps.env, ...extraEnv },
			interactive: true,
			killTree: true,
			onOutput: (text) => {
				this.deps.log(text.trimEnd());
				const match = /Listening on (\S+)/.exec(text);
				if (match) {
					resolveUrl(match[1]);
				}
			}
		});
		const live: LiveViewer = { process, cli, queue: Promise.resolve() };
		const settled = process.completed.then(
			() => ({ kind: 'exited' as const }),
			(error: unknown) => ({ kind: 'rejected' as const, error })
		);
		void settled.then((outcome) => {
			resolveUrl(undefined);
			if (this.live === live) {
				this.live = undefined;
			}
			if (outcome.kind === 'exited') {
				this.deps.log('— Trace viewer closed.');
			} else if (!(outcome.error instanceof ProcessError && outcome.error.code === 'cancelled')) {
				const message = errorMessage(outcome.error);
				this.deps.log(`— Trace viewer: ${message}`);
				if (/executable doesn't exist|browser.*not.*installed|Failed to launch/i.test(message)) {
					this.deps.log('— The viewer opens in a Chromium Playwright installs: run `npx playwright install chromium`.');
				}
			}
		});

		// ENOENT arrives on the next tick; give the spawn that long before the
		// first path is written to a child that never started.
		const early = await Promise.race([settled, delay(SPAWN_SETTLE_MS).then(() => undefined)]);
		if (early?.kind === 'rejected') {
			const error = early.error;
			if (error instanceof ProcessError && error.code === 'not-installed') {
				return { kind: 'not-installed' };
			}
			return { kind: 'failed', message: errorMessage(error) };
		}
		if (early?.kind === 'exited') {
			return { kind: 'failed', message: 'The trace viewer exited at once. See the BFAST Tests log.' };
		}
		const readyUrl = Promise.race([url, delay(VIEWER_READY_TIMEOUT_MS).then(() => undefined)]);
		return { kind: 'live', live, url: readyUrl };
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
