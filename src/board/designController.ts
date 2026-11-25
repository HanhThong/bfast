// A board's design tabs: the documents on a ticket, and one open at a time.

import * as vscode from 'vscode';
import { TicketConflictError } from '../data/ticketStore';
import type { TicketType } from '../data/types';
import {
	allowsDesigns,
	type DesignDocument,
	type DesignStyle,
	type DesignSummary
} from '../design/designDocument';
import { errorMessage } from '../platform/errors';
import type { DesignToHost } from '../shared/protocol';
import type { BoardHost } from './boardHost';
import type { DesignBoardServices } from './boardServices';

export class DesignController {
	constructor(
		private readonly host: BoardHost,
		/** Absent, and a board simply grows no design tabs. */
		private readonly designs: DesignBoardServices | undefined,
		/**
		 * A document was opened. The assistant says whether a conversation about
		 * it can be continued — riding on the open rather than on `ticketDetail`,
		 * since a conversation belongs to one document.
		 */
		private readonly onDocumentOpened: (ticketId: string, designId: string) => void
	) {}

	/**
	 * The design half of a `ticketDetail`: the ticket's documents and the styles
	 * the "+" menu offers.
	 *
	 * Both absent for a ticket type that cannot carry designs, so the webview
	 * needs no rule of its own about which types those are — an absent list is
	 * what hides the tab bar's "+".
	 */
	async state(
		id: string,
		type: TicketType
	): Promise<{ designs?: DesignSummary[]; designStyles?: DesignStyle[] }> {
		const store = this.designs?.store;
		if (!store || !allowsDesigns(type)) {
			return {};
		}
		return {
			designs: await store.list(id),
			designStyles: (await this.designs?.styles()) ?? []
		};
	}

	/**
	 * Every design tab message. They share a shape — act, then send back the
	 * refreshed tab bar — so one handler keeps the reply consistent and the error
	 * path in one place.
	 */
	async handle(message: DesignToHost): Promise<void> {
		const store = this.designs?.store;
		if (!store) {
			return;
		}

		try {
			switch (message.type) {
				case 'designOpen': {
					const document = await store.get(message.id, message.design);
					if (!document) {
						throw new Error(`Design ${message.design} is no longer on this ticket.`);
					}
					this.host.post({ type: 'designDocument', id: message.id, document });
					// Riding on the open rather than on `ticketDetail`: a conversation
					// belongs to one document, and the tab bar carries every document
					// the ticket has.
					this.onDocumentOpened(message.id, message.design);
					return;
				}

				case 'designCreate': {
					const document = await store.create(message.id, message.style, message.title);
					await this.postDesigns(message.id, document);
					return;
				}

				case 'designSave': {
					const document = await store.update(
						message.id,
						message.design,
						message.body,
						message.baseUpdatedAt,
						message.aiNote
					);
					await this.postDesigns(message.id, document);
					return;
				}

				case 'designRename': {
					const document = await store.rename(message.id, message.design, message.title);
					await this.postDesigns(message.id, document);
					return;
				}

				case 'designDelete': {
					// The confirmation is the host's: a webview cannot open a modal, and
					// deleting a file is the one gesture here that is hard to undo.
					const confirmed = await vscode.window.showWarningMessage(
						`Delete the design “${message.design}”?`,
						{ modal: true, detail: 'The file goes to the trash.' },
						'Delete'
					);
					if (confirmed === 'Delete') {
						await store.remove(message.id, message.design);
						await this.postDesigns(message.id);
					}
					return;
				}
			}
		} catch (error) {
			this.host.post({
				type: 'designError',
				id: message.id,
				design: 'design' in message ? message.design : undefined,
				message:
					error instanceof TicketConflictError
						? 'This design changed on disk since you opened it. Copy your work, reload and try again.'
						: errorMessage(error, 'The design could not be saved.')
			});
		}
	}

	/** The refreshed tab bar, plus the document when one was written. */
	private async postDesigns(id: string, document?: DesignDocument): Promise<void> {
		const store = this.designs?.store;
		if (!store || this.host.isDisposed()) {
			return;
		}
		this.host.post({ type: 'designSaved', id, document, designs: await store.list(id) });
		// A design write files a history entry, which the board's History tab
		// shows — so the ticket has to be re-read, the way a save does it.
		this.host.onChanged();
	}
}
