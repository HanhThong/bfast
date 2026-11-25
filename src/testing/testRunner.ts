// The pure half of "Run Tests" — see docs/tests/ for the contract this
// implements. `src/testing/testCommands.ts` is the `vscode` half, and
// `testBatches.ts` the seam between them that owns "one batch per test case".
//
// No `vscode` import: everything the run needs is injected (the ticket store,
// the results store, the process runner, a settings accessor, the evidence
// finder), which is what lets
// `testRunner.test.ts` drive the whole flow against a `FakeProcessRunner` and a
// scratch tracker — the same posture as `environmentStore.ts` and
// `ai/generateChildren.ts`. The types every surface reads live in
// `testReport.ts`, which is bundled into the webview and must not import this
// file back.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
	ProcessError,
	runProcess,
	type ProcessRunner,
	type RunningProcess
} from '../platform/runProcess';
import { TrackerNotConfiguredError, type WritableTicketStore } from '../data/ticketStore';
import { buildTree, collectTestCases, findNode } from '../data/ticketTree';
import type { TestRunRecord, TicketStatus, TicketSummary } from '../data/types';
import { sharedLimiter, type SharedLimiter } from '../platform/semaphore';
import { shellCommand } from '../platform/shellCommand';
import {
	substituteCommand,
	testsCommand,
	testsConcurrency,
	testsCwd,
	testsEvidence,
	testsIdleTimeoutMs,
	type TestsSettings
} from '../settings/testsSettings';
import { findService, serviceLabel, type TestService } from '../settings/testServices';
import { findEvidence as findEvidenceOnDisk, type EvidenceFinder } from './evidenceGlob';
import { OutputTail, stripAnsi } from './outputTail';
import type { TestResultsStore } from './testResultsStore';
import type { NewTestRun } from './testRunFile';
import {
	EVIDENCE_MTIME_TOLERANCE_MS,
	formatBytes,
	MAX_EVIDENCE_FILE_BYTES,
	MAX_EVIDENCE_FILES,
	MAX_RUN_LOG_CHARS,
	testRunComment,
	type TestCaseResult,
	type TestRunProgress,
	type TestRunSummary
} from './testReport';
import { errorMessage } from '../platform/errors';

// The runner's vocabulary lives in `testReport.ts`; re-exported so the host
// half keeps importing it from the module that produces it.
export type {
	TestCaseResult,
	TestOutcome,
	TestRunProgress,
	TestRunSummary
} from './testReport';

export interface TestRunDeps {
	store: WritableTicketStore;
	/** Where every run is filed — outside the tracker; see `testResultsStore.ts`. */
	results: TestResultsStore;
	/** Injection seam; defaults to `runProcess`. */
	runner?: ProcessRunner;
	/**
	 * Read once per batch — a save mid-run does not change a running batch's
	 * command, pattern or timeout. `concurrency` is the exception, read through
	 * `slots` as each slot is taken: it is a window-wide cap, and a cap two
	 * batches disagreed about would not be a cap.
	 */
	settings: () => TestsSettings | undefined;
	/** Where a relative `tests.cwd` resolves from; `undefined` refuses the run. */
	workspaceRoot: () => string | undefined;
	/**
	 * The window's test slots, shared by every Run Tests batch. Absent — a test
	 * driving the runner directly — means a private cap for that batch alone.
	 */
	slots?: SharedLimiter;
	/** What `tests.evidence` matched under `cwd`. Defaults to the walker; a test scripts one. */
	findEvidence?: EvidenceFinder;
	onProgress?: (progress: TestRunProgress) => void;
	/**
	 * The master environment's stack variables (its port variables,
	 * `BFAST_PROJECT_NAME`) when one exists — added to every test command's
	 * environment, so a test finds `ORDERS_PORT` without hard-coding it.
	 * Absent, or answering `undefined`, means the process environment alone.
	 */
	stackEnvironment?: () => Promise<Record<string, string> | undefined>;
	/**
	 * Brings compose services up in the master environment before a service's
	 * test cases run — once per service per batch. Rejects with a sentence the
	 * service's test cases are recorded with. Absent means no service with
	 * `e2e.compose` can run here. docs/tests/services.md §Bringing compose services up.
	 */
	composeUp?: (services: readonly string[], run: ServiceStackRun) => Promise<void>;
}

/** What a compose bring-up is handed: where its output goes, and how a Stop reaches it. */
export interface ServiceStackRun {
	onOutput: (text: string) => void;
	onCancel: (cancel: () => void) => void;
}

/** How one test case runs: which line, where — or why it cannot. */
type TestCaseRoute =
	| { template: string; cwd: string; service?: TestService }
	| { error: string };

/** The `ai/generateChildren.RunHooks` shape: no `CancellationToken` in here. */
export interface TestRunHooks {
	onCancel?: (cancel: () => void) => void;
}

/**
 * Output retained per channel by the process runner for its own error
 * summary. The run's `output.log` is the runner's own interleaved tail
 * (`OutputTail`) — a `timeout` or a cancel carries no result object to read.
 */
const MAX_RETAINED_OUTPUT = 10_000;

/**
 * Runs the configured command once per test case in `ticketId`'s subtree,
 * files each run's evidence and records each outcome on its ticket — the
 * contract docs/tests/README.md pins.
 *
 * The caller checks `testsCommand` first (it owns the "open settings" answer),
 * so an unconfigured command here is a programming error, not a user state.
 */
export async function runTests(
	deps: TestRunDeps,
	ticketId: string,
	hooks?: TestRunHooks
): Promise<TestRunSummary> {
	// Snapshotted once: a batch runs to the settings it started with.
	const settings = deps.settings();
	// May be unset when every test case in scope runs as a service; a project
	// test case is then recorded as an error rather than run with nothing.
	const template = testsCommand(settings);
	const evidencePattern = testsEvidence(settings);

	let cancelled = false;
	let abortedWith: TestRunSummary['abortedWith'];
	const live = new Set<RunningProcess>();
	/** A compose bring-up in flight, before any test case runs — Stop reaches it too. */
	let stackCancel: (() => void) | undefined;
	// Handed out before anything spawns: the × can land first, and cancelling an
	// empty set is safe — the flag is what the queued runs read.
	const stop = (): void => {
		cancelled = true;
		stackCancel?.();
		for (const run of live) {
			run.cancel('The test run was cancelled.');
		}
	};
	hooks?.onCancel?.(stop);

	const summary = (results: TestCaseResult[]): TestRunSummary => ({
		results,
		passed: results.filter((result) => result.outcome === 'passed').length,
		failed: results.filter((result) => result.outcome === 'failed' || result.outcome === 'timeout')
			.length,
		errors: results.filter((result) => result.outcome === 'error').length,
		// Only when the press cut something short: a Stop that lands after the last
		// command exited records that run normally and cancelled nothing.
		cancelled:
			cancelled &&
			results.some((result) => result.outcome === 'cancelled' || result.outcome === 'skipped'),
		...(abortedWith ? { abortedWith } : {})
	});

	const root = deps.workspaceRoot();
	if (root === undefined) {
		abortedWith = { code: 'bad-cwd', message: 'Open a workspace folder to run tests.' };
		return summary([]);
	}
	const relativeCwd = testsCwd(settings);
	const cwd = relativeCwd === undefined ? root : path.join(root, relativeCwd);
	// Checked here because `spawn` reports a missing cwd as ENOENT on the
	// executable, which would be misdiagnosed as "cmd.exe is not installed".
	if (!(await isDirectory(cwd))) {
		abortedWith = {
			code: 'bad-cwd',
			message: `The tests working directory \`${relativeCwd ?? cwd}\` does not exist in this workspace.`
		};
		return summary([]);
	}

	// Fresh from disk, never the sidebar's cache — the house rule for commands.
	const node = findNode(buildTree(await deps.store.listSummaries()), ticketId);
	if (node === undefined) {
		abortedWith = {
			code: 'not-found',
			message: `Ticket ${ticketId} is no longer in the tracker folder.`
		};
		return summary([]);
	}

	const testCases = collectTestCases(node);
	// Every lane up front, so a surface can paint them as waiting: with a
	// concurrency of one and eight test cases, seven have not started, and a row
	// that simply is not there yet reads as one that was dropped.
	deps.onProgress?.({ kind: 'scope', testCases });
	if (testCases.length === 0) {
		return summary([]);
	}

	const concurrency = Math.max(1, testsConcurrency(settings));
	if (evidencePattern !== undefined && concurrency > 1) {
		// A warning, never a refusal — the `unknownPlaceholders` posture. BFAST
		// cannot tell whether the tool clears its folder; the user can.
		deps.onProgress?.({
			kind: 'output',
			text:
				`⚠ tests.evidence is set and tests.concurrency is ${concurrency}: a test tool that ` +
				'clears its output folder when a run starts will lose evidence when two runs overlap.\n'
		});
	}

	/**
	 * Where each test case runs — `docs/tests/services.md` §Assigning a test case
	 * to a service. Never a silent fallback: a test case naming a service that
	 * cannot run it is an error, not a run of the project command.
	 */
	const routeFor = (ticket: TicketSummary): TestCaseRoute => {
		if (ticket.service === undefined) {
			return template === undefined
				? { error: `${ticket.id} has no service and no test command is set in the BFAST settings.` }
				: { template, cwd };
		}
		const service = findService(settings, ticket.service);
		if (service === undefined) {
			return {
				error: `${ticket.id} is assigned to “${ticket.service}”, which is not a service in the Tests settings.`
			};
		}
		if (service.e2e?.testCommand === undefined) {
			return {
				error: `${ticket.id} is assigned to “${serviceLabel(service)}”, which has no e2e test case command.`
			};
		}
		return { template: service.e2e.testCommand, cwd: path.join(root, service.folder), service };
	};

	// Every service the scope reaches, readied once before anything runs: its
	// folder checked, its compose services brought up. A failure is the
	// service's, recorded on each of its test cases — the others still run.
	const serviceFailure = new Map<string, string>();
	const readied = new Set<string>();
	for (const ticket of testCases) {
		const route = routeFor(ticket);
		if ('error' in route || route.service === undefined || readied.has(route.service.id)) {
			continue;
		}
		const service = route.service;
		readied.add(service.id);
		if (cancelled) {
			break;
		}
		if (!(await isDirectory(route.cwd))) {
			serviceFailure.set(
				service.id,
				`The folder \`${service.folder}\` of service “${serviceLabel(service)}” does not exist in this workspace.`
			);
			continue;
		}
		const compose = service.e2e?.compose ?? [];
		if (compose.length === 0) {
			continue;
		}
		if (deps.composeUp === undefined) {
			serviceFailure.set(
				service.id,
				`Service “${serviceLabel(service)}” needs compose services up, and BFAST cannot start them here.`
			);
			continue;
		}
		deps.onProgress?.({
			kind: 'output',
			text: `— Bringing up ${compose.join(', ')} for ${serviceLabel(service)} in the Master environment\n`
		});
		try {
			await deps.composeUp(compose, {
				onOutput: (text) => deps.onProgress?.({ kind: 'output', text: stripAnsi(text) }),
				onCancel: (cancel) => {
					stackCancel = cancel;
				}
			});
		} catch (error) {
			serviceFailure.set(
				service.id,
				`The compose services of “${serviceLabel(service)}” did not come up: ${errorMessage(error)}`
			);
		} finally {
			stackCancel = undefined;
		}
	}

	// Read once per batch, like every other setting: the master environment's
	// ports do not move while its stack is up.
	let stackEnv: Record<string, string> | undefined;
	try {
		stackEnv = await deps.stackEnvironment?.();
	} catch {
		stackEnv = undefined;
	}

	const runner = deps.runner ?? runProcess;
	const findEvidence = deps.findEvidence ?? findEvidenceOnDisk;
	const idleTimeoutMs = testsIdleTimeoutMs(settings);
	const idleSeconds = Math.round(idleTimeoutMs / 1000);

	/** The evidence files this run may claim, and what it could not. */
	const collectEvidence = async (
		ticket: TicketSummary,
		startedAt: string
	): Promise<{ pattern?: string; files: string[]; warnings: string[] }> => {
		if (evidencePattern === undefined) {
			return { files: [], warnings: [] };
		}
		// `{{id}}` and `{{key}}` only: `{{folder}}` is absolute and the walker
		// refuses an absolute pattern.
		const pattern = substituteCommand(evidencePattern, { id: ticket.id, key: ticket.key });
		const files: string[] = [];
		const warnings: string[] = [];
		try {
			const search = await findEvidence(cwd, pattern);
			const notBefore = Date.parse(startedAt) - EVIDENCE_MTIME_TOLERANCE_MS;
			let older = 0;
			for (const match of search.matches) {
				// A tool that fails before it clears its own folder leaves the previous
				// run's files behind; a match older than this run is not this run's.
				if (match.mtimeMs < notBefore) {
					older++;
					continue;
				}
				if (match.size > MAX_EVIDENCE_FILE_BYTES) {
					warnings.push(
						`${path.relative(cwd, match.path)} is ${formatBytes(match.size)}, over the ` +
							`${formatBytes(MAX_EVIDENCE_FILE_BYTES)} cap, and was not copied.`
					);
					continue;
				}
				files.push(match.path);
			}
			if (older > 0) {
				warnings.push(
					`${older} older ${older === 1 ? 'file' : 'files'} ignored: written before this run started.`
				);
			}
			if (search.truncated) {
				warnings.push(
					`More than ${MAX_EVIDENCE_FILES} files matched; only the first ${MAX_EVIDENCE_FILES} were copied.`
				);
			}
		} catch (error) {
			warnings.push(
				`Evidence could not be searched: ${errorMessage(error)}`
			);
		}
		return { pattern, files, warnings };
	};

	/**
	 * Files the run in the results store and, when the verdict moves the
	 * ticket, writes the status — the two writes a recorded outcome can end in.
	 * The record may fail without losing the status; the status may fail
	 * without losing the batch, unless the tracker itself is gone. Never
	 * rejects: the fan-out's contract is a tagged outcome.
	 */
	const record = async (
		ticket: TicketSummary,
		outcome: 'passed' | 'failed' | 'timeout',
		line: string,
		exitCode: number | null | undefined,
		startedAt: string,
		tail: OutputTail
	): Promise<TestCaseResult> => {
		const finishedAt = new Date().toISOString();
		const evidence = await collectEvidence(ticket, startedAt);

		let run: TestRunRecord | undefined;
		let recordError: string | undefined;
		try {
			const request: NewTestRun = {
				startedAt,
				finishedAt,
				outcome,
				exitCode,
				command: line,
				output: tail.text,
				...(tail.truncated ? { outputTruncated: true } : {}),
				...(evidence.pattern !== undefined ? { evidencePattern: evidence.pattern } : {}),
				files: evidence.files,
				...(evidence.warnings.length > 0 ? { warnings: evidence.warnings } : {})
			};
			run = await deps.results.addRun(ticket.id, request);
		} catch (error) {
			recordError = errorMessage(error);
		}

		const target: TicketStatus = outcome === 'passed' ? 'done' : 'blocked';
		try {
			// Against the status on disk now, not the one the scope snapshotted: a
			// long batch is time enough for someone to move it by hand.
			const current = (await deps.store.getDetail(ticket.id))?.status ?? ticket.status;
			if (current !== target) {
				// The one thing a run writes into the tracker: a status it changed,
				// with the run named so the two histories can be joined by hand. The
				// same verdict again touches the ticket not at all — no entry, no
				// `updatedAt` bump — because the run folder is its record, and
				// `history.md` is the ticket's history, not the test log.
				await deps.store.updateStatus(ticket.id, target, {
					comment: testRunComment({ line, outcome, exitCode, idleSeconds, run, recordError })
				});
			}
		} catch (error) {
			if (error instanceof TrackerNotConfiguredError) {
				// Every remaining write would fail the same way: a broken tracker is
				// batch-ending, where one unwritable ticket is not.
				abortedWith ??= { code: 'not-found', message: error.message };
			}
			return {
				ticket,
				outcome: 'error',
				exitCode,
				startedAt,
				...(run ? { run } : {}),
				message: errorMessage(error)
			};
		}

		const warnings = run?.warnings ?? [];
		const message = recordError
			? `evidence could not be recorded: ${recordError}`
			: warnings.length > 0
				? `evidence: ${warnings.join(' ')}`
				: undefined;
		return {
			ticket,
			outcome,
			exitCode,
			startedAt,
			...(run ? { run } : {}),
			...(message ? { message } : {})
		};
	};

	const runOne = async (ticket: TicketSummary): Promise<TestCaseResult> => {
		if (cancelled || abortedWith) {
			return { ticket, outcome: 'skipped' };
		}

		const route = routeFor(ticket);
		if ('error' in route) {
			return { ticket, outcome: 'error', message: route.error };
		}
		const failure = route.service && serviceFailure.get(route.service.id);
		if (failure) {
			return { ticket, outcome: 'error', message: failure };
		}
		const vars: Record<string, string> = { id: ticket.id, key: ticket.key };
		if (route.template.includes('{{folder}}')) {
			// Guarded like the run itself: the fan-out's contract is a tagged
			// outcome, never a rejection, and this is the one other await in here.
			let folder: { fsPath: string } | undefined;
			try {
				folder = await deps.store.folderUri?.(ticket.id);
			} catch (error) {
				return {
					ticket,
					outcome: 'error',
					message: errorMessage(error)
				};
			}
			if (folder === undefined) {
				// Substituting '' into a shell line is worse than not running it.
				return {
					ticket,
					outcome: 'error',
					message: `The store cannot resolve {{folder}} for ${ticket.id}.`
				};
			}
			vars.folder = folder.fsPath;
			// The × can land during that await, when this run is not yet in `live`
			// for the cancel loop to reach — so the flag is read again before the
			// spawn, or a cancelled batch would still start (and record) this one.
			if (cancelled || abortedWith) {
				return { ticket, outcome: 'skipped' };
			}
		}

		const line = substituteCommand(route.template, vars);
		const startedAt = new Date().toISOString();
		deps.onProgress?.({ kind: 'started', ticket, line, startedAt });

		// The run's own interleaved tail, colour stripped at capture: a timeout or
		// a cancel carries no result object to read, and the channels are kept
		// apart in the one that does.
		const tail = new OutputTail(MAX_RUN_LOG_CHARS);
		const shell = shellCommand(line, process.platform);
		const run = runner({
			executable: shell.executable,
			args: shell.args,
			...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
			cwd: route.cwd,
			...(stackEnv ? { env: { ...process.env, ...stackEnv } } : {}),
			idleTimeoutMs,
			maxBufferedOutput: MAX_RETAINED_OUTPUT,
			// The shell starts a test runner that starts browsers; a signal to the
			// shell alone leaves those recording on.
			killTree: true,
			onOutput: (text) => {
				const clean = stripAnsi(text);
				tail.append(clean);
				deps.onProgress?.({ kind: 'output', testCase: ticket.id, text: clean });
			}
		});
		live.add(run);
		try {
			const result = await run.completed;
			return await record(ticket, 'passed', line, result.code, startedAt, tail);
		} catch (error) {
			if (!(error instanceof ProcessError)) {
				throw error;
			}
			switch (error.code) {
				case 'cancelled':
					return { ticket, outcome: 'cancelled', startedAt };
				case 'timeout':
					return record(ticket, 'timeout', line, undefined, startedAt, tail);
				case 'failed':
					if (error.result) {
						return record(ticket, 'failed', line, error.result.code, startedAt, tail);
					}
				// falls through: a `failed` with no result means the shell itself
				// would not start — a broken system, not a broken test.
				case 'not-installed':
					abortedWith ??= { code: 'spawn-failed', message: error.message };
					return { ticket, outcome: 'error', startedAt, message: error.message };
			}
		} finally {
			live.delete(run);
		}
	};

	// Fan out under the concurrency cap. Each run settles to a tagged outcome,
	// never a rejection, and its writes land as it settles — evidence copied and
	// status written **before the slot is released**, so a sequential batch can
	// never have the next command clear a folder this one has not read yet. The
	// store's own write queue serialises the disk writes.
	//
	// The cap is the window's, not this batch's: at the default of one, two Run
	// Tests batches must no more overlap than two test cases in one batch do —
	// the databases a suite shares do not care which batch a command came from.
	// The floor guards an injected raw settings object; a parsed block can never
	// carry a concurrency below one.
	const slots = deps.slots ?? sharedLimiter(() => Math.max(1, testsConcurrency(settings)));
	// This batch's turn-taking handle, so another ticket's runs interleave with
	// these rather than waiting the whole batch out.
	const group = {};
	const results: TestCaseResult[] = [];
	let done = 0;
	// `allSettled`, so a thrown run — a programming error — still lets every
	// other run settle (as skipped, after `stop()`) before the batch ends: the
	// batch's `done` has to be its last event.
	const settled = await Promise.allSettled(
		testCases.map(async (ticket, index) => {
			const release = await slots.acquire(group);
			let result: TestCaseResult;
			try {
				result = await runOne(ticket);
			} catch (error) {
				// A programming error in one run ends the batch: the queue is skipped
				// and the live ones killed *before* the slot frees, or the next in line
				// would spawn into a batch nobody is watching any more.
				stop();
				throw error;
			} finally {
				release();
			}
			results[index] = result;
			done += 1;
			deps.onProgress?.({ kind: 'result', result, done, total: testCases.length });
		})
	);
	const failure = settled.find(
		(entry): entry is PromiseRejectedResult => entry.status === 'rejected'
	);
	if (failure) {
		throw failure.reason;
	}

	return summary(results.filter((result) => result !== undefined));
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.stat(target)).isDirectory();
	} catch {
		return false;
	}
}
