// Inventory and orchestration for the scan server — the heart of the feature's
// long-lived half.
//
// `vscode`-free on purpose: the filesystem via `fs/promises`, the backend via an
// injected `ScanProvider`, secrets via an injected `ScanContext`, so
// `scanServerStore.test.ts` drives the whole lifecycle against fakes and a
// scratch folder.
//
// The inventory is **derived from disk**: `get()` reads `server.json` under the
// scan home and asks the provider for live health — there is no second registry
// to fall out of step, and a home the OS cleaned away simply reads as `absent`.
// Only three things are held in memory, all UI rather than inventory (a reload
// losing them is correct): which operation is in flight, the last failure until
// a later operation succeeds, and the recent runs the sidebar lists.
//
// Writes go through a **queue**, the same shape as `EnvironmentStore`'s and
// `FileTicketStore.write`'s: each operation chains onto the tail and the chain
// survives a rejection, so Start can never race Stop and one failure does not
// block every later operation.

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { allocatePorts, probePort, type PortProbe } from '../environments/portAllocator';
import {
	scanMode as resolveScanMode,
	scanPortRange,
	scanToolId,
	type ScanSettings
} from '../settings/scanSettings';
import type { ScanContext } from './scanContext';
import type { ScanOutcome, ScanTargetRef } from './scanReport';
import {
	ScanCancelledError,
	ScanError,
	scanProjectName,
	type ScanCredentials,
	type ScanEndpoint,
	type ScanProgressListener,
	type ScanProvider,
	type ScanServerDescriptor,
	type ScanServerHandle,
	type ScanServerLifecycle,
	type ScanServerStatus,
	type ServerHealth
} from './scanProvider';
import {
	belongsTo,
	parseScanServerState,
	SCAN_STATE_FILE,
	serializeScanServerState,
	stateToDescriptor,
	type ScanServerState
} from './scanServerState';
import { errorMessage } from '../platform/errors';

/** What the sidebar lists under the server. Memory only; a reload losing them is correct. */
export interface ScanRunSummary {
	target: ScanTargetRef;
	outcome: ScanOutcome;
	/** The one-line verdict, already rendered. */
	summary: string;
	/** ISO 8601. */
	finishedAt: string;
	dashboardUrl?: string;
}

/** Ten is enough to see a trend; the dashboard is the history. */
export const MAX_RECENT_RUNS = 10;

export interface ScanServerStoreDeps {
	context: ScanContext;
	/** The registry in production, a fake in tests. */
	provider: ScanProvider;
	/** Probes a candidate port. Defaults to a real bind attempt. */
	portProbe?: PortProbe;
	/** The "BFAST Code Quality" channel's sink, wired in `activate()`. */
	onProgress?: ScanProgressListener;
	/** Injected so a test does not depend on the clock. */
	now?: () => Date;
}

export class ScanServerStore {
	private readonly context: ScanContext;
	private readonly provider: ScanProvider;
	private readonly portProbe: PortProbe;
	private readonly onProgress?: ScanProgressListener;
	private readonly now: () => Date;

	/** The operation chain. Entries linger after settling; `active` is the busy truth. */
	private queue: Promise<unknown> = Promise.resolve();
	/** How many operations are queued or running. */
	private active = 0;
	/** What the running operation is, for the sidebar's transitional statuses. */
	private opStatus: ScanServerStatus | undefined;
	/** Queued *and* running, so a cancel reaches an operation that has not started yet. */
	private readonly liveOps = new Set<LiveOperation>();
	/** The last failure, shown as `error` until an operation succeeds. */
	private lastError: string | undefined;
	private readonly recentRuns: ScanRunSummary[] = [];
	private disposed = false;

	private readonly listeners = new Set<() => void>();

	constructor(deps: ScanServerStoreDeps) {
		this.context = deps.context;
		this.provider = deps.provider;
		this.portProbe = deps.portProbe ?? probePort;
		this.onProgress = deps.onProgress;
		this.now = deps.now ?? (() => new Date());
	}

	/** Returns an unsubscribe, the shape `EnvironmentStore.onDidChange` uses. */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	availability() {
		return this.provider.availability();
	}

	/** True while an operation is queued or running — the busy truth. */
	get busy(): boolean {
		return this.active > 0;
	}

	/**
	 * The one server, always answered — `absent` when nothing is deployed and
	 * `external` when it is not BFAST's to run. Derived from disk every time.
	 */
	async get(): Promise<ScanServerHandle> {
		const settings = this.context.settings();
		const descriptor = await this.readDescriptor(settings);
		const credentialed = await this.hasCredentials();
		const endpoint = this.endpointOf(descriptor);

		if (this.opStatus) {
			return { ...descriptor, status: this.opStatus, credentialed, endpoint };
		}
		if (resolveScanMode(settings) === 'external') {
			// Not a failure state: an external server has no lifecycle here, and
			// `external` is a status precisely so Start/Stop never offer themselves.
			return { ...descriptor, status: 'external', credentialed, endpoint };
		}
		if (this.lastError) {
			return {
				...descriptor,
				status: 'error',
				statusDetail: this.lastError,
				credentialed,
				endpoint
			};
		}
		if (descriptor.createdAt === undefined) {
			return { ...descriptor, status: 'absent', credentialed };
		}

		const health = await this.health(descriptor);
		const status: ScanServerStatus =
			health === 'up'
				? 'running'
				: health === 'starting'
					? 'starting'
					: health === 'down'
						? 'stopped'
						: 'unknown';
		return { ...descriptor, status, credentialed, endpoint };
	}

	/**
	 * Allocates the port, writes the state file, and creates whatever must exist.
	 * Does **not** start it — create and start are separate gestures, the rule
	 * `EnvironmentStore` already holds to.
	 *
	 * Returns nothing, like every other lifecycle method: a handle built inside
	 * the queue would still be carrying the transitional `deploying` status, so
	 * it would report a state that is already untrue by the time the caller reads
	 * it. The caller asks `get()`.
	 */
	deploy(): Promise<void> {
		return this.enqueue('deploying', async (op) => {
			const settings = this.context.settings();
			this.requireOwnServer(settings);

			const home = this.requireHome();
			if (await this.readState()) {
				throw new ScanError(
					'exists',
					'A scan server is already deployed for this workspace. Remove it first, or just start it.'
				);
			}

			const workspaceRoot = this.context.workspaceRoot();
			const state: ScanServerState = {
				version: 1,
				tool: scanToolId(settings),
				mode: 'auto',
				projectName: scanProjectName(
					scanToolId(settings),
					this.context.workspaceSlug() ?? 'workspace'
				),
				port: await this.allocatePort(settings),
				createdAt: this.now().toISOString(),
				...(workspaceRoot ? { sourceRoot: workspaceRoot } : {})
			};

			await mkdir(home, { recursive: true });
			op.throwIfCancelled();

			const lifecycle = this.requireLifecycle();
			const descriptor = stateToDescriptor(state, home);
			const operation = lifecycle.create(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
			op.throwIfCancelled();

			// Asked only now, because `create` is what puts the compose file where
			// the question can be asked at all. A stack left running when the temp
			// folder was cleaned keeps its published port, and `up` does not
			// force-recreate — so recording the freshly allocated number would put
			// one port in the sidebar and another on the server.
			const adopted = await lifecycle.existingPort?.(descriptor);
			const recorded = adopted === undefined ? state : { ...state, port: adopted };
			if (adopted !== undefined && adopted !== state.port) {
				this.onProgress?.({
					kind: 'phase',
					label: `Adopting the port an existing stack already publishes (${adopted})`
				});
			}

			// The state file lands **after** create succeeds: a half-made server
			// nothing recorded reads as absent, which is recoverable, where one the
			// sidebar shows but cannot start is a dead end.
			await writeFile(
				path.join(home, SCAN_STATE_FILE),
				serializeScanServerState(recorded),
				'utf8'
			);
		});
	}

	start(): Promise<void> {
		return this.enqueue('starting', async (op) => {
			const descriptor = await this.requireDescriptor();
			op.throwIfCancelled();
			const operation = this.requireLifecycle().start(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
		});
	}

	stop(): Promise<void> {
		return this.enqueue('stopping', async (op) => {
			const descriptor = await this.requireDescriptor();
			op.throwIfCancelled();
			const operation = this.requireLifecycle().stop(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
		});
	}

	/**
	 * Mints or verifies the credentials a scan needs, and **persists what comes
	 * back**. The provider returns rather than stores, so this is the one place a
	 * secret is written — see `ScanContext.storeCredentials`.
	 */
	provision(): Promise<void> {
		return this.enqueue('provisioning', async (op) => {
			const descriptor = await this.requireDescriptor();
			op.throwIfCancelled();
			const operation = this.requireLifecycle().provision(descriptor, this.onProgress);
			op.track(operation);
			const credentials = await operation.completed;
			await this.context.storeCredentials(credentials);
		});
	}

	/**
	 * Destroys the stack **with its volumes**, removes the scan home, and clears
	 * the stored credentials — all three, because the analysis history and the
	 * password BFAST generated go together, and a leftover token pointing at
	 * nothing is worse than none.
	 */
	remove(): Promise<void> {
		return this.enqueue('removing', async (op) => {
			const descriptor = await this.requireDescriptor();

			const operation = this.requireLifecycle().destroy(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
			op.throwIfCancelled();

			this.onProgress?.({ kind: 'phase', label: 'Removing the scan folder' });
			await rm(descriptor.home, { recursive: true, force: true });
			await this.context.clearCredentials();
		});
	}

	/**
	 * Everything between "nothing here" and "a scan can run", as **one gesture**:
	 * deploy if absent, start if not running, then provision. Each step is
	 * skipped when already done, so on a healthy server this costs one HTTP call
	 * and writes nothing — which is what makes it the right thing behind both
	 * the Deploy and the Start button, and the thing `ready()` runs before a scan.
	 *
	 * One gesture rather than three because the three were never separately
	 * useful: a deployed-but-stopped server cannot scan, a running one with no
	 * credentials cannot either, and a user pressing Deploy wants the state in
	 * which pressing Scan works. `deploy()` and `start()` stay as the steps, for
	 * the queue's transitional statuses and for tests that pin each one.
	 */
	async setup(onProgress?: ScanProgressListener): Promise<void> {
		const settings = this.context.settings();
		const external = resolveScanMode(settings) === 'external';

		if (!external) {
			if ((await this.get()).status === 'absent') {
				onProgress?.({ kind: 'phase', label: 'Deploying the scan server' });
				await this.deploy();
			}
			if ((await this.get()).status !== 'running') {
				onProgress?.({ kind: 'phase', label: 'Starting the scan server' });
				await this.start();
			}
		}

		// Always provision: it is idempotent and ordered cheapest-first, so on a
		// healthy instance this costs one call and writes nothing — and it is what
		// turns "the token was revoked last week" into a re-mint rather than a 401
		// four minutes into a scan.
		await this.provision();
	}

	/**
	 * Get to a server a scan can use, or say why not: `setup()` plus what the
	 * runner needs handed back. Everything it does goes through the queue, so a
	 * scan started while the user is pressing Stop cannot interleave with it.
	 */
	async ready(
		onProgress?: ScanProgressListener
	): Promise<{ endpoint: ScanEndpoint; credentials: ScanCredentials }> {
		const external = resolveScanMode(this.context.settings()) === 'external';
		await this.setup(onProgress);

		const descriptor = await this.requireDescriptor();
		const endpoint = this.endpointOf(descriptor);
		if (!endpoint) {
			throw new ScanError(
				'not-configured',
				external
					? 'Set the scan server URL in the BFAST settings.'
					: 'The scan server has no endpoint yet.'
			);
		}
		const credentials = await this.context.credentials();
		if (!credentials.analysisToken) {
			throw new ScanError(
				'unauthorized',
				'No SonarQube token is stored for this workspace. Run BFAST: Set SonarQube Token.'
			);
		}
		return { endpoint, credentials };
	}

	recordRun(summary: ScanRunSummary): void {
		this.recentRuns.unshift(summary);
		this.recentRuns.splice(MAX_RECENT_RUNS);
		this.fireChange();
	}

	get runs(): readonly ScanRunSummary[] {
		return this.recentRuns;
	}

	/**
	 * Cancels the running operation *and* anything queued behind it, which would
	 * otherwise start the moment the running one dies and make the cancel look
	 * ignored.
	 */
	cancel(): void {
		for (const operation of this.liveOps) {
			operation.cancel();
		}
	}

	dispose(): void {
		// The flag covers work that is queued but has no operation running yet:
		// its `perform` throws before anything is spawned.
		this.disposed = true;
		for (const operation of this.liveOps) {
			operation.cancel('the extension was shut down');
		}
		this.listeners.clear();
	}

	// ------------------------------------------------------------------ private

	private enqueue<T>(
		status: ScanServerStatus,
		work: (op: LiveOperation) => Promise<T>
	): Promise<T> {
		// The operation exists from the moment it is queued, so a cancel aimed at
		// it lands even before its turn comes.
		const op = new LiveOperation();
		this.liveOps.add(op);

		const previous = this.queue;
		this.active += 1;
		// The count comes down inside `finally`, which settles **before** the
		// caller's `await` resumes — so "not busy" is never observed early.
		const run = previous
			.then(() => this.perform(status, work, op))
			.finally(() => {
				this.active = Math.max(0, this.active - 1);
			});
		// The chain has to survive a rejection, or one failed operation blocks
		// every later one.
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async perform<T>(
		status: ScanServerStatus,
		work: (op: LiveOperation) => Promise<T>,
		op: LiveOperation
	): Promise<T> {
		this.opStatus = status;
		this.fireChange();
		try {
			if (this.disposed) {
				throw new ScanCancelledError('the extension was shut down');
			}
			// A cancel that arrived while this was still queued stops it here,
			// before anything is spawned.
			op.throwIfCancelled();
			const result = await work(op);
			this.lastError = undefined;
			return result;
		} catch (error) {
			// A cancelled operation leaves `error` too: a half-done deploy is not a
			// clean `absent`, and "cancelled" as the reason is the honest label.
			this.lastError = errorMessage(error);
			throw error;
		} finally {
			this.liveOps.delete(op);
			this.opStatus = undefined;
			this.fireChange();
		}
	}

	/** Re-read from disk at call time — the state file is the authority. */
	private async readState(): Promise<ScanServerState | undefined> {
		const home = this.context.scanHome();
		if (home === undefined) {
			return undefined;
		}
		let state: ScanServerState | undefined;
		try {
			state = parseScanServerState(JSON.parse(await readFile(path.join(home, SCAN_STATE_FILE), 'utf8')));
		} catch {
			// Missing, unreadable or not JSON — either way there is no server here.
			return undefined;
		}
		// A same-named other workspace shares the temp folder; its file is not ours.
		return state && belongsTo(state, this.context.workspaceRoot()) ? state : undefined;
	}

	/** The descriptor as it stands, synthesised when nothing is deployed. */
	private async readDescriptor(settings: ScanSettings | undefined): Promise<ScanServerDescriptor> {
		const home = this.context.scanHome() ?? '';
		const state = await this.readState();
		if (state) {
			return stateToDescriptor(state, home);
		}
		return {
			tool: scanToolId(settings),
			mode: resolveScanMode(settings),
			projectName: scanProjectName(
				scanToolId(settings),
				this.context.workspaceSlug() ?? 'workspace'
			),
			home
		};
	}

	private async requireDescriptor(): Promise<ScanServerDescriptor> {
		const settings = this.context.settings();
		const descriptor = await this.readDescriptor(settings);
		if (resolveScanMode(settings) !== 'external' && descriptor.createdAt === undefined) {
			throw new ScanError('not-configured', 'No scan server is deployed for this workspace yet.');
		}
		return descriptor;
	}

	private endpointOf(descriptor: ScanServerDescriptor): ScanEndpoint | undefined {
		return this.provider.server?.endpoint(descriptor);
	}

	private health(descriptor: ScanServerDescriptor): Promise<ServerHealth> {
		const lifecycle = this.provider.server;
		// A tool with no server is never unhealthy; it simply has nothing to ask.
		return lifecycle ? lifecycle.health(descriptor) : Promise.resolve('unknown');
	}

	private async hasCredentials(): Promise<boolean> {
		return Boolean((await this.context.credentials()).analysisToken);
	}

	private requireHome(): string {
		const home = this.context.scanHome();
		if (home === undefined) {
			throw new ScanError('not-configured', 'Open a folder before deploying a scan server.');
		}
		return home;
	}

	private requireLifecycle(): ScanServerLifecycle {
		const lifecycle = this.provider.server;
		if (!lifecycle) {
			throw new ScanError('external', `${this.provider.label} has no server to manage.`);
		}
		return lifecycle;
	}

	/** An external server is not BFAST's to deploy, start, stop or remove. */
	private requireOwnServer(settings: ScanSettings | undefined): void {
		if (resolveScanMode(settings) === 'external') {
			throw new ScanError(
				'external',
				'This workspace points at a SonarQube BFAST does not manage. Change the mode in settings to have BFAST deploy one.'
			);
		}
	}

	private async allocatePort(settings: ScanSettings | undefined): Promise<number> {
		const ports = await allocatePorts(
			['BFAST_SONAR_PORT'],
			scanPortRange(settings),
			new Set(),
			this.portProbe
		);
		return ports.BFAST_SONAR_PORT;
	}

	private fireChange(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/**
 * One queued operation's cancellation state. `track` is handed whatever is
 * currently cancellable, and a cancel that lands between steps is honoured at
 * the next `throwIfCancelled`. Lifted from `environmentStore.ts`, where the
 * same three-method shape does the same job.
 */
class LiveOperation {
	private cancelled = false;
	private reason: string | undefined;
	private current: { cancel(reason?: string): void } | undefined;

	cancel(reason = 'The operation was cancelled.'): void {
		this.cancelled = true;
		this.reason ??= reason;
		this.current?.cancel(this.reason);
	}

	track(cancellable: { cancel(reason?: string): void }): void {
		this.current = cancellable;
		if (this.cancelled) {
			cancellable.cancel(this.reason);
		}
	}

	throwIfCancelled(): void {
		if (this.cancelled) {
			throw new ScanCancelledError(this.reason);
		}
	}
}
