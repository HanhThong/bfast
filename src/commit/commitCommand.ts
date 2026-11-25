// The "Commit Ticket…" command: right-click a ticket once it has been
// reviewed, and commit its files in the tracker — and nothing else the user
// has staged. docs/commit/README.md §Outcomes is the table this must keep
// matching.
//
// Nothing is written into the ticket: a commit is not a change to it, so no
// history entry and no `updatedAt` bump (which would also fail the next save
// of a board open mid-edit — the `addAttachment` trap). The dialogs go through
// an injectable `CommitUi`, so the suite drives the command without a window.

import * as vscode from 'vscode';
import type { TicketNode } from '../data/ticketTree';
import type { TicketStore } from '../data/ticketStore';
import type { TicketSummary } from '../data/types';
import { errorMessage } from '../platform/errors';
import type { ProcessRunner } from '../platform/runProcess';
import {
	commitMessageTemplate,
	renderCommitMessage,
	type GitSettings
} from '../settings/gitSettings';
import { CommitError, commitPaths, ticketChanges } from './ticketCommit';

export interface CommitServices {
	store: Pick<TicketStore, 'getSummary' | 'folderUri'>;
	runner: ProcessRunner;
	/** The `git` block, read at call time. */
	settings: () => GitSettings | undefined;
	/** A commit landed — the sidebar's marks look again, git extension or not. */
	onCommitted?: () => void;
}

export type CommitScope = 'own' | 'subtree';

export interface CommitScopeOption {
	scope: CommitScope;
	label: string;
	detail: string;
}

/** The dialogs, injectable so the suite drives the command without a window. */
export interface CommitUi {
	info(message: string, ...actions: string[]): Thenable<string | undefined>;
	error(message: string): void;
	pickScope(options: CommitScopeOption[]): Thenable<CommitScope | undefined>;
	askMessage(initial: string, prompt: string): Thenable<string | undefined>;
	progress<T>(title: string, task: () => Promise<T>): Thenable<T>;
	showSourceControl(): void;
}

const realUi: CommitUi = {
	info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
	error: (message) => void vscode.window.showErrorMessage(message),
	pickScope: async (options) =>
		(
			await vscode.window.showQuickPick(
				options.map((option) => ({ ...option, description: option.detail })),
				{ title: 'Commit Ticket', placeHolder: 'What to commit' }
			)
		)?.scope,
	askMessage: (initial, prompt) =>
		vscode.window.showInputBox({
			title: 'Commit Ticket',
			prompt,
			value: initial,
			validateInput: (value) => (value.trim().length === 0 ? 'Enter a commit message.' : undefined)
		}),
	progress: (title, task) =>
		vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task),
	showSourceControl: () => void vscode.commands.executeCommand('workbench.view.scm')
};

const SHOW_SOURCE_CONTROL = 'Show Source Control';

const files = (count: number): string => (count === 1 ? '1 file' : `${count} files`);

/** Every step of the outcome table, in order; each early return is one of its rows. */
export async function commitTicket(
	services: CommitServices,
	ticket: TicketSummary,
	ui: CommitUi = realUi
): Promise<void> {
	const folder = await services.store.folderUri?.(ticket.id);
	if (!folder) {
		ui.error(`Cannot commit ${ticket.id}: its folder could not be found.`);
		return;
	}

	let changes;
	try {
		changes = await ticketChanges(services.runner, folder.fsPath);
	} catch (error) {
		ui.error(`Cannot commit ${ticket.id}: ${errorMessage(error)}`);
		return;
	}

	const subtree = [...changes.own, ...changes.children];
	if (subtree.length === 0) {
		void ui.info(`Nothing to commit for ${ticket.id}: its files match the last commit.`);
		return;
	}

	// Asked only when tickets below it changed too; otherwise there is one
	// honest answer and a pick would be a click for nothing.
	let scope: CommitScope = changes.children.length > 0 ? 'subtree' : 'own';
	if (changes.children.length > 0) {
		const options: CommitScopeOption[] = [];
		if (changes.own.length > 0) {
			options.push({
				scope: 'own',
				label: `${ticket.id} only`,
				detail: files(changes.own.length)
			});
		}
		options.push({
			scope: 'subtree',
			label: `${ticket.id} and the tickets under it`,
			detail: files(subtree.length)
		});
		const picked = await ui.pickScope(options);
		if (picked === undefined) {
			return;
		}
		scope = picked;
	}
	const paths = scope === 'own' ? changes.own : subtree;

	const initial = renderCommitMessage(commitMessageTemplate(services.settings()), {
		id: ticket.id,
		key: ticket.key,
		title: ticket.title,
		type: ticket.type,
		status: ticket.status
	});
	const message = (
		await ui.askMessage(initial, `Commit message for ${ticket.id} (${files(paths.length)})`)
	)?.trim();
	if (!message) {
		return;
	}

	let hash: string;
	try {
		hash = await ui.progress(`Committing ${ticket.id}…`, () =>
			commitPaths(services.runner, changes.top, paths, message)
		);
	} catch (error) {
		ui.error(
			error instanceof CommitError
				? `Commit of ${ticket.id} failed: ${error.message}`
				: `Commit of ${ticket.id} failed: ${errorMessage(error)}`
		);
		return;
	}
	services.onCommitted?.();

	const choice = await ui.info(
		`Committed ${ticket.id} as ${hash} (${files(paths.length)}).`,
		SHOW_SOURCE_CONTROL
	);
	if (choice === SHOW_SOURCE_CONTROL) {
		ui.showSourceControl();
	}
}

export function registerCommitCommands(services: CommitServices): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('bfast.commitTicket', async (node?: TicketNode) => {
			// Unreachable from the menu, whose `when` clause requires a ticket row;
			// it guards a keybinding or a palette invocation with no node.
			const id = node?.ticket.id;
			const ticket = id ? await services.store.getSummary(id) : undefined;
			if (!ticket) {
				void vscode.window.showWarningMessage('Right-click a ticket to commit it.');
				return;
			}
			await commitTicket(services, ticket);
		})
	];
}
