// Links between tickets — "blocks", "relates to", "duplicates", "clones" and
// their inverses, each stored on both tickets. docs/tracker/ §Links is the spec.
//
// Pure and Node-free: the host stores them, the board's webview labels them,
// and the MCP table names the relations, so all three read this one table.
//
// A link is stored on **both** tickets, each under its own side's relation:
// `ST-1.1 blocks ST-1.2` is `blocks: ST-1.2` in ST-1.1's `metadata.yaml` and
// `blockedBy: ST-1.1` in ST-1.2's. Storing one side and deriving the other
// would need a read of the whole tracker to draw one board — the scan the lazy
// tree exists to avoid — where two flat keys cost nothing to read.

/** Every relation a ticket can have to another, from its own point of view. */
export type LinkRelation =
	| 'relates-to'
	| 'blocks'
	| 'is-blocked-by'
	| 'duplicates'
	| 'is-duplicated-by'
	| 'clones'
	| 'is-cloned-by';

/** In the order the board groups them and the picker offers them. */
export const LINK_RELATIONS: readonly LinkRelation[] = [
	'blocks',
	'is-blocked-by',
	'relates-to',
	'duplicates',
	'is-duplicated-by',
	'clones',
	'is-cloned-by'
];

interface RelationInfo {
	/** What the board and the picker say: "ST-1.1 *blocks* ST-1.2". */
	label: string;
	/** The relation the other ticket records. `relates-to` is its own inverse. */
	inverse: LinkRelation;
	/** The `metadata.yaml` key — camelCase, like every other key there. */
	key: string;
}

export const LINK_RELATION_INFO: Readonly<Record<LinkRelation, RelationInfo>> = {
	'blocks': { label: 'blocks', inverse: 'is-blocked-by', key: 'blocks' },
	'is-blocked-by': { label: 'is blocked by', inverse: 'blocks', key: 'blockedBy' },
	'relates-to': { label: 'relates to', inverse: 'relates-to', key: 'relatesTo' },
	'duplicates': { label: 'duplicates', inverse: 'is-duplicated-by', key: 'duplicates' },
	'is-duplicated-by': { label: 'is duplicated by', inverse: 'duplicates', key: 'duplicatedBy' },
	'clones': { label: 'clones', inverse: 'is-cloned-by', key: 'clones' },
	'is-cloned-by': { label: 'is cloned by', inverse: 'clones', key: 'clonedBy' }
};

/** Every `metadata.yaml` key a link may be stored under, in `LINK_RELATIONS` order. */
export const LINK_KEYS: readonly string[] = LINK_RELATIONS.map(
	(relation) => LINK_RELATION_INFO[relation].key
);

/** One link as one ticket records it. */
export interface TicketLink {
	relation: LinkRelation;
	/** The other ticket's id, as the tree gives it (a rank included). */
	id: string;
}

/**
 * A ticket id as the tree writes it: `EP-1`, `ST-1.2`, `AC-1#2.1.1`. Anything
 * else in a link list is a typo or a merge artefact, and is dropped on read
 * rather than shown as a ticket that can never resolve.
 */
const TICKET_ID = /^(EP|ST|AC|TC)-\d+(#\d+)?(\.\d+(#\d+)?)*$/;

export function isLinkRelation(value: unknown): value is LinkRelation {
	return typeof value === 'string' && (LINK_RELATIONS as readonly string[]).includes(value);
}

export function inverseRelation(relation: LinkRelation): LinkRelation {
	return LINK_RELATION_INFO[relation].inverse;
}

/**
 * The links in a metadata map, by relation then in the order written. Lookup
 * is case-insensitive (a hand-typed `BlockedBy:` still lands), ids are split on
 * commas or whitespace, and a duplicate or an unreadable id is dropped — never
 * thrown on, the `parseMetadata` rule.
 */
export function parseLinks(read: (key: string) => string | undefined): TicketLink[] {
	const links: TicketLink[] = [];
	for (const relation of LINK_RELATIONS) {
		const seen = new Set<string>();
		for (const id of (read(LINK_RELATION_INFO[relation].key) ?? '').split(/[\s,]+/)) {
			const trimmed = id.trim().toUpperCase();
			if (TICKET_ID.test(trimmed) && !seen.has(trimmed)) {
				seen.add(trimmed);
				links.push({ relation, id: trimmed });
			}
		}
	}
	return links;
}

/** One `key: ids` entry per relation that has any, in `LINK_RELATIONS` order. */
export function serializeLinks(links: readonly TicketLink[]): [string, string][] {
	return LINK_RELATIONS.flatMap((relation) => {
		const ids = links.filter((link) => link.relation === relation).map((link) => link.id);
		return ids.length > 0 ? [[LINK_RELATION_INFO[relation].key, ids.join(', ')] as [string, string]] : [];
	});
}

export function hasLink(links: readonly TicketLink[], relation: LinkRelation, id: string): boolean {
	return links.some((link) => link.relation === relation && link.id === id);
}

/** `links` with one more, or the same array when it is already there. */
export function withLink(links: readonly TicketLink[], relation: LinkRelation, id: string): TicketLink[] {
	return hasLink(links, relation, id) ? [...links] : [...links, { relation, id }];
}

export function withoutLink(
	links: readonly TicketLink[],
	relation: LinkRelation,
	id: string
): TicketLink[] {
	return links.filter((link) => !(link.relation === relation && link.id === id));
}

/** Every link to `from` re-pointed at `to` — a type change moved an id. */
export function retargetLinks(links: readonly TicketLink[], from: string, to: string): TicketLink[] {
	const moved: TicketLink[] = [];
	for (const link of links) {
		const next = link.id === from ? { ...link, id: to } : link;
		if (!hasLink(moved, next.relation, next.id)) {
			moved.push(next);
		}
	}
	return moved;
}

/** Whether `value` reads as a ticket id a link may name. */
export function isLinkableId(value: string): boolean {
	return TICKET_ID.test(value.trim().toUpperCase());
}
