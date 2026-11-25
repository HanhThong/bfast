// A scripted `ScanProvider` — the seam's proof, exactly as
// `fakeEnvironmentProvider.ts` is for `EnvironmentProvider` and
// `fakeAiProvider.ts` for `AiProvider`: if satisfying the interface ever needed
// a cast, a `vscode` import, or any knowledge of docker or `fetch`, the seam
// would be in the wrong place.
//
// A script, not a mock framework. It records every operation in order and
// answers by call index, and `hangFrom` is the only way to exercise a cancel
// that lands mid-operation — or, with the store's queue, one that lands on an
// operation still waiting its turn.

import type { ScanReport } from '../scan/scanReport';
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
} from '../scan/scanProvider';

/** An empty-but-valid report, so a test that does not care can ignore the shape. */
export const EMPTY_REPORT: ScanReport = {
	gate: 'ok',
	conditions: [],
	measures: [],
	issues: [],
	truncated: false
};

export interface FakeScanOptions {
	/**
	 * Forces what `health` answers. Absent means the fake tracks it: `down`
	 * until `start` has run, `up` after — which is what makes `ready()``s
	 * "deploy, then start, then provision" order observable at all.
	 */
	health?: ServerHealth;
	/** What `endpoint` answers; absent means a plain localhost one. */
	endpoint?: ScanEndpoint;
	/** What `provision` returns. */
	credentials?: ScanCredentials;
	/**
	 * Reports by `scan` call index; the last one repeats. A run and a re-run are
	 * different answers, so one fixed report cannot exercise both.
	 */
	reports?: ScanReport[];
	/** Operation indexes (0-based, across every kind) that fail. */
	failAt?: number[];
	/** From this operation index on, operations hang until settled by hand. */
	hangFrom?: number;
	availability?: ScanAvailability;
	/** Set to omit `server` entirely — a scanner-only tool. */
	scannerOnly?: boolean;
	/**
	 * What `readProjectIdentity` answers, by directory. Absent means the method
	 * is omitted entirely — the tool has no properties file to read.
	 */
	identity?: (directory: string) => ScanProjectIdentity | undefined;
}

export type FakeScanOperationKind =
	| 'create'
	| 'start'
	| 'stop'
	| 'destroy'
	| 'provision'
	| 'scan';

export interface FakeScanOperationRecord {
	kind: FakeScanOperationKind;
	server?: ScanServerDescriptor;
	request?: ScanRequest;
}

export class FakeScanProvider implements ScanProvider {
	readonly id = 'sonarqube' as const;
	readonly label = 'Fake SonarQube';

	/** Every operation, in order — what a lifecycle test asserts on. */
	readonly operations: FakeScanOperationRecord[] = [];
	readonly hanging: FakeScanOperation<unknown>[] = [];
	cancelled = 0;
	disposed = false;

	readonly server?: ScanServerLifecycle;
	readonly readProjectIdentity?: (directory: string) => Promise<ScanProjectIdentity | undefined>;

	private scanCalls = 0;
	/** Whether `start` has run more recently than `stop` or `destroy`. */
	private started = false;

	constructor(private readonly options: FakeScanOptions = {}) {
		if (options.identity) {
			const identity = options.identity;
			this.readProjectIdentity = (directory) => Promise.resolve(identity(directory));
		}
		if (!options.scannerOnly) {
			this.server = {
				availability: () => this.availability(),
				create: (server, onProgress) => this.operation('create', onProgress, { server }),
				start: (server, onProgress) => {
					this.started = true;
					return this.operation('start', onProgress, { server });
				},
				stop: (server, onProgress) => {
					this.started = false;
					return this.operation('stop', onProgress, { server });
				},
				destroy: (server, onProgress) => {
					this.started = false;
					return this.operation('destroy', onProgress, { server });
				},
				provision: (server, onProgress) =>
					this.operation<ScanCredentials>('provision', onProgress, { server }, () =>
						this.options.credentials ?? { analysisToken: 'fake-analysis', resultsToken: 'fake-results' }
					),
				health: () =>
					Promise.resolve(this.options.health ?? (this.started ? 'up' : 'down')),
				endpoint: (server) =>
					this.options.endpoint ?? {
						url: `http://localhost:${server.port ?? 9000}`,
						containerUrl: 'http://sonarqube:9000',
						network: `${server.projectName}_default`
					}
			};
		}
	}

	availability(): Promise<ScanAvailability> {
		return Promise.resolve(this.options.availability ?? { ok: true });
	}

	scan(request: ScanRequest, onProgress?: ScanProgressListener): ScanOperation<ScanReport> {
		const index = this.scanCalls++;
		return this.operation<ScanReport>('scan', onProgress, { request }, () => {
			const reports = this.options.reports ?? [];
			return reports[Math.min(index, reports.length - 1)] ?? EMPTY_REPORT;
		});
	}

	dispose(): void {
		this.disposed = true;
		for (const operation of [...this.hanging]) {
			operation.cancel('disposed');
		}
	}

	private operation<T>(
		kind: FakeScanOperationKind,
		onProgress: ScanProgressListener | undefined,
		record: Omit<FakeScanOperationRecord, 'kind'>,
		value?: () => T
	): ScanOperation<T> {
		const index = this.operations.length;
		this.operations.push({ kind, ...record });
		onProgress?.({ kind: 'phase', label: kind });

		const operation = new FakeScanOperation<T>(() => this.cancelled++);
		if (this.options.hangFrom !== undefined && index >= this.options.hangFrom) {
			this.hanging.push(operation as FakeScanOperation<unknown>);
		} else if (this.options.failAt?.includes(index)) {
			operation.rejectNow(new ScanError('server-error', `${kind} failed`));
		} else {
			operation.resolveNow((value?.() ?? undefined) as T);
		}
		return operation;
	}
}

export class FakeScanOperation<T> implements ScanOperation<T> {
	readonly completed: Promise<T>;

	private settle!: (value: T) => void;
	private fail!: (error: unknown) => void;
	private settled = false;

	constructor(private readonly onCancel: () => void = () => undefined) {
		this.completed = new Promise<T>((resolve, reject) => {
			this.settle = resolve;
			this.fail = reject;
		});
		// An unobserved rejection must not be noise in a test run.
		this.completed.catch(() => undefined);
	}

	resolveNow(value: T): void {
		if (!this.settled) {
			this.settled = true;
			this.settle(value);
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
		this.rejectNow(new ScanCancelledError(reason));
	}
}
