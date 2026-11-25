// The docker compose command lines, as pure string maths.
//
// Kept apart from `dockerComposeProvider.ts` for the same reason
// `trackerPaths.ts` sits apart from `fileTicketStore.ts`: the rules are
// directly unit-testable with no process spawned, and the provider stays a
// thin shell around them. The exact argv arrays are the contract
// docs/environments/docker-compose.md documents — a test pins them.

import type { ContainerState, EnvironmentContainer, StackStatus } from './environmentProvider';

/** `docker compose -p <project> --file <base> [--file <override>…] up -d --build --force-recreate` — the whole stack, from scratch. */
export function composeUpArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'up', '-d', '--build', '--force-recreate'];
}

/**
 * `docker compose … up -d --wait <service…>` — only the named services (and
 * what they depend on), left running. What a service's e2e run asks of the
 * master environment: no `--build` / `--force-recreate`, so a stack that is
 * already up is reused rather than rebuilt for every test run; `--wait` makes
 * "up" mean healthy where the compose file declares a health check.
 */
export function composeUpServicesArgs(
	project: string,
	composeFiles: readonly string[],
	services: readonly string[]
): string[] {
	return [...composeBase(project, composeFiles), 'up', '-d', '--wait', ...services];
}

/**
 * `docker compose --file … config --services` — the service names the compose
 * chain declares. No project name: nothing is started, only the files read.
 */
export function composeConfigServicesArgs(composeFiles: readonly string[]): string[] {
	const args = ['compose'];
	for (const file of composeFiles) {
		args.push('--file', file);
	}
	return [...args, 'config', '--services'];
}

/** One service per line of `config --services`, in the order compose printed them. */
export function parseComposeServices(stdout: string): string[] {
	return [
		...new Set(
			stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(line))
		)
	];
}

/** `docker compose … down` — stops the stack, keeps its volumes. */
export function composeDownArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'down'];
}

/** `docker compose … down --volumes --remove-orphans` — everything but the images. */
export function composeDestroyArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'down', '--volumes', '--remove-orphans'];
}

/** One engine-wide listing covering every project at once; no cwd, no file. */
export function composeLsArgs(): string[] {
	return ['compose', 'ls', '--all', '--format', 'json'];
}

/** The probe `availability()` runs: compose v2 required, v1 has no `docker compose`. */
export function composeVersionArgs(): string[] {
	return ['compose', 'version'];
}

/**
 * `docker compose -p <project> ps --all --format json` — every container of one
 * project, **exited ones included**.
 *
 * Like `composeLsArgs` it takes no cwd, no `--file` and none of the stack's
 * variables: compose matches containers by the project label the engine already
 * holds. So a broken or missing compose file — the state a failing environment
 * is most likely to be in — cannot hide the containers, which is precisely when
 * they matter. `--all` is what keeps an exited container in the list, and an
 * exited container is where a failure explains itself.
 */
export function composePsArgs(project: string): string[] {
	return ['compose', '-p', project, 'ps', '--all', '--format', 'json'];
}

/**
 * `docker logs --follow --tail <n> <container>` — the engine's own log store,
 * not compose, so a container that has already exited still has a log to open
 * and opening it is instant.
 */
export function dockerLogsArgs(containerId: string, tail: number): string[] {
	return ['logs', '--follow', '--tail', String(tail), containerId];
}

/** One `--file` per entry, **in order** — compose merges later files over earlier ones. */
function composeBase(project: string, composeFiles: readonly string[]): string[] {
	const args = ['compose', '-p', project];
	for (const file of composeFiles) {
		args.push('--file', file);
	}
	return args;
}

/**
 * Maps `docker compose ls --all --format json` output onto the projects asked
 * about. Never throws: junk maps to `'unknown'`, a project absent from the
 * listing to `'stopped'` (it was never started — compose only lists projects
 * with containers), and a mixed status line to `'partial'`.
 */
export function parseComposeLs(
	json: string,
	projects: readonly string[]
): ReadonlyMap<string, StackStatus> {
	const statuses = new Map<string, StackStatus>();

	let listing: unknown;
	try {
		listing = JSON.parse(json);
	} catch {
		for (const project of projects) {
			statuses.set(project, 'unknown');
		}
		return statuses;
	}

	const byName = new Map<string, string>();
	if (Array.isArray(listing)) {
		for (const entry of listing) {
			if (typeof entry === 'object' && entry !== null) {
				const record = entry as { Name?: unknown; Status?: unknown };
				if (typeof record.Name === 'string' && typeof record.Status === 'string') {
					byName.set(record.Name, record.Status);
				}
			}
		}
	}

	for (const project of projects) {
		const status = byName.get(project);
		statuses.set(project, status === undefined ? 'stopped' : parseStatusLine(status));
	}
	return statuses;
}

/**
 * `'running(3)'` → running; `'running(1), exited(1)'` → partial;
 * `'exited(2)'` / `'created(2)'` → stopped; anything unrecognisable → unknown.
 */
function parseStatusLine(status: string): StackStatus {
	const segments = status
		.split(',')
		.map((segment) => segment.trim().toLowerCase())
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return 'unknown';
	}

	let running = 0;
	for (const segment of segments) {
		const state = segment.replace(/\(.*$/, '').trim();
		if (state.length === 0) {
			return 'unknown';
		}
		if (state === 'running') {
			running++;
		}
	}

	if (running === segments.length) {
		return 'running';
	}
	return running > 0 ? 'partial' : 'stopped';
}

/**
 * A stack's status from its own containers — what `statuses()` asks when
 * `compose ls` reads `partial`, because `ls` counts states and nothing else.
 *
 * The one thing `ls` cannot tell apart is a **one-shot job that finished** —
 * an install or migration service that exits 0 once its work is done — from a
 * service that died. Both are `exited(1)` there, so a stack whose only
 * non-running container is a completed job read as `partial`, and the sidebar
 * called a healthy environment an error. Here a container that exited with code
 * 0 counts as done, the way compose's own `service_completed_successfully`
 * does: the stack is `running` when at least one container runs and every other
 * one finished cleanly. Anything else — a non-zero exit, `dead`, `restarting`,
 * `created`, an exit code compose did not report — is still `partial`.
 */
export function stackStatusFromContainers(
	containers: readonly EnvironmentContainer[]
): StackStatus {
	const running = containers.filter((container) => container.state === 'running').length;
	if (running === 0) {
		return 'stopped';
	}
	const settled = containers.every(
		(container) =>
			container.state === 'running' ||
			(container.state === 'exited' && container.exitCode === 0)
	);
	return settled ? 'running' : 'partial';
}

/**
 * Maps `docker compose ps --all --format json` output onto containers, sorted
 * by name so a ten-second poll does not shuffle the sidebar.
 *
 * Forgiving, the `parseComposeLs` posture: newline-delimited objects (compose
 * v2.21 and later) and a single JSON array (older v2) are both read, a line
 * that does not parse is skipped, and a record missing a field degrades that
 * one container to `'unknown'` rather than failing the listing. Never throws —
 * a listing that half-worked still names the service that died.
 */
export function parseComposePs(output: string): EnvironmentContainer[] {
	const containers: EnvironmentContainer[] = [];
	for (const record of readJsonRecords(output)) {
		const container = toContainer(record);
		if (container) {
			containers.push(container);
		}
	}
	return containers.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * The records in a `--format json` payload, whichever shape it came in: a
 * whole-text parse covers the array (and the single object a one-container
 * NDJSON payload is indistinguishable from), and anything else is read line by
 * line. Lines that do not parse are dropped silently — that is the forgiveness.
 */
function readJsonRecords(output: string): Record<string, unknown>[] {
	const asRecord = (value: unknown): Record<string, unknown> | undefined =>
		typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;

	const text = output.trim();
	if (text.length === 0) {
		return [];
	}

	try {
		const whole: unknown = JSON.parse(text);
		if (Array.isArray(whole)) {
			return whole.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);
		}
		const single = asRecord(whole);
		if (single) {
			return [single];
		}
	} catch {
		// Newline-delimited, the shape compose writes today.
	}

	const records: Record<string, unknown>[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		try {
			const record = asRecord(JSON.parse(trimmed));
			if (record) {
				records.push(record);
			}
		} catch {
			// A warning compose printed onto stdout, or a truncated line.
		}
	}
	return records;
}

/**
 * One record → one container, or `undefined` when it names nothing that can be
 * shown or followed. `id` and `name` stand in for each other because `docker
 * logs` takes either, so a payload carrying only one of them still works.
 */
function toContainer(record: Record<string, unknown>): EnvironmentContainer | undefined {
	const id = text(record.ID) ?? text(record.Name) ?? text(record.Names);
	const name = text(record.Name) ?? text(record.Names) ?? id;
	if (id === undefined || name === undefined) {
		return undefined;
	}

	const state = parseContainerState(text(record.State));
	// Compose reports `ExitCode: 0` for a running container too, so it is only
	// read where it means something — otherwise a tooltip would claim a healthy
	// service had "exited with 0".
	const exitCode =
		(state === 'exited' || state === 'dead') && typeof record.ExitCode === 'number'
			? record.ExitCode
			: undefined;

	return {
		id,
		name,
		service: text(record.Service) ?? name,
		state,
		status: text(record.Status) ?? '',
		...(exitCode === undefined ? {} : { exitCode })
	};
}

const CONTAINER_STATES: readonly ContainerState[] = [
	'running',
	'restarting',
	'created',
	'paused',
	'exited',
	'dead'
];

/** Docker's own state words; anything else is `'unknown'`, never guessed at. */
function parseContainerState(value: string | undefined): ContainerState {
	const state = value?.trim().toLowerCase();
	return CONTAINER_STATES.find((candidate) => candidate === state) ?? 'unknown';
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
