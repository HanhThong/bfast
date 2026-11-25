// Run Tests' share of activation: the results store, the window's batches,
// the trace viewer, and what a board's Tests tab reads all of it through.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { TrackerWatcher } from '../data/trackerWatcher';
import type { WritableTicketStore } from '../data/ticketStore';
import type { TestBoardServices } from '../board/bfastPanel';
import { runProcess } from '../platform/runProcess';
import { sharedLimiter } from '../platform/semaphore';
import {
	testsConcurrency,
	testsCwd,
	testsIdleTimeoutMs,
	testsTraceFrames
} from '../settings/testsSettings';
import { registerTestCommands } from '../testing/testCommands';
import { createTestBatches, type TestBatches } from '../testing/testBatches';
import { settingsTestResultsContext } from '../testing/testResultsContext';
import { TestResultsStore } from '../testing/testResultsStore';
import { RUN_FILE } from '../testing/testRunFile';
import {
	openEvidence,
	openTraceSource,
	openTraceViewer,
	readEvidenceVideo,
	readTrace,
	readTraceFrame,
	type EvidenceServices
} from '../testing/evidenceService';
import { createTraceReader } from '../testing/traceReader';
import { TraceViewerLauncher } from '../testing/traceViewerLauncher';
import type { CoreServices, FeatureModule } from './core';
import type { EnvironmentHandle } from '../environments/environmentProvider';
import { masterStack } from '../environments/masterStack';

export interface TestsModuleDeps {
	store: WritableTicketStore;
	/** Repaints the tickets section, so statuses land while a run is going. */
	refresh: () => void;
	/** A run landed that changed no ticket file; open boards re-read their report. */
	reloadBoards: () => Promise<void>;
	/**
	 * An environment by id — the master's, for its stack variables and to bring
	 * a service's compose services up in. Read at call time; absent means no
	 * environments section, and a service needing compose cannot run.
	 */
	findEnvironment?: (id: string) => Promise<EnvironmentHandle | undefined>;
}

export interface TestsModule extends FeatureModule {
	/**
	 * The one seam both Run Tests surfaces — the sidebar command and every
	 * board's Tests tab — start, stop and watch through, which is what holds "a
	 * test case belongs to at most one running batch" across the two.
	 */
	batches: TestBatches;
	results: TestResultsStore;
	/** What a board's Tests tab needs. */
	board: TestBoardServices;
}

export function activateTests(core: CoreServices, deps: TestsModuleDeps): TestsModule {
	const { settings, workspace } = core;
	const tests = () => workspace.block('tests');

	// Test runs live outside the tracker, under `tests.resultsFolder`; the same
	// read-at-call-time posture, so a change of folder reaches the next run.
	const results = new TestResultsStore(settingsTestResultsContext(settings));

	// The "Run Tests" log — its own channel, so a test run's output never
	// interleaves with a stack build's.
	const output = vscode.window.createOutputChannel('BFAST Tests');

	// The window's test slots: one cap per window, since the databases a suite
	// shares do not care which batch a command came from.
	const slots = sharedLimiter(() => Math.max(1, testsConcurrency(tests())));
	// The master environment, for the stack variables every test command gets
	// and the compose services a service's e2e test cases need up first.
	const stack = deps.findEnvironment
		? masterStack({
				find: deps.findEnvironment,
				settings: () => workspace.block('environments'),
				runner: runProcess,
				idleTimeoutMs: () => testsIdleTimeoutMs(tests())
			})
		: undefined;
	const batches = createTestBatches({
		store: deps.store,
		results,
		settings: tests,
		workspaceRoot: () => workspace.root(),
		slots,
		...(stack
			? { stackEnvironment: () => stack.stackEnvironment(), composeUp: stack.composeUp }
			: {})
	});

	// "Open in Playwright Trace Viewer" with no command configured: the
	// workspace's own Playwright, one viewer process per window. On a remote it
	// serves on a port and the url goes through `asExternalUri`, which is what
	// forwards the port to the user's machine.
	const traceViewer = new TraceViewerLauncher({
		runner: runProcess,
		exists: async (file) => {
			try {
				return (await fs.stat(file)).isFile();
			} catch {
				return false;
			}
		},
		roots: () => {
			const root = workspace.root();
			if (root === undefined) {
				return [];
			}
			const cwd = testsCwd(tests());
			return cwd === undefined ? [root] : [path.join(root, cwd), root];
		},
		remote: () => vscode.env.remoteName !== undefined,
		openExternal: async (url) => {
			const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
			await vscode.env.openExternal(external);
		},
		log: (line) => output.appendLine(line),
		env: process.env,
		execPath: process.execPath
	});

	const evidence: EvidenceServices = {
		results,
		tests,
		workspaceRoot: () => workspace.root(),
		output,
		traces: createTraceReader({ frameSource: () => testsTraceFrames(tests()) }),
		traceViewer
	};

	// The results folder is the other history, and a `git pull` can bring a
	// teammate's runs with no ticket file changing at all — a same-verdict run
	// writes nothing into the tracker — so the boards watch it too. Only
	// `run.json` counts: it is written last, so one event per run rather than
	// one per megabyte copied, and a folder without one is not a run yet. The
	// tree is not repainted: a run changes no ticket.
	const resultsWatcher = new TrackerWatcher(
		() => void deps.reloadBoards(),
		() => false,
		(relativePath) => !relativePath.endsWith(RUN_FILE)
	);

	return {
		batches,
		results,
		board: {
			batches,
			results,
			settings: tests,
			openEvidence: (id, run, file) => openEvidence(evidence, id, run, file),
			readEvidence: (id, run, file, convert) => readEvidenceVideo(evidence, id, run, file, convert),
			readTrace: (id, run, file) => readTrace(evidence, id, run, file),
			readTraceFrame: (id, run, file, frame) => readTraceFrame(evidence, id, run, file, frame),
			openTraceViewer: (id, run, file) => openTraceViewer(evidence, id, run, file),
			openTraceSource: (file, line, column) => openTraceSource(file, line, column),
			traceViewerAvailable: () => traceViewer.available()
		},
		onSettingsApplied(current) {
			resultsWatcher.retarget(current ? settings.testResultsFolderUri(current) : undefined);
		},
		disposables: [
			resultsWatcher,
			output,
			traceViewer,
			...registerTestCommands({
				batches,
				store: deps.store,
				results,
				tests,
				workspaceRoot: () => workspace.root(),
				output,
				refresh: deps.refresh
			})
		]
	};
}
