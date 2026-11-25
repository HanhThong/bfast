// The pure half of "Run Scan" — see docs/scan/ for the contract this
// implements. `src/scan/scanCommands.ts` is the `vscode` half.
//
// No `vscode` import: everything the run needs is injected (the store, the
// server, the provider, a settings accessor), which is what lets
// `scanRunner.test.ts` drive the whole flow against a `FakeScanProvider` and a
// scratch tracker — the same posture as `testRunner.ts` and `environmentStore.ts`.
//
// Two rules from the docs are enforced here rather than left to the caller:
//
//   - **A scan stamps exactly the ticket it was invoked from, and does not fan
//     out.** A test case *is* a test, so Run Tests runs one command per test
//     case; a code scan is one analysis of one codebase, and repeating it per
//     descendant would run the identical analysis N times and write the
//     identical verdict N times.
//   - **No outcome changes a ticket's status.** Run Tests owns `done` and
//     `blocked`; a scan writes a history entry through `recordNote` and nothing
//     else. Two features writing one field would fight, and a `blocked` that
//     actually meant "your Docker was off" poisons the tracker.

import * as path from 'path';
import type { WritableTicketStore } from '../data/ticketStore';
import {
	defaultProjectKey,
	scanCwd,
	scanIdleTimeoutMs,
	validateProjectKey,
	type ScanSettings
} from '../settings/scanSettings';
import type { ScanRunSummary, ScanServerStore } from './scanServerStore';
import {
	ScanCancelledError,
	ScanError,
	type ScanOperation,
	type ScanProgressListener,
	type ScanProjectIdentity,
	type ScanProvider
} from './scanProvider';
import {
	hasReport,
	outcomeForGate,
	summariseReport,
	type ScanOutcome,
	type ScanPhase,
	type ScanProjectKeySource,
	type ScanReport,
	type ScanTargetRef
} from './scanReport';
import { errorMessage } from '../platform/errors';

export interface ScanRunDeps {
	provider: ScanProvider;
	server: ScanServerStore;
	store: WritableTicketStore;
	/** Read once per run — a save mid-run does not change a running scan. */
	settings: () => ScanSettings | undefined;
	workspaceRoot: () => string | undefined;
	/** The folder's own name; the default project key comes from it. */
	workspaceName: () => string | undefined;
	/**
	 * The ticket's environment worktree — the checkout of the branch the work is
	 * actually on — or `undefined` when it has none.
	 *
	 * The one and only coupling between Code Quality and Environments, and what a
	 * ticket scan **is**: a scan started from a ticket analyses its environment
	 * and nothing else. There is no fallback to the workspace — a ticket with no
	 * environment has nothing of its own to scan, and quietly analysing the
	 * repo's main checkout under that ticket's name would file a verdict about
	 * code the ticket never touched. Scan Workspace is the whole-repo gesture.
	 * This runner still never learns environments exist.
	 */
	resolveDirectory?: (ticketId: string) => Promise<string | undefined>;
	onProgress?: (progress: ScanRunProgress) => void;
	/** Injected so a test does not depend on the clock. */
	now?: () => Date;
}

export type ScanRunProgress =
	| { kind: 'phase'; phase: ScanPhase; label: string }
	| { kind: 'output'; text: string }
	| { kind: 'report'; report: ScanReport };

export interface ScanRunResult {
	target: ScanTargetRef;
	outcome: ScanOutcome;
	report?: ScanReport;
	/** The one-line verdict, ready for a notification and a history entry. */
	summary: string;
	/** Why it failed, for an error notification. Absent when it did not. */
	message?: string;
	/** Set when the verdict could not be written onto the ticket. */
	recordError?: string;
	/** ISO 8601. */
	finishedAt: string;
}

/** The `testRunner.TestRunHooks` shape: no `CancellationToken` in the pure half. */
export interface ScanRunHooks {
	onCancel?: (cancel: () => void) => void;
}

/** The history action a scan writes. One word, like `created` and `changed`. */
export const SCAN_HISTORY_ACTION = 'scanned';

/**
 * One analysis, start to finish.
 *
 * **Never rejects.** Every failure is a tagged outcome, the `runTests` contract,
 * so the caller renders one thing rather than branching between a result and an
 * exception.
 */
export async function runScan(
	deps: ScanRunDeps,
	ticketId?: string,
	hooks?: ScanRunHooks
): Promise<ScanRunResult> {
	// Snapshotted once: a run uses the settings it started with.
	const settings = deps.settings();
	const now = deps.now ?? (() => new Date());

	let cancelled = false;
	let live: ScanOperation<unknown> | undefined;
	// Handed out before anything starts: the Stop button can be pressed first,
	// and cancelling nothing is safe — the flag is what the later steps read.
	hooks?.onCancel?.(() => {
		cancelled = true;
		live?.cancel('The scan was cancelled.');
	});

	const { target, problem } = await resolveScope(deps, settings, ticketId);
	const finish = (
		outcome: ScanOutcome,
		summary: string,
		extra: Partial<ScanRunResult> = {}
	): ScanRunResult => ({
		target,
		outcome,
		summary,
		finishedAt: now().toISOString(),
		...extra
	});

	if (problem !== undefined) {
		return finish('unreachable', 'nothing to scan', { message: problem });
	}

	const progress = (phase: ScanPhase, label: string): void =>
		deps.onProgress?.({ kind: 'phase', phase, label });
	const toRunner: ScanProgressListener = (event) => {
		if (event.kind === 'output') {
			deps.onProgress?.({ kind: 'output', text: event.text });
		} else {
			deps.onProgress?.({ kind: 'output', text: `— ${event.label}\n` });
		}
	};

	let report: ScanReport;
	try {
		if (cancelled) {
			throw new ScanCancelledError();
		}

		progress('preparing', 'Preparing the scan server');
		const ready = await deps.server.ready(toRunner);
		if (cancelled) {
			throw new ScanCancelledError();
		}

		progress('scanning', `Scanning ${target.directory}`);
		const operation = deps.provider.scan(
			{
				directory: target.directory,
				projectKey: target.projectKey,
				...(target.projectName ? { projectName: target.projectName } : {}),
				...(ticketId ? { ticketId } : {}),
				endpoint: ready.endpoint,
				credentials: ready.credentials,
				idleTimeoutMs: scanIdleTimeoutMs(settings)
			},
			(event) => {
				// The importing phase is the provider's own; it announces it in a
				// phase label, and the tab follows.
				if (event.kind === 'phase' && /process the analysis/i.test(event.label)) {
					progress('importing', event.label);
				}
				toRunner(event);
			}
		);
		live = operation;
		report = await operation.completed;
	} catch (error) {
		const outcome = outcomeForError(error, cancelled);
		const message = errorMessage(error);
		return finish(outcome, outcomeSummary(outcome), { message });
	} finally {
		live = undefined;
	}

	deps.onProgress?.({ kind: 'report', report });
	progress('report', 'Analysis complete');

	const outcome = outcomeForGate(report.gate);
	const summary = summariseReport(report);
	const recordError = ticketId
		? await recordOnTicket(deps, ticketId, report, summary)
		: undefined;

	const result = finish(outcome, summary, {
		report,
		...(recordError ? { recordError } : {})
	});
	deps.server.recordRun(toRunSummary(result));
	return result;
}

/** The sidebar's row for a finished run. */
export function toRunSummary(result: ScanRunResult): ScanRunSummary {
	return {
		target: result.target,
		outcome: result.outcome,
		summary: result.summary,
		finishedAt: result.finishedAt,
		...(result.report?.dashboardUrl ? { dashboardUrl: result.report.dashboardUrl } : {})
	};
}

/**
 * What gets scanned, and what the verdict is filed under.
 *
 * A ticket scan analyses that ticket's **environment worktree** and nothing
 * else; a workspace scan analyses the workspace root, or `scan.cwd`. The
 * project key is one per workspace — Community Edition analyses the main
 * branch only, so a key per ticket would be N projects with one analysis each.
 *
 * **Where the key comes from, in order:** the checkout's own properties file
 * (`sonar-project.properties`, read through the provider), then the
 * `scan.projectKey` setting, then the workspace folder's name. The file wins
 * because `-D` beats it inside the scanner: a key BFAST chose would silently
 * rename the project a team already set up in CI, and every dashboard link
 * they have would point at the old one. The source rides on the target so the
 * setup screen can say which it was.
 *
 * A ticket with no environment yields a target with an empty `directory` —
 * the tab still opens and says why. `runScan` refuses to analyse it.
 */
export async function resolveTarget(
	deps: ScanRunDeps,
	settings: ScanSettings | undefined,
	ticketId?: string
): Promise<ScanTargetRef> {
	return (await resolveScope(deps, settings, ticketId)).target;
}

/**
 * `resolveTarget`, plus the reason there is nothing to scan when there is not.
 *
 * Exported for the MCP server: the tab shows `problem` to a person, but a tool
 * that started the scan over a port sees only its answer, so the refusal has
 * to reach it there rather than in a tab it cannot read.
 */
export async function resolveScope(
	deps: ScanRunDeps,
	settings: ScanSettings | undefined,
	ticketId?: string
): Promise<{ target: ScanTargetRef; problem?: string }> {
	let directory: string;
	let problem: string | undefined;

	if (ticketId) {
		// The environment or nothing — never the workspace under the ticket's name.
		directory = '';
		try {
			directory = (await deps.resolveDirectory?.(ticketId)) ?? '';
			if (directory.length === 0) {
				problem = `${ticketId} has no environment to scan. Create and start one from the Environments section, or use Scan Workspace.`;
			}
		} catch (error) {
			// A broken environments read is a failed scan, not a silent scan of
			// the wrong tree.
			problem = `BFAST could not find the environment for ${ticketId}: ${errorMessage(error)}`;
		}
	} else {
		const root = deps.workspaceRoot() ?? '';
		const relative = scanCwd(settings);
		directory = relative === undefined ? root : path.join(root, relative);
		if (directory.length === 0) {
			problem = 'Open a workspace folder before scanning.';
		}
	}

	const project = await resolveProject(deps, settings, directory);

	const target: ScanTargetRef = {
		...(ticketId ? { ticketId } : {}),
		...(ticketId ? { ticketKey: await ticketKey(deps, ticketId) } : {}),
		projectKey: project.projectKey,
		...(project.projectName ? { projectName: project.projectName } : {}),
		projectKeySource: project.source,
		directory,
		...(ticketId && directory.length > 0 ? { worktree: true } : {})
	};
	return problem === undefined ? { target } : { target, problem };
}

/** The three-way fallback for the key, and the file-then-folder one for the name. */
async function resolveProject(
	deps: ScanRunDeps,
	settings: ScanSettings | undefined,
	directory: string
): Promise<{ projectKey: string; projectName?: string; source: ScanProjectKeySource }> {
	let identity: ScanProjectIdentity | undefined;
	try {
		identity =
			directory.length > 0 ? await deps.provider.readProjectIdentity?.(directory) : undefined;
	} catch {
		// The seam promises not to throw; a provider that does anyway must not
		// take the scan down over a file the fallbacks cover.
	}

	// A key the file names but SonarQube would refuse is ignored rather than
	// sent: the scanner would fail on it four minutes in, and the fallbacks
	// give a key that works.
	const fromFile =
		identity?.projectKey !== undefined && validateProjectKey(identity.projectKey) === undefined
			? identity.projectKey
			: undefined;
	const workspaceName = deps.workspaceName();
	const projectName = identity?.projectName ?? workspaceName;
	const named = projectName ? { projectName } : {};

	if (fromFile !== undefined) {
		return { projectKey: fromFile, ...named, source: 'properties' };
	}
	if (settings?.projectKey !== undefined) {
		return { projectKey: settings.projectKey, ...named, source: 'settings' };
	}
	return {
		projectKey: defaultProjectKey(workspaceName ?? path.basename(deps.workspaceRoot() ?? '')),
		...named,
		source: 'folder'
	};
}

/** The local segment, for a tab title. Best effort — a scan does not need it. */
async function ticketKey(deps: ScanRunDeps, ticketId: string): Promise<string | undefined> {
	try {
		return (await deps.store.getSummary(ticketId))?.key;
	} catch {
		return undefined;
	}
}

/**
 * Writes the verdict into the ticket's history, and returns why it could not
 * when it could not.
 *
 * A failed write is reported, never thrown: the analysis really happened and its
 * result is on screen, so losing the run over a tracker that moved underneath it
 * would be the wrong trade.
 */
async function recordOnTicket(
	deps: ScanRunDeps,
	ticketId: string,
	report: ScanReport,
	summary: string
): Promise<string | undefined> {
	const parts = [`Code scan: ${summary}`];
	if (report.scmDisabled) {
		// Worth saying out loud rather than leaving as a mystery: without SCM data
		// SonarQube's "new code" measures mean nothing.
		parts.push('Analysed without SCM data, so “new code” measures are not meaningful.');
	}
	if (report.dashboardUrl) {
		parts.push(report.dashboardUrl);
	}
	try {
		await deps.store.recordNote(ticketId, SCAN_HISTORY_ACTION, parts.join(' '));
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

/** `ScanErrorCode` → the outcome table's row. */
export function outcomeForError(error: unknown, cancelled: boolean): ScanOutcome {
	if (cancelled || error instanceof ScanCancelledError) {
		return 'cancelled';
	}
	if (error instanceof ScanError) {
		switch (error.code) {
			case 'timeout':
				return 'timeout';
			case 'unauthorized':
				return 'unauthorized';
			case 'not-installed':
			case 'not-configured':
			case 'external':
			case 'no-ports':
			case 'exists':
			case 'busy':
				return 'unreachable';
			case 'server-error':
				return 'ce-failed';
			case 'scanner-error':
				return 'scanner-failed';
			case 'cancelled':
				return 'cancelled';
		}
	}
	return 'scanner-failed';
}

/** The one-line verdict for an outcome that produced no report. */
function outcomeSummary(outcome: ScanOutcome): string {
	switch (outcome) {
		case 'cancelled':
			return 'cancelled';
		case 'timeout':
			return 'went quiet and was stopped';
		case 'unauthorized':
			return 'the server refused the stored credentials';
		case 'unreachable':
			return 'the server could not be reached';
		case 'ce-failed':
			return 'SonarQube could not process the analysis';
		default:
			return 'the scanner failed';
	}
}

/** Re-exported so the command layer can label a run without importing the report module. */
export { hasReport };
