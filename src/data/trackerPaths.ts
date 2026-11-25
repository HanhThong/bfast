// Pure naming rules for the on-disk tracker: how a ticket type maps to a folder
// name, a content file and an id, and which types may nest inside which.
//
// A folder carries the ticket's full id (`AC-1.2.1-Wrong_password`), so it
// names itself; ancestry still comes from the nesting, never from parsing that
// id, and the name as a whole is held to `MAX_FOLDER_NAME`.

import { TicketType } from './types';

export const TYPE_PREFIX: Record<TicketType, string> = {
	epic: 'EP',
	story: 'ST',
	ac: 'AC',
	testcase: 'TC'
};

/** The file inside a ticket folder that holds its description. */
export const TYPE_FILE: Record<TicketType, string> = {
	epic: 'Epic.mdx',
	story: 'Story.mdx',
	ac: 'AC.mdx',
	testcase: 'TestCase.mdx'
};

/** Sibling order in the tree: acceptance criteria before loose test cases. */
export const TYPE_ORDER: readonly TicketType[] = ['epic', 'story', 'ac', 'testcase'];

/** Longest a slug may be when the caller names no tighter cap — see `folderName` for a ticket's. */
const MAX_SLUG = 60;

/**
 * Longest a ticket folder's name may be, id included. A path budget, not
 * taste: a tracker nests four deep, so its deepest file is at most `.tracker/`,
 * four of these and `/metadata.yaml` — 186 characters from the repository root
 * — which leaves room under Windows' 260 for where the repository is checked
 * out, an environment's worktree under `%TEMP%` included. docs/tracker/ is the
 * specification.
 */
export const MAX_FOLDER_NAME = 40;

/** The fewest slug characters a folder keeps, however long its id grows. */
const MIN_FOLDER_SLUG = 12;

// Everything Windows forbids in a name, plus control characters. Spaces are
// not in here: they survive to become underscores a step later.
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Names Windows refuses for a file or folder, whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** True for a stem Windows refuses (`con`, `lpt1`), whatever extension follows it. */
export function isReservedFileName(stem: string): boolean {
	return RESERVED_NAMES.test(stem);
}

const FOLDER_NAME = /^(EP|ST|AC|TC)-(\d+(?:\.\d+)*)(?:-(.*))?$/i;

const PREFIX_TO_TYPE: Record<string, TicketType> = {
	EP: 'epic',
	ST: 'story',
	AC: 'ac',
	TC: 'testcase'
};

/** Where each type may be created. The tree shape lives here and nowhere else. */
export function allowedChildTypes(parent: TicketType | undefined): readonly TicketType[] {
	switch (parent) {
		case undefined:
			return ['epic'];
		// An epic can be split into sub-epics before it is split into stories,
		// and the two can sit side by side. A test case may sit under any
		// container: under a criterion it proves that criterion, higher up it is
		// a test that crosses several functions of the story or epic it hangs under.
		case 'epic':
			return ['epic', 'story', 'testcase'];
		case 'story':
			return ['ac', 'testcase'];
		case 'ac':
			return ['testcase'];
		case 'testcase':
			return [];
	}
}

/**
 * The type a folder must be when nothing on disk says so but a `metadata.yaml`
 * marks it as a ticket — the one child a parent most plainly holds. An epic
 * now takes sub-epics too, but a bare folder under one is still read as the
 * story it always was, so a tracker that loaded before keeps loading the same.
 */
export function fallbackChildType(parent: TicketType | undefined): TicketType | undefined {
	switch (parent) {
		case undefined:
			return 'epic';
		case 'epic':
			return 'story';
		case 'ac':
			return 'testcase';
		default:
			return undefined;
	}
}

/**
 * True for a type that can have children. Within one parent, every such type
 * shares **one** ordinal sequence (see `nextOrdinal`), because a tree id
 * records only the leaf's type: a descendant's id has to say which container
 * it walks through by ordinal alone.
 */
export function isContainerType(type: TicketType): boolean {
	return allowedChildTypes(type).length > 0;
}

/**
 * What two siblings must share to collide: the ordinal, and either the type
 * or — for containers — merely being a container. `EP-1.2` and `ST-1.2` under
 * one epic would hand `TC-1.2.1.1` to two different tickets.
 */
export function ordinalKey(type: TicketType, ordinal: number): string {
	return `${isContainerType(type) ? 'container' : type}:${ordinal}`;
}

/**
 * What a ticket of `type` may be turned into. Only an epic and a story trade
 * places: both are containers in one ordinal sequence under an epic, so the
 * swap keeps the ordinal and no sibling's id moves. An acceptance criterion or
 * a test case has a shape of its own (Given / When / Then, one runnable test)
 * that no conversion could honestly produce.
 */
export function convertibleTypes(type: TicketType): readonly TicketType[] {
	switch (type) {
		case 'epic':
			return ['story'];
		case 'story':
			return ['epic'];
		default:
			return [];
	}
}

const TYPE_NAME: Record<TicketType, string> = {
	epic: 'epic',
	story: 'story',
	ac: 'acceptance criterion',
	testcase: 'test case'
};

/**
 * Why a ticket cannot become `target`, or `undefined` when it can. Pure, so the
 * hierarchy rule is stated once: the parent has to take the new type, and
 * every child has to be one the new type takes — which, for an epic and a
 * story, means no children at all, since they hold disjoint types. Children
 * are refused rather than converted along: a story's criteria have nowhere to
 * go under an epic, and guessing would rewrite a subtree nobody looked at.
 */
export function typeChangeRefusal(change: {
	key: string;
	type: TicketType;
	target: TicketType;
	parentType: TicketType | undefined;
	childTypes: readonly TicketType[];
}): string | undefined {
	const { key, type, target, parentType, childTypes } = change;
	if (!convertibleTypes(type).includes(target)) {
		return `${capitalized(TYPE_NAME[type])} ${key} cannot become ${withArticle(target)}.`;
	}
	if (!allowedChildTypes(parentType).includes(target)) {
		return parentType
			? `${key} cannot become ${withArticle(target)}: ${withArticle(parentType)} cannot contain one.`
			: `${key} cannot become ${withArticle(target)}: only an epic can sit at the top level.`;
	}
	const stranded = childTypes.filter((child) => !allowedChildTypes(target).includes(child));
	if (stranded.length > 0) {
		return (
			`${key} cannot become ${withArticle(target)} while it still holds ` +
			`${stranded.length === 1 ? 'a child' : `${stranded.length} children`} ` +
			`${withArticle(target)} cannot contain. Move or delete ` +
			`${stranded.length === 1 ? 'it' : 'them'} first.`
		);
	}
	return undefined;
}

function withArticle(type: TicketType): string {
	const name = TYPE_NAME[type];
	return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
}

function capitalized(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function typeRank(type: TicketType): number {
	return TYPE_ORDER.indexOf(type);
}

/** The type a folder's content file names, if it holds one. Case-insensitive. */
export function typeFromContentFile(fileName: string): TicketType | undefined {
	const lower = fileName.toLowerCase();
	return (Object.keys(TYPE_FILE) as TicketType[]).find(
		(type) => TYPE_FILE[type].toLowerCase() === lower
	);
}

export function typeFromPrefix(prefix: string): TicketType | undefined {
	return PREFIX_TO_TYPE[prefix.toUpperCase()];
}

/**
 * Turns a title into something safe to use as a folder name on any OS.
 *
 * `max` is a parameter rather than a constant because a design document's file
 * name sits *inside* a ticket folder that already carries the full id, and the
 * budget there is tighter — the same reason `assetFileName` caps its stem
 * shorter than this. The rules that are easy to get wrong (the word boundary,
 * the trailing dot, the reserved names) stay in one place.
 */
export function slugifyTitle(title: string, max = MAX_SLUG): string {
	let slug = title
		.replace(INVALID_FILENAME_CHARS, '')
		.trim()
		.replace(/\s+/g, '_')
		.replace(/_{2,}/g, '_')
		.replace(/^[._\s]+|[._\s]+$/g, '');

	if (slug.length > max) {
		// A cut that lands exactly on a word boundary already keeps whole words.
		const onBoundary = slug[max] === '_';
		slug = slug.slice(0, max);
		// Otherwise prefer cutting on a word boundary, but not so far back that
		// the name stops resembling the title.
		const boundary = slug.lastIndexOf('_');
		if (!onBoundary && boundary >= max / 3) {
			slug = slug.slice(0, boundary);
		}
		// Punctuation mid-title reads as a typo once it ends the name.
		slug = slug.replace(/[,;._]+$/, '');
	}

	// A trailing dot is legal in the string but not in a Windows folder name.
	slug = slug.replace(/[._]+$/g, '');

	if (slug === '') {
		return 'Untitled';
	}
	return RESERVED_NAMES.test(slug) ? `${slug}_` : slug;
}

/** The reverse, good enough for a title when `metadata.yaml` is missing. */
export function deslugify(slug: string): string {
	const title = slug.replace(/_+/g, ' ').trim();
	return title === '' ? 'Untitled' : title;
}

/**
 * Where a ticket's images live. The scanner skips it for free: it holds no
 * content file and no `metadata.yaml`, which is exactly what `loadTicket`
 * requires before it treats a folder as a ticket.
 */
export const ASSETS_FOLDER = 'assets';

/** Longest an asset's stem may be. Ticket folders already nest deep on Windows. */
const MAX_ASSET_STEM = 40;

/** What still looks like a usable extension once the stem is split off. */
const ASSET_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;

// Legal in a file name, but not in a url or inside `![alt](…)`: `#` and `%`
// break the resolved url, and an unbalanced bracket breaks the link syntax.
// Folder names never hit this, which is why `slugifyTitle` keeps them.
const ASSET_UNSAFE = /[#%()[\]]/g;

/**
 * A file name safe to write inside `assets/` **and** to put in a markdown image
 * link. The extension is preserved — it is what makes the image render — so the
 * stem is what gets trimmed, and a name carrying no usable extension gets one.
 *
 * Any directory part is dropped, so a dropped file called `../../etc/passwd`
 * cannot escape the assets folder.
 */
export function assetFileName(name: string, fallbackExtension = '.png'): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	const dot = base.lastIndexOf('.');
	const raw = dot > 0 ? base.slice(dot) : '';
	const extension = ASSET_EXTENSION.test(raw) ? raw.toLowerCase() : fallbackExtension;

	// `slugifyTitle` already knows the forbidden characters, the reserved Windows
	// names and the leading-dot rule; only its length cap is wrong here, because
	// it cuts on a word boundary and would happily eat the extension.
	let stem = slugifyTitle(dot > 0 ? base.slice(0, dot) : base).replace(ASSET_UNSAFE, '');
	if (stem.length > MAX_ASSET_STEM) {
		stem = stem.slice(0, MAX_ASSET_STEM);
	}
	if (stem === '' || stem === 'Untitled') {
		stem = 'image';
	}

	return `${stem}${extension}`;
}

/** `diagram.png` + 1 → `diagram-1.png`, for when the name is already taken. */
export function suffixFileName(name: string, suffix: number): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`;
}

/** `AC-1` — the prefix and ordinal a folder name starts with. */
export function localSegment(type: TicketType, ordinal: number): string {
	return `${TYPE_PREFIX[type]}-${ordinal}`;
}

/** The type and own ordinal an id ends with, whether it is local or full. */
export function parseLocalSegment(
	segment: string
): { type: TicketType; ordinal: number } | undefined {
	const parsed = parseId(segment);
	return parsed
		? { type: parsed.type, ordinal: parsed.ordinals[parsed.ordinals.length - 1] }
		: undefined;
}

/**
 * `AC-1.2.1-Wrong_password_shows_an_error` — the ticket's full id then a slug
 * of its title, so a folder names itself without needing its ancestors. The
 * whole name is held to `MAX_FOLDER_NAME`: the id repeats every ancestor's
 * ordinal, so the slug gets what the id leaves.
 */
export function folderName(id: string, title: string): string {
	return `${id}-${slugifyTitle(title, Math.max(MIN_FOLDER_SLUG, MAX_FOLDER_NAME - id.length - 1))}`;
}

/**
 * Splits `AC-1.2.1-Wrong_password` into the id it claims and the slug. `id` is
 * only what the folder says it is — the tree still resolves ids from the
 * nesting, so a hand-renamed folder cannot reparent anything.
 */
export function parseFolderName(
	name: string
): { id?: string; type?: TicketType; ordinals?: number[]; slug: string } {
	const match = FOLDER_NAME.exec(name);
	const type = match ? typeFromPrefix(match[1]) : undefined;
	if (!match || !type) {
		return { slug: name };
	}

	const ordinals = match[2].split('.').map(Number);
	return {
		// Rebuilt rather than taken verbatim, so the prefix is normalised to
		// upper case however the folder happened to be typed.
		id: buildId(ordinals.slice(0, -1), type, ordinals[ordinals.length - 1]),
		type,
		ordinals,
		slug: match[3] ?? ''
	};
}

/**
 * `AC-1.1.2` — the type prefix, then every ancestor's ordinal followed by this
 * ticket's own. The prefix is what keeps an AC and a test case that share a
 * position under the same story apart.
 */
export function buildId(
	ancestorOrdinals: readonly number[],
	type: TicketType,
	ordinal: number
): string {
	return `${TYPE_PREFIX[type]}-${[...ancestorOrdinals, ordinal].join('.')}`;
}

export function parseId(id: string): { type: TicketType; ordinals: number[] } | undefined {
	const match = /^(EP|ST|AC|TC)-(\d+(?:\.\d+)*)$/i.exec(id);
	const type = match ? typeFromPrefix(match[1]) : undefined;
	if (!match || !type) {
		return undefined;
	}
	return { type, ordinals: match[2].split('.').map(Number) };
}

/**
 * One segment of a tree id: the ordinal the nesting gives a ticket and — only
 * when two same-type siblings resolve to the same ordinal — its rank among
 * them, from 2 up. `EP-1#2` is the second folder claiming epic 1.
 */
export interface IdSegment {
	ordinal: number;
	rank?: number;
}

const TREE_ID = /^(EP|ST|AC|TC)-(\d+(?:#\d+)?(?:\.\d+(?:#\d+)?)*)$/i;

/**
 * The id the tree, the board and every command use: `buildId`, with a rank on
 * any segment that needed one. The rank sits on the segment it disambiguates —
 * `ST-1#2.1` is the first story under the second `EP-1` — and not at the end,
 * where `ST-1.1#2` already means a second `ST-1.1` under the *first* `EP-1`.
 * That makes every id a pure function of the nesting, whatever order the
 * folders were read in, and `parseTreeId` its exact inverse. Folder names and
 * `metadata.yaml` never carry a rank: they hold the plain `buildId`.
 */
export function buildTreeId(segments: readonly IdSegment[], type: TicketType): string {
	return `${TYPE_PREFIX[type]}-${segments
		.map((segment) =>
			segment.rank !== undefined && segment.rank > 1
				? `${segment.ordinal}#${segment.rank}`
				: `${segment.ordinal}`
		)
		.join('.')}`;
}

/** The inverse of `buildTreeId`; `undefined` for anything that is not a tree id. */
export function parseTreeId(
	id: string
): { type: TicketType; segments: IdSegment[] } | undefined {
	const match = TREE_ID.exec(id);
	const type = match ? typeFromPrefix(match[1]) : undefined;
	if (!match || !type) {
		return undefined;
	}
	const segments = match[2].split('.').map((part): IdSegment => {
		const [ordinal, rank] = part.split('#');
		return rank === undefined
			? { ordinal: Number(ordinal) }
			: { ordinal: Number(ordinal), rank: Number(rank) };
	});
	return { type, segments };
}

/**
 * The short label the tree shows: the type prefix and this ticket's own
 * ordinal, with its own rank when it has one (`EP-1#2`, so a duplicate stays
 * visible) but never an ancestor's (`ST-1#2.1` → `ST-1`).
 */
export function localOf(id: string): string {
	const parsed = parseTreeId(id);
	if (!parsed) {
		return id;
	}
	const own = parsed.segments[parsed.segments.length - 1];
	const label = localSegment(parsed.type, own.ordinal);
	return own.rank !== undefined && own.rank > 1 ? `${label}#${own.rank}` : label;
}

/**
 * The next free ordinal for a type inside one parent. Deliberately one past the
 * highest rather than one past the count, so deleting `AC-2` and adding another
 * yields `AC-3` and never resurrects a retired id.
 *
 * Container types (`isContainerType`) count as one sequence: under an epic,
 * `EP-1.1` and `ST-1.2` — never `EP-1.1` and `ST-1.1` — because their children
 * would otherwise share ids (`AC-1.1.1` under the story and `ST-1.1.1` under
 * the sub-epic are told apart by prefix, but their test cases are not). A
 * tracker with no sub-epic has only one container type per parent, so its ids
 * are exactly what they were. Test cases keep their own sequence beside the
 * acceptance criteria, as they always have.
 */
export function nextOrdinal(
	siblings: readonly { type: TicketType; ordinal: number }[],
	type: TicketType
): number {
	const container = isContainerType(type);
	return siblings.reduce(
		(next, sibling) =>
			(container ? isContainerType(sibling.type) : sibling.type === type)
				? Math.max(next, sibling.ordinal + 1)
				: next,
		1
	);
}

/**
 * True for a path, **relative to the tracker root**, that lies inside a ticket's
 * `assets/` folder. An image never changes the tree, so the tracker watcher
 * drops its events: each file would otherwise cost a rescan and a reload of
 * every open board, and `isWriting` cannot cover them, since the file events
 * land after the write has settled. (Test runs used to file their evidence
 * under the ticket too; they now live in the results folder, outside the
 * tracker — see `testing/testResultsStore.ts` — so nothing else is a sidecar.)
 *
 * The first segment is deliberately not considered: a folder named `assets` at
 * the tracker root is somebody's stray folder, not a ticket's sidecar, and a
 * refresh on it is harmless. Matching on an absolute path would be wrong for
 * the opposite reason — a workspace under `/home/x/assets/` would never refresh.
 */
export function isSidecarPath(relativePath: string): boolean {
	const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
	return segments.slice(1).some((segment) => segment === ASSETS_FOLDER);
}
