import * as vscode from 'vscode';
import { TicketTreeProvider } from './ticketTreeProvider';

/**
 * A native TreeView cannot host a text field, so the filter is a quick input
 * box. `onDidChangeValue` re-filters the tree on every keystroke, so it still
 * behaves like typing into a search box.
 */
export function showFilterInput(provider: TicketTreeProvider): void {
	const input = vscode.window.createInputBox();
	input.title = 'Filter tickets';
	input.placeholder = 'Filter by key or title';
	input.value = provider.activeFilter;
	// Escape should undo the filtering it applied while typing; Enter keeps it.
	const applied = provider.activeFilter;
	let accepted = false;

	input.onDidChangeValue((value) => provider.setFilter(value));
	input.onDidAccept(() => {
		accepted = true;
		input.hide();
	});
	input.onDidHide(() => {
		if (!accepted) {
			provider.setFilter(applied);
		}
		input.dispose();
	});

	input.show();
}
