import * as vscode from 'vscode';
// A board's Tests tab: the report, a test case's runs and output, the evidence
// a run left behind, and the live batches this board follows.

import { isSafeEvidenceSegment } from '../shared/evidencePath';
import { unhandled } from '../platform/exhaustive';
import type { TestsToHost } from '../shared/protocol';
import {
	testsConcurrency,
	testsConfigured,
	testsEvidence,
	testsEvidenceCommand
} from '../settings/testsSettings';
import { serviceLabel, testServices } from '../settings/testServices';
import { MAX_INLINE_OUTPUT_CHARS, type TestBatchProgress } from '../testing/testReport';
import { buildTestReport } from '../testing/testReportBuilder';
import type { BoardHost } from './boardHost';
import type { TestBoardServices } from './boardServices';

export class TestsController {
	/**
	 * The test cases of the last report this board painted, and the batches it
	 * decided to follow. A batch is relevant when its root is this ticket, or its
	 * scope reaches one of these test cases (a parent run from the sidebar) —
	 * decided once at `scope` and kept until `done`, so five open boards do not
	 * each carry every batch's output chunks.
	 */
	private reportedTestCases = new Set<string>();
	private relevantBatches = new Set<string>();
	/** A report request while one is building marks it dirty and rebuilds once. */
	private buildingReport = false;
	private reportDirty = false;

	private readonly unsubscribe: () => void;

	constructor(
		private readonly host: BoardHost,
		private readonly tests: TestBoardServices
	) {
		// Every batch in the window, filtered to the ones this board follows.
		this.unsubscribe = tests.batches.onDidProgress((root, event) =>
			this.forwardBatch(root, event)
		);
	}

	dispose(): void {
		this.unsubscribe();
	}

	/**
	 * The board moved to another ticket: a late report or batch event for the
	 * one it left has nowhere to go.
	 */
	onTicketChanged(): void {
		this.reportedTestCases.clear();
		this.relevantBatches.clear();
	}

	async handle(message: TestsToHost): Promise<void> {
		switch (message.type) {
			case 'testsReport':
				await this.postTestReport(message.id);
				break;

			case 'testsRuns': {
				const listed = await this.tests.results.listRuns(message.testCase);
				this.host.post({
					type: 'testsRuns',
					id: message.id,
					testCase: message.testCase,
					runs: listed.runs,
					total: listed.total
				});
				break;
			}

			case 'testsOutput': {
				// The run id came from the webview; the host re-validates every message.
				const output = isSafeEvidenceSegment(message.run)
					? await this.tests.results.readOutput(
							message.testCase,
							message.run,
							MAX_INLINE_OUTPUT_CHARS
						)
					: undefined;
				this.host.post({
					type: 'testsOutput',
					id: message.id,
					testCase: message.testCase,
					run: message.run,
					text: output?.text ?? '',
					truncated: output?.truncated ?? false
				});
				break;
			}

			case 'testsRun': {
				void this.host.pin();
				// Followed from before its first event: a batch that aborts before it
				// has a scope (a missing cwd) still has to reach the tab that pressed Run.
				this.relevantBatches.add(message.id);
				const started = await this.tests.batches.start(message.id);
				if (started.kind === 'refused') {
					this.relevantBatches.delete(message.id);
					this.host.post({ type: 'testsError', id: message.id, message: started.message });
				}
				break;
			}

			case 'testsCancel': {
				const batches = this.tests.batches;
				// The batch the tab shows, when it has one. An epic's board that two
				// disjoint story batches reach follows and names only the first.
				if (message.root !== undefined && batches.batchFor(message.root) === message.root) {
					batches.cancel(message.root);
					break;
				}
				// No root yet — Stop pressed while Run was starting: the board's own
				// batch, or a parent's that reaches its test cases (an AC's or a story's
				// id is never a batch's root by itself).
				const roots = new Set<string>(this.relevantBatches);
				for (const id of [message.id, ...this.reportedTestCases]) {
					const root = batches.batchFor(id);
					if (root) {
						roots.add(root);
					}
				}
				for (const root of roots) {
					batches.cancel(root);
				}
				break;
			}

			case 'openEvidence':
				await this.tests.openEvidence(message.testCase, message.run, message.file);
				break;

			case 'testsMedia':
				await this.postMedia(message.id, message.testCase, message.run, message.file, message.convert === true);
				break;

			case 'testsTrace': {
				const result = await this.tests.readTrace(message.testCase, message.run, message.file);
				this.host.post({
					type: 'testsTrace',
					id: message.id,
					testCase: message.testCase,
					run: message.run,
					file: message.file,
					...result
				});
				break;
			}

			case 'testsTraceFrame': {
				const result = await this.tests.readTraceFrame(
					message.testCase,
					message.run,
					message.file,
					message.frame
				);
				this.host.post({
					type: 'testsTraceFrame',
					id: message.id,
					testCase: message.testCase,
					run: message.run,
					file: message.file,
					frame: message.frame,
					...result
				});
				break;
			}

			case 'openTraceViewer':
				await this.tests.openTraceViewer(message.testCase, message.run, message.file);
				break;

			case 'openTraceSource':
				if (typeof message.file === 'string' && Number.isFinite(message.line)) {
					await this.tests.openTraceSource(message.file, message.line, message.column);
				}
				break;

			case 'testsSetService':
				if (message.id === this.host.ticketId()) {
					await vscode.commands.executeCommand(
						'bfast.setTestCaseService',
						message.id,
						message.service
					);
				}
				break;

			default:
				unhandled(message);
		}
	}

	/**
	 * The Tests tab's first paint: each test case in the subtree with its
	 * latest run, plus what a live batch has got to. Coalesced — a request
	 * while one is building marks it dirty and rebuilds once when it lands —
	 * because a batch's results and the tracker watcher both ask again.
	 */
	private async postTestReport(id: string): Promise<void> {
		if (this.buildingReport) {
			this.reportDirty = true;
			return;
		}
		this.buildingReport = true;
		try {
			do {
				this.reportDirty = false;
				const report = await buildTestReport(this.host.store, this.tests.results, id);
				if (this.host.isDisposed() || this.host.ticketId() !== id) {
					return;
				}
				if (!report) {
					this.host.post({
						type: 'testsError',
						id,
						message: `Ticket ${id} is no longer in the tracker folder.`
					});
					return;
				}

				this.reportedTestCases = new Set(report.testCases.map((testCase) => testCase.id));
				// Each test case's folder in the results store, as a uri the webview
				// may load a video from — the `assetBase` rule, pointed at the other
				// folder. The results folder is workspace-relative, so the workspace
				// roots the panel already lists cover it.
				const evidenceBases: Record<string, string> = {};
				for (const testCase of report.testCases) {
					const folder = this.tests.results.testCaseFolder(testCase.id);
					if (folder) {
						// The trailing slash matters, as it does for `assetBase`.
						evidenceBases[testCase.id] = `${this.host.asWebviewUri(folder)}/`;
					}
				}

				const batches = this.tests.batches;
				const running =
					batches.batchFor(id) ??
					report.testCases.map((testCase) => batches.batchFor(testCase.id)).find(Boolean);
				if (running) {
					this.relevantBatches.add(running);
				}
				const batch = running ? batches.snapshot(running) : undefined;
				const settings = this.tests.settings();
				const evidenceCommand = testsEvidenceCommand(settings) !== undefined;
				// A few `stat`s per paint, so the button can say what it will do
				// before it is pressed; the command wins when it is set.
				const traceViewer = evidenceCommand
					? 'command'
					: (await this.tests.traceViewerAvailable())
						? 'playwright'
						: 'none';
				if (this.host.isDisposed() || this.host.ticketId() !== id) {
					return;
				}
				this.host.post({
					type: 'testsReport',
					id,
					report,
					evidenceBases,
					// A service's test case command counts: a tracker whose test cases
					// all run as services needs no project command.
					configured: testsConfigured(settings),
					evidenceConfigured: testsEvidence(settings) !== undefined,
					canOpenEvidence: evidenceCommand,
					traceViewer,
					concurrency: testsConcurrency(settings),
					services: testServices(settings).map((service) => ({
						id: service.id,
						label: serviceLabel(service),
						runnable: service.e2e?.testCommand !== undefined
					})),
					...(running ? { running } : {}),
					...(batch ? { batch } : {})
				});
			} while (this.reportDirty);
		} finally {
			this.buildingReport = false;
		}
	}

	/** The bytes of one evidence video, for the board's fallback player — `readEvidenceVideo` checks the names. */
	private async postMedia(id: string, testCase: string, run: string, file: string, convert: boolean): Promise<void> {
		const result = await this.tests.readEvidence(testCase, run, file, convert);
		this.host.post({ type: 'testsMedia', id, testCase, run, file, ...(convert ? { converted: true } : {}), ...result });
	}

	/** One batch event, forwarded when this board follows the batch — see the field note. */
	private forwardBatch(root: string, event: TestBatchProgress): void {
		const ticketId = this.host.ticketId();
		if (!ticketId) {
			return;
		}
		if (root === ticketId) {
			// The board's own batch, whatever event comes first — one that aborts
			// before its scope (a missing cwd) sends only `done`.
			this.relevantBatches.add(root);
		} else if (event.kind === 'scope') {
			if (!event.testCases.some((testCase) => this.reportedTestCases.has(testCase.id))) {
				return;
			}
			this.relevantBatches.add(root);
		} else if (!this.relevantBatches.has(root)) {
			return;
		}
		this.host.post({ type: 'testsProgress', id: root, event });
		if (event.kind === 'done') {
			this.relevantBatches.delete(root);
		}
	}
}
