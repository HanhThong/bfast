// The `vscode` half of technical design documents: reading and writing the
// `.mdx` files that sit beside a ticket's own content file.
//
// A seam of its own rather than more of `TicketWriter`, for the reason
// `TestResultsStore` is one: a design document is not a ticket, and a remote
// tracker's store would have nothing to say about one. `TicketStore` and `TicketWriter` are
// untouched, so `MockTicketStore` and any future backend stay valid.
//
// Everything it writes goes through a promise queue of its own, the
// `FileTicketStore.write` shape — including the `recordNote` that files the
// history entry. Both in one operation is not tidiness: split across two queues
// there would be a window in which neither store reports being busy, and the
// tracker watcher would rescan the tree mid-write.

import * as vscode from 'vscode';
import {
	compareDesigns,
	designFileName,
	designId,
	nextDesignOrdinal,
	parseDesignDocument,
	parseDesignFileName,
	resolveStyle,
	serializeDesignDocument,
	type DesignDocument,
	type DesignStyle,
	type DesignSummary
} from './designDocument';
import { deleteFolder } from '../data/fileTicketStore';
import { TicketConflictError, type WritableTicketStore } from '../data/ticketStore';
import type { TicketSummary } from '../data/types';

/** Raised when a ticket cannot carry design documents, or cannot be found. */
export class DesignNotAllowedError extends Error {}

/**
 * What the store needs from the world, read **at call time** so construction
 * order in `activate()` does not matter — the `TrackerContext` posture.
 */
export interface DesignContext {
	/**
	 * Every style a board offers, built-in ones included. Asynchronous because
	 * a style is declared by a design skill, and skills are files read on demand.
	 */
	styles(): Promise<readonly DesignStyle[]>;
	/** Name stamped on the history entry a write files. */
	author(): string;
}

export class DesignStore {
	private queue: Promise<unknown> = Promise.resolve();
	private writing = 0;

	constructor(
		private readonly tickets: WritableTicketStore,
		private readonly context: DesignContext
	) {}

	/**
	 * Whether a write of ours is in flight, for the tracker watcher's `isBusy`.
	 *
	 * Note what this does *not* buy: an fs event routinely lands after the flag
	 * has cleared, so a design save still usually costs one refresh. That is
	 * wanted — it is how a board in another window, or an editor tab open on the
	 * `.mdx`, learns the document changed.
	 */
	get isWriting(): boolean {
		return this.writing > 0;
	}

	/** Every style a document can be created in — the board's "+" menu. */
	styles(): Promise<readonly DesignStyle[]> {
		return this.context.styles();
	}

	/** Every design document on a ticket, in tab order. Never throws. */
	async list(ticketId: string): Promise<DesignSummary[]> {
		const folder = await this.tickets.folderUri?.(ticketId);
		if (!folder) {
			return [];
		}

		const styles = await this.context.styles();
		const designs: DesignSummary[] = [];
		for (const [name, type] of await readDirectory(folder)) {
			if (!(type & vscode.FileType.File) || !parseDesignFileName(name)) {
				continue;
			}
			const text = await readFile(vscode.Uri.joinPath(folder, name));
			const document = parseDesignDocument(text ?? '', name, ticketId, styles);
			if (document) {
				designs.push(toSummary(document));
			}
		}

		return designs.sort((a, b) => compareDesigns(styles, a, b));
	}

	/** One design document, or `undefined` when it is gone. */
	async get(ticketId: string, id: string): Promise<DesignDocument | undefined> {
		const found = await this.locate(ticketId, id);
		if (!found) {
			return undefined;
		}
		const text = await readFile(vscode.Uri.joinPath(found.folder, found.fileName));
		return text === undefined
			? undefined
			: parseDesignDocument(text, found.fileName, ticketId, await this.context.styles());
	}

	/**
	 * Adds one — **empty**. A new design is written by the assistant from what the
	 * user says it should show, or by hand; a stock diagram dropped in first would
	 * be one more thing to delete before either. The ordinal is claimed from what
	 * is on disk right now, so two boards adding at once cannot land on the same
	 * file name.
	 */
	async create(
		ticketId: string,
		styleId: string,
		title: string,
		body = '',
		comment?: string
	): Promise<DesignDocument> {
		return this.write(async () => {
			const { folder } = await this.requireTicket(ticketId);
			const styles = await this.context.styles();
			const style = styles.find((candidate) => candidate.id === styleId);
			if (!style) {
				throw new DesignNotAllowedError(`No design style called “${styleId}”.`);
			}

			const existing = await this.list(ticketId);
			const ordinal = nextDesignOrdinal(existing, style.prefix);
			const now = new Date().toISOString();
			const document: DesignDocument = {
				id: designId(style.prefix, ordinal),
				ticketId,
				style: style.id,
				prefix: style.prefix,
				ordinal,
				title: title.trim() || 'Untitled',
				fileName: designFileName(style.prefix, ordinal, title),
				body,
				createdBy: this.context.author(),
				createdAt: now,
				updatedAt: now,
				extra: {}
			};

			await writeFile(
				vscode.Uri.joinPath(folder, document.fileName),
				serializeDesignDocument(document)
			);
			await this.note(
				ticketId,
				`Added the “${document.title}” ${style.label.toLowerCase()}.` + (comment ? `\n\n${comment}` : '')
			);
			return document;
		});
	}

	/**
	 * Replaces a document's body.
	 *
	 * `baseUpdatedAt` is the token the board last saw. It is the *document's* own,
	 * never the ticket's: sharing the ticket's would make saving a diagram fail
	 * the next save of a description someone had open mid-edit.
	 */
	async update(
		ticketId: string,
		id: string,
		body: string,
		baseUpdatedAt?: string,
		comment?: string
	): Promise<DesignDocument> {
		return this.write(async () => {
			const current = await this.require(ticketId, id);
			if (baseUpdatedAt !== undefined && current.updatedAt !== baseUpdatedAt) {
				throw new TicketConflictError();
			}

			const folder = await this.requireFolder(ticketId);
			const document: DesignDocument = {
				...current,
				body,
				updatedAt: new Date().toISOString()
			};
			await writeFile(
				vscode.Uri.joinPath(folder, document.fileName),
				serializeDesignDocument(document)
			);

			const style = resolveStyle(await this.context.styles(), document.prefix);
			await this.note(
				ticketId,
				`Updated the “${document.title}” ${style.label.toLowerCase()}.` +
					(comment ? `\n\n${comment}` : '')
			);
			return document;
		});
	}

	/** Retitles one. Only the slug moves; the id keeps its ordinal. */
	async rename(ticketId: string, id: string, title: string): Promise<DesignDocument> {
		return this.write(async () => {
			const current = await this.require(ticketId, id);
			const folder = await this.requireFolder(ticketId);
			const trimmed = title.trim() || 'Untitled';
			const fileName = designFileName(current.prefix, current.ordinal, trimmed);

			const document: DesignDocument = {
				...current,
				title: trimmed,
				fileName,
				updatedAt: new Date().toISOString()
			};
			await writeFile(
				vscode.Uri.joinPath(folder, fileName),
				serializeDesignDocument(document)
			);
			if (fileName !== current.fileName) {
				await deleteFolder(vscode.Uri.joinPath(folder, current.fileName));
			}

			await this.note(ticketId, `Renamed “${current.title}” to “${trimmed}”.`);
			return document;
		});
	}

	/** Removes one, to the trash where there is one. */
	async remove(ticketId: string, id: string): Promise<void> {
		return this.write(async () => {
			const current = await this.require(ticketId, id);
			const folder = await this.requireFolder(ticketId);
			await deleteFolder(vscode.Uri.joinPath(folder, current.fileName));
			await this.note(ticketId, `Deleted the “${current.title}” design.`);
		});
	}

	// ------------------------------------------------------------- internals

	/**
	 * One history entry on the ticket and nothing else — no status change, no
	 * `updatedAt` bump. `history.md` is what changed about the *ticket*; a design
	 * document's own history is git's.
	 */
	private async note(ticketId: string, comment: string): Promise<void> {
		await this.tickets.recordNote(ticketId, 'designed', comment);
	}

	private async require(ticketId: string, id: string): Promise<DesignDocument> {
		const document = await this.get(ticketId, id);
		if (!document) {
			throw new DesignNotAllowedError(`Design ${id} is not on ${ticketId} any more.`);
		}
		return document;
	}

	private async locate(
		ticketId: string,
		id: string
	): Promise<{ folder: vscode.Uri; fileName: string } | undefined> {
		const folder = await this.tickets.folderUri?.(ticketId);
		if (!folder) {
			return undefined;
		}
		for (const [name, type] of await readDirectory(folder)) {
			const parsed = type & vscode.FileType.File ? parseDesignFileName(name) : undefined;
			if (parsed && designId(parsed.prefix, parsed.ordinal) === id) {
				return { folder, fileName: name };
			}
		}
		return undefined;
	}

	/** The ticket, refusing one that may not carry designs. Writing is strict. */
	private async requireTicket(
		ticketId: string
	): Promise<{ ticket: TicketSummary; folder: vscode.Uri }> {
		const ticket = await this.tickets.getSummary(ticketId);
		if (!ticket) {
			throw new DesignNotAllowedError(`${ticketId} is not in the tracker.`);
		}
		if (!allowsDesigns(ticket)) {
			throw new DesignNotAllowedError(
				'Technical design documents belong to an epic or a story.'
			);
		}
		return { ticket, folder: await this.requireFolder(ticketId) };
	}

	/**
	 * `TicketStore.folderUri` is optional — a remote-backed store has no folder
	 * to return — so this feature has to say so rather than assume one.
	 */
	private async requireFolder(ticketId: string): Promise<vscode.Uri> {
		const folder = await this.tickets.folderUri?.(ticketId);
		if (!folder) {
			throw new DesignNotAllowedError(
				'Technical design documents need a folder-backed tracker.'
			);
		}
		return folder;
	}

	/** Runs `operation` after every write already queued, never alongside one. */
	private write<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(async () => {
			this.writing++;
			try {
				return await operation();
			} finally {
				this.writing--;
			}
		});

		// The queue has to survive a rejection, or one failed write blocks the rest.
		this.queue = run.catch(() => undefined);
		return run;
	}
}

function allowsDesigns(ticket: TicketSummary): boolean {
	return ticket.type === 'epic' || ticket.type === 'story';
}

function toSummary(document: DesignDocument): DesignSummary {
	const { id, ticketId, style, prefix, ordinal, title, fileName, updatedAt } = document;
	return { id, ticketId, style, prefix, ordinal, title, fileName, updatedAt };
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return [];
	}
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}
