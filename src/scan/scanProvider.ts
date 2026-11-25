// The seam the code-scan feature sits behind.
//
// Structured like `src/environments/environmentProvider.ts`: the interface, its
// types and its error classes in one `vscode`-free module with no
// implementation. The store, the runner, the sidebar and the panel only ever
// see this file, so adding a second tool is a settings value, not a code change.
//
// The seam is drawn on the **tool** axis (sonarqube today, semgrep or trivy
// later), not on the deployment axis. Deploying SonarQube is not a generic
// docker-compose problem: the compose file, the readiness probe and the
// credential provisioning are all SonarQube facts, so a deployment-shaped
// provider could start containers and answer nothing else. Deployment is
// therefore a strategy a tool picks for itself, behind `ScanServerLifecycle`.
// The two axes are also not symmetric — every tool has a scanner, not every
// tool has a server — which is why `server` is optional, the same idiom
// `EnvironmentProvider.reclaim?` already uses.
//
// The split, the one `environmentProvider.ts` documents, moved one level in:
// the **store** owns a server's existence — the generated compose file, the
// allocated port, the state file, the per-server queue, and persisting whatever
// provisioning minted. A **provider** owns running that server and running a
// scan against it, and is handed only the descriptor plus its own settings.
//
// docs/scan/provider-interface.md is the contract; it must keep matching this.

import type { ScanMode, ScanToolId } from '../settings/scanSettings';
import type { ScanReport } from './scanReport';

/**
 * What a scan server IS, independent of any tool. Persisted in the state file
 * for a deployed one, and synthesised from settings for an external one.
 */
export interface ScanServerDescriptor {
	tool: ScanToolId;
	mode: ScanMode;
	/**
	 * The compose project name — `bfast-sonar-<workspace-slug>`. One shared
	 * server per workspace, deliberately not one per ticket environment: an
	 * analysis history is only worth having when every ticket's scans land in
	 * the same project, and SonarQube is far too heavy to run four of.
	 */
	projectName: string;
	/** BFAST's own folder for this server — the generated compose file and state. */
	home: string;
	/** Published host port. Allocated at create; absent for an external server. */
	port?: number;
	/** ISO 8601; absent for a server BFAST never created. */
	createdAt?: string;
}

/**
 * Where a scan actually talks to.
 *
 * `containerUrl` is not a nicety: a container resolving `localhost` finds
 * itself, which is the single most common way an otherwise-correct scan setup
 * fails. Making it a field rather than something each caller re-derives is what
 * keeps that bug from coming back.
 */
export interface ScanEndpoint {
	/** What the **host** reaches the server on: `http://localhost:9000`. */
	url: string;
	/** What a **scanner container** reaches it on, when that differs. */
	containerUrl?: string;
	/** The docker network the scanner must join to use `containerUrl`. */
	network?: string;
	/** Extra `docker run` flags the endpoint needs, e.g. `--add-host`. */
	runFlags?: string[];
}

/** What the credentials a scan needs look like, whoever minted them. */
export interface ScanCredentials {
	/** Goes into the scanner. The only credential that leaves the extension host. */
	analysisToken?: string;
	/** Reads results back over the Web API. Never leaves the host. */
	resultsToken?: string;
	/** Only for a BFAST-deployed server: the admin password provisioning generated. */
	adminPassword?: string;
}

/**
 * What a checkout says its project is — for SonarQube, the `sonar.projectKey`
 * and `sonar.projectName` in a committed `sonar-project.properties`. Either
 * field may be absent; a file that names only one still names it.
 */
export interface ScanProjectIdentity {
	projectKey?: string;
	projectName?: string;
}

/** Backend-reported state of a scan server, tool-generic. */
export type ServerHealth = 'up' | 'starting' | 'down' | 'unknown';

/**
 * What the sidebar shows. The five transitional ones mean an operation is in
 * flight; `absent` is a deployable server that was never created; `external`
 * is one BFAST does not own, and is a status rather than a flag precisely so it
 * never matches the `when` clause of Start, Stop or Remove.
 */
export type ScanServerStatus =
	| 'absent'
	| 'deploying'
	| 'stopped'
	| 'starting'
	| 'provisioning'
	| 'running'
	| 'stopping'
	| 'removing'
	| 'error'
	| 'unknown'
	| 'external';

export interface ScanServerHandle extends ScanServerDescriptor {
	status: ScanServerStatus;
	/** The error a failed operation left behind, until a later one succeeds. */
	statusDetail?: string;
	/** Where to reach it, once there is enough configured to say. */
	endpoint?: ScanEndpoint;
	/**
	 * Whether a usable credential exists. A boolean, never the value: this
	 * crosses into the tree provider and, through it, into tooltips.
	 */
	credentialed: boolean;
}

/**
 * What an operation reports while it runs. `output` is raw process output — or
 * a container log line — and lands in the "BFAST Code Quality" output channel and
 * the results tab: the proof a five-minute first boot has not hung. None of it
 * is parsed.
 */
export type ScanProgress =
	| { kind: 'phase'; label: string }
	| { kind: 'output'; text: string; channel: 'stdout' | 'stderr' };

export type ScanProgressListener = (progress: ScanProgress) => void;

/**
 * One long operation in flight. `EnvironmentOperation` with a payload: a start
 * yields nothing, a provision yields the credentials it minted and a scan
 * yields its report. One type parameter beats three near-identical interfaces,
 * and the synchronous-returns-a-handle shape is `EnvironmentOperation`'s for
 * `EnvironmentOperation`'s reason — the caller needs something to cancel before
 * the promise settles.
 */
export interface ScanOperation<T = void> {
	/** Rejects with a `ScanError`. */
	readonly completed: Promise<T>;
	/** Idempotent, and safe to call after the operation has settled. */
	cancel(reason?: string): void;
}

export interface ScanAvailability {
	ok: boolean;
	reason?: ScanErrorCode;
	/** The disabled action's tooltip. */
	message?: string;
}

export type ScanErrorCode =
	/** `docker` missing (spawn ENOENT), or the configured command's shell. */
	| 'not-installed'
	/** No workspace, no project key, no server url, no command in `command` mode. */
	| 'not-configured'
	/** An operation this deployment does not offer — Start on an external server. */
	| 'external'
	/** Create when a server already exists. */
	| 'exists'
	/** The configured port range is exhausted. */
	| 'no-ports'
	/** No token, or the server refused the one there is. */
	| 'unauthorized'
	/** The server answered, and said no. */
	| 'server-error'
	/** An operation is already in flight for this server. */
	| 'busy'
	| 'cancelled'
	| 'timeout'
	/** The scanner ran and reported a failure of its own. */
	| 'scanner-error';

/**
 * Carries a code because the command layer switches on it to decide what to
 * tell the user — `unauthorized` offers "Set token", `not-configured` offers
 * "Open Settings". `message` must never interpolate a descriptor or a
 * credential: it reaches a notification, the log and the results tab.
 */
export class ScanError extends Error {
	constructor(
		readonly code: ScanErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'ScanError';
	}
}

export class ScanCancelledError extends ScanError {
	constructor(reason = 'The operation was cancelled.') {
		super('cancelled', reason);
		this.name = 'ScanCancelledError';
	}
}

/**
 * Running the server a tool needs.
 *
 * **Optional on `ScanProvider`**, the way `EnvironmentProvider.reclaim` is:
 * absent means the tool has no server — a scanner-only tool runs over a
 * checkout and reports, and there is nothing to start.
 *
 * One implementation per deployment, chosen by the *tool* at call time. The
 * external one deliberately implements the whole interface and refuses four of
 * its methods with `'external'` rather than being a smaller type: the store's
 * queue, its statuses and its error handling are then identical for both, and
 * "you cannot start someone else's server" is a message rather than a missing
 * code path.
 */
export interface ScanServerLifecycle {
	/** Cheap and cached where possible; a missing docker is a refused action, never a broken view. */
	availability(): Promise<ScanAvailability>;

	/**
	 * Everything that has to exist before the server can run — the generated
	 * compose file, its folders. Does **not** start it: create and start are
	 * separate gestures, the rule `EnvironmentStore` already holds to.
	 */
	create(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

	/**
	 * Brings the server up **and waits until it answers**. A container that is
	 * running is not a server that is ready, and every caller after this one
	 * would otherwise re-implement the wait.
	 */
	start(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

	/** Shuts it down, keeping its data. */
	stop(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

	/** Removes containers, networks **and volumes** — the analysis history goes with it. */
	destroy(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

	/**
	 * Mints the credentials a scan needs and **returns** them; it does not store
	 * them. A provider must not learn where a secret lives, exactly as it must
	 * not learn about git or the marker — the store takes what comes back and
	 * hands it to `ScanContext.storeCredentials`.
	 *
	 * Idempotent by contract, and ordered cheapest-first: on a healthy instance
	 * it costs one call and writes nothing, which is what makes
	 * "Re-provision credentials" safe to press at any time. For an external
	 * server it mints nothing and only **verifies** what is configured, so the
	 * one gesture answers "are my credentials good" in both modes.
	 */
	provision(
		server: ScanServerDescriptor,
		onProgress?: ScanProgressListener
	): ScanOperation<ScanCredentials>;

	/**
	 * The host port a stack for this project is **already** publishing, when one
	 * is. Optional: a technology with no such notion omits it.
	 *
	 * It exists for one real failure: the scan home lives in the OS temp folder,
	 * so it can be cleaned away while the containers keep running. The server then
	 * reads as absent, a deploy allocates a *new* port, and `up` — which
	 * deliberately does not force-recreate — adopts the existing containers on
	 * their old published port. The sidebar would show one number and the server
	 * would be on another. Asking first is what keeps the recorded port true.
	 */
	existingPort?(server: ScanServerDescriptor): Promise<number | undefined>;

	/** Never throws — an unreachable server is `'unknown'`, not an exception. */
	health(server: ScanServerDescriptor): Promise<ServerHealth>;

	/** Where to talk to it. `undefined` when it is not configured enough to say. */
	endpoint(server: ScanServerDescriptor): ScanEndpoint | undefined;
}

/** What one scan is asked to do. Built by the runner; the provider only obeys. */
export interface ScanRequest {
	/** Absolute directory the scanner analyses. */
	directory: string;
	/**
	 * The project analyses are filed under. The runner resolved it — from the
	 * checkout's own properties file first, then settings, then the folder name
	 * — and the provider must file under exactly this key and no other.
	 */
	projectKey: string;
	/** A readable name for the project, so a dashboard is not titled after a slug. */
	projectName?: string;
	/** The ticket this run was started from, when it was. Context only. */
	ticketId?: string;
	endpoint: ScanEndpoint;
	credentials: ScanCredentials;
	/** Silence budget for each step; never a ceiling on the work. */
	idleTimeoutMs: number;
}

/**
 * A scan tool.
 *
 * `sonarqube` is the first. The next one adds a member to `ScanToolId`, a file
 * beside the sonarqube provider, and an entry in `configuredScanProvider` — and
 * touches nothing else. There is deliberately no stub second tool:
 * `FakeScanProvider` is the seam's proof, the standard CLAUDE.md already sets
 * for `AiProvider`.
 */
export interface ScanProvider {
	/** Stable machine id; doubles as the settings value. */
	readonly id: ScanToolId;
	/** User-visible name, e.g. `'SonarQube'`. */
	readonly label: string;

	/** The whole feature's gate: docker missing, no url, no project key. */
	availability(): Promise<ScanAvailability>;

	/**
	 * What the checkout at `directory` says its project is, when the tool has a
	 * file for that — `sonar-project.properties` for SonarQube. Optional, the
	 * `server?` idiom: a tool with no such file omits it and the runner falls
	 * back to settings and the folder name. Never throws; an unreadable file is
	 * `undefined`. It is a provider method rather than a runner rule because the
	 * file's name and grammar are the tool's, and the runner must not learn them.
	 */
	readProjectIdentity?(directory: string): Promise<ScanProjectIdentity | undefined>;

	/**
	 * The server half, when the tool has one. Absent means scanner-only — the
	 * Code Quality section then shows the tool and its runs and no lifecycle rows.
	 */
	readonly server?: ScanServerLifecycle;

	/**
	 * One analysis, start to finish: run the scanner, wait for the server to
	 * finish processing it, and come back with the report the results tab
	 * renders. Short-lived, unqueued and cancellable throughout — the opposite
	 * of the lifecycle above, which is exactly why they are separate members.
	 */
	scan(request: ScanRequest, onProgress?: ScanProgressListener): ScanOperation<ScanReport>;

	/** Cancels every live operation. The provider owns its child processes. */
	dispose(): void;
}

/**
 * `('sonarqube', 'my-app')` → `'bfast-sonar-my-app'` — the per-workspace
 * isolation name: the compose project today, a namespace tomorrow. Compose
 * requires `[a-z0-9][a-z0-9_-]*`, the stricter of the two — the same rule and
 * the same shape as `environmentProjectName`.
 */
export function scanProjectName(tool: ScanToolId, workspaceSlug: string): string {
	const slug = workspaceSlug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const prefix = tool === 'sonarqube' ? 'bfast-sonar' : `bfast-${tool}`;
	return `${prefix}-${slug.length > 0 ? slug : 'workspace'}`;
}
