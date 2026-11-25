// Domain model for BFAST tickets. Shared between the extension host and the
// webview (the webview imports these with `import type`, so nothing from this
// file ends up in the webview bundle at runtime).

import type { LinkRelation } from './ticketLinks';

export type TicketType = 'epic' | 'story' | 'ac' | 'testcase';

export type TicketStatus = 'todo' | 'in-progress' | 'in-review' | 'done' | 'blocked';

/** Every type, in the order siblings are listed under a parent. */
export const TICKET_TYPES: readonly TicketType[] = ['epic', 'story', 'ac', 'testcase'];

/** Every status, in the order they are offered in the "Set status" quick pick. */
export const TICKET_STATUSES: readonly TicketStatus[] = [
	'todo',
	'in-progress',
	'in-review',
	'done',
	'blocked'
];

/**
 * What the tree needs to render a node. Kept small: a level is listed before
 * any description is read, and the sidebar's filter lists every ticket.
 */
export interface TicketSummary {
	id: string;
	key: string;
	type: TicketType;
	title: string;
	status: TicketStatus;
	assignee?: string;
	/** A test case's service (`tests.services` id) — docs/tests/services.md. */
	service?: string;
	/** Parent ticket id, absent for top-level epics. */
	parentId?: string;
	/**
	 * Whether the ticket's folder holds a subfolder that could be a child
	 * ticket — from the listing the store already made, not from loading the
	 * children, so a stray non-ticket folder counts too. The sidebar draws an
	 * expander on it; absent means the store cannot say.
	 */
	hasChildren?: boolean;
	/**
	 * Set when the ticket loaded but something about it is off — an acceptance
	 * criterion with no test case, a missing `metadata.yaml`. Advisory only: the
	 * ticket still appears in the tree.
	 */
	warning?: string;
}

export interface HistoryEntry {
	id: string;
	/** ISO 8601 timestamp. */
	timestamp: string;
	author: string;
	/** Human readable verb, e.g. 'created', 'changed status'. */
	action: string;
	field?: string;
	from?: string;
	to?: string;
	comment?: string;
}

/** Loaded on demand when a ticket is selected. */
export interface TicketDetail extends TicketSummary {
	description: string;
	history: HistoryEntry[];
	createdBy?: string;
	/** ISO 8601 timestamp. */
	createdAt?: string;
	/**
	 * ISO 8601 timestamp. Doubles as the optimistic-concurrency token: the board
	 * echoes back the value it last saw, and a save is refused when the file on
	 * disk has moved on since.
	 */
	updatedAt?: string;
	/**
	 * Links to other tickets, as this ticket records them, each resolved to the
	 * ticket it names. A link whose ticket is not in the tracker — deleted by
	 * hand, or lost in a merge — keeps its id and has no `target`, so the board
	 * can say so and offer to remove it. Absent from a store that has none.
	 */
	links?: TicketLinkView[];
}

/** One link on a ticket's board: the relation, and the other ticket as it is now. */
export interface TicketLinkView {
	relation: LinkRelation;
	id: string;
	target?: Pick<TicketSummary, 'id' | 'key' | 'type' | 'title' | 'status'>;
}

/**
 * The verdict a recorded test run reached. `unknown` is a run folder with no
 * readable `run.json` — a write that died mid-way, or a folder made by hand —
 * which is listed with whatever files it holds rather than dropped.
 */
export type TestRunOutcome = 'passed' | 'failed' | 'timeout' | 'unknown';

/** One evidence file in a run folder — never `run.json` or `output.log`. */
export interface TestRunFile {
	name: string;
	size?: number;
	/**
	 * Named by `run.json` but not on disk: a teammate gitignored the traces, say.
	 * Shown greyed and never turned into a url or a command.
	 */
	missing?: boolean;
}

/**
 * One recorded run of a test case — the contents of `<ticket>/evidence/<id>/`.
 * The directory listing is authoritative for `files` and `hasOutput`; `run.json`
 * supplies everything else, and reads forgivingly (see `data/testRunFile.ts`).
 */
export interface TestRunRecord {
	/** The folder name under `evidence/`: the start time with `:` → `-`. */
	id: string;
	/** ISO 8601. Absent when `run.json` was unreadable and the folder name did not parse. */
	startedAt?: string;
	finishedAt?: string;
	outcome: TestRunOutcome;
	exitCode?: number | null;
	/** The rendered command line that ran. */
	command?: string;
	author?: string;
	/** The rendered `tests.evidence` pattern, so "no files matched" can say what was searched. */
	evidencePattern?: string;
	files: TestRunFile[];
	/** Whether `output.log` is there to read. */
	hasOutput: boolean;
	/** `output.log` is the tail of a longer stream. */
	outputTruncated?: boolean;
	/** What the run could not do: files skipped, older matches ignored, a source that vanished. */
	warnings?: string[];
}
