// The batches: who is running, and the one rule both surfaces share.
//
// A batch is one `runTests` for one root ticket. Two surfaces start, stop and
// watch them — the sidebar's Run Tests and any open board's Tests tab — and
// "a test case belongs to at most one running batch" has to hold across both.
// That rule used to be a module-private `Set` in the `vscode` half, keyed on
// the root alone, which let a board re-run a test its story's batch was in the
// middle of; here it is a pure factory (the `sharedLimiter` shape — a Map, a
// listener Set, no class, no `dispose`) that `testBatches.test.ts` drives
// against a `FakeProcessRunner`.
//
// No `vscode` import. The channel lines, the notification and the toast are
// the command half's, fed by `onDidProgress`; the board's lanes are fed by the
// same events, and a board that opens mid-batch takes `snapshot`.

import { buildTree, collectTestCases, findNode } from '../data/ticketTree';
import { testsConfigured } from '../settings/testsSettings';
import {
	summarySentence,
	type TestBatchProgress,
	type TestBatchSnapshot,
	type TestLane,
	type TestLogLine,
	type TestRunSummary
} from './testReport';
import { runTests, type TestRunDeps } from './testRunner';
import { errorMessage } from '../platform/errors';

export type TestBatchStart =
	| { kind: 'started'; completed: Promise<TestRunSummary | undefined> }
	| {
			kind: 'refused';
			reason: 'unconfigured' | 'running' | 'overlap' | 'not-found';
			message: string;
	  };

export type TestBatchListener = (root: string, event: TestBatchProgress) => void;

export interface TestBatches {
	/**
	 * Starts a batch for `root`, or says why not. `completed` resolves to the
	 * summary — `undefined` when the runner threw — after the `done` event.
	 */
	start(root: string): Promise<TestBatchStart>;
	/** Safe before the first spawn (remembered and spent on the cancel handle) and after the end. */
	cancel(root: string): void;
	/** The root of the batch `id` is in — as its root, or as one of its test cases. */
	batchFor(id: string): string | undefined;
	/** Where a live batch has got to, for a surface that subscribed late. */
	snapshot(root: string): TestBatchSnapshot | undefined;
	/** Every event of every batch, tagged with its root. Returns the unsubscribe. */
	onDidProgress(listener: TestBatchListener): () => void;
}

export const UNCONFIGURED_MESSAGE = 'Set a test command in the BFAST settings before running tests.';

/** Most log lines a snapshot carries. A late subscriber wants the recent past, not all of it. */
const SNAPSHOT_LOG_LINES = 200;

interface Batch {
	root: string;
	testCases: Set<string>;
	lanes: Map<string, TestLane>;
	log: TestLogLine[];
	/** Output chunks are not line-oriented; whole lines are what a snapshot keeps. */
	partial: Map<string, string>;
	cancel?: () => void;
	/** Stop was pressed before the run was cancellable — see `GeneratePanel`. */
	stopRequested: boolean;
}

export function createTestBatches(deps: Omit<TestRunDeps, 'onProgress'>): TestBatches {
	const batches = new Map<string, Batch>();
	const listeners = new Set<TestBatchListener>();

	const emit = (root: string, event: TestBatchProgress): void => {
		for (const listener of listeners) {
			try {
				listener(root, event);
			} catch {
				// One surface's bug must not stop the batch or the other surfaces.
			}
		}
	};

	const flush = (batch: Batch, testCase: string | undefined): void => {
		const key = testCase ?? '';
		const rest = batch.partial.get(key);
		if (rest !== undefined && rest.length > 0) {
			batch.log.push({ ...(testCase ? { testCase } : {}), text: rest });
		}
		batch.partial.delete(key);
	};

	const track = (batch: Batch, event: TestBatchProgress): void => {
		switch (event.kind) {
			case 'scope':
				batch.testCases = new Set(event.testCases.map((ticket) => ticket.id));
				for (const ticket of event.testCases) {
					batch.lanes.set(ticket.id, { status: 'waiting' });
				}
				break;
			case 'started':
				batch.lanes.set(event.ticket.id, {
					status: 'running',
					line: event.line,
					startedAt: event.startedAt
				});
				break;
			case 'output': {
				const key = event.testCase ?? '';
				const lines = ((batch.partial.get(key) ?? '') + event.text).split('\n');
				batch.partial.set(key, lines.pop() ?? '');
				for (const line of lines) {
					if (line.trim().length > 0) {
						batch.log.push({ ...(event.testCase ? { testCase: event.testCase } : {}), text: line });
					}
				}
				if (batch.log.length > SNAPSHOT_LOG_LINES) {
					batch.log.splice(0, batch.log.length - SNAPSHOT_LOG_LINES);
				}
				break;
			}
			case 'result': {
				flush(batch, event.result.ticket.id);
				const lane = batch.lanes.get(event.result.ticket.id);
				batch.lanes.set(event.result.ticket.id, {
					...lane,
					status: event.result.outcome,
					...(event.result.message ? { note: event.result.message } : {})
				});
				break;
			}
			case 'done':
				for (const key of [...batch.partial.keys()]) {
					flush(batch, key === '' ? undefined : key);
				}
				break;
		}
	};

	const run = async (batch: Batch): Promise<TestRunSummary | undefined> => {
		let summary: TestRunSummary | undefined;
		let message: string;
		try {
			summary = await runTests(
				{
					...deps,
					onProgress: (event) => {
						track(batch, event);
						emit(batch.root, event);
					}
				},
				batch.root,
				{
					onCancel: (cancel) => {
						batch.cancel = cancel;
						// The press can land before the run reaches its first
						// cancellable step; it is remembered and spent here.
						if (batch.stopRequested) {
							cancel();
						}
					}
				}
			);
			message = summarySentence(batch.root, summary);
		} catch (error) {
			// A rejection is a programming error, and still ends the batch: a
			// surface showing Stop must be told, or it shows one for ever — and the
			// runs the fan-out still had queued or live must not go on unwatched.
			batch.cancel?.();
			message = errorMessage(error, 'The test run failed unexpectedly.');
		}
		// Gone before `done` goes out, so a listener asking `batchFor` hears no.
		batches.delete(batch.root);
		const done: TestBatchProgress = { kind: 'done', message, ...(summary ? { summary } : {}) };
		track(batch, done);
		emit(batch.root, done);
		return summary;
	};

	return {
		async start(root) {
			if (!testsConfigured(deps.settings())) {
				return { kind: 'refused', reason: 'unconfigured', message: UNCONFIGURED_MESSAGE };
			}
			if (batches.has(root)) {
				return {
					kind: 'refused',
					reason: 'running',
					message: `BFAST is already running tests for ${root}. Wait for that to finish.`
				};
			}

			// Claimed before the first await, so two presses cannot both pass.
			const batch: Batch = {
				root,
				testCases: new Set(),
				lanes: new Map(),
				log: [],
				partial: new Map(),
				stopRequested: false
			};
			batches.set(root, batch);

			try {
				// The overlap check reads the tree the runner will read: comparing
				// collected ids is the only legal way, since a ticket's ancestry comes
				// from its nesting and may never be inferred from its id.
				const node = findNode(buildTree(await deps.store.listSummaries()), root);
				if (!node) {
					batches.delete(root);
					return {
						kind: 'refused',
						reason: 'not-found',
						message: `Ticket ${root} is no longer in the tracker folder.`
					};
				}
				const ids = collectTestCases(node).map((ticket) => ticket.id);
				for (const other of batches.values()) {
					if (other === batch) {
						continue;
					}
					const shared = ids.find((id) => other.testCases.has(id));
					if (shared !== undefined) {
						batches.delete(root);
						return {
							kind: 'refused',
							reason: 'overlap',
							message: `${shared} is already running as part of ${other.root}.`
						};
					}
				}
				batch.testCases = new Set(ids);
			} catch (error) {
				batches.delete(root);
				return {
					kind: 'refused',
					reason: 'not-found',
					message: errorMessage(error)
				};
			}

			return { kind: 'started', completed: run(batch) };
		},

		cancel(root) {
			const batch = batches.get(root);
			if (!batch) {
				return;
			}
			batch.stopRequested = true;
			batch.cancel?.();
		},

		batchFor(id) {
			if (batches.has(id)) {
				return id;
			}
			for (const batch of batches.values()) {
				if (batch.testCases.has(id)) {
					return batch.root;
				}
			}
			return undefined;
		},

		snapshot(root) {
			const batch = batches.get(root);
			if (!batch) {
				return undefined;
			}
			return {
				root,
				lanes: Object.fromEntries(batch.lanes),
				log: [...batch.log]
			};
		},

		onDidProgress(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
}
