// The one way BFAST runs an external command.
//
// Generalised from the spawn + settle + summarise shape in
// `src/ai/claudeCliProvider.ts` (which keeps its own copy — its stream-json
// handling is entangled with `messageStream.ts` and does not generalise).
// No `vscode` import, so every caller's tests can drive it — or fake it via
// the `ProcessRunner` type — without an extension host.
//
// Three decisions carried over, all load-bearing:
// - `shell: false`: the arguments are a list, so nothing is ever interpreted
//   by a command interpreter. On Windows this also means only real `.exe`s
//   launch — `git.exe` and `docker.exe` qualify, `.cmd` shims do not.
// - `windowsHide: true`: no console window flashes.
// - stderr is captured for diagnostics only and never logged wholesale — a
//   caller's environment may hold credentials.

import { spawn } from 'child_process';
import { IdleWatchdog } from './idleWatchdog';

export interface RunProcessRequest {
	executable: string;
	args: string[];
	cwd?: string;
	/** Built by the caller by spreading; never assign to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Written to the child's stdin, which is then closed — unless `interactive`. */
	stdin?: string;
	/**
	 * Keep stdin open and hand it back on the `RunningProcess`, for a child
	 * driven over its stdin after it starts (Playwright's trace viewer takes
	 * the traces to open that way). Off by default: a child waiting on an
	 * stdin nobody closes never exits.
	 */
	interactive?: boolean;
	/**
	 * How long the child may produce **nothing at all** before it is stopped.
	 *
	 * An idle window rather than a wall clock: an image build streams for as
	 * long as it needs to and is plainly alive while it does, so a ceiling on
	 * the whole operation kills the builds it was meant to protect. Silence is
	 * the only thing that actually tells a hang from slow work.
	 */
	idleTimeoutMs?: number;
	/** Live output, line-oriented-ish (chunks as they arrive), both channels. */
	onOutput?: (text: string, channel: 'stdout' | 'stderr') => void;
	/**
	 * Passed straight to `spawn`. The explicit `cmd.exe /c` wrap in
	 * `src/testing/testRunner.ts` needs it: without it Node quotes and
	 * backslash-escapes the command line by MSVCRT rules, which `cmd` does not
	 * parse — the wrapped line must reach it byte-for-byte. Leave unset when the
	 * arguments are a real argument list.
	 */
	windowsVerbatimArguments?: boolean;
	/**
	 * Stop the child's whole process tree, not only the child. A shell that
	 * started a test runner that started browsers takes a signal to the shell
	 * alone and leaves the rest recording on. On POSIX the child is spawned as
	 * its own process group and the group is signalled; Windows already tree-kills
	 * every child. Opt-in, because a detached child outlives a host that dies —
	 * right for a test run, not something `git` or `docker` asked for.
	 */
	killTree?: boolean;
	/**
	 * Cap, in characters per channel, on how much output is retained for the
	 * result. The **tail** is kept — a CLI puts its actual complaint at the end,
	 * the same rule `summariseStderr` reads by. Streaming via `onOutput` is
	 * unaffected. Absent keeps everything, as callers that parse stdout need.
	 */
	maxBufferedOutput?: number;
}

export interface RunProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type ProcessErrorCode = 'not-installed' | 'failed' | 'timeout' | 'cancelled';

/**
 * Carries a code because callers map it onto their own error vocabulary —
 * `ENOENT` has to end up as a greyed-out action, not a stack trace.
 */
export class ProcessError extends Error {
	constructor(
		readonly code: ProcessErrorCode,
		message: string,
		readonly result?: RunProcessResult,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'ProcessError';
	}
}

/** A child process in flight. `completed` rejects with a `ProcessError`. */
export interface RunningProcess {
	readonly completed: Promise<RunProcessResult>;
	/** Idempotent, and safe to call after the process has already settled. */
	cancel(reason?: string): void;
	/** Only for an `interactive` request: what reaches the child's stdin, and how to close it. */
	readonly stdin?: ProcessStdin;
}

export interface ProcessStdin {
	write(text: string): void;
	end(): void;
}

/** The injection seam: production passes `runProcess`, tests pass a fake. */
export type ProcessRunner = (request: RunProcessRequest) => RunningProcess;

/** How long a killed child gets to release its pipes before we settle anyway. */
const KILL_SETTLE_MS = 2_000;

export function runProcess(request: RunProcessRequest): RunningProcess {
	let cancelledWith: ProcessError | undefined;
	let settled = false;
	let resolveResult!: (result: RunProcessResult) => void;
	let rejectResult!: (error: ProcessError) => void;
	const completed = new Promise<RunProcessResult>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	const child = spawn(request.executable, request.args, {
		cwd: request.cwd,
		env: request.env,
		// No shell: see the module comment.
		shell: false,
		windowsHide: true,
		windowsVerbatimArguments: request.windowsVerbatimArguments,
		// Its own process group, so `killChild` can reach everything it started.
		detached: request.killTree === true && process.platform !== 'win32'
	});

	// EPIPE when the child died before reading — the exit code and stderr are
	// the real report; an errored stdin must not crash the host.
	child.stdin.on('error', () => undefined);
	if (request.interactive) {
		if (request.stdin) {
			child.stdin.write(request.stdin);
		}
	} else {
		child.stdin.end(request.stdin ?? '');
	}

	const stdout: string[] = [];
	const stderr: string[] = [];
	let stdoutLength = 0;
	let stderrLength = 0;

	/** Drops from the front until the buffer fits the cap; returns the new length. */
	const keepTail = (buffer: string[], length: number): number => {
		const cap = request.maxBufferedOutput;
		if (cap === undefined) {
			return length;
		}
		while (length > cap && buffer.length > 0) {
			const first = buffer[0];
			const excess = length - cap;
			if (first.length <= excess) {
				buffer.shift();
				length -= first.length;
			} else {
				let kept = first.slice(excess);
				length -= excess;
				// The cut counts UTF-16 units, so it can land inside a surrogate
				// pair; a tail must not start with the orphaned low half.
				const head = kept.charCodeAt(0);
				if (head >= 0xdc00 && head <= 0xdfff) {
					kept = kept.slice(1);
					length -= 1;
				}
				buffer[0] = kept;
			}
		}
		return length;
	};

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		watchdog?.touch();
		stdout.push(chunk);
		stdoutLength = keepTail(stdout, stdoutLength + chunk.length);
		request.onOutput?.(chunk, 'stdout');
	});

	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		watchdog?.touch();
		stderr.push(chunk);
		stderrLength = keepTail(stderr, stderrLength + chunk.length);
		request.onOutput?.(chunk, 'stderr');
	});

	const timers: NodeJS.Timeout[] = [];
	/** Undefined when the caller asked for no window at all. */
	let watchdog: IdleWatchdog | undefined;

	const finish = (code: number | null): void => {
		if (settled) {
			return;
		}
		settled = true;
		watchdog?.stop();
		for (const timer of timers) {
			clearTimeout(timer);
		}
		const result: RunProcessResult = {
			code,
			stdout: stdout.join(''),
			stderr: stderr.join('')
		};
		if (cancelledWith) {
			rejectResult(cancelledWith);
		} else if (code === 0) {
			resolveResult(result);
		} else {
			rejectResult(new ProcessError('failed', summariseStderr(result.stderr), result));
		}
	};

	const fail = (error: ProcessError): void => {
		if (settled) {
			return;
		}
		settled = true;
		watchdog?.stop();
		for (const timer of timers) {
			clearTimeout(timer);
		}
		rejectResult(error);
	};

	/**
	 * `kill()` reaches only the direct child, and `docker`/`git` spawn children
	 * of their own — on Windows those keep running and keep the pipes open, so
	 * `close` never fires. Hence the whole tree, and a fallback that settles
	 * from the collected output if an orphan still holds the pipes.
	 */
	const killChild = (): void => {
		if (process.platform === 'win32' && child.pid !== undefined) {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
				shell: false,
				windowsHide: true
			});
		} else if (request.killTree && child.pid !== undefined) {
			// The whole group (`-pid`): the shell, what it ran, what that ran.
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				child.kill();
			}
		} else {
			child.kill();
		}
		const fallback = setTimeout(() => {
			if (request.killTree && process.platform !== 'win32' && child.pid !== undefined) {
				// Still holding the pipes past the grace period: no more asking.
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					// Already gone.
				}
			}
			finish(child.exitCode);
		}, KILL_SETTLE_MS);
		fallback.unref();
		timers.push(fallback);
	};

	if (request.idleTimeoutMs !== undefined) {
		watchdog = new IdleWatchdog(request.idleTimeoutMs, () => {
			cancelledWith ??= new ProcessError(
				'timeout',
				`\`${request.executable}\` went quiet and was stopped.`
			);
			killChild();
		});
	}

	child.on('error', (error: NodeJS.ErrnoException) => {
		fail(
			error.code === 'ENOENT'
				? new ProcessError(
						'not-installed',
						`Could not run \`${request.executable}\`. Is it installed and on your PATH?`,
						undefined,
						error
					)
				: new ProcessError(
						'failed',
						`\`${request.executable}\` could not be started.`,
						undefined,
						error
					)
		);
	});

	child.on('close', (code) => finish(code));

	const stdin: ProcessStdin = {
		write(text) {
			if (!settled && child.stdin.writable) {
				child.stdin.write(text);
			}
		},
		end() {
			if (child.stdin.writable) {
				child.stdin.end();
			}
		}
	};

	return {
		completed,
		cancel(reason = 'The operation was cancelled.'): void {
			if (settled) {
				return;
			}
			cancelledWith ??= new ProcessError('cancelled', reason);
			killChild();
		},
		...(request.interactive ? { stdin } : {})
	};
}

/**
 * The last non-empty stderr line, capped — a CLI puts its actual complaint at
 * the end, and an error dialog cannot hold a build log.
 */
export function summariseStderr(stderr: string): string {
	const text = stderr.trim();
	if (text.length === 0) {
		return 'The command failed without an error message.';
	}
	const last = text.split('\n').filter((line) => line.trim().length > 0).pop() ?? text;
	return last.trim().slice(0, 300);
}
