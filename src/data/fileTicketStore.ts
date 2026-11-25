import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	appendHistory,
	HISTORY_FILE,
	NewHistoryEntry,
	parseHistory,
	serializeHistory
} from './historyFile';
import { METADATA_FILE, parseMetadata, serializeMetadata, TicketMetadata } from './ticketMetadata';
import {
	CreateTicketRequest,
	DescriptionChangeNote,
	LinkChangeNote,
	StatusChangeNote,
	TicketConflictError,
	TicketTypeChangeError,
	TitleChangeNote,
	TypeChangeNote,
	TrackerNotConfiguredError,
	WritableTicketStore,
	type AdoptOutcome,
	type FolderRename,
	type PreviousDescription,
	type ShortenOutcome,
	type TypeChangePlan
} from './ticketStore';
import {
	hasLink,
	inverseRelation,
	LINK_RELATION_INFO,
	retargetLinks,
	withLink,
	withoutLink,
	type LinkRelation,
	type TicketLink
} from './ticketLinks';
import { TrackerContext } from './trackerContext';
import {
	allowedChildTypes,
	fallbackChildType,
	isContainerType,
	assetFileName,
	ASSETS_FOLDER,
	buildId,
	buildTreeId,
	deslugify,
	folderName,
	type IdSegment,
	localOf,
	MAX_FOLDER_NAME,
	nextOrdinal,
	ordinalKey,
	parseFolderName,
	parseLocalSegment,
	parseTreeId,
	suffixFileName,
	typeChangeRefusal,
	typeFromContentFile,
	typeRank,
	TYPE_FILE
} from './trackerPaths';
import { TicketDetail, TicketLinkView, TicketStatus, TicketSummary, TicketType } from './types';
import { errorMessage } from '../platform/errors';

/** A tracker nested deeper than this is a symlink loop, not a backlog. */
const MAX_DEPTH = 10;

/** How many ordinals to try before giving up on a folder name collision. */
const MAX_NAME_ATTEMPTS = 10;

/** What loaded but is not quite right. Advisory: the ticket still shows up. */
const WARNING_TEXT = {
	'missing-metadata': 'No metadata.yaml',
	'missing-content': 'No description file',
	'duplicate-id': 'Duplicate id',
	'id-drift': 'Id does not match its folder',
	'ac-without-testcase': 'No test case yet'
} as const;

type TicketWarning = keyof typeof WARNING_TEXT;

interface LoadedTicket {
	summary: TicketSummary;
	/**
	 * The id the nesting gives this ticket, before any `#2` suffix a duplicate
	 * picks up. This is the one that goes in the folder name and the metadata.
	 */
	resolvedId: string;
	/** The ticket's own folder. */
	uri: vscode.Uri;
	type: TicketType;
	ordinal: number;
	/** Every ancestor's ordinal then this one, for building children's ids. */
	ordinalPath: number[];
	/** The same path with ranks, which is what `summary.id` is built from. */
	idPath: IdSegment[];
	metadata: TicketMetadata;
	warnings: TicketWarning[];
}

/**
 * Everything read since the last `invalidate()`: one memoised load per level,
 * keyed by the parent's id (`''` for the root), and every ticket those loads
 * produced, by id. Replaced whole, never cleared — see `invalidate`.
 */
interface Generation {
	levels: Map<string, Promise<LoadedTicket[]>>;
	known: Map<string, LoadedTicket>;
}

function newGeneration(): Generation {
	return { levels: new Map(), known: new Map() };
}

/**
 * Tickets stored as folders under the configured tracker directory: one folder
 * per ticket, holding its description (`Epic.mdx`, `Story.mdx`, `AC.mdx` or
 * `TestCase.mdx`), a `metadata.yaml` and a `history.md`, with child tickets as
 * subfolders. Test runs are not in here: they are the results store's
 * (`testing/testResultsStore.ts`), outside the tracker.
 *
 * The tracker is meant to live in git and be edited by hand, so reading is
 * forgiving: a folder missing a file, carrying a hand-typed id, or holding
 * something that is not a ticket at all degrades to a warning rather than an
 * error. Writing is the strict half — it re-reads from disk immediately before
 * every change and serialises concurrent writes.
 */
export class FileTicketStore implements WritableTicketStore {
	private generation = newGeneration();

	/** Serialises writes, so two saves cannot interleave on the same file. */
	private queue: Promise<unknown> = Promise.resolve();

	private writing = 0;

	constructor(private readonly context: TrackerContext) {}

	/** True while this store is writing, so a watcher can ignore its own noise. */
	get isWriting(): boolean {
		return this.writing > 0;
	}

	/**
	 * Drops everything read so far; the next read goes back to disk. A fresh
	 * generation is assigned rather than the maps cleared: `write()` invalidates
	 * in its `finally` while a read's level load may still be in flight, and that
	 * load closes over the generation it started in — so it lands its result
	 * there, resolves its caller with what disk said when it was asked, and can
	 * never leak a pre-write row into the generation that outlives it.
	 */
	invalidate(): void {
		this.generation = newGeneration();
	}

	dispose(): void {
		this.invalidate();
	}

	async listSummaries(): Promise<TicketSummary[]> {
		return (await this.loadAll()).map((ticket) => ticket.summary);
	}

	async listChildren(parentId?: string): Promise<TicketSummary[]> {
		const parent = parentId === undefined ? undefined : await this.find(parentId);
		if (parentId !== undefined && !parent) {
			return [];
		}
		return (await this.level(parent)).map((ticket) => ticket.summary);
	}

	async getSummary(id: string): Promise<TicketSummary | undefined> {
		return (await this.find(id))?.summary;
	}

	async getDetail(id: string): Promise<TicketDetail | undefined> {
		const ticket = await this.find(id);
		return ticket ? this.readDetail(ticket) : undefined;
	}

	/** Where a ticket lives, for "Reveal in File Explorer". */
	async folderUri(id: string): Promise<vscode.Uri | undefined> {
		return (await this.find(id))?.uri;
	}

	async longFolderNames(): Promise<FolderRename[]> {
		return (await this.loadAll()).flatMap((ticket) => shortened(ticket) ?? []);
	}

	async createTicket(request: CreateTicketRequest): Promise<TicketSummary> {
		return this.write(async () => {
			const parent = request.parentId ? await this.require(request.parentId) : undefined;

			if (!allowedChildTypes(parent?.type).includes(request.type)) {
				throw new Error(
					parent
						? `A ${parent.type} cannot contain a ${request.type}.`
						: `A ${request.type} cannot sit at the top level.`
				);
			}

			return this.createUnder(parent, request);
		});
	}

	async createAcceptanceCriterion(
		storyId: string,
		acTitle: string,
		testCaseTitle: string
	): Promise<TicketSummary> {
		return this.write(async () => {
			const story = await this.require(storyId);
			if (story.type !== 'story') {
				throw new Error('An acceptance criterion belongs to a story.');
			}

			const ac = await this.createUnder(story, { type: 'ac', title: acTitle });
			const acFolder = this.lastCreatedUri;

			try {
				this.invalidate();
				await this.createUnder(await this.require(ac.id), {
					type: 'testcase',
					title: testCaseTitle
				});
			} catch (error) {
				// An acceptance criterion with no test case is exactly what this
				// method exists to prevent, so undo rather than leave one behind.
				if (acFolder) {
					await this.remove(acFolder);
				}
				throw error;
			}

			return ac;
		});
	}

	async updateDescription(
		id: string,
		description: string,
		baseUpdatedAt?: string,
		note?: DescriptionChangeNote
	): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const metadata = await this.readMetadata(ticket);

			// The caller edited what it last read; if disk has moved on since,
			// saving would silently drop whatever changed it.
			if (baseUpdatedAt !== undefined && metadata.updatedAt !== baseUpdatedAt) {
				throw new TicketConflictError();
			}

			// Read before writing, so the entry can say what the text actually was
			// rather than only that it changed.
			const previous = (await this.readFile(ticket.uri, TYPE_FILE[ticket.type])) ?? '';

			await this.writeFile(ticket.uri, TYPE_FILE[ticket.type], description);
			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'description',
				from: previous,
				to: description,
				// Spread rather than pass `undefined`, so an ordinary edit serialises
				// exactly as it always has and existing history files still read.
				...(note?.comment ? { comment: note.comment } : {})
			});

			return this.readDetail(ticket, metadata);
		});
	}

	async updateStatus(
		id: string,
		status: TicketStatus,
		note?: StatusChangeNote
	): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const metadata = await this.readMetadata(ticket);
			const from = metadata.status;

			metadata.status = status;
			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'status',
				from,
				to: status,
				// Spread rather than pass `undefined`, so an ordinary status change
				// serialises exactly as it always has — same rule as updateDescription.
				...(note?.comment ? { comment: note.comment } : {})
			});

			ticket.summary = { ...ticket.summary, status };
			return this.readDetail(ticket, metadata);
		});
	}

	/**
	 * Assigns a test case to a service, or clears it — see `TicketWriter.setService`.
	 * Through `touch`, like a status change: it changes what the ticket runs as.
	 * The same service again is a non-event and writes nothing.
	 */
	async setService(
		id: string,
		service: string | undefined,
		note?: StatusChangeNote
	): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			if (ticket.type !== 'testcase') {
				throw new Error(`Only a test case runs as a service; ${ticket.summary.key} is not one.`);
			}
			const next = service?.trim() || undefined;
			if (next !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(next)) {
				throw new Error(`“${next}” is not a service id.`);
			}
			const metadata = await this.readMetadata(ticket);
			const from = metadata.service;
			if (from === next) {
				return this.readDetail(ticket, metadata);
			}
			if (next === undefined) {
				delete metadata.service;
			} else {
				metadata.service = next;
			}
			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'service',
				...(from !== undefined ? { from } : {}),
				...(next !== undefined ? { to: next } : {}),
				...(note?.comment ? { comment: note.comment } : {})
			});
			const { service: _dropped, ...rest } = ticket.summary;
			ticket.summary = next === undefined ? rest : { ...rest, service: next };
			return this.readDetail(ticket, metadata);
		});
	}

	/**
	 * One history entry, no metadata write — see `TicketWriter.recordNote`.
	 *
	 * Deliberately **not** through `touch`, which exists to stamp `updatedAt` and
	 * rewrite the metadata. Both are wrong here: nothing about the ticket changed,
	 * and bumping `updatedAt` would fail the next save of a board that is open
	 * mid-edit. Still through `write`, so it serialises with every other write the
	 * way a scan landing during a rename has to.
	 */
	async recordNote(id: string, action: string, comment: string): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const metadata = await this.readMetadata(ticket);

			const history = await this.readFile(ticket.uri, HISTORY_FILE);
			await this.writeFile(
				ticket.uri,
				HISTORY_FILE,
				appendHistory(history, {
					action,
					comment,
					timestamp: new Date().toISOString(),
					author: this.context.author()
				})
			);

			return this.readDetail(ticket, metadata);
		});
	}

	/**
	 * See `TicketWriter.adoptDescription`. Goes through `write()`, so it
	 * serialises with every save — the check on `updatedAt` below is only
	 * meaningful if nothing can write between the read and the touch.
	 */
	async adoptDescription(
		id: string,
		previous: PreviousDescription | undefined,
		note: DescriptionChangeNote
	): Promise<AdoptOutcome> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const metadata = await this.readMetadata(ticket);
			const current = (await this.readFile(ticket.uri, TYPE_FILE[ticket.type])) ?? '';

			if (previous?.updatedAt !== undefined && previous.updatedAt !== metadata.updatedAt) {
				return { outcome: 'superseded', ticket: await this.readDetail(ticket, metadata) };
			}
			if (previous?.text !== undefined && previous.text === current) {
				return { outcome: 'unchanged', ticket: await this.readDetail(ticket, metadata) };
			}

			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'description',
				// `from` only when the caller could vouch for it: a `to`-only entry
				// reads as "this is what it became", which is true, where a guessed
				// `from` would not be.
				...(previous?.text !== undefined ? { from: previous.text } : {}),
				to: current,
				...(note.comment ? { comment: note.comment } : {})
			});
			return { outcome: 'recorded', ticket: await this.readDetail(ticket, metadata) };
		});
	}

	/**
	 * The ticket whose folder holds `uri` — the inverse of `folderUri`, walked
	 * down the nesting one level at a time so a rank or an `id-drift` folder
	 * resolves the way the tree resolves it, never by parsing the folder's name.
	 */
	async ticketAt(uri: vscode.Uri): Promise<TicketSummary | undefined> {
		const target = uri.fsPath;
		let parent: LoadedTicket | undefined;
		for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
			const level = await this.level(parent);
			const next = level.find((ticket) => within(ticket.uri.fsPath, target));
			if (!next) {
				return undefined;
			}
			if (path.dirname(target) === next.uri.fsPath) {
				return next.summary;
			}
			parent = next;
		}
		return undefined;
	}

	async renameTicket(
		id: string,
		title: string,
		note?: TitleChangeNote
	): Promise<TicketSummary> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const metadata = await this.readMetadata(ticket);
			const from = metadata.title;
			const trimmed = title.trim();

			// The same title is not a change: no entry, no `updatedAt` bump.
			if (trimmed === from) {
				return { ...ticket.summary, title: trimmed };
			}

			metadata.title = trimmed;
			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'title',
				from,
				to: trimmed,
				// Spread rather than pass `undefined` — the updateStatus rule.
				...(note?.comment ? { comment: note.comment } : {})
			});

			// Only the slug moves: the ordinal, and so this ticket's id and every
			// descendant's, is unchanged.
			const renamed = vscode.Uri.joinPath(
				ticket.uri,
				'..',
				folderName(ticket.resolvedId, trimmed)
			);
			if (renamed.path !== ticket.uri.path) {
				await vscode.workspace.fs.rename(ticket.uri, renamed, { overwrite: false });
			}

			return { ...ticket.summary, title: trimmed };
		});
	}

	async planTypeChange(id: string, type: TicketType): Promise<TypeChangePlan> {
		const ticket = await this.require(id);
		const { treeId } = await this.typeChangeTarget(ticket, type);
		return { id: ticket.summary.id, newId: treeId };
	}

	async changeType(id: string, type: TicketType, note?: TypeChangeNote): Promise<TicketSummary> {
		return this.write(async () => {
			const ticket = await this.require(id);
			if (ticket.type === type) {
				return ticket.summary;
			}
			const { resolvedId, treeId } = await this.typeChangeTarget(ticket, type);
			const metadata = await this.readMetadata(ticket);

			// Every check before the first write, so a refusal leaves the folder
			// exactly as it was.
			const target = vscode.Uri.joinPath(ticket.uri, '..', folderName(resolvedId, metadata.title));
			if (target.path !== ticket.uri.path && (await this.exists(target))) {
				throw new TicketTypeChangeError(
					`A folder named “${path.posix.basename(target.path)}” is already there.`
				);
			}
			const files = (await this.readDirectory(ticket.uri))
				.filter(([, fileType]) => fileType & vscode.FileType.File)
				.map(([name]) => name);
			const content = files.find((name) => typeFromContentFile(name) === ticket.type);
			if (files.some((name) => typeFromContentFile(name) === type)) {
				throw new TicketTypeChangeError(
					`${ticket.summary.key} already holds a ${TYPE_FILE[type]}; remove one of the two description files first.`
				);
			}

			// The description file first: it is what names the type when the
			// folder and the metadata disagree, so a write that dies part-way
			// leaves a ticket of the new type with an `id-drift` warning — which
			// the next write heals — rather than one of the old type.
			if (content) {
				await vscode.workspace.fs.rename(
					vscode.Uri.joinPath(ticket.uri, content),
					vscode.Uri.joinPath(ticket.uri, TYPE_FILE[type]),
					{ overwrite: false }
				);
			}

			metadata.id = resolvedId;
			await this.touch(ticket, metadata, {
				action: 'changed',
				field: 'type',
				from: ticket.type,
				to: type,
				...(note?.comment ? { comment: note.comment } : {})
			});

			if (target.path !== ticket.uri.path) {
				await vscode.workspace.fs.rename(ticket.uri, target, { overwrite: false });
			}

			this.invalidate();
			// The other side of every link names this ticket by its old id. The
			// ticket's own links are the index of who does, so no scan is needed.
			await this.retargetLinked(metadata.links, ticket.summary.id, treeId);
			return (await this.require(treeId)).summary;
		});
	}

	/**
	 * The id a type change would give `ticket`, or a `TicketTypeChangeError`.
	 * The ordinal stays — an epic and a story share one sequence under their
	 * parent, so it is free for the new type — unless another sibling already
	 * holds it (a hand-made clash, the one a rank marks), in which case the
	 * next free one is taken and the clash is resolved on the way.
	 */
	private async typeChangeTarget(
		ticket: LoadedTicket,
		type: TicketType
	): Promise<{ resolvedId: string; treeId: string }> {
		const parent = ticket.summary.parentId ? await this.require(ticket.summary.parentId) : undefined;
		const refusal = typeChangeRefusal({
			key: ticket.summary.key,
			type: ticket.type,
			target: type,
			parentType: parent?.type,
			childTypes: (await this.level(ticket)).map((child) => child.type)
		});
		if (refusal) {
			throw new TicketTypeChangeError(refusal);
		}

		const siblings = (await this.level(parent)).filter(
			(sibling) => sibling.summary.id !== ticket.summary.id
		);
		const taken = siblings.some(
			(sibling) => ordinalKey(sibling.type, sibling.ordinal) === ordinalKey(type, ticket.ordinal)
		);
		const ordinal = taken ? nextOrdinal(siblings, type) : ticket.ordinal;
		return {
			resolvedId: buildId(parent?.ordinalPath ?? [], type, ordinal),
			treeId: buildTreeId([...(parent?.idPath ?? []), { ordinal }], type)
		};
	}

	async deleteTicket(id: string): Promise<void> {
		await this.write(async () => {
			const ticket = await this.require(id);

			// Every link that leaves the subtree, read before the folder goes. A
			// link between two tickets that both go needs nothing.
			const subtree = await this.subtree(ticket);
			const inside = new Set(subtree.map((member) => member.summary.id));
			const leaving: { from: string; link: TicketLink }[] = [];
			for (const member of subtree) {
				for (const link of (await this.readMetadata(member)).links) {
					if (!inside.has(link.id)) {
						leaving.push({ from: member.summary.id, link });
					}
				}
			}

			await this.remove(ticket.uri);

			// Best-effort: the delete has happened, and a link left behind only
			// shows as "not in the tracker" on the board that still holds it.
			for (const { from, link } of leaving) {
				try {
					const other = await this.find(link.id);
					if (other) {
						await this.writeLinkSide(
							other,
							await this.readMetadata(other),
							inverseRelation(link.relation),
							from,
							'unlinked',
							`${from} was deleted.`
						);
					}
				} catch {
					// See above.
				}
			}
		});
	}

	async linkTickets(
		id: string,
		relation: LinkRelation,
		targetId: string,
		note?: LinkChangeNote
	): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const wanted = targetId.trim().toUpperCase();
			const other = await this.find(wanted);
			if (!other) {
				throw new Error(`No ticket “${targetId.trim()}” in the tracker folder.`);
			}
			if (other.summary.id === ticket.summary.id) {
				throw new Error('A ticket cannot be linked to itself.');
			}

			const metadata = await this.readMetadata(ticket);
			await this.writeLinkSide(ticket, metadata, relation, other.summary.id, 'linked', note?.comment);
			await this.writeLinkSide(
				other,
				await this.readMetadata(other),
				inverseRelation(relation),
				ticket.summary.id,
				'linked',
				note?.comment
			);
			return this.readDetail(ticket, metadata);
		});
	}

	async unlinkTickets(
		id: string,
		relation: LinkRelation,
		targetId: string,
		note?: LinkChangeNote
	): Promise<TicketDetail> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const wanted = targetId.trim().toUpperCase();

			const metadata = await this.readMetadata(ticket);
			await this.writeLinkSide(ticket, metadata, relation, wanted, 'unlinked', note?.comment);

			// The other side may be gone — a hand delete, a merge — and then there
			// is nothing to take it off.
			const other = await this.find(wanted);
			if (other && other.summary.id !== ticket.summary.id) {
				await this.writeLinkSide(
					other,
					await this.readMetadata(other),
					inverseRelation(relation),
					ticket.summary.id,
					'unlinked',
					note?.comment
				);
			}
			return this.readDetail(ticket, metadata);
		});
	}

	/**
	 * Copies an image into `<ticket>/assets/` and returns the ticket-relative
	 * path the description references it by.
	 *
	 * Two things it deliberately does not do:
	 *
	 * It does not `touch()` the ticket. The board is mid-edit holding the
	 * `updatedAt` it read when Edit was pressed, so bumping it here would make
	 * the user's own image insert fail their next save as a conflict.
	 *
	 * It does not record history either. `history.md` is a log of changes to the
	 * *ticket*, and an image dropped in and then cut from the draft before saving
	 * would leave an entry describing something that never happened. The save
	 * that follows records `changed description`, and the diff shows the image.
	 *
	 * An asset the user then cancels out of is left on disk: git shows it, and
	 * deleting it would race the write queue and surprise anyone who cut the
	 * markdown meaning to paste it elsewhere.
	 */
	async addAttachment(id: string, fileName: string, bytes: Uint8Array): Promise<string> {
		return this.write(async () => {
			const ticket = await this.require(id);
			const assets = vscode.Uri.joinPath(ticket.uri, ASSETS_FOLDER);

			// Only ever created on demand: a test pins that a fresh ticket folder
			// holds exactly its three files.
			await vscode.workspace.fs.createDirectory(assets);

			const desired = assetFileName(fileName);
			let name = desired;
			for (
				let attempt = 1;
				await this.exists(vscode.Uri.joinPath(assets, name));
				attempt++
			) {
				if (attempt > MAX_NAME_ATTEMPTS) {
					throw new Error(`Could not find a free name for "${fileName}" in ${ASSETS_FOLDER}.`);
				}
				name = suffixFileName(desired, attempt);
			}

			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(assets, name), bytes);

			// Always forward slashes: this goes into a markdown link, not a path.
			return `${ASSETS_FOLDER}/${name}`;
		});
	}

	/**
	 * Renames every folder named longer than `MAX_FOLDER_NAME` — only the name:
	 * no `touch()`, so no history entry and no `updatedAt` bump, and a board
	 * open mid-edit still saves. Deepest first, so a rename never moves a path
	 * this has yet to use: a test case's leaves its criterion where it was, and
	 * the criterion's then carries the renamed test case along. A folder whose
	 * new name is taken, or that refuses the rename, is skipped and reported,
	 * and the rest still go.
	 */
	async shortenFolderNames(): Promise<ShortenOutcome> {
		return this.write(async () => {
			// What disk says now, not what the listing the user confirmed saw.
			this.invalidate();
			const planned = (await this.loadAll())
				.flatMap((ticket) => {
					const rename = shortened(ticket);
					return rename ? [{ ticket, rename }] : [];
				})
				.sort((a, b) => b.ticket.ordinalPath.length - a.ticket.ordinalPath.length);

			const outcome: ShortenOutcome = { renamed: [], skipped: [] };
			for (const { ticket, rename } of planned) {
				const target = vscode.Uri.joinPath(ticket.uri, '..', rename.to);
				if (await this.exists(target)) {
					outcome.skipped.push({ ...rename, reason: `${rename.to} already exists` });
					continue;
				}
				try {
					await vscode.workspace.fs.rename(ticket.uri, target, { overwrite: false });
					outcome.renamed.push(rename);
				} catch (error) {
					outcome.skipped.push({
						...rename,
						reason: errorMessage(error)
					});
				}
			}
			return outcome;
		});
	}

	// ---------------------------------------------------------------- reading

	private root(): vscode.Uri {
		const root = this.context.rootUri();
		if (!root) {
			throw new TrackerNotConfiguredError();
		}
		return root;
	}

	/**
	 * One level of the tracker — the root's epics, or `parent`'s direct children
	 * — in sibling order, read once per generation. This is the only place
	 * folders are read: the sidebar's expand, a board's `getDetail`, a create's
	 * sibling count and a command's `listSummaries` all come through here, so
	 * they cannot disagree on an id, a rank or a warning.
	 */
	private level(parent: LoadedTicket | undefined): Promise<LoadedTicket[]> {
		const generation = this.generation;
		const key = parent?.summary.id ?? '';
		let pending = generation.levels.get(key);
		if (!pending) {
			pending = this.loadLevel(parent, generation).catch((error) => {
				// A failed load must not stay cached, or the tree stays broken until
				// something else happens to invalidate it. Its own generation: a
				// newer one never held it.
				generation.levels.delete(key);
				throw error;
			});
			generation.levels.set(key, pending);
		}
		return pending;
	}

	/**
	 * Every ticket, depth-first in sibling order — the order the sidebar draws
	 * and `buildTree` preserves, which `collectTestCases` and the tests count
	 * on. A leaf is not read at all: its listing already said it has nothing.
	 */
	private async loadAll(): Promise<LoadedTicket[]> {
		const all: LoadedTicket[] = [];
		const walk = async (parent: LoadedTicket | undefined): Promise<void> => {
			for (const ticket of await this.level(parent)) {
				all.push(ticket);
				if (ticket.summary.hasChildren) {
					await walk(ticket);
				}
			}
		};
		await walk(undefined);
		return all;
	}

	private async loadLevel(
		parent: LoadedTicket | undefined,
		generation: Generation
	): Promise<LoadedTicket[]> {
		const folder = parent?.uri ?? this.context.rootUri();
		if (
			!folder ||
			// Nothing can live under a test case, so its folder is not even read.
			allowedChildTypes(parent?.type).length === 0 ||
			(parent?.ordinalPath.length ?? 0) >= MAX_DEPTH
		) {
			return [];
		}

		const loaded: LoadedTicket[] = [];
		for (const [name, fileType] of await this.readDirectory(folder)) {
			// Dot folders are tooling, not tickets.
			if (!(fileType & vscode.FileType.Directory) || name.startsWith('.')) {
				continue;
			}

			const ticket = await this.loadTicket(vscode.Uri.joinPath(folder, name), name, parent, loaded);
			if (ticket) {
				loaded.push(ticket);
			}
		}

		// Sort by type then ordinal, so tree order does not depend on how the
		// filesystem happened to enumerate the folder.
		loaded.sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.ordinal - b.ordinal);

		// Two folders can resolve to the same id after a bad merge, and keeping
		// both matters: `buildTree` maps by id, so a silent collision would drop
		// one ticket *and* hand its children to the other. The later one (the
		// sort is stable, so enumeration order decides) takes a rank on its own
		// segment — see `buildTreeId` — which keeps its descendants' ids apart
		// from the first one's whatever order the levels get read in.
		// Keyed by `ordinalKey`, not the id: an `EP-1.2` and an `ST-1.2` under
		// one epic are distinct ids but one container sequence, and their
		// descendants would collide just the same. When they clash, the type
		// this parent held before sub-epics existed (`fallbackChildType`) keeps
		// the plain id and the other takes the rank: a stray epic folder that an
		// older BFAST skipped must never rename a story people already link to.
		// The sort is stable, so same-type duplicates keep enumeration order.
		const primary = fallbackChildType(parent?.type);
		const rankOrder = [...loaded].sort(
			(a, b) => Number(b.type === primary) - Number(a.type === primary)
		);
		const seen = new Map<string, number>();
		for (const ticket of rankOrder) {
			const key = ordinalKey(ticket.type, ticket.ordinal);
			const rank = (seen.get(key) ?? 0) + 1;
			seen.set(key, rank);
			if (rank > 1) {
				ticket.idPath[ticket.idPath.length - 1] = { ordinal: ticket.ordinal, rank };
				ticket.warnings.push('duplicate-id');
				const id = buildTreeId(ticket.idPath, ticket.type);
				ticket.summary = { ...ticket.summary, id, key: localOf(id), warning: describe(ticket.warnings) };
			}
			generation.known.set(ticket.summary.id, ticket);
		}
		return loaded;
	}

	/**
	 * A ticket by id. What this generation has already read is the shortcut;
	 * a miss walks down to it — `known` is never the last word, since mid-scan
	 * it holds only the levels read so far.
	 */
	private async find(id: string): Promise<LoadedTicket | undefined> {
		return this.generation.known.get(id) ?? this.resolve(id);
	}

	/**
	 * Walks down to a ticket one level at a time: each segment of the id says
	 * which ordinal (and rank) to look for at the next level, and what sits
	 * there comes from that folder's listing. This is the inverse of
	 * `buildTreeId` applied to an id the store itself derived from the nesting
	 * — the id supplies only what to look for, never who the parent is, so the
	 * rule that ancestry comes from the nesting still holds: an ancestor is
	 * whatever the level says is there — the one container holding that
	 * ordinal, since containers share a sequence (see `nextOrdinal`) — and
	 * the last step demands the exact id.
	 */
	private async resolve(id: string): Promise<LoadedTicket | undefined> {
		const parsed = parseTreeId(id);
		if (!parsed) {
			return undefined;
		}

		let parent: LoadedTicket | undefined;
		for (let depth = 0; depth < parsed.segments.length; depth++) {
			const wanted = parsed.segments[depth];
			const last = depth === parsed.segments.length - 1;
			const next = (await this.level(parent)).find((ticket) =>
				last
					? ticket.summary.id === id
					: isContainerType(ticket.type) &&
						ticket.ordinal === wanted.ordinal &&
						(ticket.idPath[depth].rank ?? 1) === (wanted.rank ?? 1)
			);
			if (!next) {
				return undefined;
			}
			parent = next;
		}
		return parent;
	}

	private async loadTicket(
		uri: vscode.Uri,
		name: string,
		parent: LoadedTicket | undefined,
		siblings: readonly LoadedTicket[]
	): Promise<LoadedTicket | undefined> {
		const entries = await this.readDirectory(uri);
		const fileNames = entries
			.filter(([, fileType]) => fileType & vscode.FileType.File)
			.map(([entry]) => entry);

		const contentType = fileNames
			.map(typeFromContentFile)
			.find((type): type is TicketType => type !== undefined);
		const hasMetadata = fileNames.some(
			(entry) => entry.toLowerCase() === METADATA_FILE.toLowerCase()
		);

		const fromFolder = parseFolderName(name);
		const allowed = allowedChildTypes(parent?.type);

		const metadataText = hasMetadata ? await this.readFile(uri, METADATA_FILE) : undefined;
		const claimed = parseLocalSegment(parseMetadata(metadataText, { id: '', title: '' }).id);

		// A content file names the type outright; failing that the folder prefix
		// does, then the id in the metadata. The last resort — the child this
		// parent plainly holds (`fallbackChildType`) — needs a `metadata.yaml`
		// to back it up, because it would otherwise turn every stray folder at
		// the root into an epic.
		const type =
			contentType ??
			fromFolder.type ??
			claimed?.type ??
			(hasMetadata ? fallbackChildType(parent?.type) : undefined);

		if (!type || !allowed.includes(type)) {
			// Nothing marks this as a ticket, or it is one that cannot live here —
			// either way it is an ordinary folder (assets, notes) and skipping it
			// silently is the point.
			return undefined;
		}

		const warnings: TicketWarning[] = [];
		if (!hasMetadata) {
			warnings.push('missing-metadata');
		}
		if (!contentType) {
			warnings.push('missing-content');
		}

		// The ordinal comes from metadata when it names one of this type, then
		// from the folder name, and only then from counting the siblings read so
		// far — which leaves that last resort to enumeration order, as a
		// duplicate's rank already is. Only the last ordinal is taken from either:
		// the ones before it describe the ancestry, and that is the nesting's to
		// decide, not the name's.
		const fromFolderOrdinal = fromFolder.ordinals?.[fromFolder.ordinals.length - 1];
		const ordinal =
			(claimed?.type === type ? claimed.ordinal : undefined) ??
			fromFolderOrdinal ??
			nextOrdinal(siblings, type);

		const ancestors = parent?.ordinalPath ?? [];
		const resolvedId = buildId(ancestors, type, ordinal);
		const idPath: IdSegment[] = [...(parent?.idPath ?? []), { ordinal }];
		const id = buildTreeId(idPath, type);

		const metadata = parseMetadata(metadataText, {
			id: resolvedId,
			title: deslugify(fromFolder.slug || name)
		});

		// Structure wins over what the folder or the file claims: an id taken at
		// face value could contradict the nesting and orphan the ticket. Both
		// names are checked, because either can be edited by hand.
		if (
			(hasMetadata && metadata.id !== resolvedId) ||
			(fromFolder.id !== undefined && fromFolder.id !== resolvedId)
		) {
			warnings.push('id-drift');
		}

		// Whether anything under here could be a child, from the listing already
		// in hand rather than by reading the children — and deliberately
		// over-inclusive: a stray folder makes an expander that opens to nothing,
		// where the opposite mistake would hide a real ticket. A test case's
		// folder holds only sidecars, so it never gets one.
		const hasChildren =
			allowedChildTypes(type).length > 0 &&
			entries.some(
				([entry, fileType]) =>
					fileType & vscode.FileType.Directory &&
					!entry.startsWith('.') &&
					entry !== ASSETS_FOLDER
			);
		// An acceptance criterion is supposed to have at least one test case.
		// Judged from the listing for the same reason: reading every AC's
		// children up front is exactly the scan lazy loading exists to avoid.
		if (type === 'ac' && !hasChildren) {
			warnings.push('ac-without-testcase');
		}

		return {
			resolvedId,
			summary: {
				id,
				key: localOf(id),
				type,
				title: metadata.title,
				status: metadata.status,
				assignee: metadata.assignee,
				...(metadata.service ? { service: metadata.service } : {}),
				parentId: parent?.summary.id,
				hasChildren,
				...(warnings.length > 0 ? { warning: describe(warnings) } : {})
			},
			uri,
			type,
			ordinal,
			ordinalPath: [...ancestors, ordinal],
			idPath,
			metadata,
			warnings
		};
	}

	private async readDetail(
		ticket: LoadedTicket,
		metadata = ticket.metadata
	): Promise<TicketDetail> {
		const [description, history] = await Promise.all([
			this.readFile(ticket.uri, TYPE_FILE[ticket.type]),
			this.readFile(ticket.uri, HISTORY_FILE)
		]);

		return {
			...ticket.summary,
			title: metadata.title,
			status: metadata.status,
			assignee: metadata.assignee,
			...(metadata.service ? { service: metadata.service } : {}),
			description: description ?? '',
			history: parseHistory(history, ticket.summary.id),
			createdBy: metadata.createdBy,
			createdAt: metadata.createdAt,
			updatedAt: metadata.updatedAt,
			links: await this.resolveLinks(metadata.links)
		};
	}

	/** Each link with the ticket it names as it is now — or none, when it is gone. */
	private resolveLinks(links: readonly TicketLink[]): Promise<TicketLinkView[]> {
		return Promise.all(
			links.map(async (link) => {
				const other = await this.find(link.id);
				return other
					? {
							...link,
							target: {
								id: other.summary.id,
								key: other.summary.key,
								type: other.summary.type,
								title: other.summary.title,
								status: other.summary.status
							}
						}
					: { ...link };
			})
		);
	}

	/** The ticket and every ticket under it, read a level at a time. */
	private async subtree(ticket: LoadedTicket, depth = 0): Promise<LoadedTicket[]> {
		if (depth >= MAX_DEPTH) {
			return [ticket];
		}
		const children = await this.level(ticket);
		const below = await Promise.all(children.map((child) => this.subtree(child, depth + 1)));
		return [ticket, ...below.flat()];
	}

	/**
	 * One side of a link: adds or removes `relation → otherId` in `metadata`,
	 * writes the file and one history entry — and leaves `updatedAt` alone, for
	 * `addAttachment`'s reason. `false`, and nothing written, when this side
	 * already says so: the same link twice is a non-event.
	 */
	private async writeLinkSide(
		ticket: LoadedTicket,
		metadata: TicketMetadata,
		relation: LinkRelation,
		otherId: string,
		action: 'linked' | 'unlinked',
		comment?: string
	): Promise<boolean> {
		const present = hasLink(metadata.links, relation, otherId);
		if (present === (action === 'linked')) {
			return false;
		}
		metadata.links =
			action === 'linked'
				? withLink(metadata.links, relation, otherId)
				: withoutLink(metadata.links, relation, otherId);
		await this.writeFile(ticket.uri, METADATA_FILE, serializeMetadata(metadata));

		const history = await this.readFile(ticket.uri, HISTORY_FILE);
		await this.writeFile(
			ticket.uri,
			HISTORY_FILE,
			appendHistory(history, {
				action,
				field: LINK_RELATION_INFO[relation].label,
				...(action === 'linked' ? { to: otherId } : { from: otherId }),
				...(comment ? { comment } : {}),
				timestamp: new Date().toISOString(),
				author: this.context.author()
			})
		);
		return true;
	}

	/**
	 * After a type change moved `from` to `to`: re-points the other side of each
	 * link. No history entry — the link did not change, only how one end is
	 * spelled, and the type change already has its own entry.
	 */
	private async retargetLinked(links: readonly TicketLink[], from: string, to: string): Promise<void> {
		for (const id of new Set(links.map((link) => link.id))) {
			const other = await this.find(id);
			if (!other) {
				continue;
			}
			const metadata = await this.readMetadata(other);
			const moved = retargetLinks(metadata.links, from, to);
			if (JSON.stringify(moved) !== JSON.stringify(metadata.links)) {
				metadata.links = moved;
				await this.writeFile(other.uri, METADATA_FILE, serializeMetadata(metadata));
			}
		}
	}

	// ---------------------------------------------------------------- writing

	/** Set by `createUnder`, so an aborted two-step create knows what to undo. */
	private lastCreatedUri: vscode.Uri | undefined;

	/** Runs `operation` after every write already queued, never alongside one. */
	private write<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.queue.then(async () => {
			this.writing++;
			try {
				return await operation();
			} finally {
				this.writing--;
				this.invalidate();
			}
		});

		// The queue has to survive a rejection, or one failed write blocks the rest.
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async createUnder(
		parent: LoadedTicket | undefined,
		request: Pick<CreateTicketRequest, 'type' | 'title' | 'description' | 'assignee' | 'comment'>
	): Promise<TicketSummary> {
		const parentUri = parent?.uri ?? this.root();
		const siblings = await this.level(parent);

		const title = request.title.trim();
		const now = new Date().toISOString();
		const author = this.context.author();

		const ancestors = parent?.ordinalPath ?? [];
		let ordinal = nextOrdinal(siblings, request.type);
		let uri: vscode.Uri | undefined;
		let id: string | undefined;

		// A folder can exist without having loaded as a ticket, so claim a name by
		// checking disk rather than by trusting the scan.
		for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++, ordinal++) {
			const candidateId = buildId(ancestors, request.type, ordinal);
			const candidate = vscode.Uri.joinPath(parentUri, folderName(candidateId, title));
			if (!(await this.exists(candidate))) {
				uri = candidate;
				id = candidateId;
				break;
			}
		}

		if (!uri || !id) {
			throw new Error(`Could not find a free folder name for “${title}”.`);
		}

		const metadata: TicketMetadata = {
			id,
			title,
			status: 'todo',
			assignee: request.assignee,
			createdBy: author,
			createdAt: now,
			updatedAt: now,
			links: [],
			extra: {}
		};

		// `createDirectory` is recursive and idempotent, so this also creates the
		// tracker root the first time a ticket is added to a fresh workspace.
		await vscode.workspace.fs.createDirectory(uri);
		await this.writeFile(uri, TYPE_FILE[request.type], request.description ?? '');
		await this.writeFile(uri, METADATA_FILE, serializeMetadata(metadata));
		await this.writeFile(
			uri,
			HISTORY_FILE,
			// Spread rather than passed as `undefined`, so an ordinary create
			// serialises exactly as it always has and existing files still read.
			serializeHistory([
				{
					timestamp: now,
					author,
					action: 'created',
					...(request.comment ? { comment: request.comment } : {})
				}
			])
		);

		this.lastCreatedUri = uri;
		this.invalidate();

		// The tree id, which carries a duplicate parent's rank; the plain `id`
		// is what went into the folder name and the metadata.
		const treeId = buildTreeId([...(parent?.idPath ?? []), { ordinal }], request.type);
		return {
			id: treeId,
			key: localOf(treeId),
			type: request.type,
			title,
			status: 'todo',
			assignee: request.assignee,
			parentId: parent?.summary.id,
			hasChildren: false
		};
	}

	/** Stamps `updatedAt`, rewrites the metadata and appends one history entry. */
	private async touch(
		ticket: LoadedTicket,
		metadata: TicketMetadata,
		entry: Omit<NewHistoryEntry, 'timestamp' | 'author'>
	): Promise<void> {
		const now = new Date().toISOString();
		metadata.updatedAt = now;

		await this.writeFile(ticket.uri, METADATA_FILE, serializeMetadata(metadata));

		const history = await this.readFile(ticket.uri, HISTORY_FILE);
		await this.writeFile(
			ticket.uri,
			HISTORY_FILE,
			appendHistory(history, { ...entry, timestamp: now, author: this.context.author() })
		);
	}

	/**
	 * The ticket's metadata as it is on disk right now. Writes never build on the
	 * copy the scan cached, because an editor or a `git pull` may have moved it
	 * since.
	 */
	private async readMetadata(ticket: LoadedTicket): Promise<TicketMetadata> {
		return parseMetadata(await this.readFile(ticket.uri, METADATA_FILE), {
			id: ticket.summary.id,
			title: ticket.summary.title
		});
	}

	private async require(id: string): Promise<LoadedTicket> {
		const ticket = await this.find(id);
		if (!ticket) {
			throw new Error(`Ticket ${id} is no longer in the tracker folder.`);
		}
		return ticket;
	}

	// --------------------------------------------------------------- file i/o

	private async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		try {
			return await vscode.workspace.fs.readDirectory(uri);
		} catch {
			// Missing or unreadable: an empty folder is the right answer either way.
			return [];
		}
	}

	private async readFile(folder: vscode.Uri, name: string): Promise<string | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name));
			return new TextDecoder().decode(bytes);
		} catch {
			return undefined;
		}
	}

	private async writeFile(folder: vscode.Uri, name: string, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(folder, name),
			new TextEncoder().encode(content)
		);
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async remove(uri: vscode.Uri): Promise<void> {
		await deleteFolder(uri);
		this.invalidate();
	}
}

/**
 * The rename a folder named longer than `MAX_FOLDER_NAME` gets — the name a
 * ticket with its id and title is given today, the id being the one the
 * nesting gives it, as `renameTicket` does — or `undefined` when it fits.
 */
function shortened(ticket: LoadedTicket): FolderRename | undefined {
	const from = path.posix.basename(ticket.uri.path);
	if (from.length <= MAX_FOLDER_NAME) {
		return undefined;
	}
	const to = folderName(ticket.resolvedId, ticket.metadata.title);
	return to === from ? undefined : { id: ticket.summary.id, from, to };
}

/** Whether `target` is `folder` itself or lies under it — a path comparison, not a string one. */
function within(folder: string, target: string): boolean {
	const relative = path.relative(folder, target);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The one shape of `workspace.fs.delete` this module needs. */
type DeleteFolder = (
	uri: vscode.Uri,
	options: { recursive: boolean; useTrash: boolean }
) => Thenable<void>;

/**
 * To the trash, so a mis-clicked Delete is recoverable — but a trash is not
 * something every file system has. A remote workspace (SSH, WSL, a container)
 * and every virtual provider answer `useTrash` with "provider does not support
 * it", and a Delete the user has already confirmed must not fail on that. So
 * the fallback is a permanent delete.
 *
 * It fires on *any* failure of the trash attempt rather than on a sniffed error
 * message: that message is localized and provider-specific, while every other
 * reason a delete fails — the folder is already gone, the permissions are wrong
 * — fails the second attempt the same way, so the real error still reaches the
 * user.
 */
export async function deleteFolder(
	uri: vscode.Uri,
	del: DeleteFolder = (target, options) => vscode.workspace.fs.delete(target, options)
): Promise<void> {
	try {
		await del(uri, { recursive: true, useTrash: true });
	} catch {
		await del(uri, { recursive: true, useTrash: false });
	}
}

function describe(warnings: readonly TicketWarning[]): string {
	return warnings.map((warning) => WARNING_TEXT[warning]).join(', ');
}
