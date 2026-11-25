// The board's own messages: which ticket it shows, its description, its images.
//
// One file per webview concern, joined in `index.ts`. See the note there.

import type { LinkRelation } from '../../data/ticketLinks';
import type { TicketDetail } from '../../data/types';
// `designDocument.ts` is Node-free for the same reason `testReport.ts` is: the
// store that writes these files imports `vscode`, and this module is bundled
// into every webview.
import type { DesignStyle, DesignSummary } from '../../design/designDocument';

/**
 * The largest image `insertImage` may carry, and the largest file the host will
 * copy into a ticket's `assets/`.
 *
 * Part of the protocol rather than a constant on either side, because both have
 * to agree: the webview checks it so a mistake fails before the bytes are
 * encoded, and the host checks it again because the webview is the untrusted
 * half. A paste or a drop at this size travels as base64 and will not be
 * instant; the toolbar's file picker never crosses the bridge and stays quick.
 */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** What this part of the webview sends to the extension host. */
export type TicketToHost =
	| {
			type: 'ready';
			/** What the board was showing before a reload, if anything. */
			selectedId?: string;
	  }
	| {
			/**
			 * The description, or a design document, entered edit mode. The host
			 * pins a preview tab on it — the way a file is pinned the moment it is
			 * dirtied — and nothing else; the webview knows nothing about tabs.
			 */
			type: 'editStarted';
			id: string;
	  }
	| {
			type: 'saveDescription';
			id: string;
			description: string;
			/**
			 * The `updatedAt` the board last saw. The host refuses the write when
			 * the file on disk has moved on since, rather than overwriting an edit
			 * made in an editor tab or pulled in from git.
			 */
			baseUpdatedAt?: string;
			/**
			 * Set when the draft being saved came out of an AI run. Becomes the
			 * history entry's comment, so `history.md` records the provenance —
			 * which provider, which model, what it cost — beside the change itself.
			 */
			aiNote?: string;
	  }
	/**
	 * The toolbar's image button. The host owns the whole flow — dialog, read,
	 * copy — so no bytes cross the bridge for this one.
	 *
	 * `requestId` correlates the reply: the dialog is modal and slow, the button
	 * can be pressed twice, and a paste can be in flight at the same time.
	 */
	| { type: 'pickImage'; requestId: string; id: string }
	| {
			/** A paste, or a drop that carried a real `File`. The bytes are only here. */
			type: 'insertImage';
			requestId: string;
			id: string;
			fileName: string;
			/**
			 * Standard base64, no `data:` prefix. A webview may only post strings
			 * and json-serializable values, so a typed array is not an option.
			 * Size-capped here and re-checked by the host.
			 */
			data: string;
	  }
	| {
			/** A drag out of the VS Code explorer hands over a uri, not a `File`. */
			type: 'insertImageFromUri';
			requestId: string;
			id: string;
			uri: string;
	  }
	| { type: 'openTicket'; id: string }
	/**
	 * "Link ticket": the host asks which relation and which ticket in two quick
	 * picks — a searchable list of every ticket is VS Code's to draw, not the
	 * board's — and every open board repaints from the write.
	 */
	| { type: 'linkTicket'; id: string }
	/** The × on a link row. Carries the relation and the id exactly as the board showed them. */
	| { type: 'unlinkTicket'; id: string; relation: LinkRelation; targetId: string }
	| { type: 'openSettings' };

/**
 * Messages the extension host sends to the webview.
 *
 * `assetBase` is the ticket's own folder as a uri the webview may load, which is
 * what turns an `assets/x.png` in the description into a visible image. It rides
 * on the message rather than living on `TicketDetail`, because that type is the
 * `vscode`-free domain model and has no business knowing about webview uris.
 */
export type HostToTicket =
	| {
			type: 'ticketDetail';
			ticket: TicketDetail;
			assetBase?: string;
			/**
			 * The ticket's design documents, and the styles the "+" menu offers.
			 *
			 * They ride on this message rather than being fetched separately so the
			 * tab bar is correct on the board's very first paint — and so a create
			 * or a delete in another window repaints this one for free, since every
			 * watcher event ends in a `reloadAll`. Absent for a ticket type that
			 * cannot carry them.
			 */
			designs?: DesignSummary[];
			designStyles?: DesignStyle[];
	  }
	/** The save landed; carries the re-read ticket, so `updatedAt` and history follow. */
	| {
			type: 'ticketSaved';
			ticket: TicketDetail;
			assetBase?: string;
			designs?: DesignSummary[];
			designStyles?: DesignStyle[];
	  }
	| { type: 'ticketError'; id: string; message: string }
	| {
			type: 'imageInserted';
			requestId: string;
			/** Ticket-relative, ready to splice into the draft: `assets/diagram.png`. */
			path: string;
			/** What goes in the `![alt]` half, from the same sanitised name. */
			alt: string;
	  }
	| {
			/**
			 * Also sent when the user simply closed the file dialog, so the board can
			 * drop its pending state; `message` is absent in that case.
			 */
			type: 'imageFailed';
			requestId: string;
			message?: string;
	  };
