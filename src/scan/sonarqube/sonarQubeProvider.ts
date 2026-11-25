// `ScanProvider` backed by SonarQube.
//
// Thin on purpose: the argv arrays live in `sonarCompose.ts`, the API in
// `sonarApi.ts`, the provisioning sequence in `sonarProvisioning.ts` and the
// JSON mapping in `sonarResults.ts`, all pure and all unit-tested with no
// process and no network. This file is the shell that wires them to a real
// docker and a real server.
//
// Two lifecycles sit behind one `server` member, chosen from `scan.mode` at call
// time: `AutoServerLifecycle` deploys and provisions, `ExternalServerLifecycle`
// refuses the four operations that are not BFAST's to perform and verifies the
// credentials the user supplied. Both implement the whole interface rather than
// one being a smaller type, so the store's queue, its statuses and its error
// handling are identical for both — "you cannot start someone else's server"
// becomes a message rather than a missing code path.

import { access, copyFile, mkdir, readFile, rm, stat } from 'fs/promises';
import * as path from 'path';
import { runProcess, ProcessError, type ProcessRunner, type RunningProcess } from '../../platform/runProcess';
import { shellCommand } from '../../platform/shellCommand';
import {
	scanAutoProvision,
	scanComposeOverrides,
	scanCommand,
	scanIdleTimeoutMs,
	scannerImage,
	scannerMode,
	scanMode,
	scanProperties,
	substituteCommand,
	type ScanSettings
} from '../../settings/scanSettings';
import { scannerEnvironment, type ScanContext } from '../scanContext';
import { pollUntil } from '../scanPoll';
import {
	buildReport,
	dashboardUrl,
	FALLBACK_METRICS,
	ISSUE_PAGE_SIZE,
	MAX_ISSUES,
	parseCeTask,
	parseIssues,
	parseMeasures,
	parseQualityGate,
	parseReportTask,
	REPORT_TASK_FILE,
	REPORT_TASK_NAME,
	SUMMARY_METRICS
} from './sonarResults';
import type { ScanReport } from '../scanReport';
import {
	ScanCancelledError,
	ScanError,
	type ScanAvailability,
	type ScanCredentials,
	type ScanEndpoint,
	type ScanOperation,
	type ScanProgressListener,
	type ScanProjectIdentity,
	type ScanProvider,
	type ScanRequest,
	type ScanServerDescriptor,
	type ScanServerLifecycle,
	type ServerHealth
} from '../scanProvider';
import {
	DOCKER_EXECUTABLE,
	composeVersionArgs,
	describeCommand,
	dockerMemoryArgs,
	imageInspectArgs,
	imagePullArgs,
	parseComposePort,
	resolveEndpoint,
	SCAN_COMPOSE_FILE,
	SCAN_COMPOSE_TEMPLATE,
	scanStackEnvironment,
	scannerDockerArgs,
	sonarDestroyArgs,
	sonarDownArgs,
	sonarLogsArgs,
	sonarPortArgs,
	sonarUpArgs
} from './sonarCompose';
import { httpSonarClient, sonarErrorFor, type SonarClient } from './sonarApi';
import { projectIdentityOf, readSonarProjectProperties } from './sonarProjectProperties';
import { ensureProject, provisionSonarQube, verifyResultsToken } from './sonarProvisioning';
import { errorMessage } from '../../platform/errors';

/** How long `docker compose version` gets before availability calls it missing. */
const PROBE_TIMEOUT_MS = 10_000;
/** A `down` prints little and exits; this behaves as the wall clock it replaced. */
const STOP_IDLE_TIMEOUT_MS = 2 * 60_000;
/** SonarQube asks for 2 GB plus the OS's own; below this the JVM and ES fight. */
const MIN_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
/** Elasticsearch's own floor. SonarQube's docs ask for 524288. */
const MIN_MAX_MAP_COUNT = 262_144;
const RECOMMENDED_MAX_MAP_COUNT = 524_288;

/** The scanner's analyzer cache, under the scan home so the invoking user owns it. */
const SCANNER_CACHE_DIR = 'scanner-cache';
/** Where the scanner's `.scannerwork` lands in `docker` mode — never the repository. */
const SCANNER_WORK_DIR = 'scannerwork';

export interface SonarQubeProviderDeps {
	context: ScanContext;
	/** The extension's own directory, where `templates/` is shipped. */
	extensionRoot: string;
	/** Injection seam; defaults to the real `runProcess`. */
	runner?: ProcessRunner;
	/** Injection seam; defaults to a real HTTP client for the given base url. */
	clientFor?: (baseUrl: string) => SonarClient;
	/** VS Code's `http.proxy`, named in an error because Node's fetch ignores it. */
	proxy?: () => string | undefined;
	/** Injected so a test does not read the real `/proc` or the real platform. */
	platform?: NodeJS.Platform;
	maxMapCount?: () => Promise<number | undefined>;
}

export class SonarQubeProvider implements ScanProvider {
	readonly id = 'sonarqube' as const;
	readonly label = 'SonarQube';

	readonly server: ScanServerLifecycle;

	private readonly live = new Set<SonarOperation<unknown>>();
	private probed: { ok: boolean; message?: string } | undefined;

	constructor(readonly deps: SonarQubeProviderDeps) {
		const auto = new AutoServerLifecycle(this);
		const external = new ExternalServerLifecycle(this);
		// One member, two strategies, chosen at call time — so switching mode in
		// settings takes effect on the next operation rather than the next reload.
		this.server = {
			availability: () => this.lifecycle(auto, external).availability(),
			create: (...args) => this.lifecycle(auto, external).create(...args),
			start: (...args) => this.lifecycle(auto, external).start(...args),
			stop: (...args) => this.lifecycle(auto, external).stop(...args),
			destroy: (...args) => this.lifecycle(auto, external).destroy(...args),
			provision: (...args) => this.lifecycle(auto, external).provision(...args),
			health: (...args) => this.lifecycle(auto, external).health(...args),
			endpoint: (...args) => this.lifecycle(auto, external).endpoint(...args)
		};
	}

	async availability(): Promise<ScanAvailability> {
		if (!this.deps.context.workspaceRoot()) {
			return { ok: false, reason: 'not-configured', message: 'Open a folder before scanning.' };
		}
		if (this.settings === undefined && scanMode(undefined) === 'external') {
			return { ok: false, reason: 'not-configured', message: 'Set the scan server URL in the BFAST settings.' };
		}
		// A user-written command needs no docker at all.
		if (scannerMode(this.settings) === 'command') {
			return scanCommand(this.settings) === undefined
				? {
						ok: false,
						reason: 'not-configured',
						message: 'Set a scan command in the BFAST settings, or switch the scanner back to the docker image.'
					}
				: { ok: true };
		}
		this.probed ??= await this.probeDocker();
		return this.probed.ok
			? { ok: true }
			: { ok: false, reason: 'not-installed', message: this.probed.message };
	}

	/** The checkout's own `sonar-project.properties`, when it has one. Never throws. */
	async readProjectIdentity(directory: string): Promise<ScanProjectIdentity | undefined> {
		const properties = await readSonarProjectProperties(directory);
		return properties === undefined ? undefined : projectIdentityOf(properties);
	}

	scan(request: ScanRequest, onProgress?: ScanProgressListener): ScanOperation<ScanReport> {
		return this.operation<ScanReport>(async (track) => {
			const directory = request.directory;
			const scmDisabled = !(await isGitDirectory(directory));
			const fileProperties = Object.keys((await readSonarProjectProperties(directory)) ?? {});

			await this.prepareProject(request, onProgress);
			const taskFile = await this.runScanner(
				request,
				directory,
				scmDisabled,
				fileProperties,
				onProgress,
				track
			);

			onProgress?.({ kind: 'phase', label: 'Waiting for SonarQube to process the analysis' });
			return this.collectReport(request, taskFile, scmDisabled, onProgress);
		});
	}

	dispose(): void {
		for (const operation of [...this.live]) {
			operation.cancel('the extension was shut down');
		}
	}

	// ------------------------------------------------------------- internals

	/** Read at call time, so a settings change reaches the next operation. */
	get settings(): ScanSettings | undefined {
		return this.deps.context.settings();
	}

	get runner(): ProcessRunner {
		return this.deps.runner ?? runProcess;
	}

	get platform(): NodeJS.Platform {
		return this.deps.platform ?? process.platform;
	}

	clientFor(baseUrl: string): SonarClient {
		return (
			this.deps.clientFor?.(baseUrl) ??
			httpSonarClient({ baseUrl, proxy: this.deps.proxy?.() })
		);
	}

	private lifecycle(auto: ScanServerLifecycle, external: ScanServerLifecycle): ScanServerLifecycle {
		return scanMode(this.settings) === 'external' ? external : auto;
	}

	/** Compose v2 specifically: a machine with only the v1 binary has no `docker compose`. */
	private async probeDocker(): Promise<{ ok: boolean; message?: string }> {
		try {
			await this.runner({
				executable: DOCKER_EXECUTABLE,
				args: composeVersionArgs(),
				idleTimeoutMs: PROBE_TIMEOUT_MS
			}).completed;
			return { ok: true };
		} catch {
			return {
				ok: false,
				message:
					'Could not run `docker compose`. Install Docker with Compose v2 and make sure it is on your PATH.'
			};
		}
	}

	/** Every compose file for this server, base first. */
	composeFiles(server: ScanServerDescriptor): string[] {
		const overrides = scanComposeOverrides(this.settings).map((file) =>
			path.isAbsolute(file) ? file : path.join(this.deps.context.workspaceRoot() ?? '', file)
		);
		return [path.join(server.home, SCAN_COMPOSE_FILE), ...overrides];
	}

	/** A compose invocation, with the stack variables spread — never assigned. */
	compose(
		server: ScanServerDescriptor,
		args: string[],
		options: { idleTimeoutMs: number; onProgress?: ScanProgressListener; maxBufferedOutput?: number }
	): RunningProcess {
		options.onProgress?.({
			kind: 'output',
			text: `${describeCommand(DOCKER_EXECUTABLE, args)}\n`,
			channel: 'stdout'
		});
		return this.runner({
			executable: DOCKER_EXECUTABLE,
			args,
			cwd: server.home,
			env: { ...process.env, ...scanStackEnvironment(server.port, server.projectName) },
			idleTimeoutMs: options.idleTimeoutMs,
			...(options.maxBufferedOutput === undefined
				? {}
				: { maxBufferedOutput: options.maxBufferedOutput }),
			onOutput: (text, channel) => options.onProgress?.({ kind: 'output', text, channel })
		});
	}

	idleTimeoutMs(): number {
		return scanIdleTimeoutMs(this.settings);
	}

	stopIdleTimeoutMs(): number {
		return Math.min(STOP_IDLE_TIMEOUT_MS, this.idleTimeoutMs());
	}

	/** The host-side base url for a server, or `undefined` when nothing says. */
	hostUrl(server: ScanServerDescriptor): string | undefined {
		if (scanMode(this.settings) === 'external') {
			return this.settings?.hostUrl;
		}
		return server.port === undefined ? undefined : `http://localhost:${server.port}`;
	}

	endpointFor(server: ScanServerDescriptor): ScanEndpoint | undefined {
		const hostUrl = this.hostUrl(server);
		if (hostUrl === undefined) {
			return undefined;
		}
		return resolveEndpoint({
			hostUrl,
			project: server.projectName,
			deployed: scanMode(this.settings) !== 'external',
			...(this.settings?.scannerNetwork ? { networkOverride: this.settings.scannerNetwork } : {})
		});
	}

	/** `GET api/system/status` — anonymous, and served while the instance boots. */
	async serverStatus(baseUrl: string): Promise<string | undefined> {
		try {
			const response = await this.clientFor(baseUrl).request({
				method: 'GET',
				path: 'api/system/status'
			});
			const body = response.body;
			const status =
				typeof body === 'object' && body !== null
					? (body as { status?: unknown }).status
					: undefined;
			return typeof status === 'string' ? status.toUpperCase() : undefined;
		} catch {
			// Connection refused is most of a cold start, not an error.
			return undefined;
		}
	}

	operation<T>(work: (track: (child: { cancel(reason?: string): void }) => void) => Promise<T>): ScanOperation<T> {
		const operation = new SonarOperation<T>(work, () => this.live.delete(operation as SonarOperation<unknown>));
		this.live.add(operation as SonarOperation<unknown>);
		return operation;
	}

	// ------------------------------------------------------------- scanning

	/**
	 * The project exists before the scanner runs, under the key the runner
	 * resolved and the name the checkout gave it.
	 *
	 * Best effort, and deliberately so: a token that can analyse but not create
	 * projects (an external instance where the project was made by hand and the
	 * permission dropped) still scans, because the scanner auto-provisions on an
	 * unknown key. A refusal here is a warning in the log, never a failed run —
	 * the credential itself was verified a moment ago by `provision`.
	 */
	private async prepareProject(
		request: ScanRequest,
		onProgress: ScanProgressListener | undefined
	): Promise<void> {
		const token = request.credentials.resultsToken;
		if (!token) {
			return;
		}
		try {
			await ensureProject({
				client: this.clientFor(request.endpoint.url),
				token,
				projectKey: request.projectKey,
				...(request.projectName ? { projectName: request.projectName } : {}),
				...(this.settings?.organization ? { organization: this.settings.organization } : {}),
				onProgress: (label) => onProgress?.({ kind: 'phase', label })
			});
		} catch (error) {
			const reason = errorMessage(error);
			onProgress?.({
				kind: 'output',
				text: `⚠ BFAST could not create the project ${request.projectKey} ahead of the scan (${reason}); the analysis will try to provision it itself.\n`,
				channel: 'stderr'
			});
		}
	}

	/**
	 * Runs the scanner and returns where its `report-task.txt` is: a BFAST-owned
	 * folder in `docker` mode, the repository's own `.scannerwork/` in `command`
	 * mode, where the user's scanner runs on the host with its defaults.
	 *
	 * The previous run's file is removed first. A run that fails before writing
	 * would otherwise leave it in place, and polling a stale task id would
	 * report the *last* scan's verdict as this one's.
	 */
	private async runScanner(
		request: ScanRequest,
		directory: string,
		scmDisabled: boolean,
		fileProperties: string[],
		onProgress: ScanProgressListener | undefined,
		track: (child: { cancel(reason?: string): void }) => void
	): Promise<string> {
		const settings = this.settings;
		const environment = scannerEnvironment({
			// A container gets the container url; a shell line runs on the host and
			// must have the published one.
			hostUrl:
				scannerMode(settings) === 'command'
					? request.endpoint.url
					: (request.endpoint.containerUrl ?? request.endpoint.url),
			projectKey: request.projectKey,
			...(settings?.organization ? { organization: settings.organization } : {}),
			...(request.ticketId ? { ticketId: request.ticketId } : {}),
			credentials: request.credentials
		});

		if (scannerMode(settings) === 'command') {
			const template = scanCommand(settings);
			if (template === undefined) {
				throw new ScanError('not-configured', 'Set a scan command in the BFAST settings.');
			}
			const line = substituteCommand(template, {
				projectKey: request.projectKey,
				hostUrl: request.endpoint.url,
				folder: directory,
				id: request.ticketId ?? '',
				key: request.ticketId ?? ''
			});
			const taskFile = path.join(directory, ...REPORT_TASK_FILE.split('/'));
			await rm(taskFile, { force: true });
			onProgress?.({ kind: 'phase', label: `Running ${line}` });
			// A user-written line is inherently a shell line; the docker path below
			// deliberately does not go through this.
			const shell = shellCommand(line, this.platform);
			const child = this.runner({
				executable: shell.executable,
				args: shell.args,
				...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
				cwd: directory,
				env: environment,
				idleTimeoutMs: request.idleTimeoutMs,
				onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
			});
			track(child);
			await child.completed;
			return taskFile;
		}

		const image = scannerImage(settings);
		await this.ensureImage(image, onProgress, track);

		const home = this.deps.context.scanHome() ?? directory;
		const cacheDir = path.join(home, SCANNER_CACHE_DIR);
		const workDir = path.join(home, SCANNER_WORK_DIR);
		await mkdir(cacheDir, { recursive: true });
		await mkdir(workDir, { recursive: true });
		const taskFile = path.join(workDir, REPORT_TASK_NAME);
		await rm(taskFile, { force: true });

		const args = scannerDockerArgs({
			image,
			directory,
			cacheDir,
			workDir,
			endpoint: request.endpoint,
			projectKey: request.projectKey,
			...(request.projectName ? { projectName: request.projectName } : {}),
			...(settings?.organization ? { organization: settings.organization } : {}),
			...(settings?.sources ? { sources: settings.sources } : {}),
			...(settings?.exclusions ? { exclusions: settings.exclusions } : {}),
			properties: scanProperties(settings),
			scmDisabled,
			fileProperties,
			platform: this.platform,
			...uidGid(this.platform)
		});

		onProgress?.({ kind: 'phase', label: 'Running the scanner' });
		onProgress?.({
			kind: 'output',
			text: `${describeCommand(DOCKER_EXECUTABLE, args)}\n`,
			channel: 'stdout'
		});
		const child = this.runner({
			executable: DOCKER_EXECUTABLE,
			args,
			cwd: directory,
			env: environment,
			idleTimeoutMs: request.idleTimeoutMs,
			onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
		});
		track(child);
		await child.completed;
		return taskFile;
	}

	/** A 500 MB pull deserves a labelled phase rather than a silent stall. */
	private async ensureImage(
		image: string,
		onProgress: ScanProgressListener | undefined,
		track: (child: { cancel(reason?: string): void }) => void
	): Promise<void> {
		try {
			await this.runner({
				executable: DOCKER_EXECUTABLE,
				args: imageInspectArgs(image),
				idleTimeoutMs: PROBE_TIMEOUT_MS
			}).completed;
			return;
		} catch {
			// Not present, or docker said something else; either way, try to pull.
		}
		onProgress?.({
			kind: 'phase',
			label: `Downloading the scanner image ${image} (about 500 MB, once)`
		});
		const child = this.runner({
			executable: DOCKER_EXECUTABLE,
			args: imagePullArgs(image),
			idleTimeoutMs: this.idleTimeoutMs(),
			onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
		});
		track(child);
		await child.completed;
	}

	/**
	 * The scanner exiting 0 means the report was *uploaded*. Everything here is
	 * what turns that into a verdict.
	 */
	private async collectReport(
		request: ScanRequest,
		taskFile: string,
		scmDisabled: boolean,
		onProgress: ScanProgressListener | undefined
	): Promise<ScanReport> {
		const hostUrl = request.endpoint.url;
		const client = this.clientFor(hostUrl);
		const auth = { kind: 'token' as const, token: request.credentials.resultsToken ?? request.credentials.analysisToken ?? '' };

		const taskId = await this.readTaskId(taskFile);
		const task = await pollUntil({
			read: async () => {
				const response = await client.request({
					method: 'GET',
					path: 'api/ce/task',
					params: { id: taskId, additionalFields: 'warnings' },
					auth
				});
				if (response.status === 401 || response.status === 403) {
					throw sonarErrorFor(response);
				}
				return parseCeTask(response.body);
			},
			done: (value) => value.status !== 'PENDING' && value.status !== 'IN_PROGRESS',
			// The status and its warnings are the whole payload; a change in them is
			// the only evidence the compute engine is alive.
			fingerprint: (value) => `${value.status}:${value.warnings.length}`,
			idleTimeoutMs: request.idleTimeoutMs,
			label: 'SonarQube',
			onChange: (value) =>
				onProgress?.({ kind: 'phase', label: `Analysis ${value.status.toLowerCase()}` })
		});

		for (const warning of task.warnings) {
			onProgress?.({ kind: 'output', text: `⚠ ${warning}\n`, channel: 'stderr' });
		}
		if (task.status === 'FAILED') {
			throw new ScanError(
				'server-error',
				task.errorMessage ?? 'SonarQube could not process the analysis.'
			);
		}
		if (task.status === 'CANCELED') {
			throw new ScanCancelledError('SonarQube cancelled the analysis.');
		}

		// `analysisId` over `projectKey`: on a shared instance a colleague's run
		// can land between the submit and the read, and `projectKey` answers with
		// the *latest* analysis rather than this one.
		const gateResponse = await client.request({
			method: 'GET',
			path: 'api/qualitygates/project_status',
			params: task.analysisId
				? { analysisId: task.analysisId }
				: { projectKey: request.projectKey },
			auth
		});
		const { gate, conditions } = parseQualityGate(gateResponse.body);

		const measures = await this.readMeasures(client, auth, request.projectKey);
		const issues = await this.readIssues(client, auth, request.projectKey);

		return buildReport({
			gate,
			conditions,
			measures,
			issues: issues.issues,
			...(issues.total === undefined ? {} : { total: issues.total }),
			dashboardUrl: dashboardUrl(hostUrl, request.projectKey),
			...(scmDisabled ? { scmDisabled: true } : {})
		});
	}

	/**
	 * The task id out of `report-task.txt`. Freshness is `runScanner`'s job: it
	 * removes the previous run's file before the scanner starts, so a file here
	 * is this run's.
	 */
	private async readTaskId(file: string): Promise<string> {
		let text: string;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			throw new ScanError(
				'scanner-error',
				'The scanner finished but wrote no report-task.txt, so BFAST cannot find the analysis it submitted.'
			);
		}
		const task = parseReportTask(text);
		if (task === undefined) {
			throw new ScanError(
				'scanner-error',
				'The scanner wrote a report-task.txt with no task id in it.'
			);
		}
		return task.ceTaskId;
	}

	private async readMeasures(client: SonarClient, auth: { kind: 'token'; token: string }, projectKey: string) {
		const ask = async (metrics: readonly string[]) =>
			client.request({
				method: 'GET',
				path: 'api/measures/component',
				params: { component: projectKey, metricKeys: metrics.join(',') },
				auth
			});

		let response = await ask(SUMMARY_METRICS);
		if (response.status === 400) {
			// An unknown metric key fails the **whole** call rather than returning
			// that one as null, and the legacy metrics are on their way out. Retry
			// once with the one every version has, and report the rest as absent.
			response = await ask(FALLBACK_METRICS);
		}
		return parseMeasures(response.body);
	}

	private async readIssues(
		client: SonarClient,
		auth: { kind: 'token'; token: string },
		projectKey: string
	) {
		const collected: ReturnType<typeof parseIssues>['issues'] = [];
		let total: number | undefined;

		for (let page = 1; collected.length < MAX_ISSUES; page += 1) {
			const response = await client.request({
				method: 'GET',
				path: 'api/issues/search',
				params: {
					componentKeys: projectKey,
					resolved: 'false',
					ps: String(ISSUE_PAGE_SIZE),
					p: String(page),
					s: 'SEVERITY',
					asc: 'false'
				},
				auth
			});
			if (response.status === 401 || response.status === 403) {
				throw new ScanError(
					'unauthorized',
					'The stored token can run an analysis but cannot read its results. BFAST needs a **user** token — run BFAST: Set SonarQube Token.'
				);
			}
			const parsed = parseIssues(response.body);
			total = parsed.total ?? total;
			collected.push(...parsed.issues);
			if (parsed.issues.length < ISSUE_PAGE_SIZE) {
				break;
			}
		}
		return { issues: collected, ...(total === undefined ? {} : { total }) };
	}

	// --------------------------------------------------------- pre-flight

	/** The scan home's copy of the compose file, made at deploy time. */
	async writeComposeFile(server: ScanServerDescriptor): Promise<void> {
		const template = path.join(this.deps.extensionRoot, ...SCAN_COMPOSE_TEMPLATE);
		const destination = path.join(server.home, SCAN_COMPOSE_FILE);
		try {
			await access(destination);
			return;
		} catch {
			// Not there yet, which is the normal case for a deploy.
		}
		try {
			await copyFile(template, destination);
		} catch (error) {
			throw new ScanError(
				'not-configured',
				'BFAST could not write its SonarQube compose file. A VSIX missing its own templates is a packaging fault.',
				error
			);
		}
	}

	/**
	 * `vm.max_map_count`, on Linux only.
	 *
	 * Not fixable from compose — the sysctl is not namespaced, so the engine
	 * refuses it, and the only workaround would be a privileged init container, an
	 * escalation a ticket tracker has no business requesting. So BFAST detects and
	 * explains. Skipped off Linux, where Docker Desktop's VM already sets it and
	 * the host's `/proc` says nothing about the VM anyway.
	 */
	async checkMaxMapCount(): Promise<void> {
		if (this.platform !== 'linux') {
			return;
		}
		const value = await (this.deps.maxMapCount ?? readMaxMapCount)();
		if (value === undefined || value >= MIN_MAX_MAP_COUNT) {
			return;
		}
		throw new ScanError('not-configured', maxMapCountMessage(value));
	}

	/** A guess about someone else's machine, so a warning and never a refusal. */
	async checkMemory(onProgress?: ScanProgressListener): Promise<void> {
		try {
			const result = await this.runner({
				executable: DOCKER_EXECUTABLE,
				args: dockerMemoryArgs(),
				idleTimeoutMs: PROBE_TIMEOUT_MS
			}).completed;
			const bytes = Number(result.stdout.trim());
			if (Number.isFinite(bytes) && bytes > 0 && bytes < MIN_MEMORY_BYTES) {
				onProgress?.({
					kind: 'phase',
					label: `⚠ Docker reports ${Math.round(bytes / 1024 ** 3)} GB of memory. SonarQube wants about 2 GB of its own; it may be slow or fail to start.`
				});
			}
		} catch {
			// A machine that will not answer is not a machine to refuse.
		}
	}
}

/** The message the log-grep net reuses, so both routes say the same thing. */
export function maxMapCountMessage(value?: number): string {
	const seen = value === undefined ? '' : ` It is currently ${value}.`;
	return (
		"SonarQube's Elasticsearch needs `vm.max_map_count` to be at least " +
		`${MIN_MAX_MAP_COUNT} on Linux, and BFAST cannot set it — the sysctl is not namespaced.${seen} Run:\n` +
		`  sudo sysctl -w vm.max_map_count=${RECOMMENDED_MAX_MAP_COUNT}\n` +
		`  echo 'vm.max_map_count=${RECOMMENDED_MAX_MAP_COUNT}' | sudo tee /etc/sysctl.d/99-sonarqube.conf`
	);
}

/** Recognises the boot failure in a log BFAST already collected. */
export function looksLikeMaxMapCount(log: string): boolean {
	return /max_map_count|max virtual memory areas/i.test(log);
}

async function readMaxMapCount(): Promise<number | undefined> {
	try {
		// A plain file read: no spawn, no root.
		const value = Number((await readFile('/proc/sys/vm/max_map_count', 'utf8')).trim());
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * True when the directory holds a real `.git` **directory**.
 *
 * In an environment worktree `.git` is a *file* carrying a `gitdir:` pointer to
 * a path outside the mount, so the scanner finds a repository it cannot read and
 * floods the log with blame failures.
 */
async function isGitDirectory(directory: string): Promise<boolean> {
	try {
		return (await stat(path.join(directory, '.git'))).isDirectory();
	} catch {
		return false;
	}
}

/** `-u` is Linux-only; see `scannerDockerArgs`. */
function uidGid(platform: NodeJS.Platform): { uid?: number; gid?: number } {
	if (platform !== 'linux') {
		return {};
	}
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return uid === undefined || gid === undefined ? {} : { uid, gid };
}

/**
 * One operation as a `ScanOperation<T>`.
 *
 * `cancel` records its reason first and then kills the child, so the settled
 * error says "cancelled" rather than whatever the kill looked like to docker —
 * and a cancel that lands before the process spawns is honoured the moment
 * `track` sees it. The `ComposeOperation` shape, with a payload.
 */
class SonarOperation<T> implements ScanOperation<T> {
	readonly completed: Promise<T>;
	private child: { cancel(reason?: string): void } | undefined;
	private cancelledWith: ScanCancelledError | undefined;
	private settled = false;

	constructor(
		execute: (track: (child: { cancel(reason?: string): void }) => void) => Promise<T>,
		onSettled: () => void
	) {
		this.completed = this.run(execute).finally(() => {
			this.settled = true;
			onSettled();
		});
	}

	cancel(reason = 'The operation was cancelled.'): void {
		if (this.settled) {
			return;
		}
		this.cancelledWith ??= new ScanCancelledError(reason);
		this.child?.cancel(reason);
	}

	private async run(
		execute: (track: (child: { cancel(reason?: string): void }) => void) => Promise<T>
	): Promise<T> {
		let result: T;
		try {
			result = await execute((child) => {
				this.child = child;
				if (this.cancelledWith) {
					child.cancel(this.cancelledWith.message);
				}
			});
		} catch (error) {
			if (this.cancelledWith) {
				throw this.cancelledWith;
			}
			throw mapProcessError(error);
		}
		if (this.cancelledWith) {
			throw this.cancelledWith;
		}
		return result;
	}
}

/** `ProcessErrorCode` → `ScanErrorCode`, at exactly one boundary. */
export function mapProcessError(error: unknown): ScanError {
	if (error instanceof ScanError) {
		return error;
	}
	if (error instanceof ProcessError) {
		switch (error.code) {
			case 'not-installed':
				return new ScanError(
					'not-installed',
					'Could not run `docker`. Install Docker and make sure it is on your PATH.',
					error
				);
			case 'timeout':
				return new ScanError(
					'timeout',
					'The scan went quiet and was stopped. The output channel shows how far it got.',
					error
				);
			case 'cancelled':
				return new ScanCancelledError(error.message);
			default:
				return new ScanError('scanner-error', error.message, error);
		}
	}
	return new ScanError('scanner-error', 'The scan failed.', error);
}

/** The deployment BFAST owns. */
class AutoServerLifecycle implements ScanServerLifecycle {
	constructor(private readonly provider: SonarQubeProvider) {}

	availability(): Promise<ScanAvailability> {
		return this.provider.availability();
	}

	create(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation {
		return this.provider.operation(async () => {
			await this.provider.checkMaxMapCount();
			await mkdir(server.home, { recursive: true });
			await this.provider.writeComposeFile(server);
			await this.provider.checkMemory(onProgress);
			onProgress?.({ kind: 'phase', label: 'Scan server prepared' });
		});
	}

	/**
	 * Brings the stack up **and waits until the API answers**.
	 *
	 * Two things at once, and the pairing is the point: the followed container
	 * log gives the idle watchdog real bytes to reset on — and puts a four-minute
	 * boot on screen — while an HTTP poll decides when to stop. A wall clock here
	 * would kill exactly the slow first boot it was meant to protect.
	 */
	start(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation {
		return this.provider.operation(async (track) => {
			const files = this.provider.composeFiles(server);
			onProgress?.({ kind: 'phase', label: 'Starting SonarQube' });
			const up = this.provider.compose(server, sonarUpArgs(server.projectName, files), {
				idleTimeoutMs: this.provider.idleTimeoutMs(),
				...(onProgress ? { onProgress } : {})
			});
			track(up);
			await up.completed;

			const endpoint = this.provider.endpointFor(server);
			if (!endpoint) {
				throw new ScanError('not-configured', 'The scan server has no port allocated.');
			}

			onProgress?.({ kind: 'phase', label: 'Waiting for SonarQube to come up' });
			const log: string[] = [];
			const logs = this.provider.compose(server, sonarLogsArgs(server.projectName, files), {
				idleTimeoutMs: this.provider.idleTimeoutMs(),
				maxBufferedOutput: 20_000,
				onProgress: (progress) => {
					if (progress.kind === 'output') {
						log.push(progress.text);
					}
					onProgress?.(progress);
				}
			});
			// The log is a heartbeat, not a result: its own rejection is noise.
			logs.completed.catch(() => undefined);
			track(logs);

			try {
				await pollUntil({
					read: () => this.provider.serverStatus(endpoint.url),
					done: (status) => status === 'UP',
					fingerprint: (status) => status ?? 'unreachable',
					idleTimeoutMs: this.provider.idleTimeoutMs(),
					label: 'SonarQube',
					onChange: (status) =>
						onProgress?.({
							kind: 'phase',
							label: status === undefined ? 'SonarQube is not answering yet' : `SonarQube is ${status}`
						})
				});
			} catch (error) {
				// The net that catches a remote docker context, colima, rootless and
				// a WSL distro — every case where the host's /proc is not the kernel
				// the container ran on.
				if (looksLikeMaxMapCount(log.join(''))) {
					throw new ScanError('not-configured', maxMapCountMessage(), error);
				}
				throw error;
			} finally {
				logs.cancel('the server came up');
			}
		});
	}

	stop(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation {
		return this.provider.operation(async (track) => {
			onProgress?.({ kind: 'phase', label: 'Stopping SonarQube' });
			const child = this.provider.compose(
				server,
				sonarDownArgs(server.projectName, this.provider.composeFiles(server)),
				{ idleTimeoutMs: this.provider.stopIdleTimeoutMs(), ...(onProgress ? { onProgress } : {}) }
			);
			track(child);
			await child.completed;
		});
	}

	destroy(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation {
		return this.provider.operation(async (track) => {
			onProgress?.({ kind: 'phase', label: 'Removing SonarQube and its data' });
			const child = this.provider.compose(
				server,
				sonarDestroyArgs(server.projectName, this.provider.composeFiles(server)),
				{ idleTimeoutMs: this.provider.stopIdleTimeoutMs(), ...(onProgress ? { onProgress } : {}) }
			);
			track(child);
			await child.completed;
		});
	}

	/**
	 * Mints what a scan needs — or, with `autoProvision: false`, only checks the
	 * token the user supplied, exactly as the external lifecycle does. That flag
	 * means "this instance is mine to manage", and the one thing it must
	 * guarantee is that BFAST never changes its admin password.
	 */
	provision(
		server: ScanServerDescriptor,
		onProgress?: ScanProgressListener
	): ScanOperation<ScanCredentials> {
		return this.provider.operation<ScanCredentials>(async () => {
			const endpoint = this.provider.endpointFor(server);
			if (!endpoint) {
				throw new ScanError('not-configured', 'The scan server has no endpoint yet.');
			}
			const context = this.provider.deps.context;
			const client = this.provider.clientFor(endpoint.url);
			const current = await context.credentials();
			const progress = (label: string): void => onProgress?.({ kind: 'phase', label });

			if (!scanAutoProvision(this.provider.settings)) {
				await verifyResultsToken(client, current.resultsToken ?? current.analysisToken, progress);
				return {};
			}
			return provisionSonarQube({
				client,
				current,
				rememberPassword: (password) => context.storeCredentials({ adminPassword: password }),
				onProgress: progress
			});
		});
	}

	/**
	 * The port a leftover stack is already publishing.
	 *
	 * The scan home lives in the OS temp folder and can be cleaned away while the
	 * containers keep running. Without this the next deploy would allocate a new
	 * port, `up` would adopt the existing containers on their old one, and the
	 * sidebar would show a number the server is not on.
	 */
	async existingPort(server: ScanServerDescriptor): Promise<number | undefined> {
		try {
			const result = await this.provider.compose(
				server,
				sonarPortArgs(server.projectName, this.provider.composeFiles(server)),
				{ idleTimeoutMs: PROBE_TIMEOUT_MS }
			).completed;
			return parseComposePort(result.stdout);
		} catch {
			// No stack, no compose file yet, or no docker — all of them mean there
			// is nothing to adopt, which is the normal case.
			return undefined;
		}
	}

	async health(server: ScanServerDescriptor): Promise<ServerHealth> {
		const endpoint = this.provider.endpointFor(server);
		if (!endpoint) {
			return 'unknown';
		}
		const status = await this.provider.serverStatus(endpoint.url);
		if (status === 'UP') {
			return 'up';
		}
		if (status === undefined) {
			// Nothing answered. Either it is down, or it is a container that has not
			// opened its port yet — `stopped` is the honest sidebar answer.
			return 'down';
		}
		return 'starting';
	}

	endpoint(server: ScanServerDescriptor): ScanEndpoint | undefined {
		return this.provider.endpointFor(server);
	}
}

/**
 * A server BFAST does not own.
 *
 * It implements the whole interface and refuses four of its methods rather than
 * being a smaller type, so nothing upstream needs a branch: the store queues,
 * reports and handles errors identically, and "you cannot start someone else's
 * server" is a message.
 */
class ExternalServerLifecycle implements ScanServerLifecycle {
	constructor(private readonly provider: SonarQubeProvider) {}

	availability(): Promise<ScanAvailability> {
		return this.provider.availability();
	}

	create(): ScanOperation {
		return refuse();
	}

	start(): ScanOperation {
		return refuse();
	}

	stop(): ScanOperation {
		return refuse();
	}

	destroy(): ScanOperation {
		return refuse();
	}

	/**
	 * Mints nothing and **verifies** what is configured, so the one gesture — "Re-provision
	 * credentials" — answers "are my credentials good" in both modes. The check
	 * itself is `verifyResultsToken`, shared with the deployed lifecycle's
	 * `autoProvision: false` path.
	 */
	provision(
		server: ScanServerDescriptor,
		onProgress?: ScanProgressListener
	): ScanOperation<ScanCredentials> {
		return this.provider.operation<ScanCredentials>(async () => {
			const endpoint = this.provider.endpointFor(server);
			if (!endpoint) {
				throw new ScanError('not-configured', 'Set the scan server URL in the BFAST settings.');
			}
			const credentials = await this.provider.deps.context.credentials();
			await verifyResultsToken(
				this.provider.clientFor(endpoint.url),
				credentials.resultsToken ?? credentials.analysisToken,
				(label) => onProgress?.({ kind: 'phase', label })
			);
			// The user supplied it; nothing new was minted, so nothing is returned.
			return {};
		});
	}

	async health(server: ScanServerDescriptor): Promise<ServerHealth> {
		const endpoint = this.provider.endpointFor(server);
		if (!endpoint) {
			return 'unknown';
		}
		const status = await this.provider.serverStatus(endpoint.url);
		return status === 'UP' ? 'up' : status === undefined ? 'unknown' : 'starting';
	}

	endpoint(server: ScanServerDescriptor): ScanEndpoint | undefined {
		return this.provider.endpointFor(server);
	}
}

function refuse<T>(): ScanOperation<T> {
	const completed = Promise.reject(
		new ScanError(
			'external',
			'This workspace points at a SonarQube BFAST does not manage. Change the mode in settings to have BFAST deploy one.'
		)
	);
	// Nobody may await this handle; an unobserved rejection must not be noise.
	completed.catch(() => undefined);
	return { completed: completed as Promise<T>, cancel: () => undefined };
}
