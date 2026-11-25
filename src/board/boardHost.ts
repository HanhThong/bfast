// What a board hands each of its controllers: the tab they share.

import type * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import type { HostToBoard } from '../shared/protocol';

/**
 * The board, as narrow as its controllers need it.
 *
 * A controller owns one concern of a board — its images, its Tests tab, its
 * design tabs, its assistant — and reaches the tab only through this: it can
 * post to the webview and ask which ticket is up, and it cannot touch the
 * panel's title, its lifecycle or another controller's state.
 */
export interface BoardHost {
	readonly store: WritableTicketStore;
	/** Posts to the webview; dropped once the tab has gone. */
	post(message: HostToBoard): void;
	/** The ticket this board is showing. */
	ticketId(): string | undefined;
	/** True once the tab has closed — a reply that lands late is dropped. */
	isDisposed(): boolean;
	/** Pins a preview tab: work started in it. */
	pin(): Promise<void>;
	/** A file as a uri this board's webview may load. */
	asWebviewUri(uri: vscode.Uri): vscode.Uri;
	/** A ticket changed on disk; the sidebar and every other board follow. */
	onChanged(): void;
}
