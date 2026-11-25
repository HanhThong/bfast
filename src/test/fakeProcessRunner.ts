// A scripted `ProcessRunner`, shaped like `fakeAiProvider.ts`: a script, not a
// mock framework. It records every request, answers by call index, and its
// `hangFrom` mode — a process that settles only when the test says so — is the
// only way to exercise cancel-mid-operation.

import {
	ProcessError,
	type ProcessRunner,
	type ProcessStdin,
	type RunProcessRequest,
	type RunProcessResult,
	type RunningProcess
} from '../platform/runProcess';

export interface FakeProcessOptions {
	/** Results by call index; the last one repeats. Default: empty success. */
	results?: Partial<RunProcessResult>[];
	/** Call indexes (0-based) that reject with a `failed` ProcessError. */
	failAt?: number[];
	/** From this call index on, processes hang until settled by hand. */
	hangFrom?: number;
	/** Call indexes that reject with `not-installed`, as a missing binary would. */
	missingAt?: number[];
	/** stderr attached to a failure, so error mapping has something to summarise. */
	stderr?: string;
	/**
	 * Asked first, for a request that succeeds: a side effect a real child
	 * would have (`git worktree add` filling a folder), and the result to give
	 * when it returns one — which wins over `results`, for a test whose call
	 * indexes depend on what an earlier step found.
	 */
	respond?: (request: RunProcessRequest) => Partial<RunProcessResult> | undefined;
}

export class FakeProcessRunner {
	readonly requests: RunProcessRequest[] = [];
	readonly hanging: FakeRunningProcess[] = [];
	cancelled = 0;

	constructor(private readonly options: FakeProcessOptions = {}) {}

	/** The value handed to whatever takes a `ProcessRunner`. */
	get runner(): ProcessRunner {
		return (request) => this.spawn(request);
	}

	private spawn(request: RunProcessRequest): RunningProcess {
		const index = this.requests.length;
		this.requests.push(request);

		const process = new FakeRunningProcess(request, () => this.cancelled++);

		if (this.options.hangFrom !== undefined && index >= this.options.hangFrom) {
			this.hanging.push(process);
			return process;
		}

		if (this.options.missingAt?.includes(index)) {
			process.rejectNow(
				new ProcessError('not-installed', `Could not run \`${request.executable}\`.`)
			);
		} else if (this.options.failAt?.includes(index)) {
			const stderr = this.options.stderr ?? 'it failed';
			process.rejectNow(
				new ProcessError('failed', stderr, { code: 1, stdout: '', stderr })
			);
		} else {
			const scripted =
				this.options.respond?.(request) ??
				this.options.results?.[Math.min(index, (this.options.results?.length ?? 1) - 1)];
			process.resolveNow({ code: 0, stdout: '', stderr: '', ...scripted });
		}
		return process;
	}
}

export class FakeRunningProcess implements RunningProcess {
	readonly completed: Promise<RunProcessResult>;
	/** What an `interactive` caller wrote, one entry per write. */
	readonly written: string[] = [];
	stdinEnded = false;
	readonly stdin?: ProcessStdin;

	private settle!: (result: RunProcessResult) => void;
	private fail!: (error: unknown) => void;
	private settled = false;

	constructor(
		private readonly request: RunProcessRequest,
		private readonly onCancel: () => void
	) {
		this.completed = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		// An unobserved rejection must not be noise in a test run.
		this.completed.catch(() => undefined);
		if (request.interactive) {
			this.stdin = {
				write: (text) => this.written.push(text),
				end: () => {
					this.stdinEnded = true;
				}
			};
		}
	}

	/** Streams the scripted output first, as a real child would, then settles. */
	resolveNow(result: RunProcessResult): void {
		if (!this.settled) {
			this.settled = true;
			this.emit(result);
			this.settle(result);
		}
	}

	/** What the child printed reaches `onOutput` before the result does. */
	emit(result: Pick<RunProcessResult, 'stdout' | 'stderr'>): void {
		if (result.stdout) {
			this.request.onOutput?.(result.stdout, 'stdout');
		}
		if (result.stderr) {
			this.request.onOutput?.(result.stderr, 'stderr');
		}
	}

	rejectNow(error: unknown): void {
		if (!this.settled) {
			this.settled = true;
			if (error instanceof ProcessError && error.result) {
				this.emit(error.result);
			}
			this.fail(error);
		}
	}

	cancel(reason = 'The operation was cancelled.'): void {
		if (this.settled) {
			return;
		}
		this.onCancel();
		this.rejectNow(new ProcessError('cancelled', reason));
	}
}
