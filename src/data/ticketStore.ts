import * as vscode from 'vscode';
import type { LinkRelation } from './ticketLinks';
import { TicketDetail, TicketStatus, TicketSummary, TicketType } from './types';

/**
 * The single seam between the board UI and wherever tickets actually live.
 * `FileTicketStore` reads the configured tracker folder; `MockTicketStore` is a
 * read-only fixture for the tree tests. A store backed by a remote tracker's
 * API could be dropped in later without touching the panel or the webview.
 */
export interface TicketStore {
	/**
	 * Every ticket, flat, in tree order. A whole-tracker read, for the commands
	 * that need a subtree — Run Tests, a batch's scope, the Tests tab's report,
	 * the new-environment pick — and for the sidebar's filter, which has to see
	 * everything to search it. The tree itself reads a level at a time.
	 */
	listSummaries(): Promise<TicketSummary[]>;
	/**
	 * One level, in tree order (type, then ordinal): the epics when `parentId`
	 * is absent, else that ticket's direct children. Reads only that folder,
	 * which is what lets the sidebar open a large tracker without reading it.
	 * An unknown parent lists nothing.
	 */
	listChildren(parentId?: string): Promise<TicketSummary[]>;
	/**
	 * One ticket's summary, found by walking down through its ancestors'
	 * folders — never by reading the whole tracker.
	 */
	getSummary(id: string): Promise<TicketSummary | undefined>;
	getDetail(id: string): Promise<TicketDetail | undefined>;

	/**
	 * Where the ticket lives, for "Reveal in File Explorer" and for the board to
	 * resolve the images in its description. Optional because a ticket does not
	 * have to be a folder: a remote-backed store would have nothing to
	 * return here.
	 */
	folderUri?(id: string): Promise<vscode.Uri | undefined>;

	/**
	 * The inverse: the ticket whose folder holds `uri`, when `uri` is inside one.
	 * Optional for the same reason, and resolved by walking the nesting — a
	 * folder's name is only a claim about its id, and a rank never appears in one.
	 */
	ticketAt?(uri: vscode.Uri): Promise<TicketSummary | undefined>;

	/**
	 * Every ticket folder whose name is longer than `MAX_FOLDER_NAME`, and the
	 * name it would get — what `shortenFolderNames` would do, without doing it.
	 * Optional for the `folderUri` reason. docs/tracker/ is the specification.
	 */
	longFolderNames?(): Promise<FolderRename[]>;
}

/** One ticket folder's rename: its name now and the one it gets — names, not paths. */
export interface FolderRename {
	id: string;
	from: string;
	to: string;
}

/** What `shortenFolderNames` did. */
export interface ShortenOutcome {
	renamed: FolderRename[];
	/** Left as they were, and why — a name already taken, a folder held open. */
	skipped: (FolderRename & { reason: string })[];
}

/** What a caller knew about a description before something else changed it. */
export interface PreviousDescription {
	/** The text as it was; absent when it could not be captured. */
	text?: string;
	/** The ticket's `updatedAt` at that moment; absent when unread. */
	updatedAt?: string;
}

/** What `adoptDescription` did. */
export type AdoptOutcome =
	/** Disk had moved on from what the caller knew: recorded, `updatedAt` bumped. */
	| { outcome: 'recorded'; ticket: TicketDetail }
	/** Disk holds exactly the previous text: nothing changed, nothing written. */
	| { outcome: 'unchanged'; ticket: TicketDetail }
	/**
	 * The store wrote the ticket after the caller looked — a Save from a board —
	 * so the change is already in history under its own author and this one
	 * would be a lie. Nothing written.
	 */
	| { outcome: 'superseded'; ticket: TicketDetail };

export interface CreateTicketRequest {
	/** Absent for a top-level epic. */
	parentId?: string;
	type: TicketType;
	title: string;
	description?: string;
	assignee?: string;
	/**
	 * Provenance for the `created` history entry. The sidebar's generate commands
	 * put the model, turns and cost here, so a ticket whose description a model
	 * wrote says so in git — the same job `DescriptionChangeNote.comment` does for
	 * an edit, which a create cannot use because there is no description to change.
	 */
	comment?: string;
}

/**
 * Extra provenance to record beside a description change.
 *
 * `comment` lands in the history entry's blockquote — the one field
 * `NewHistoryEntry` has always accepted and nothing used until the AI assistant
 * needed somewhere to say which provider and model produced the text, and what
 * the run cost.
 */
export interface DescriptionChangeNote {
	comment?: string;
}

/**
 * Extra provenance to record beside a status change — the job
 * `DescriptionChangeNote` does for an edit. The test runner names the run
 * that set the status here, so `git log` on the tracker can say which run
 * in the results folder a `done` or `blocked` came from.
 */
export interface StatusChangeNote {
	comment?: string;
}

/**
 * Extra provenance to record beside a title change. The MCP server says here
 * that the rename arrived from a connected tool, so a reader can tell where it
 * came from without it being a different kind of change.
 */
export interface TitleChangeNote {
	comment?: string;
}

/** Provenance beside a type change — the `TitleChangeNote` job. */
export interface TypeChangeNote {
	comment?: string;
}

/** Provenance beside a link or an unlink — the `TitleChangeNote` job. */
export interface LinkChangeNote {
	comment?: string;
}

/** What `planTypeChange` found: the ticket's id now and the one it would get. */
export interface TypeChangePlan {
	id: string;
	newId: string;
}

/** The write half, kept separate so a read-only store can still be a `TicketStore`. */
export interface TicketWriter {
	createTicket(request: CreateTicketRequest): Promise<TicketSummary>;

	/**
	 * Creates an acceptance criterion together with its first test case, or
	 * neither. An AC with no test case is not something this should be able to
	 * produce, so the two writes succeed or fail as one.
	 */
	createAcceptanceCriterion(
		storyId: string,
		acTitle: string,
		testCaseTitle: string
	): Promise<TicketSummary>;

	/**
	 * `baseUpdatedAt` is the `updatedAt` the caller last saw. When it no longer
	 * matches the file on disk the write is refused rather than clobbering an
	 * edit made elsewhere.
	 */
	updateDescription(
		id: string,
		description: string,
		baseUpdatedAt?: string,
		note?: DescriptionChangeNote
	): Promise<TicketDetail>;

	updateStatus(id: string, status: TicketStatus, note?: StatusChangeNote): Promise<TicketDetail>;

	/**
	 * Assigns a **test case** to a service (`tests.services` id), or clears it
	 * with `undefined`. One `changed — service` entry and an `updatedAt` bump —
	 * it changes which command runs the ticket — and nothing at all when the
	 * service is already that one. Refuses any other ticket type.
	 * docs/tests/services.md is the spec.
	 */
	setService(id: string, service: string | undefined, note?: StatusChangeNote): Promise<TicketDetail>;

	/**
	 * Appends one history entry and nothing else — no status change, and no
	 * `updatedAt` bump.
	 *
	 * A code scan's verdict is a fact *about* a ticket, not an edit of it, and
	 * `updateStatus(id, itsCurrentStatus, note)` would write
	 * `changed — status — from: todo — to: todo`, which is a lie in a file people
	 * read. It leaves `updatedAt` alone for `addAttachment`'s reason: a board
	 * sitting open mid-edit is holding the `updatedAt` it read when Edit was
	 * pressed, and bumping it would fail the user's own next save over something
	 * they never asked to be an edit.
	 */
	recordNote(id: string, action: string, comment: string): Promise<TicketDetail>;

	/**
	 * Records a change to the description file that something *other than the
	 * store* made — an AI run's `Edit`, which writes the file directly — so
	 * `updatedAt` moves and `history.md` says what happened, as it would for a
	 * save. Without it a board open mid-edit on that ticket sees no drift and
	 * its next save clobbers the change silently.
	 *
	 * `previous` is what the caller knew before the change: its `text` becomes
	 * `from` (omitted when unknown — better no claim than a wrong one), and its
	 * `updatedAt` is the concurrency token: when the store has written the ticket
	 * since, the outcome is `superseded` and nothing is recorded.
	 */
	adoptDescription(
		id: string,
		previous: PreviousDescription | undefined,
		note: DescriptionChangeNote
	): Promise<AdoptOutcome>;

	/**
	 * A rename to the title the ticket already carries changes nothing and
	 * writes nothing — no history entry, no `updatedAt` bump — so a tool that
	 * retries, or sets the same title on every loop, does not fill the history
	 * with non-events.
	 */
	renameTicket(id: string, title: string, note?: TitleChangeNote): Promise<TicketSummary>;

	/**
	 * What `changeType` would do — the id the ticket would get — without doing
	 * it, or a `TicketTypeChangeError` saying why it cannot. Lets a command
	 * name the new id in its confirmation and refuse before asking.
	 */
	planTypeChange(id: string, type: TicketType): Promise<TypeChangePlan>;

	/**
	 * Turns an epic into a story or a story into an epic (`convertibleTypes`),
	 * refused by `typeChangeRefusal`. The ticket keeps its ordinal unless a
	 * hand-made clash already holds it, so its id changes only in the prefix
	 * (`EP-1.2` → `ST-1.2`); its description file is renamed, the folder too,
	 * and one `changed — type` entry is written with an `updatedAt` bump —
	 * this one *is* a change to the ticket. The same type again is a non-event,
	 * the `renameTicket` rule.
	 */
	changeType(id: string, type: TicketType, note?: TypeChangeNote): Promise<TicketSummary>;

	/**
	 * Links `id` to `targetId` (`ST-1.1 blocks ST-1.2`). Both sides are written —
	 * `relation` on this ticket, its inverse on the other — each with one
	 * `linked` history entry and **no** `updatedAt` bump, for `addAttachment`'s
	 * reason: a link is not an edit of the description a board may have open.
	 * The same link again is a non-event; a link to itself, or to a ticket that
	 * is not in the tracker, is refused. docs/tracker/ §Links is the spec.
	 */
	linkTickets(
		id: string,
		relation: LinkRelation,
		targetId: string,
		note?: LinkChangeNote
	): Promise<TicketDetail>;

	/**
	 * The inverse of `linkTickets`: removes both sides, each with an `unlinked`
	 * entry. A link whose other ticket has gone is removed from this side alone;
	 * a link that is not there is a non-event.
	 */
	unlinkTickets(
		id: string,
		relation: LinkRelation,
		targetId: string,
		note?: LinkChangeNote
	): Promise<TicketDetail>;

	/**
	 * Deletes the ticket and everything under it, and takes the other side of
	 * every link the subtree held off the tickets that remain, so none of them
	 * goes on pointing at a ticket that is gone.
	 */
	deleteTicket(id: string): Promise<void>;

	/**
	 * Copies bytes into the ticket's `assets/` folder, creating it if needed, and
	 * returns the path to reference the file by, relative to the ticket folder
	 * (`assets/diagram.png`). The name is sanitised, and suffixed when it is
	 * already taken — an existing asset is never overwritten.
	 *
	 * Deliberately does **not** count as a change to the ticket: it leaves
	 * `updatedAt` and `history.md` alone. See `FileTicketStore.addAttachment`.
	 */
	addAttachment(id: string, fileName: string, bytes: Uint8Array): Promise<string>;

	/**
	 * Renames every folder `longFolderNames` lists to the name a ticket with
	 * that id and title is given today. Only names move: no history entry and
	 * no `updatedAt` bump, for `addAttachment`'s reason — a folder's name is not
	 * a change to the ticket. A folder that cannot be renamed is skipped and
	 * reported, never overwritten. Optional for the `folderUri` reason.
	 */
	shortenFolderNames?(): Promise<ShortenOutcome>;
}

export interface WritableTicketStore extends TicketStore, TicketWriter {}

/** Thrown when a write is attempted before a tracker folder is configured. */
export class TrackerNotConfiguredError extends Error {
	constructor() {
		super('Configure a BFAST tracker folder before creating tickets.');
		this.name = 'TrackerNotConfiguredError';
	}
}

/** Thrown when a type change would break the hierarchy; the message says how. */
export class TicketTypeChangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TicketTypeChangeError';
	}
}

/** Thrown when the ticket changed on disk since the caller last read it. */
export class TicketConflictError extends Error {
	constructor() {
		super('This ticket changed on disk since you opened it. Refresh before saving.');
		this.name = 'TicketConflictError';
	}
}
