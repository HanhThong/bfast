// A scripted `EnvironmentProvider` — the seam's proof, exactly as
// `fakeAiProvider.ts` is for `AiProvider`: if satisfying the interface ever
// needed a cast, a `vscode` import or any knowledge of docker, the seam would
// be in the wrong place.

import {
	EnvironmentCancelledError,
	EnvironmentError,
	type EnvironmentAvailability,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentOperation,
	type EnvironmentProgressListener,
	type EnvironmentProvider,
	type StackStatus
} from '../environments/environmentProvider';

export interface FakeEnvironmentOptions {
	/** What `statuses` answers per environment id; absent ids answer `'stopped'`. */
	statuses?: Record<string, StackStatus>;
	/** Operation indexes (0-based, counting start/stop/destroy calls) that fail. */
	failAt?: number[];
	/** From this operation index on, operations hang until settled by hand. */
	hangFrom?: number;
	availability?: EnvironmentAvailability;
	/** What `containers` answers per environment id; absent ids answer `[]`. */
	containers?: Record<string, EnvironmentContainer[]>;
	/** Ids whose `containers` rejects, the way an unreachable backend does. */
	containersFail?: Record<string, string>;
}

/** A live `logs()` follow, for a test to feed lines into and then end. */
export interface FakeLogRun {
	readonly env: EnvironmentDescriptor;
	readonly container: EnvironmentContainer;
	readonly tail: number;
	readonly operation: FakeOperation;
	/** Pushes raw output to whoever is following. */
	emit(text: string, channel?: 'stdout' | 'stderr'): void;
}

interface OperationRecord {
	kind: 'start' | 'stop' | 'destroy' | 'reclaim';
	env: EnvironmentDescriptor;
}

export class FakeEnvironmentProvider implements EnvironmentProvider {
	readonly id = 'docker-compose' as const;
	readonly label = 'Fake';

	/** Every start/stop/destroy, in order. */
	readonly operations: OperationRecord[] = [];
	/** Every `logs()` call, in order — each one still open until the test ends it. */
	readonly logRuns: FakeLogRun[] = [];
	readonly hanging: FakeOperation[] = [];
	cancelled = 0;
	disposed = false;

	constructor(private readonly options: FakeEnvironmentOptions = {}) {}

	availability(): Promise<EnvironmentAvailability> {
		return Promise.resolve(this.options.availability ?? { ok: true });
	}

	start(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation('start', env, onProgress);
	}

	stop(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation('stop', env, onProgress);
	}

	destroy(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation('destroy', env, onProgress);
	}

	reclaim(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation('reclaim', env, onProgress);
	}

	statuses(envs: readonly EnvironmentDescriptor[]): Promise<ReadonlyMap<string, StackStatus>> {
		return Promise.resolve(
			new Map(envs.map((env) => [env.id, this.options.statuses?.[env.id] ?? 'stopped']))
		);
	}

	containers(env: EnvironmentDescriptor): Promise<EnvironmentContainer[]> {
		const failure = this.options.containersFail?.[env.id];
		return failure === undefined
			? Promise.resolve(this.options.containers?.[env.id] ?? [])
			: Promise.reject(new EnvironmentError('provider-error', failure));
	}

	/**
	 * Hands back an operation that never settles by itself — a follow ends when
	 * the container goes or the caller cancels, so a test drives both ends.
	 */
	logs(
		env: EnvironmentDescriptor,
		container: EnvironmentContainer,
		options: { tail: number },
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		const operation = new FakeOperation(() => this.cancelled++);
		this.logRuns.push({
			env,
			container,
			tail: options.tail,
			operation,
			emit: (text, channel = 'stdout') => onProgress?.({ kind: 'output', text, channel })
		});
		return operation;
	}

	dispose(): void {
		this.disposed = true;
		for (const operation of [...this.hanging, ...this.logRuns.map((run) => run.operation)]) {
			operation.cancel('disposed');
		}
	}

	private operation(
		kind: OperationRecord['kind'],
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		const index = this.operations.length;
		this.operations.push({ kind, env });
		onProgress?.({ kind: 'phase', label: `${kind} ${env.id}` });

		const operation = new FakeOperation(() => this.cancelled++);
		if (this.options.hangFrom !== undefined && index >= this.options.hangFrom) {
			this.hanging.push(operation);
		} else if (this.options.failAt?.includes(index)) {
			operation.rejectNow(new EnvironmentError('provider-error', `${kind} failed`));
		} else {
			operation.resolveNow();
		}
		return operation;
	}
}

export class FakeOperation implements EnvironmentOperation {
	readonly completed: Promise<void>;

	private settle!: () => void;
	private fail!: (error: unknown) => void;
	private settled = false;

	constructor(private readonly onCancel: () => void = () => undefined) {
		this.completed = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		this.completed.catch(() => undefined);
	}

	resolveNow(): void {
		if (!this.settled) {
			this.settled = true;
			this.settle();
		}
	}

	rejectNow(error: unknown): void {
		if (!this.settled) {
			this.settled = true;
			this.fail(error);
		}
	}

	cancel(reason = 'The operation was cancelled.'): void {
		if (this.settled) {
			return;
		}
		this.onCancel();
		this.rejectNow(new EnvironmentCancelledError(reason));
	}
}
