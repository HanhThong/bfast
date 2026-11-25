// `metadata.yaml` — everything structured about a ticket. The `.mdx` beside it
// holds only prose, so exactly one file has to be parsed to draw the tree.
//
// Parsing is tolerant on purpose: this file is meant to be edited by hand and
// merged by git, so a field that has gone missing or turned to nonsense falls
// back to a default instead of dropping the ticket out of the sidebar.

import { LINK_KEYS, parseLinks, serializeLinks, type TicketLink } from './ticketLinks';
import { TicketStatus, TICKET_STATUSES } from './types';
import { parseYamlMap, serializeYamlMap, YamlMap } from './yaml';

export const METADATA_FILE = 'metadata.yaml';

const HEADER = '# BFAST ticket metadata — rewritten by the extension on every change.';

const KNOWN_KEYS = [
	'id',
	'title',
	'status',
	'assignee',
	'service',
	'createdBy',
	'createdAt',
	'updatedAt'
] as const;

/** The order keys are written in: the ticket's own fields, then its links. */
const KEY_ORDER: readonly string[] = [...KNOWN_KEYS, ...LINK_KEYS];

export interface TicketMetadata {
	id: string;
	title: string;
	status: TicketStatus;
	assignee?: string;
	/**
	 * A test case's service — the `tests.services` id whose e2e command runs it.
	 * docs/tests/services.md. Absent everywhere else, and on a test case that
	 * runs with the project's own `tests.command`.
	 */
	service?: string;
	createdBy?: string;
	/** ISO 8601, but kept verbatim when it is not — never silently rewritten. */
	createdAt?: string;
	updatedAt?: string;
	/**
	 * Links to other tickets, one key per relation (`blocks: ST-1.2, ST-1.3`).
	 * See `ticketLinks.ts` — each side of a link is stored on its own ticket.
	 */
	links: TicketLink[];
	/** Keys BFAST does not own, carried through untouched on the next write. */
	extra: YamlMap;
}

export interface MetadataFallback {
	id: string;
	title: string;
}

export function parseMetadata(
	text: string | undefined,
	fallback: MetadataFallback
): TicketMetadata {
	const map = parseYamlMap(text ?? '');

	// Case-insensitive lookup, so a hand-typed `Title:` still lands.
	const byLowerKey = new Map<string, string>();
	for (const [key, value] of Object.entries(map)) {
		byLowerKey.set(key.toLowerCase(), value);
	}
	const read = (key: string): string | undefined => {
		const value = byLowerKey.get(key.toLowerCase());
		return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
	};

	const extra: YamlMap = {};
	const known = new Set<string>(KEY_ORDER.map((key) => key.toLowerCase()));
	for (const [key, value] of Object.entries(map)) {
		if (!known.has(key.toLowerCase())) {
			extra[key] = value;
		}
	}

	return {
		id: read('id') ?? fallback.id,
		title: read('title') ?? fallback.title,
		status: parseStatus(read('status')),
		assignee: read('assignee'),
		// Spread so a ticket without one has no `service` key at all.
		...(read('service') ? { service: read('service') } : {}),
		createdBy: read('createdBy'),
		createdAt: read('createdAt'),
		updatedAt: read('updatedAt'),
		links: parseLinks(read),
		extra
	};
}

export function serializeMetadata(meta: TicketMetadata): string {
	const map: YamlMap = { ...meta.extra };

	map.id = meta.id;
	map.title = meta.title;
	map.status = meta.status;
	// An absent optional field is left out rather than written as an empty
	// string, so the file stays as short as what is actually known.
	for (const [key, value] of [
		['assignee', meta.assignee],
		['service', meta.service],
		['createdBy', meta.createdBy],
		['createdAt', meta.createdAt],
		['updatedAt', meta.updatedAt]
	] as const) {
		if (value !== undefined && value !== '') {
			map[key] = value;
		} else {
			delete map[key];
		}
	}

	// Every link key is dropped first, so an unlinked relation leaves no empty
	// key behind; then only the relations that still hold an id are written.
	for (const key of LINK_KEYS) {
		delete map[key];
	}
	for (const [key, ids] of serializeLinks(meta.links)) {
		map[key] = ids;
	}

	return serializeYamlMap(map, { order: KEY_ORDER, header: HEADER });
}

function parseStatus(value: string | undefined): TicketStatus {
	const lower = value?.toLowerCase();
	return TICKET_STATUSES.find((status) => status === lower) ?? 'todo';
}
