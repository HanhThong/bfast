// The seam the environments feature sits behind.
//
// Structured like `src/ai/aiProvider.ts`: the interface, its types and its
// error classes in one `vscode`-free module, with no implementation. The store,
// the sidebar and the commands only ever see this file, so swapping
// `DockerComposeProvider` for `K8sProvider` — or something else entirely — is
// a settings value, not a code change.
//
// The split (documented in docs/environments/provider-interface.md): the
// **store** owns an environment's existence — git worktrees, port allocation,
// the marker file, the per-environment operation queue. A **provider** owns
// running the stack in a worktree that already exists, and is handed only the
// descriptor plus its own settings; it knows nothing about git, markers or how
// ports were chosen.

import type { EnvironmentProviderId } from '../settings/environmentSettings';

/**
 * The master environment's id — what it is queued, listed and looked up
 * under. A ticket id never looks like this (`<PREFIX>-<ordinals>`), so the two
 * key spaces cannot collide.
 */
export const MASTER_ENVIRONMENT_ID = 'master';

/**
 * A ticket's environment — a worktree on its branch — or the **master**
 * environment: the workspace folder itself, whatever it has checked out.
 */
export type EnvironmentScope = 'ticket' | 'master';

/**
 * What an environment IS, independent of any backend. Persisted in the marker
 * file (`.bfast/environment.json` inside a worktree; `master.json` beside the
 * worktrees for the master environment).
 */
export interface EnvironmentDescriptor {
	/**
	 * The key everything is keyed on — the store's queues, the provider's
	 * status map, every command: the ticket id for a ticket's environment,
	 * `MASTER_ENVIRONMENT_ID` for the master one.
	 */
	id: string;
	scope: EnvironmentScope;
	/** Absent for the master environment; equal to `id` otherwise. */
	ticketId?: string;
	kind: EnvironmentProviderId;
	/**
	 * A ticket environment's worktree branch. For the master environment, the
	 * branch the workspace has checked out — read when it is listed, since it
	 * moves under the environment — or `''` when that cannot be read.
	 */
	branch: string;
	/**
	 * Absolute path of the folder the stack runs in: the worktree checkout,
	 * or the workspace itself for the master environment.
	 */
	worktreePath: string;
	/**
	 * The isolation name — the compose project today, the k8s namespace
	 * tomorrow. `environmentProjectName(ticketId)` for a ticket, derived and
	 * never stored; the master environment's is recorded in its marker at
	 * creation, so Start and Delete can never disagree on it.
	 */
	projectName: string;
	/** Port-variable name → allocated port. */
	ports: Record<string, number>;
	/**
	 * Which `ports` entry is the main (browser-facing) one. Recorded explicitly
	 * — a `Record` carries no order. Host-side UI only; providers may ignore it.
	 */
	mainPort?: string;
	/** ISO 8601. */
	createdAt: string;
}

/** Backend-reported state of a stack, provider-generic. */
export type StackStatus = 'running' | 'partial' | 'stopped' | 'unknown';

/** Backend-reported state of one container, provider-generic. */
export type ContainerState =
	| 'running'
	| 'restarting'
	| 'created'
	| 'paused'
	| 'exited'
	| 'dead'
	| 'unknown';

/**
 * One container of an environment's stack — a row under the environment in the
 * sidebar, and what a log tab is opened on.
 *
 * Provider-generic: `id` and `name` are opaque strings the host only ever hands
 * back, and `status` is the backend's **own sentence** rather than something
 * BFAST composes, so a k8s provider fills it with a pod phase and the rows keep
 * reading correctly. `state` is the small closed set the icon is drawn from;
 * anything a provider cannot map is `'unknown'`, never invented.
 */
export interface EnvironmentContainer {
	/** The backend's own id; what `logs()` is opened on. */
	id: string;
	/**
	 * The container's own name (`bfast-st-1-2-web-1`). Stable across a recreate,
	 * which is what lets a log tab keyed on it survive a Start.
	 */
	name: string;
	/** The service it is an instance of — the row's label. */
	service: string;
	state: ContainerState;
	/** The backend's own words: `'Up 3 minutes (healthy)'`, `'Exited (1) 12 seconds ago'`. */
	status: string;
	/** Present when the container has exited. */
	exitCode?: number;
}

/**
 * What the sidebar shows. The transitional four mean an operation is in
 * flight; `error` is a failed last operation or a `partial` stack; `unknown`
 * means the backend could not be queried (Docker not running, say).
 */
export type EnvironmentStatus =
	| 'creating'
	| 'stopped'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'deleting'
	| 'error'
	| 'unknown';

export interface EnvironmentHandle extends EnvironmentDescriptor {
	status: EnvironmentStatus;
	/** The error a failed operation left behind, until a later one succeeds. */
	statusDetail?: string;
}

/**
 * What an operation reports while it runs. `output` is raw process output and
 * lands in the "BFAST Environments" output channel — the proof a minutes-long
 * build has not hung. None of it is parsed.
 */
export type EnvironmentProgress =
	| { kind: 'phase'; label: string }
	| { kind: 'output'; text: string; channel: 'stdout' | 'stderr' };

export type EnvironmentProgressListener = (progress: EnvironmentProgress) => void;

/**
 * A start/stop/destroy in flight. Mirrors `AiRun`: an operation starts, emits
 * progress and finishes, and the caller needs a cancel for the middle.
 */
export interface EnvironmentOperation {
	/** Rejects with an `EnvironmentError`. */
	readonly completed: Promise<void>;
	/** Idempotent, and safe to call after the operation has settled. */
	cancel(reason?: string): void;
}

export interface EnvironmentAvailability {
	ok: boolean;
	reason?: EnvironmentErrorCode;
	/** The disabled action's tooltip. */
	message?: string;
}

export type EnvironmentErrorCode =
	/** `docker` / `kubectl` / `git` missing (spawn ENOENT). */
	| 'not-installed'
	/** The k8s stub. */
	| 'not-implemented'
	/** No workspace, no settings block, or a missing compose file. */
	| 'not-configured'
	/** Create on a ticket that already has an environment. */
	| 'exists'
	/** The configured port range is exhausted. */
	| 'no-ports'
	| 'git-error'
	/** An operation is already in flight for this environment. */
	| 'busy'
	| 'cancelled'
	| 'timeout'
	/** The backend ran and reported a failure of its own. */
	| 'provider-error';

/**
 * Carries a code because the command layer switches on it to decide what to
 * tell the user. `message` must never interpolate an environment object — a
 * future caller's may hold secrets.
 */
export class EnvironmentError extends Error {
	constructor(
		readonly code: EnvironmentErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'EnvironmentError';
	}
}

export class EnvironmentCancelledError extends EnvironmentError {
	constructor(reason = 'The operation was cancelled.') {
		super('cancelled', reason);
		this.name = 'EnvironmentCancelledError';
	}
}

/**
 * The backend that runs a stack in an environment's worktree.
 */
export interface EnvironmentProvider {
	/** Stable machine id; doubles as the settings value. */
	readonly id: EnvironmentProviderId;
	/** User-visible name, e.g. `'Docker Compose'`. */
	readonly label: string;

	/**
	 * Cheap and cached where possible. A missing binary must degrade to a
	 * disabled action with `message` as its tooltip, never a broken view.
	 */
	availability(): Promise<EnvironmentAvailability>;

	/** The whole stack, from scratch, in the worktree. */
	start(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation;

	/** Shuts the stack down, keeping its persistent data. */
	stop(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation;

	/**
	 * Removes the running footprint `start()` created — containers, networks,
	 * volumes, or the namespace. Built images are deliberately left in the
	 * image store (see docs/environments/docker-compose.md). Called by Delete
	 * before the worktree is removed.
	 */
	destroy(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation;

	/**
	 * Optional: make the worktree deletable by the invoking user, right before
	 * the host removes the folder. The docker provider chowns back files
	 * containers created as root on Linux — without it the removal dies on
	 * `Permission denied`. Deliberately independent of the stack definition
	 * (a half-deleted worktree may have lost its compose file) and best-effort
	 * by contract: it must never fail the delete; `removeWorktree` is the
	 * arbiter. Absent means the technology has nothing to reclaim.
	 */
	reclaim?(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation;

	/**
	 * Batch on purpose: compose answers every project in one `compose ls`, k8s
	 * in one API call. Never throws — an unreachable backend maps every entry
	 * to `'unknown'`. Keyed by environment `id`.
	 */
	statuses(envs: readonly EnvironmentDescriptor[]): Promise<ReadonlyMap<string, StackStatus>>;

	/**
	 * The containers the environment's stack is made of, **exited ones
	 * included** — a container that died is the one worth reading.
	 *
	 * Unlike `statuses` this one *does* reject, with an `EnvironmentError`:
	 * "the backend could not be asked" and "the stack has no containers" are
	 * different facts and the sidebar shows them differently. An empty list for
	 * a Docker that is not running would read as "your environment has nothing
	 * in it", which is the one wrong thing to say there.
	 *
	 * Required rather than optional (`reclaim?`'s shape): a provider that
	 * cannot answer says so with `'not-implemented'`, and the registry then has
	 * nothing to forget to forward.
	 */
	containers(env: EnvironmentDescriptor): Promise<EnvironmentContainer[]>;

	/**
	 * Follows one container's log, newest last, starting with `tail` lines of
	 * history. Emits `{ kind: 'output' }` progress and settles when the stream
	 * ends — the container stopped or was removed — or when cancelled.
	 *
	 * The one operation armed with **no idle timeout**: silence from a
	 * container is its healthy state, not a hang, so the single signal the
	 * watchdog reads means the opposite here.
	 */
	logs(
		env: EnvironmentDescriptor,
		container: EnvironmentContainer,
		options: { tail: number },
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation;

	/** Cancels every live operation. The provider owns its child processes. */
	dispose(): void;
}

/**
 * `'ST-1.2'` → `'bfast-st-1-2'` — the per-environment isolation name: the
 * compose project today, the k8s namespace tomorrow. Compose requires
 * `[a-z0-9][a-z0-9_-]*`, the stricter of the two.
 */
export function environmentProjectName(ticketId: string): string {
	const slug = ticketId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `bfast-${slug.length > 0 ? slug : 'ticket'}`;
}

/**
 * How a message names an environment — `environment ST-1.2`, or `the master
 * environment`, which has no id a person would recognise.
 */
export function environmentLabel(id: string): string {
	return id === MASTER_ENVIRONMENT_ID ? 'the master environment' : `environment ${id}`;
}

/**
 * `'bfast-st-1-2-web-1'` → `'web-1'`: a container's name without the project
 * prefix every container of one stack repeats.
 *
 * What a log tab is titled with, rather than the service alone — the two read
 * the same for the single-replica stacks this feature is built for, and the
 * name stays unique when a service is scaled, which is what keeps two tabs
 * from claiming one title.
 */
export function containerDisplayName(
	env: EnvironmentDescriptor,
	container: EnvironmentContainer
): string {
	const prefix = `${env.projectName}-`;
	return container.name.startsWith(prefix) ? container.name.slice(prefix.length) : container.name;
}

/**
 * Everything a stack ever receives from BFAST, spread over `process.env` by
 * the provider. One address on purpose: the docs and both providers point
 * here, so a variable is added in this function or not at all.
 *
 * The master environment has no ticket, and `BFAST_TICKET_ID` is still
 * **set** — compose warns on stderr for every unset variable a file mentions
 * — but empty, so a `${BFAST_TICKET_ID:?}` refuses as it should and
 * `BFAST_PROJECT_NAME`, unique per stack, is the one to key on.
 */
export function stackEnvironment(env: EnvironmentDescriptor): Record<string, string> {
	const ports: Record<string, string> = {};
	for (const [name, port] of Object.entries(env.ports)) {
		ports[name] = String(port);
	}
	return {
		...ports,
		BFAST_TICKET_ID: env.ticketId ?? '',
		BFAST_PROJECT_NAME: env.projectName
	};
}
