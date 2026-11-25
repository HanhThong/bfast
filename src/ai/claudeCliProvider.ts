// `AiProvider` backed by the Claude Code CLI the user already has installed.
//
// The default implementation, and the reason the assistant costs the extension
// no runtime dependency: it spawns `claude -p`, reads `stream-json` off stdout
// and maps it with `messageStream.ts` — the same mapper the Agent SDK provider
// uses, so the two cannot drift.
//
// It also inherits whatever the CLI is already authenticated with, which is why
// a machine that has run `claude` once needs no key configured here at all.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { agentEnvironment, type AiContext } from './aiContext';
import {
	AiCancelledError,
	AiError,
	type AiAvailability,
	type AiProgressListener,
	type AiProvider,
	type AiRequest,
	type AiResult,
	type AiRun
} from './aiProvider';
import { DEFAULT_IDLE_TIMEOUT_MS, IdleWatchdog, idleTimeoutMessage } from '../platform/idleWatchdog';
import { AgentStream, LineBuffer, parseAgentMessage } from './messageStream';

/**
 * The only tools a run may use, hard-coded rather than configurable.
 *
 * Read-only by design. The generated text has to come back through
 * `updateDescription` so `updatedAt` bumps and `history.md` records the change;
 * a `Write` or `Edit` tool would let the agent go round the store, the conflict
 * check and the history file all at once. `Bash` would be worse still — an
 * arbitrary-code surface reachable from a description that may have arrived in
 * a `git pull`.
 *
 * `--restricted` below is the belt to this brace: it removes the command- and
 * code-running tools outright, confines the file tools to the working
 * directory, and ignores the user's own settings files and hooks.
 */
export const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const;

const DEFAULT_EXECUTABLE = 'claude';

/** How long `claude --version` gets before availability calls it missing. */
const PROBE_TIMEOUT_MS = 10_000;

/** How long a killed child gets to release its pipes before we settle anyway. */
const KILL_SETTLE_MS = 2_000;

/**
 * The injection seam for spawning, so a test can drive a run without a real
 * `claude` on the PATH.
 *
 * `spawnAgent` builds the argv itself — that is the point of it, since the
 * allow-list and `--restricted` are policy — so there is no other way in. The
 * same shape `ClaudeAgentSdkProvider` gives its module loader.
 */
export type AgentSpawner = (
	executable: string,
	request: AiRequest,
	env: NodeJS.ProcessEnv
) => ChildProcessWithoutNullStreams;

export class ClaudeCliProvider implements AiProvider {
	readonly id = 'claude-cli';
	readonly label = 'Claude Code CLI';

	private readonly live = new Set<CliRun>();
	/** Keyed by executable, so changing the setting re-probes rather than lying. */
	private probed: { executable: string; ok: boolean; message?: string } | undefined;

	constructor(
		private readonly context: AiContext,
		/** Injected in tests, so none of this needs a real `claude` on the PATH. */
		private readonly spawn: AgentSpawner = spawnAgent
	) {}

	async availability(): Promise<AiAvailability> {
		if (!this.context.workingDirectory()) {
			return {
				ok: false,
				reason: 'not-configured',
				message: 'Open a folder before using the AI assistant.'
			};
		}

		const executable = this.executable();
		if (this.probed?.executable !== executable) {
			this.probed = { executable, ...(await probe(executable, this.environment())) };
		}

		return this.probed.ok
			? { ok: true }
			: { ok: false, reason: 'not-installed', message: this.probed.message };
	}

	run(request: AiRequest, onProgress?: AiProgressListener): AiRun {
		const run = new CliRun(
			this.executable(),
			request,
			() => this.environment(),
			this.spawn,
			onProgress,
			() => this.live.delete(run)
		);
		this.live.add(run);
		return run;
	}

	dispose(): void {
		for (const run of [...this.live]) {
			run.cancel('the extension was shut down');
		}
		this.live.clear();
	}

	private executable(): string {
		return this.context.settings()?.executablePath?.trim() || DEFAULT_EXECUTABLE;
	}

	private async environment(): Promise<NodeJS.ProcessEnv> {
		return agentEnvironment(await this.context.credentials());
	}
}

class CliRun implements AiRun {
	readonly runId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	readonly completed: Promise<AiResult>;

	private child: ChildProcessWithoutNullStreams | undefined;
	private cancelledWith: AiError | undefined;
	private settled = false;
	/** Settles `settle()` early when an orphan is never going to release the pipes. */
	private abandon: (() => void) | undefined;
	private fallback: NodeJS.Timeout | undefined;

	constructor(
		executable: string,
		request: AiRequest,
		environment: () => Promise<NodeJS.ProcessEnv>,
		spawn: AgentSpawner,
		onProgress: AiProgressListener | undefined,
		private readonly onSettled: () => void
	) {
		this.completed = this.execute(executable, request, environment, spawn, onProgress).finally(() => {
			this.settled = true;
			this.onSettled();
		});
	}

	cancel(reason = 'The run was cancelled.'): void {
		if (this.settled) {
			return;
		}
		this.cancelledWith ??= new AiCancelledError(reason);
		this.stop();
	}

	/**
	 * Ends the child, however we got here.
	 *
	 * The user's Stop, the idle watchdog and `dispose()` all want exactly this,
	 * so it has to be safe to call twice and before the child exists.
	 *
	 * `kill()` on its own is not enough: it reaches only the direct child, and
	 * `claude` spawns children of its own. On Windows those keep running, keep
	 * the inherited pipes open, and `close` never fires — so a cancelled run
	 * would never reject and the board's Stop button would do nothing visible.
	 * `runProcess.ts` documents the same trap and solves it the same way; this
	 * file keeps its own copy for the reason its module comment gives.
	 */
	private stop(): void {
		const child = this.child;
		if (!child) {
			return;
		}
		killTree(child);
		// Armed once, and only while there is still a promise to settle.
		if (this.abandon && this.fallback === undefined) {
			this.fallback = setTimeout(this.abandon, KILL_SETTLE_MS);
			this.fallback.unref();
		}
	}

	private async execute(
		executable: string,
		request: AiRequest,
		environment: () => Promise<NodeJS.ProcessEnv>,
		spawn: AgentSpawner,
		onProgress: AiProgressListener | undefined
	): Promise<AiResult> {
		const env = await environment();
		if (this.cancelledWith) {
			throw this.cancelledWith;
		}

		const child = spawn(executable, request, env);
		this.child = child;

		// The prompt goes over stdin, never argv: a rendered template is easily
		// past Windows' command-line limit, and there is no quoting to get wrong.
		//
		// EPIPE when the child died before reading it — the exit code and stderr are
		// the real report, and an errored stream must not crash the host.
		child.stdin.on('error', () => undefined);
		child.stdin.end(request.prompt);

		const stream = new AgentStream();
		const lines = new LineBuffer();
		const diagnostics: string[] = [];

		// The watchdog watches the *pipes*, not the parsed events. A chunk that
		// turns out to be half a json line, or a plain warning on stderr, is still
		// the child saying it is alive, and this only has to answer “is anything
		// happening at all” — the narrower signal would be a second place for that
		// answer to be wrong.
		const idleMs = request.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		const watchdog = new IdleWatchdog(idleMs, () => {
			this.cancelledWith ??= new AiError('timeout', idleTimeoutMessage(idleMs));
			this.stop();
		});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			watchdog.touch();
			for (const line of lines.push(chunk)) {
				const message = parseAgentMessage(line);
				if (message) {
					stream.accept(message, onProgress);
				}
			}
		});

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			watchdog.touch();
			// Kept only to explain a non-zero exit; never logged, because the
			// environment this child ran with holds credentials.
			diagnostics.push(chunk);
		});

		const { completed, giveUp } = settle(child);
		this.abandon = giveUp;

		try {
			await completed;
		} finally {
			watchdog.stop();
			this.abandon = undefined;
			if (this.fallback !== undefined) {
				clearTimeout(this.fallback);
				this.fallback = undefined;
			}
		}

		for (const line of lines.flush()) {
			const message = parseAgentMessage(line);
			if (message) {
				stream.accept(message, onProgress);
			}
		}

		if (this.cancelledWith) {
			throw this.cancelledWith;
		}

		// A stream that produced a `result` is authoritative even on a non-zero
		// exit; only a run that never answered needs stderr to explain itself.
		if (!stream.done) {
			throw new AiError('provider-error', summarise(diagnostics));
		}

		return stream.result();
	}
}

/**
 * The argv a run gets.
 *
 * Its own function, exported, so a test can assert the policy flags and a
 * `--resume` without the spawner seam ever taking an argv: `spawnAgent` still
 * builds the list itself, which is what keeps the allow-list and `--restricted`
 * out of a caller's hands.
 */
export function agentArguments(request: AiRequest): string[] {
	const args = [
		'-p',
		'--output-format',
		'stream-json',
		// stream-json refuses to emit the per-message stream without it.
		'--verbose',
		// Removes Bash/PowerShell/REPL and WebFetch, confines the file tools to the
		// working directory, and ignores the user's own settings files — so a
		// personal hook cannot fire because someone pressed a button in a ticket
		// tracker. It also refuses `bypassPermissions`, which is why this provider
		// relies on `--allowedTools` for approval rather than a permission mode.
		'--restricted',
		'--strict-mcp-config',
		// Deny, never ask: a headless child has nowhere to answer a prompt. The
		// CLI already denied on its own in `-p`; saying so makes it policy.
		'--permission-mode',
		'dontAsk',
		'--allowedTools',
		...ALLOWED_TOOLS
	];

	if (request.edits) {
		// A board run that may edit other tickets: the closed set of tools it may
		// have at all, and the settings file carrying one `Edit(<path>)` rule per
		// existing content file plus the deny list — see `trackerEdits.ts` for
		// why a file, and why never a glob.
		assertEditTools(request.edits.tools);
		args.push('--tools', request.edits.tools.join(','), '--settings', request.edits.settingsFile);
	}

	if (request.model) {
		args.push('--model', request.model);
	}

	if (request.resumeSessionId) {
		// Continue the conversation that id names rather than start one. The id
		// came from the provider's own stream or from workspace state, never from
		// the webview — and `shell: false` below means a string is inert anyway.
		// Session persistence is left at its default (on): it is what makes a
		// later resume possible at all.
		args.push('--resume', request.resumeSessionId);
	}

	return args;
}

/**
 * The one shape `edits.tools` may take. Policy handed in by a caller is still
 * policy: a request that asked for `Write` or `Bash` here would otherwise reach
 * the command line unremarked.
 */
function assertEditTools(tools: readonly string[]): void {
	const permitted = new Set<string>([...ALLOWED_TOOLS, 'Edit']);
	for (const tool of tools) {
		if (!permitted.has(tool)) {
			throw new AiError('provider-error', `A run may not be given the ${tool} tool.`);
		}
	}
}

function spawnAgent(
	executable: string,
	request: AiRequest,
	env: NodeJS.ProcessEnv
): ChildProcessWithoutNullStreams {
	return spawn(executable, agentArguments(request), {
		cwd: request.workingDirectory,
		env,
		// No shell: the arguments are passed as a list, so nothing here is ever
		// interpreted by a command interpreter.
		shell: false,
		windowsHide: true
	});
}

/**
 * Resolves when the child is done, whether it exited or could not start — or
 * when `giveUp()` says an orphan is never going to release the pipes and the
 * run should report from the output it already collected.
 */
function settle(child: ChildProcessWithoutNullStreams): {
	completed: Promise<void>;
	giveUp: () => void;
} {
	let giveUp!: () => void;
	const completed = new Promise<void>((resolve, reject) => {
		giveUp = resolve;
		child.on('error', (error: NodeJS.ErrnoException) => {
			reject(
				error.code === 'ENOENT'
					? new AiError(
							'not-installed',
							'Could not run `claude`. Install the Claude Code CLI, or set the ' +
								'executable path in BFAST settings.',
							error
						)
					: new AiError('provider-error', 'The AI assistant could not be started.', error)
			);
		});
		child.on('close', () => resolve());
	});
	return { completed, giveUp };
}

/**
 * Ends the child and everything it started.
 *
 * See `CliRun.stop`: a plain `kill()` leaves grandchildren holding the pipes,
 * and on Windows `close` then never fires. The same fix, and for the same
 * reason, as `platform/runProcess.ts`.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
	if (process.platform === 'win32' && child.pid !== undefined) {
		spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
			shell: false,
			windowsHide: true
		});
	} else {
		child.kill();
	}
}

function summarise(diagnostics: string[]): string {
	const text = diagnostics.join('').trim();
	if (text.length === 0) {
		return 'The AI assistant stopped without answering.';
	}
	// Last line first: a CLI puts its actual complaint at the end.
	const last = text.split('\n').filter((line) => line.trim().length > 0).pop() ?? text;
	return last.slice(0, 300);
}

/** One `claude --version`, so a missing binary shows as a greyed-out button. */
function probe(
	executable: string,
	environment: Promise<NodeJS.ProcessEnv>
): Promise<{ ok: boolean; message?: string }> {
	const missing =
		'Could not run `claude`. Install the Claude Code CLI, or set the executable ' +
		'path in BFAST settings.';

	return environment.then(
		(env) =>
			new Promise((resolve) => {
				const child = spawn(executable, ['--version'], { env, shell: false, windowsHide: true });
				let answered = false;
				const done = (ok: boolean) => {
					if (answered) {
						return;
					}
					answered = true;
					clearTimeout(timer);
					resolve(ok ? { ok: true } : { ok: false, message: missing });
				};

				// The timer answers for itself rather than waiting on `close`: a binary
				// that ignores the kill would otherwise leave `availability()` pending
				// forever, and the board's AI button would never paint at all.
				const timer = setTimeout(() => {
					killTree(child);
					done(false);
				}, PROBE_TIMEOUT_MS);

				child.on('error', () => done(false));
				child.on('close', (code) => done(code === 0));
			})
	);
}
