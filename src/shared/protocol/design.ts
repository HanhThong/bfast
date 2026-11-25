// The board's design tabs: one technical design document at a time.
//
// One file per webview concern, joined in `index.ts`. See the note there.

// `designDocument.ts` is Node-free for the same reason `testReport.ts` is: the
// store that writes these files imports `vscode`, and this module is bundled
// into every webview.
import type { DesignDocument, DesignSummary } from '../../design/designDocument';

/** What this part of the webview sends to the extension host. */
export type DesignToHost =
	/**
	 * A story or criterion row on a parent's tab, or the selected test case's
	 * title: open that ticket's own board.
	 */
	/**
	 * The board's design tabs.
	 *
	 * `id` is always the board's ticket, the way the Tests tab's messages are
	 * keyed — a reply that lands after the board moved on is dropped. `design` is
	 * a document id (`ERD-1`), unique within its ticket.
	 *
	 * There is deliberately no `designList`: the list rides on `ticketDetail`, so
	 * the tab bar is right the moment the board paints.
	 */
	| { type: 'designOpen'; id: string; design: string }
	| {
			type: 'designSave';
			id: string;
			design: string;
			body: string;
			/**
			 * The document's own `updatedAt`, as the webview last saw it — never the
			 * ticket's. The store refuses the write when disk has moved on.
			 */
			baseUpdatedAt?: string;
			/** Provenance for the history entry, when the body came from a run. */
			aiNote?: string;
	  }
	| { type: 'designCreate'; id: string; style: string; title: string }
	| { type: 'designRename'; id: string; design: string; title: string }
	/** The host confirms before deleting: a webview cannot open a modal. */
	| { type: 'designDelete'; id: string; design: string };

/** What the extension host sends back. */
export type HostToDesign =
	/** One design document's full body, in answer to `designOpen`. */
	| { type: 'designDocument'; id: string; document: DesignDocument }
	/** A create, save or rename landed. `designs` is the refreshed tab bar. */
	| {
			type: 'designSaved';
			id: string;
			document?: DesignDocument;
			designs: DesignSummary[];
	  }
	| { type: 'designError'; id: string; design?: string; message: string };
