// The docker command lines for the SonarQube tool, as pure string maths.
//
// Kept apart from the provider for the same reason `composeCommand.ts` sits
// apart from `dockerComposeProvider.ts`: the rules are directly unit-testable
// with no process spawned, and the provider stays a thin shell around them. The
// exact argv arrays are the contract docs/scan/sonarqube.md documents — a test
// pins them, including the two that are security rather than behaviour:
// the token travels in the environment and never in an argument, and
// `redactArgs` blanks it before anything is echoed to the output channel.

import type { ScanProperty } from '../../settings/scanSettings';
import type { ScanEndpoint } from '../scanProvider';

export const DOCKER_EXECUTABLE = 'docker';

/** The compose file BFAST copies into the scan home at deploy time. */
export const SCAN_COMPOSE_FILE = 'docker-compose.yml';

/** Where the shipped template lives inside the extension. */
export const SCAN_COMPOSE_TEMPLATE = ['templates', 'scan', 'sonarqube', SCAN_COMPOSE_FILE];

/** The container port SonarQube's web UI listens on, and the service that owns it. */
export const SONAR_SERVICE = 'sonarqube';
export const SONAR_CONTAINER_PORT = '9000';

/**
 * The variables the scanner container inherits from BFAST's environment, passed
 * to `docker run` as bare `-e NAME` — docker then copies the value from the
 * client's own environment, so it never appears in argv. The image's entrypoint
 * turns `SONAR_TOKEN` into `-Dsonar.token`, and the scanner reads
 * `SONAR_HOST_URL` itself. **Without these the container sees neither**: the
 * docker CLI's environment is not the container's, and a scanner with no host
 * url defaults to SonarCloud and demands `sonar.organization`.
 */
export const SCANNER_INHERITED_ENV: readonly string[] = ['SONAR_HOST_URL', 'SONAR_TOKEN'];

/** The scanner's cache, mounted from a BFAST-owned folder so a non-root user can write it. */
export const SCANNER_CACHE_MOUNT = '/opt/sonar-scanner/.sonar';
/** Where the analysed directory is mounted. The scanner's own default base dir. */
export const SCANNER_WORK_MOUNT = '/usr/src';

/**
 * Where the scanner writes `.scannerwork` — `report-task.txt` above all — and
 * where BFAST mounts a folder of its own to receive it.
 *
 * The image sets `SCANNER_WORKDIR_PATH=/tmp/.scannerwork` itself (scanner-cli
 * 8.x), and its entrypoint turns that into `-Dsonar.working.directory`, so the
 * scanner has **not** written into `/usr/src/.scannerwork` for some time —
 * which is where an earlier BFAST looked, and found nothing. Mounting a host
 * folder at the path the image already uses means the file lands where BFAST
 * can read it, and `.scannerwork/` never appears in the user's repository at
 * all. BFAST sets the variable explicitly as well, so a pinned image whose
 * default differs still writes here. Not the `-D` property too: the entrypoint
 * already emits one from the variable, and a second copy makes the scanner log
 * "overridden with value" — the same value — on every run.
 */
export const SCANNER_WORKDIR_MOUNT = '/tmp/.scannerwork';

/**
 * `docker compose -p <project> --file <base> [--file <override>…] up -d --remove-orphans`.
 *
 * Three deliberate absences, all documented in docs/scan/sonarqube.md: no
 * `--build` (nothing to build), no `--force-recreate` (an environment's stack is
 * cattle, this instance is a pet whose volume holds the credentials BFAST
 * generated), and no `--pull always` (which on a rolling tag is exactly what
 * would silently upgrade the image and drop the user into a database migration).
 */
export function sonarUpArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'up', '-d', '--remove-orphans'];
}

/** `docker compose … down` — stops the server, keeps its data. */
export function sonarDownArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'down'];
}

/** `docker compose … down --volumes --remove-orphans` — the analysis history goes too. */
export function sonarDestroyArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'down', '--volumes', '--remove-orphans'];
}

/**
 * `docker compose … logs --follow` — the boot log.
 *
 * Not a nicety: it is what gives the idle watchdog **real bytes** to reset on
 * while an HTTP poll decides when to stop, and it is where the
 * `vm.max_map_count` complaint appears. `--no-color` because the output channel
 * renders escape codes literally.
 */
export function sonarLogsArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'logs', '--follow', '--no-color', '--tail', '50'];
}

/** `docker compose … port sonarqube 9000` — how BFAST re-learns a forgotten host port. */
export function sonarPortArgs(project: string, composeFiles: readonly string[]): string[] {
	return [...composeBase(project, composeFiles), 'port', SONAR_SERVICE, SONAR_CONTAINER_PORT];
}

/** The probe `availability()` runs: compose v2 required, v1 has no `docker compose`. */
export function composeVersionArgs(): string[] {
	return ['compose', 'version'];
}

/** `docker info --format {{.MemTotal}}` — the memory pre-flight. */
export function dockerMemoryArgs(): string[] {
	return ['info', '--format', '{{.MemTotal}}'];
}

/** `docker image inspect <image>` — is the scanner image already pulled? */
export function imageInspectArgs(image: string): string[] {
	return ['image', 'inspect', image];
}

/** `docker pull <image>` — an explicit, labelled phase rather than a silent stall. */
export function imagePullArgs(image: string): string[] {
	return ['pull', image];
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
 * Everything a compose invocation for this server receives.
 *
 * One address on purpose, the `stackEnvironment` rule: a variable is added in
 * this function or not at all. Spread over `process.env` by the provider, never
 * assigned to it — the extension host is shared with every other extension in
 * the window. Passed to **every** invocation including `down`, because a compose
 * file using `${BFAST_SONAR_PORT:?}` refuses to even parse without it.
 */
export function scanStackEnvironment(port: number | undefined, project: string): Record<string, string> {
	return {
		// A placeholder rather than nothing when the port is unknown: `down` and
		// `port` have to parse the file, and neither cares what the value is.
		BFAST_SONAR_PORT: String(port ?? 0),
		BFAST_SONAR_PROJECT: project
	};
}

/** What `parseComposePort` reads out of `docker compose port`. */
export function parseComposePort(stdout: string): number | undefined {
	// `0.0.0.0:20500`, or an IPv6 form. The port is whatever follows the last colon.
	const line = stdout
		.split('\n')
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (line === undefined) {
		return undefined;
	}
	const port = Number(line.slice(line.lastIndexOf(':') + 1));
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export interface ScannerArgsOptions {
	image: string;
	/** Absolute path of the directory to analyse. */
	directory: string;
	/** Absolute path of a BFAST-owned folder for the scanner's analyzer cache. */
	cacheDir: string;
	/** Absolute path of a BFAST-owned folder the scanner's `.scannerwork` lands in. */
	workDir: string;
	endpoint: ScanEndpoint;
	projectKey: string;
	projectName?: string;
	organization?: string;
	sources?: string;
	exclusions?: string;
	properties?: readonly ScanProperty[];
	/** True when the analysed directory has no usable `.git` — a worktree, say. */
	scmDisabled: boolean;
	/**
	 * The keys a `sonar-project.properties` at the analysed root already sets.
	 * BFAST's **defaults** yield to them; its **settings** still override, since
	 * a value the user typed into the form is a `-D` they asked for.
	 */
	fileProperties?: readonly string[];
	platform: NodeJS.Platform;
	/** `process.getuid?.()` — absent off Linux, where it must not be passed. */
	uid?: number;
	gid?: number;
}

/**
 * The `docker run … sonar-scanner-cli` argument list.
 *
 * Four details are load-bearing and each has a test:
 *
 * - **`-D` flags come after the image name.** They replace the image's default
 *   command, and its entrypoint recognises a leading flag and runs the scanner
 *   with them. Smuggling them through `SONAR_SCANNER_OPTS` would not work —
 *   that is JVM options.
 * - **The host url and the token's *values* are *not* here.** They travel in the
 *   environment, forwarded into the container by bare `-e NAME` flags (see
 *   `SCANNER_INHERITED_ENV`) so docker copies them without their values ever
 *   being an argument. The image's entrypoint turns `SONAR_TOKEN` into
 *   `-Dsonar.token` itself. A token on the command line would sit in the host's
 *   process table and in the argv this feature echoes to its output channel.
 * - **`-u` only on Linux.** The image runs as uid 1000; if that is not the user,
 *   anything it writes into a bind mount ends up unowned and undeletable.
 *   Docker Desktop already translates ownership on Windows and macOS, and
 *   passing `-u` there breaks the image's own assumptions — the exact rule
 *   `DockerComposeProvider.reclaim` encodes.
 * - **`.scannerwork` goes to a BFAST-owned folder, not the repository.** See
 *   `SCANNER_WORKDIR_MOUNT`: the image already writes it to `/tmp/.scannerwork`
 *   inside the container, so BFAST mounts `workDir` there and reads
 *   `report-task.txt` out of it.
 */
export function scannerDockerArgs(options: ScannerArgsOptions): string[] {
	const args = ['run', '--rm'];

	if (options.endpoint.network) {
		args.push('--network', options.endpoint.network);
	}
	for (const flag of options.endpoint.runFlags ?? []) {
		args.push(flag);
	}

	args.push('-v', `${options.directory}:${SCANNER_WORK_MOUNT}`);
	args.push('-v', `${options.cacheDir}:${SCANNER_CACHE_MOUNT}`);
	args.push('-v', `${options.workDir}:${SCANNER_WORKDIR_MOUNT}`);

	if (options.platform === 'linux' && options.uid !== undefined && options.gid !== undefined) {
		args.push('-u', `${options.uid}:${options.gid}`);
	}

	// The cache mount is only writable by the invoking user, so the scanner has
	// to be told to use it as its home; without this it writes to a directory the
	// `-u` above just made unwritable.
	args.push('-e', `SONAR_USER_HOME=${SCANNER_CACHE_MOUNT}`);
	// The image's own default, restated so a pinned image that differs still
	// writes into the mount above.
	args.push('-e', `SCANNER_WORKDIR_PATH=${SCANNER_WORKDIR_MOUNT}`);

	// Name only: the value comes from the docker client's environment, which is
	// where `scannerEnvironment` put it, and never from argv.
	for (const name of SCANNER_INHERITED_ENV) {
		args.push('-e', name);
	}

	args.push(options.image);

	for (const [key, value] of scannerProperties(options)) {
		args.push(`-D${key}=${value}`);
	}
	return args;
}

/**
 * The `-D` properties BFAST supplies, in a stable order.
 *
 * `sonar.exclusions` goes in **only when configured**, and `sonar.sources`
 * only when configured or when the checkout's own `sonar-project.properties`
 * does not lay the sources out itself — `-D` overrides the file, and overriding
 * something the user wrote with something they did not is the opposite of
 * helpful. A file that names `sonar.sources` or `sonar.tests` has a layout,
 * and BFAST's `.` on top of it would make every test file a source file too,
 * which the scanner refuses as a file indexed twice. The SCM default yields the
 * same way, except in a worktree, where disabling it is a correctness fix
 * rather than a default. `sonar.branch.name` is never here: Community Edition
 * has no branch analysis and passing it fails the run outright.
 */
export function scannerProperties(options: ScannerArgsOptions): [string, string][] {
	const inFile = new Set(options.fileProperties ?? []);
	const properties: [string, string][] = [['sonar.projectKey', options.projectKey]];
	if (options.projectName) {
		properties.push(['sonar.projectName', options.projectName]);
	}
	if (options.organization) {
		properties.push(['sonar.organization', options.organization]);
	}
	if (options.sources) {
		properties.push(['sonar.sources', options.sources]);
	} else if (!inFile.has('sonar.sources') && !inFile.has('sonar.tests')) {
		properties.push(['sonar.sources', '.']);
	}
	if (options.exclusions) {
		properties.push(['sonar.exclusions', options.exclusions]);
	}
	// Without a readable `.git` inside the mount the scanner finds a repository
	// it cannot read and floods the log with blame failures.
	if (options.scmDisabled) {
		properties.push(['sonar.scm.disabled', 'true']);
	} else if (!inFile.has('sonar.scm.provider') && !inFile.has('sonar.scm.disabled')) {
		properties.push(['sonar.scm.provider', 'git']);
	}
	for (const property of options.properties ?? []) {
		properties.push([property.key, property.value]);
	}
	return properties;
}

/** Environment variables holding something that must never be logged. */
const SECRET_ENV = /^(SONAR_TOKEN|SONAR_LOGIN|SONAR_PASSWORD)=/i;

/**
 * The argv, safe to echo.
 *
 * The output channel prints the command it is about to run, and `-e
 * SONAR_TOKEN=<secret>` would be one element of it. One function, called in one
 * place, so there is a single answer to "can this line be logged".
 */
export function redactArgs(args: readonly string[]): string[] {
	return args.map((arg) => {
		if (SECRET_ENV.test(arg)) {
			return `${arg.slice(0, arg.indexOf('=') + 1)}***`;
		}
		// A `-Dsonar.token=` should never be built at all, but redacting it here
		// too means the log stays safe even if one ever is.
		if (/^-Dsonar\.(token|login|password)=/i.test(arg)) {
			return `${arg.slice(0, arg.indexOf('=') + 1)}***`;
		}
		return arg;
	});
}

/** The line the output channel shows for a spawn. */
export function describeCommand(executable: string, args: readonly string[]): string {
	return [executable, ...redactArgs(args)].join(' ');
}

/**
 * Where the host and a scanner container each reach the server.
 *
 * The single most common way an otherwise-correct scan setup fails is a
 * container resolving `localhost` and finding itself, so this is a function with
 * a test rather than something each caller re-derives:
 *
 * - **Deployed**: join the compose network and use the service name. That
 *   reaches container port 9000 directly, identically on Docker Desktop, native
 *   Linux, rootless, colima and a remote context, and it never touches the
 *   published host port — so a firewall, a loopback-only bind or a drifted port
 *   cannot break it.
 * - **External on localhost**: `host.docker.internal` with an explicit
 *   `--add-host`. That flag is a no-op on Docker Desktop, where the name already
 *   resolves, and is what makes it resolve at all on Linux since Docker 20.10 —
 *   one rule for every platform.
 * - **External anywhere else**: the url as given; a container reaches a real
 *   hostname the same way the host does.
 */
export function resolveEndpoint(options: {
	hostUrl: string;
	project: string;
	deployed: boolean;
	/** `scan.scannerNetwork` — the escape hatch for a loopback-bound server. */
	networkOverride?: string;
}): ScanEndpoint {
	const endpoint: ScanEndpoint = { url: options.hostUrl.replace(/\/+$/, '') };

	if (options.deployed) {
		return {
			...endpoint,
			containerUrl: `http://${SONAR_SERVICE}:${SONAR_CONTAINER_PORT}`,
			network: options.networkOverride ?? `${options.project}_default`
		};
	}

	if (options.networkOverride) {
		// `host` reaches a loopback-bound server on Linux; the url needs no rewrite.
		return { ...endpoint, network: options.networkOverride };
	}

	const local = localhostUrl(endpoint.url);
	return local === undefined
		? endpoint
		: {
				...endpoint,
				containerUrl: local,
				runFlags: ['--add-host', 'host.docker.internal:host-gateway']
			};
}

/** The container-side url when the host is loopback, else `undefined`. */
function localhostUrl(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
		return undefined;
	}
	parsed.hostname = 'host.docker.internal';
	return parsed.toString().replace(/\/+$/, '');
}
