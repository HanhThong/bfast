// Inventory and orchestration for environments — the heart of the feature.
//
// `vscode`-free on purpose: filesystem via `fs/promises`, git via an injected
// `ProcessRunner`, the stack via an injected `EnvironmentProvider`, so
// `environmentStore.test.ts` drives the whole lifecycle against fakes and a
// scratch folder.
//
// The inventory is **derived from disk**: `list()` scans
// `worktreesRoot()/*/.bfast/environment.json` — one per ticket environment —
// plus `worktreesRoot()/master.json`, the master environment's, and asks the
// provider for live stack status — there is no second registry to fall out of
// step, and a worktree the OS cleaned away simply stops appearing. Only two
// overlays are held in memory, both UI rather than inventory (a reload losing
// them is correct): which operation is in flight per environment, and the
// last failure until a later operation succeeds.
//
// Writes go through a **per-environment queue**, the same shape as
// `FileTicketStore.write`: each operation chains onto its environment's tail
// and the chain survives a rejection, so Start can never race Stop on one
// environment while different environments proceed in parallel. Everything
// is keyed by the descriptor's `id` — the ticket id, or `'master'`.

import { access, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import {
	environmentLogTail,
	environmentMainPort,
	environmentPortRange,
	environmentPortVariables,
	environmentProviderId,
	type EnvironmentsSettings
} from '../settings/environmentSettings';
import { workspaceSlug } from '../platform/workspaceSlug';
import type { EnvironmentContext } from './environmentContext';
import {
	MARKER_FILE,
	MASTER_MARKER_FILE,
	markerToDescriptor,
	parseEnvironmentMarker,
	serializeEnvironmentMarker,
	type EnvironmentMarker
} from './environmentMarker';
import { giveEnvironmentMcpPort } from './environmentMcp';
import {
	EnvironmentCancelledError,
	EnvironmentError,
	MASTER_ENVIRONMENT_ID,
	environmentLabel,
	environmentProjectName,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentHandle,
	type EnvironmentOperation,
	type EnvironmentProgressListener,
	type EnvironmentProvider,
	type EnvironmentStatus,
	type StackStatus
} from './environmentProvider';
import { readCheckedOutBranch } from './gitHead';
import {
	addWorktree,
	enableLongPathsIfNeeded,
	environmentBranchName,
	pruneWorktrees,
	removeWorktree
} from './gitWorktree';
import { allocatePorts, type PortProbe } from './portAllocator';
import { runProcess, type ProcessRunner } from '../platform/runProcess';
import { errorMessage } from '../platform/errors';

export interface EnvironmentStoreDeps {
	context: EnvironmentContext;
	/** The registry in production, a fake in tests. */
	provider: EnvironmentProvider;
	/** Runs git. Defaults to the real one. */
	runner?: ProcessRunner;
	/** Probes a candidate port. Defaults to a real bind attempt. */
	portProbe?: PortProbe;
	/** The "BFAST Environments" output channel's sink, wired in `activate()`. */
	onProgress?: EnvironmentProgressListener;
	/**
	 * Whose path rules a new worktree is held to — only Windows has a check to
	 * run. Defaults to this machine's; tests pin it, so every platform runs the
	 * same git sequence.
	 */
	platform?: NodeJS.Platform;
}

export class EnvironmentStore {
	private readonly context: EnvironmentContext;
	private readonly provider: EnvironmentProvider;
	private readonly runner: ProcessRunner;
	private readonly portProbe: PortProbe | undefined;
	private readonly onProgress: EnvironmentProgressListener | undefined;
	private readonly platform: NodeJS.Platform;

	/** Per-environment operation chains. Entries linger after settling; `active` is the busy truth. */
	private readonly queue = new Map<string, Promise<unknown>>();
	/** How many operations are queued or running per environment. */
	private readonly active = new Map<string, number>();
	/**
	 * Creates additionally serialize across environments: allocation reads the
	 * markers and the marker lands only after `git worktree add`, so two creates
	 * running side by side would each see a world without the other and hand out
	 * the same ports.
	 */
	private createChain: Promise<unknown> = Promise.resolve();
	/** What the running operation is, for the sidebar's transitional statuses. */
	private readonly opStatus = new Map<string, EnvironmentStatus>();
	/** Queued *and* running, so a cancel reaches an operation that has not started yet. */
	private readonly liveOps = new Map<string, Set<LiveOperation>>();
	private disposed = false;
	/** The last failure per environment, shown as `error` until an operation succeeds. */
	private readonly lastError = new Map<string, string>();
	/** A create in flight, so the sidebar shows it before the marker exists. */
	private readonly pending = new Map<string, EnvironmentHandle>();

	private readonly listeners = new Set<() => void>();

	constructor(deps: EnvironmentStoreDeps) {
		this.context = deps.context;
		this.provider = deps.provider;
		this.runner = deps.runner ?? runProcess;
		this.portProbe = deps.portProbe;
		this.onProgress = deps.onProgress;
		this.platform = deps.platform ?? process.platform;
	}

	/** Fires after anything that should repaint the sidebar. Returns the unsubscribe. */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The configured provider's own answer, for commands to refuse early with a reason. */
	availability() {
		return this.provider.availability();
	}

	async list(): Promise<EnvironmentHandle[]> {
		const scanned = await this.scanMarkers();
		const descriptors = scanned.map((entry) => entry.descriptor);

		let stack: ReadonlyMap<string, StackStatus>;
		try {
			stack = await this.provider.statuses(descriptors);
		} catch {
			// The contract says statuses never throws; treat a provider that does
			// as an unreachable backend rather than a broken sidebar.
			stack = new Map();
		}

		const handles = descriptors.map((descriptor) =>
			this.toHandle(descriptor, stack.get(descriptor.id))
		);
		for (const [id, pending] of this.pending) {
			if (!handles.some((handle) => handle.id === id)) {
				handles.push(pending);
			}
		}

		// The master environment heads the list — it is the workspace's own, and
		// there is at most one; the tickets follow in id order.
		return handles.sort(
			(a, b) =>
				Number(b.scope === 'master') - Number(a.scope === 'master') ||
				a.id.localeCompare(b.id, undefined, { numeric: true })
		);
	}

	async find(id: string): Promise<EnvironmentHandle | undefined> {
		return (await this.list()).find((handle) => handle.id === id);
	}

	/**
	 * The environment's containers, exited ones included.
	 *
	 * A **read**, so deliberately not put through the per-environment queue:
	 * listing what is running must not wait behind a fifteen-minute build, and
	 * there is nothing here to race. Rejects with the provider's
	 * `EnvironmentError` rather than answering `[]` — the sidebar tells "could
	 * not ask" from "nothing there", and an empty list for a Docker that is not
	 * running would be the wrong one of those.
	 *
	 * Takes the descriptor rather than an id, unlike every operation here: an
	 * id would mean a `list()` — a marker scan plus a backend call — per
	 * expanded row per poll, to reach something the caller already has in hand.
	 */
	containers(env: EnvironmentDescriptor): Promise<EnvironmentContainer[]> {
		return this.provider.containers(env);
	}

	/**
	 * Follows one container's log. A read as well, and unqueued for the same
	 * reason — a follow that outlives the click must not hold Start behind it.
	 *
	 * `logTail` is read here, at call time, so a settings change reaches the
	 * next tab opened and the panel never learns there is a setting.
	 */
	logs(
		env: EnvironmentDescriptor,
		container: EnvironmentContainer,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.provider.logs(
			env,
			container,
			{ tail: environmentLogTail(this.context.settings()) },
			onProgress
		);
	}

	/**
	 * Allocates ports, adds the worktree on `story/<ticketId>` (or `epic/…`),
	 * moves the worktree's MCP server to a port of its own when its settings
	 * switch the server on, and writes the marker. Does **not** start the
	 * stack — create and start are separate gestures on purpose. Refuses with
	 * `'exists'` when the ticket already has an environment and `'busy'` while
	 * any operation for it is in flight.
	 */
	create(ticketId: string): Promise<EnvironmentHandle> {
		this.refuseIfBusy(ticketId);

		return this.enqueue(ticketId, 'creating', (op) => this.serializeCreates(async () => {
			const repo = this.context.repositoryRoot();
			const root = this.context.worktreesRoot();
			if (!repo || !root) {
				throw new EnvironmentError('not-configured', 'Open a folder before creating environments.');
			}

			const settings = this.context.settings();
			const existing = await this.scanMarkers();
			if (existing.some((entry) => entry.descriptor.id === ticketId)) {
				throw new EnvironmentError('exists', `${ticketId} already has an environment.`);
			}
			const reserved = this.reservedPorts(existing);

			const kind = environmentProviderId(settings);
			const branch = environmentBranchName(ticketId);
			const worktreePath = path.join(root, folderName(ticketId));
			const createdAt = new Date().toISOString();

			let descriptor: EnvironmentDescriptor = {
				id: ticketId,
				scope: 'ticket',
				ticketId,
				kind,
				branch,
				worktreePath,
				projectName: environmentProjectName(ticketId),
				ports: {},
				createdAt
			};
			this.pending.set(ticketId, { ...descriptor, status: 'creating' });
			this.fireChange();

			// Set only once the folder is known to be this create's own work, so
			// the failure cleanup can never delete a checkout somebody else made.
			let ours = false;
			try {
				descriptor = { ...descriptor, ...(await this.allocate(settings, reserved)) };
				this.pending.set(ticketId, { ...descriptor, status: 'creating' });
				op.throwIfCancelled();

				await mkdir(root, { recursive: true });
				// Heals registrations whose folders the OS cleaned away, which
				// would otherwise block this add.
				await pruneWorktrees(this.trackedRunner(op), repo, this.gitOutput());
				op.throwIfCancelled();

				// A folder already sitting there: with a marker it is somebody's
				// environment (this repo's are caught above, so it is another
				// workspace's) — hands off. Without one it is debris in BFAST's own
				// temp namespace — an interrupted delete or a crashed create — and
				// leaving it would dead-end every future create for this ticket.
				if (await exists(worktreePath)) {
					if (await exists(path.join(worktreePath, ...MARKER_FILE.split('/')))) {
						throw new EnvironmentError(
							'exists',
							`Another workspace's environment already occupies ${worktreePath}. ` +
								'Delete it from that workspace, or remove the folder by hand.'
						);
					}
					this.onProgress?.({ kind: 'phase', label: `Clearing leftover folder for ${ticketId}` });
					// Its stack may still exist (an interrupted delete) — best-effort
					// destroy with a synthetic descriptor (dummy port values keep a
					// `${X:?}` compose file parseable). A leftover can be too broken
					// to even name a compose file, which is why the ownership reclaim
					// below is a separate step that needs no stack definition;
					// `removeWorktree` is the arbiter of success.
					const synthetic: EnvironmentDescriptor = {
						...descriptor,
						ports: Object.fromEntries(
							environmentPortVariables(settings).map((name) => [name, 1])
						)
					};
					try {
						const leftover = this.provider.destroy(synthetic, this.onProgress);
						op.track(leftover);
						await leftover.completed;
					} catch {
						// Covered by the comment above.
					}
					op.throwIfCancelled();
					await this.reclaimWorktree(synthetic, op);
					op.throwIfCancelled();
					await removeWorktree(this.trackedRunner(op), repo, worktreePath, this.gitOutput());
					op.throwIfCancelled();
				}
				ours = true;

				this.onProgress?.({ kind: 'phase', label: `Creating worktree for ${ticketId}` });
				await addWorktree(this.trackedRunner(op), repo, worktreePath, branch, this.gitOutput());
				op.throwIfCancelled();
				if (this.platform === 'win32') {
					await this.enableLongPaths(repo, worktreePath, op);
					op.throwIfCancelled();
				}
				const mcpPort = await this.giveMcpPort(
					ticketId,
					worktreePath,
					new Set([...reserved, ...Object.values(descriptor.ports)]),
					op
				);
				op.throwIfCancelled();

				const marker: EnvironmentMarker = {
					version: 1,
					ticketId,
					kind,
					branch,
					ports: descriptor.ports,
					...(descriptor.mainPort ? { mainPort: descriptor.mainPort } : {}),
					createdAt,
					sourceRoot: repo,
					...(mcpPort === undefined ? {} : { mcpPort })
				};
				const markerPath = path.join(worktreePath, ...MARKER_FILE.split('/'));
				await mkdir(path.dirname(markerPath), { recursive: true });
				await writeFile(markerPath, serializeEnvironmentMarker(marker), 'utf8');

				return { ...descriptor, status: 'stopped' as const };
			} catch (error) {
				// The marker never landed, so no environment exists yet — clear the
				// half-made worktree so create can simply be retried. (This is not
				// a rollback of anything user-visible, and `ours` keeps it off a
				// folder that pre-existed this call.)
				if (ours) {
					await this.discardHalfCreate(repo, worktreePath);
				}
				throw error;
			} finally {
				this.pending.delete(ticketId);
			}
		}));
	}

	/**
	 * The master environment: allocates ports and writes `master.json` beside
	 * the worktrees. No git — the stack runs in the workspace folder itself,
	 * so there is no checkout to make — and nothing is written *into* the
	 * workspace. Refuses with `'exists'` when there already is one: this
	 * repo's, or a same-named workspace's, which is refused rather than
	 * overwritten exactly as a foreign folder is in `create`. `'busy'` while an
	 * operation for it is in flight.
	 */
	createMaster(): Promise<EnvironmentHandle> {
		const id = MASTER_ENVIRONMENT_ID;
		this.refuseIfBusy(id);

		return this.enqueue(id, 'creating', (op) => this.serializeCreates(async () => {
			const repo = this.context.repositoryRoot();
			const root = this.context.worktreesRoot();
			if (!repo || !root) {
				throw new EnvironmentError('not-configured', 'Open a folder before creating environments.');
			}

			// `scanMarkers` keeps another repo's marker out, which is right for
			// the sidebar and wrong here: a same-named workspace's `master.json`
			// in the way has to be refused, not silently replaced — its stack is
			// under that file's project name. Read the file itself. A file that
			// does not parse at all is debris, and is overwritten.
			const markerPath = path.join(root, MASTER_MARKER_FILE);
			const occupant = await readMarker(markerPath);
			if (occupant?.scope === 'master') {
				throw new EnvironmentError(
					'exists',
					samePath(occupant.sourceRoot, repo)
						? 'The master environment already exists.'
						: `Another workspace's master environment already occupies ${markerPath}. ` +
							'Delete it from that workspace, or remove the file by hand.'
				);
			}

			const settings = this.context.settings();
			const reserved = this.reservedPorts(await this.scanMarkers());
			const createdAt = new Date().toISOString();

			let descriptor: EnvironmentDescriptor = {
				id,
				scope: 'master',
				kind: environmentProviderId(settings),
				branch: '',
				worktreePath: repo,
				projectName: masterProjectName(root),
				ports: {},
				createdAt
			};
			this.pending.set(id, { ...descriptor, status: 'creating' });
			this.fireChange();

			try {
				descriptor = { ...descriptor, ...(await this.allocate(settings, reserved)) };
				this.pending.set(id, { ...descriptor, status: 'creating' });
				op.throwIfCancelled();

				await mkdir(root, { recursive: true });
				const marker: EnvironmentMarker = {
					version: 1,
					scope: 'master',
					kind: descriptor.kind,
					projectName: descriptor.projectName,
					ports: descriptor.ports,
					...(descriptor.mainPort ? { mainPort: descriptor.mainPort } : {}),
					createdAt,
					sourceRoot: repo
				};
				await writeFile(markerPath, serializeEnvironmentMarker(marker), 'utf8');

				return {
					...descriptor,
					branch: await readCheckedOutBranch(repo),
					status: 'stopped' as const
				};
			} finally {
				this.pending.delete(id);
			}
		}));
	}

	/** The whole stack, from scratch. Queued behind whatever is already running. */
	start(id: string): Promise<void> {
		return this.enqueue(id, 'starting', async (op) => {
			const descriptor = await this.descriptorFor(id);
			op.throwIfCancelled();
			const operation = this.provider.start(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
		});
	}

	stop(id: string): Promise<void> {
		return this.enqueue(id, 'stopping', async (op) => {
			const descriptor = await this.descriptorFor(id);
			op.throwIfCancelled();
			const operation = this.provider.stop(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
		});
	}

	/**
	 * Destroys the stack (volumes included), then removes what the environment
	 * owns on disk. For a ticket that is its worktree — the branch is kept: it
	 * may hold commits, and deleting work is worse than leaving a branch. For
	 * the master environment it is only the marker: the folder is the
	 * workspace, the user's own, and nothing here removes, reclaims or
	 * otherwise touches it.
	 */
	remove(id: string): Promise<void> {
		return this.enqueue(id, 'deleting', async (op) => {
			const repo = this.context.repositoryRoot();
			const root = this.context.worktreesRoot();
			if (!repo || !root) {
				throw new EnvironmentError('not-configured', 'Open a folder before deleting environments.');
			}
			const descriptor = await this.descriptorFor(id);

			const operation = this.provider.destroy(descriptor, this.onProgress);
			op.track(operation);
			await operation.completed;
			op.throwIfCancelled();

			if (descriptor.scope === 'master') {
				this.onProgress?.({ kind: 'phase', label: 'Removing the master environment marker' });
				await rm(path.join(root, MASTER_MARKER_FILE), { force: true });
				return;
			}

			await this.reclaimWorktree(descriptor, op);
			op.throwIfCancelled();

			this.onProgress?.({ kind: 'phase', label: `Removing worktree for ${id}` });
			await removeWorktree(this.trackedRunner(op), repo, descriptor.worktreePath, this.gitOutput());
		});
	}

	/**
	 * Cancels this environment's operations — the running one *and* anything
	 * queued behind it, which would otherwise start the moment the running one
	 * dies and make the cancel look ignored.
	 */
	cancel(id: string): void {
		for (const operation of this.liveOps.get(id) ?? []) {
			operation.cancel();
		}
	}

	dispose(): void {
		// The flag covers work that is queued but has no operation running yet:
		// its `perform` throws before spawning anything.
		this.disposed = true;
		for (const operations of this.liveOps.values()) {
			for (const operation of operations) {
				operation.cancel('the extension was shut down');
			}
		}
		this.listeners.clear();
	}

	// ------------------------------------------------------------------ private

	/** Thrown synchronously, before anything is queued — a create is refused, never waited for. */
	private refuseIfBusy(id: string): void {
		if (this.active.has(id)) {
			throw new EnvironmentError(
				'busy',
				`An operation is already running for ${environmentLabel(id)}.`
			);
		}
	}

	/**
	 * Two environments never overlap, even while both stacks are down — the
	 * master environment's ports included, and every worktree's own MCP port,
	 * which nothing listens on while its window is closed. Pending creates
	 * count too — belt to `serializeCreates`' braces.
	 */
	private reservedPorts(
		existing: { marker: EnvironmentMarker; descriptor: EnvironmentDescriptor }[]
	): Set<number> {
		const reserved = new Set<number>();
		for (const entry of existing) {
			for (const port of Object.values(entry.descriptor.ports)) {
				reserved.add(port);
			}
			if (entry.marker.scope !== 'master' && entry.marker.mcpPort !== undefined) {
				reserved.add(entry.marker.mcpPort);
			}
		}
		for (const handle of this.pending.values()) {
			for (const port of Object.values(handle.ports)) {
				reserved.add(port);
			}
		}
		return reserved;
	}

	/** One free port per configured variable, and the main one named only when it was allocated. */
	private async allocate(
		settings: EnvironmentsSettings | undefined,
		reserved: Set<number>
	): Promise<Pick<EnvironmentDescriptor, 'ports' | 'mainPort'>> {
		const ports = await allocatePorts(
			environmentPortVariables(settings),
			environmentPortRange(settings),
			reserved,
			this.portProbe
		);
		const mainPort = environmentMainPort(settings);
		return { ports, ...(mainPort && ports[mainPort] !== undefined ? { mainPort } : {}) };
	}

	private enqueue<T>(
		id: string,
		status: EnvironmentStatus,
		work: (op: LiveOperation) => Promise<T>
	): Promise<T> {
		// The operation exists from the moment it is queued, so a cancel aimed
		// at it lands even before its turn comes.
		const op = new LiveOperation();
		const queued = this.liveOps.get(id) ?? new Set();
		queued.add(op);
		this.liveOps.set(id, queued);

		const previous = this.queue.get(id) ?? Promise.resolve();
		this.active.set(id, (this.active.get(id) ?? 0) + 1);
		// The count comes down inside `finally`, which settles **before** the
		// caller's `await` resumes — so "not busy" is never observed early.
		const run = previous
			.then(() => this.perform(id, status, work, op))
			.finally(() => {
				const left = (this.active.get(id) ?? 1) - 1;
				if (left <= 0) {
					this.active.delete(id);
				} else {
					this.active.set(id, left);
				}
			});
		// The chain has to survive a rejection, or one failed operation blocks
		// every later one for that environment.
		this.queue.set(id, run.catch(() => undefined));
		return run;
	}

	private async perform<T>(
		id: string,
		status: EnvironmentStatus,
		work: (op: LiveOperation) => Promise<T>,
		op: LiveOperation
	): Promise<T> {
		this.opStatus.set(id, status);
		this.fireChange();
		try {
			if (this.disposed) {
				throw new EnvironmentCancelledError('the extension was shut down');
			}
			// A cancel that arrived while this was still queued stops it here,
			// before anything is spawned.
			op.throwIfCancelled();
			const result = await work(op);
			this.lastError.delete(id);
			return result;
		} catch (error) {
			// A cancelled operation leaves `error` too: a half-done start is not a
			// clean stopped, and "cancelled" as the reason is the honest label.
			this.lastError.set(id, errorMessage(error));
			throw error;
		} finally {
			const operations = this.liveOps.get(id);
			operations?.delete(op);
			if (operations?.size === 0) {
				this.liveOps.delete(id);
			}
			this.opStatus.delete(id);
			this.fireChange();
		}
	}

	/** See `createChain`: the allocate-through-marker-write window is store-wide. */
	private serializeCreates<T>(work: () => Promise<T>): Promise<T> {
		const run = this.createChain.then(work);
		this.createChain = run.catch(() => undefined);
		return run;
	}

	private async descriptorFor(id: string): Promise<EnvironmentDescriptor> {
		// Re-read from disk at call time — the marker is the authority, exactly
		// as every store write re-reads before acting.
		const scanned = await this.scanMarkers();
		const entry = scanned.find((candidate) => candidate.descriptor.id === id);
		if (!entry) {
			throw new EnvironmentError(
				'not-configured',
				id === MASTER_ENVIRONMENT_ID
					? 'There is no master environment. Create one from the Environments section first.'
					: `${id} has no environment. Create one from the story first.`
			);
		}
		return entry.descriptor;
	}

	private async scanMarkers(): Promise<
		{ marker: EnvironmentMarker; descriptor: EnvironmentDescriptor }[]
	> {
		const root = this.context.worktreesRoot();
		if (!root) {
			return [];
		}

		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			// No worktrees folder yet is simply no environments.
			return [];
		}

		const repo = this.context.repositoryRoot();
		const found: { marker: EnvironmentMarker; descriptor: EnvironmentDescriptor }[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const worktreePath = path.join(root, entry.name);
			// A folder with no readable marker is not an environment; skipped
			// silently, the same posture as the tracker scanner. A master-shaped
			// marker inside a worktree folder is a stray file: the master
			// environment has no worktree, and only `master.json` at the root
			// can claim to be it.
			const marker = await readMarker(path.join(worktreePath, ...MARKER_FILE.split('/')));
			if (!marker || marker.scope === 'master') {
				continue;
			}
			// Same-named workspaces share a worktrees folder; the marker's source
			// root is what keeps another repo's environments out of this sidebar.
			if (marker.sourceRoot && repo && !samePath(marker.sourceRoot, repo)) {
				continue;
			}
			found.push({ marker, descriptor: markerToDescriptor(marker, worktreePath) });
		}

		// The master environment's marker sits beside the worktrees, not in one,
		// and its folder is the repo — the window's live path, which `samePath`
		// has just equated with the recorded one. Its branch is whatever the
		// working copy has checked out at this moment.
		const master = await readMarker(path.join(root, MASTER_MARKER_FILE));
		if (master?.scope === 'master' && repo && samePath(master.sourceRoot, repo)) {
			found.push({
				marker: master,
				descriptor: {
					...markerToDescriptor(master, repo),
					branch: await readCheckedOutBranch(repo)
				}
			});
		}
		return found;
	}

	private toHandle(
		descriptor: EnvironmentDescriptor,
		stack: StackStatus | undefined
	): EnvironmentHandle {
		const running = this.opStatus.get(descriptor.id);
		if (running) {
			return { ...descriptor, status: running };
		}
		const failure = this.lastError.get(descriptor.id);
		if (failure) {
			return { ...descriptor, status: 'error', statusDetail: failure };
		}
		switch (stack) {
			case 'running':
				return { ...descriptor, status: 'running' };
			case 'partial':
				return { ...descriptor, status: 'error', statusDetail: 'Some services are not running.' };
			case 'stopped':
				return { ...descriptor, status: 'stopped' };
			default:
				return { ...descriptor, status: 'unknown' };
		}
	}

	/**
	 * Asks the provider to make the worktree deletable (root-owned bind-mount
	 * files on Linux) right before the folder goes. Best-effort by the
	 * provider's contract; a cancel still lands via the caller's next check.
	 */
	private async reclaimWorktree(
		descriptor: EnvironmentDescriptor,
		op: LiveOperation
	): Promise<void> {
		// Structural, not the caller's to remember: the master environment's
		// folder is the workspace, and a recursive chown of it is not this
		// feature's to run.
		if (descriptor.scope === 'master') {
			return;
		}
		const reclaim = this.provider.reclaim?.(descriptor, this.onProgress);
		if (!reclaim) {
			return;
		}
		op.track(reclaim);
		await reclaim.completed.catch(() => undefined);
	}

	/**
	 * Windows only: switches `core.longpaths` on for the repository when the new
	 * worktree's paths are too long for git without it — see
	 * `enableLongPathsIfNeeded`. Best-effort: the worktree is there and BFAST's
	 * own git passes the flag whatever this finds, so a failure is said in the
	 * log and the create goes on. A cancel still stops it.
	 */
	private async enableLongPaths(
		repo: string,
		worktreePath: string,
		op: LiveOperation
	): Promise<void> {
		try {
			const overflow = await enableLongPathsIfNeeded(
				this.trackedRunner(op),
				repo,
				worktreePath,
				this.gitOutput()
			);
			if (overflow) {
				const one = overflow.count === 1;
				this.onProgress?.({
					kind: 'phase',
					label:
						`Enabled core.longpaths for this repository: ${overflow.count} ` +
						`${one ? 'path' : 'paths'} in the new worktree ${one ? 'is' : 'are'} ` +
						`longer than Windows allows (longest: ${overflow.length} characters).`
				});
			}
		} catch (error) {
			if (error instanceof EnvironmentCancelledError) {
				throw error;
			}
			this.onProgress?.({
				kind: 'phase',
				label:
					`Could not check the new worktree's path lengths ` +
					`(${errorMessage(error)}). ` +
					'If git reports "Filename too long" in it, run ' +
					'`git config core.longpaths true` in the repository.'
			});
		}
	}

	/**
	 * Gives the new worktree its own MCP server port when its settings switch
	 * the server on — see `giveEnvironmentMcpPort`. Best-effort, the
	 * `enableLongPaths` posture: the worktree is usable either way, and a
	 * window whose server finds the port taken says so itself. Answers the port
	 * for the marker, which is what keeps the next create clear of it.
	 */
	private async giveMcpPort(
		ticketId: string,
		worktreePath: string,
		reserved: ReadonlySet<number>,
		op: LiveOperation
	): Promise<number | undefined> {
		try {
			const moved = await giveEnvironmentMcpPort({
				runner: this.trackedRunner(op),
				worktreePath,
				reserved,
				probe: this.portProbe,
				onOutput: this.gitOutput()
			});
			if (!moved) {
				return undefined;
			}
			this.onProgress?.({
				kind: 'phase',
				label:
					`MCP server port for ${ticketId}: ${moved.from} → ${moved.to} ` +
					`(${moved.files.join(', ')}` +
					`${moved.hidden.length > 0 ? ' — hidden from git in the worktree' : ''})`
			});
			if (moved.problems.length > 0) {
				this.onProgress?.({
					kind: 'phase',
					label: `Not everything followed the MCP port: ${moved.problems.join('; ')}.`
				});
			}
			return moved.to;
		} catch (error) {
			if (error instanceof EnvironmentCancelledError) {
				throw error;
			}
			this.onProgress?.({
				kind: 'phase',
				label:
					`Could not give ${ticketId} its own MCP server port ` +
					`(${errorMessage(error)}). ` +
					"Its window's server will find the workspace's port in use — " +
					'change the port in that window’s BFAST settings.'
			});
			return undefined;
		}
	}

	/** Wraps the runner so a live operation's cancel reaches whatever git is running. */
	private trackedRunner(op: LiveOperation): ProcessRunner {
		return (request) => {
			const child = this.runner(request);
			op.track(child);
			return child;
		};
	}

	private gitOutput(): (text: string, channel: 'stdout' | 'stderr') => void {
		return (text, channel) => this.onProgress?.({ kind: 'output', text, channel });
	}

	/** Best-effort only: a failed cleanup must not mask the error that caused it. */
	private async discardHalfCreate(repo: string, worktreePath: string): Promise<void> {
		try {
			await access(worktreePath);
		} catch {
			return;
		}
		try {
			await removeWorktree(this.runner, repo, worktreePath, this.gitOutput());
		} catch {
			// The folder stays; the next create's prune-and-retry deals with it.
		}
	}

	private fireChange(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener's bug must not break the store.
			}
		}
	}
}

/**
 * One queued operation's cancellation state. `track` hands it whatever is
 * currently cancellable — a git process, a provider operation — and a cancel
 * that lands between steps is honoured at the next `throwIfCancelled`.
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
			throw new EnvironmentCancelledError(this.reason);
		}
	}
}

/**
 * `bfast-master-<workspace-slug>` — the master environment's compose project.
 * The worktrees root's own name *is* the workspace slug (`environmentContext`
 * builds it that way, and a worktree window's parent folder is that same
 * root), re-slugged so a hand-made root still yields a compose-legal name.
 * The slug is not decoration: two repos on one machine sharing `bfast-master`
 * would share one stack, and Delete on either would `down --volumes` the
 * other's.
 */
export function masterProjectName(worktreesRoot: string): string {
	return `bfast-master-${workspaceSlug(path.basename(worktreesRoot))}`;
}

/** Ticket ids are already path-safe (`ST-1.2`); this holds that even if one is not. */
function folderName(ticketId: string): string {
	return ticketId.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** Forgiving: `undefined` for a missing file, junk JSON or an unusable marker. */
async function readMarker(markerPath: string): Promise<EnvironmentMarker | undefined> {
	let raw: string;
	try {
		raw = await readFile(markerPath, 'utf8');
	} catch {
		return undefined;
	}
	try {
		return parseEnvironmentMarker(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function samePath(a: string, b: string): boolean {
	const left = path.resolve(a);
	const right = path.resolve(b);
	return process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right;
}
