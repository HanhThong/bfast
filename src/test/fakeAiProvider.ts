// A test-only `AiProvider`.
//
// Lives under `src/test/` for the same reason `mockTicketStore.ts` does: only
// tests use it. It is also the proof that the seam is in the right place — if
// satisfying `AiProvider` needed a cast, a `vscode` import, or any knowledge of
// prompt templates, the interface would be wrong.
//
// `hang` is the interesting mode: a run that never settles until the test says
// so is how cancel, panel-disposed-mid-run and a late result are tested at all.

import {
	AiCancelledError,
	AiError,
	type AiAvailability,
	type AiProgress,
	type AiProgressListener,
	type AiProvider,
	type AiRequest,
	type AiResult,
	type AiRun
} from '../ai/aiProvider';

export interface FakeAiOptions {
	/** What a run resolves with, unless `hang` or `failWith` says otherwise. */
	answer?: string;
	/**
	 * Successive runs take these in order; past the end, `answer` is reused.
	 *
	 * A two-pass breakdown asks for a list and then for one description per
	 * title, so a single fixed answer cannot exercise it at all.
	 */
	answers?: string[];
	failWith?: AiError;
	/** Leave the run unsettled until `resolveNow` / `rejectNow` / `cancel`. */
	hang?: boolean;
	/**
	 * The first run that hangs, counting from zero. Lets a test resolve pass 1
	 * and then hold pass 2 open, which is the shape a mid-batch cancel needs.
	 */
	hangFrom?: number;
	/** The runs that fail, by index — the rest answer normally. */
	failAt?: number[];
	/** The runs that hang, by index — the rest answer normally. */
	hangAt?: number[];
	availability?: AiAvailability;
	/** Emitted in order before the run settles. */
	progress?: AiProgress[];
	meta?: AiResult['meta'];
	/**
	 * Successive runs report these in order; past the end, `meta` is reused.
	 *
	 * A resumed plan needs run 0 to hand back a session and pass 2 to hand back
	 * none, which one `meta` shared by every run cannot say.
	 */
	metas?: AiResult['meta'][];
}

export class FakeAiProvider implements AiProvider {
	readonly id = 'fake';
	readonly label = 'Fake assistant';

	/** Every request that reached the provider, in order. */
	readonly requests: AiRequest[] = [];

	/** How many times `dispose()` cancelled a live run. */
	cancelled = 0;

	private readonly live = new Set<FakeRun>();

	constructor(private readonly options: FakeAiOptions = {}) {}

	availability(): Promise<AiAvailability> {
		return Promise.resolve(this.options.availability ?? { ok: true });
	}

	run(request: AiRequest, onProgress?: AiProgressListener): AiRun {
		// Pushed first, so the index is this run's own.
		const index = this.requests.push(request) - 1;

		const run = new FakeRun(`fake-${this.requests.length}`, () => {
			this.live.delete(run);
		});
		this.live.add(run);

		for (const progress of this.options.progress ?? []) {
			onProgress?.(progress);
		}

		const hangs =
			this.options.hang === true ||
			(this.options.hangFrom !== undefined && index >= this.options.hangFrom) ||
			(this.options.hangAt?.includes(index) ?? false);

		if (!hangs) {
			const fails = this.options.failWith && (this.options.failAt?.includes(index) ?? true);
			if (fails) {
				run.rejectNow(this.options.failWith);
			} else {
				run.resolveNow(this.answerFor(index), this.options.metas?.[index] ?? this.options.meta);
			}
		}

		return run;
	}

	/** `answers[index]`, falling back to `answer` once the script runs out. */
	private answerFor(index: number): string {
		return (
			this.options.answers?.[index] ?? this.options.answer ?? 'Generated description.'
		);
	}

	dispose(): void {
		for (const run of [...this.live]) {
			this.cancelled += 1;
			run.cancel('the extension was shut down');
		}
	}

	/** The single live run, for a test that needs to settle it by hand. */
	get pending(): FakeRun | undefined {
		return [...this.live][0];
	}

	/** Every live run, oldest first, for a test that settles several by hand. */
	get running(): FakeRun[] {
		return [...this.live];
	}
}

export class FakeRun implements AiRun {
	readonly completed: Promise<AiResult>;

	private settle!: (result: AiResult) => void;
	private fail!: (error: unknown) => void;
	private done = false;

	constructor(
		readonly runId: string,
		private readonly onSettled: () => void
	) {
		this.completed = new Promise<AiResult>((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		// Nothing else attaches a handler until the test awaits it, and an
		// unobserved rejection is noise rather than a failure.
		this.completed.catch(() => undefined);
	}

	resolveNow(text: string, meta?: AiResult['meta']): void {
		if (this.finish()) {
			this.settle({ text, meta });
		}
	}

	rejectNow(error: unknown): void {
		if (this.finish()) {
			this.fail(error);
		}
	}

	cancel(reason = 'The run was cancelled.'): void {
		if (this.finish()) {
			this.fail(new AiCancelledError(reason));
		}
	}

	private finish(): boolean {
		if (this.done) {
			return false;
		}
		this.done = true;
		this.onSettled();
		return true;
	}
}
