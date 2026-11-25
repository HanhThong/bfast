// The "Run Tests" command half — see docs/tests/ for the contract.
//
// Every decision lives in `testing/testRunner.ts` and `testing/testBatches.ts`;
// this file turns a batch's events into what the window shows — the "BFAST
// Tests" output channel, one cancellable progress notification per batch, the
// coalesced sidebar refresh and the summary toast with "Show Log" — whichever
// surface started it, and turns the sidebar's gesture into `batches.start`. A
// board's Tests tab is the other surface; it reads the same events.

import * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import type { TicketNode } from '../data/ticketTree';
import type { ProcessRunner } from '../platform/runProcess';
import type { TestsSettings } from '../settings/testsSettings';
import type { TestBatches } from './testBatches';
import type { TestResultsStore } from './testResultsStore';
import type { TestCaseResult } from './testReport';

export interface TestCommandServices {
	batches: TestBatches;
	store: WritableTicketStore;
	/** Where runs are filed; what `openEvidence` resolves a name against. */
	results: TestResultsStore;
	/** Read at call time, never captured — the settings may change between runs. */
	tests: () => TestsSettings | undefined;
	/** Where a relative `tests.cwd` resolves from. */
	workspaceRoot: () => string | undefined;
	/** The "BFAST Tests" channel, created in `activate()`. */
	output: vscode.OutputChannel;
	/** Repaints the tickets section, so statuses land while the run is going. */
	refresh: () => void;
	/** Injection seam for the evidence command; absent means the real `runProcess`. */
	runner?: ProcessRunner;
}

export function registerTestCommands(services: TestCommandServices): vscode.Disposable[] {
	const { batches, output, refresh } = services;

	const showWithLog = async (
		show: (message: string, ...items: string[]) => Thenable<string | undefined>,
		message: string
	): Promise<void> => {
		const choice = await show(message, 'Show Log');
		if (choice === 'Show Log') {
			output.show(true);
		}
	};

	// Statuses land as they settle and the tree should show it — but the
	// injected refresh rescans the tracker and reloads every open board, so
	// per-result repaints are coalesced rather than issued one per test.
	let pendingRepaint: NodeJS.Timeout | undefined;
	const repaintSoon = (): void => {
		pendingRepaint ??= setTimeout(() => {
			pendingRepaint = undefined;
			refresh();
		}, 300);
	};

	// One notification per batch, opened when the scope is known and closed on
	// `done`; its × is the same cancel the board's Stop reaches.
	const notifications = new Map<
		string,
		{ report: (message: string) => void; close: () => void }
	>();
	const notify = (root: string, total: number): void => {
		void vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `BFAST: running tests for ${root}…`,
				cancellable: true
			},
			(progress, token) =>
				new Promise<void>((resolve) => {
					progress.report({ message: `0/${total}` });
					token.onCancellationRequested(() => batches.cancel(root));
					notifications.set(root, {
						report: (message) => progress.report({ message }),
						close: () => {
							notifications.delete(root);
							resolve();
						}
					});
				})
		);
	};

	const subscription = batches.onDidProgress((root, event) => {
		switch (event.kind) {
			case 'scope': {
				const count = event.testCases.length;
				output.appendLine(
					`— Run Tests: ${root} — ${count} test ${count === 1 ? 'case' : 'cases'}`
				);
				if (count > 0) {
					notify(root, count);
				}
				break;
			}
			case 'started':
				output.appendLine(
					`— ${event.ticket.id} started: ${event.line}${event.ticket.warning ? ` (⚠ ${event.ticket.warning})` : ''}`
				);
				break;
			case 'output':
				output.append(event.text);
				break;
			case 'result':
				output.appendLine(`— ${resultLine(event.result)}`);
				notifications.get(root)?.report(`${event.done}/${event.total}`);
				repaintSoon();
				break;
			case 'done': {
				output.appendLine(`— ${event.message}`);
				if (pendingRepaint !== undefined) {
					clearTimeout(pendingRepaint);
					pendingRepaint = undefined;
				}
				refresh();
				// Registered synchronously at `scope` (withProgress runs its task inline),
				// so it is always there to close.
				notifications.get(root)?.close();
				const summary = event.summary;
				if (summary === undefined || summary.abortedWith) {
					void showWithLog(vscode.window.showErrorMessage, event.message);
				} else if (summary.results.length === 0) {
					void vscode.window.showInformationMessage(event.message);
				} else {
					void showWithLog(vscode.window.showInformationMessage, event.message);
				}
				break;
			}
		}
	});

	return [
		{ dispose: subscription },
		vscode.commands.registerCommand('bfast.runTests', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			// Unreachable from the menu, whose `when` clause requires a ticket row;
			// it guards a keybinding or a palette invocation with no node.
			if (!ticket) {
				void vscode.window.showWarningMessage('Right-click a ticket to run its test cases.');
				return;
			}

			const started = await batches.start(ticket.id);
			if (started.kind === 'refused') {
				if (started.reason === 'unconfigured') {
					// "Unconfigured" has a better answer than an error: the settings
					// form, one click away.
					const choice = await vscode.window.showErrorMessage(started.message, 'Open Settings');
					if (choice === 'Open Settings') {
						void vscode.commands.executeCommand('bfast.openSettings');
					}
				} else {
					void vscode.window.showWarningMessage(started.message);
				}
			}
		})
	];
}

/** The channel's per-result line. The evidence suffix is what the file count is for. */
function resultLine(result: TestCaseResult): string {
	const id = result.ticket.id;
	const files = result.run?.files.filter((file) => !file.missing).length ?? 0;
	const evidence =
		files > 0 ? ` — ${files} evidence ${files === 1 ? 'file' : 'files'}` : '';
	const note = result.message ? ` — ${result.message}` : '';
	switch (result.outcome) {
		case 'passed':
			return `${id} passed (exit ${result.exitCode ?? 0})${evidence}${note}`;
		case 'failed':
			return `${id} failed (exit ${result.exitCode ?? 'unknown'})${evidence}${note}`;
		case 'timeout':
			return `${id} went quiet and was stopped${evidence}${note}`;
		case 'cancelled':
			return `${id} cancelled`;
		case 'skipped':
			return `${id} skipped`;
		case 'error':
			return `${id} could not be run or recorded: ${result.message ?? 'unknown error'}`;
	}
}
