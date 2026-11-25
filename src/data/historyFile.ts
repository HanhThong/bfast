// `history.md` — the change log beside each ticket. Append-only and readable as
// plain Markdown, so a diff of a ticket's history is legible in a pull request
// and a person can add an entry by hand.
//
// Grammar: one `## <ISO timestamp> — <author> — <action>` section per entry, in
// the order they happened. Optional `- field:` / `- from:` / `- to:` bullets
// come first, then a free-text comment written as a blockquote.
//
// A `from`/`to` that will not fit on a bullet — a description, most of all —
// is written as an indented fenced block labelled `from` or `to` instead. Both
// forms read back the same, so a status change keeps the one-line shape it has
// always had and only the long values cost more room.

import { HistoryEntry } from './types';

export const HISTORY_FILE = 'history.md';

/** Longer than this, or carrying a newline, and a value gets a block. */
const MAX_BULLET_VALUE = 120;

/**
 * Fenced blocks are indented two spaces, and so is everything inside them.
 *
 * That is load-bearing, not cosmetic: `parseHistory` ends an entry at the next
 * line starting `## ` in column zero, so an unindented description containing a
 * markdown heading would split its own entry in half. Two spaces keeps every
 * line out of column zero and still renders as a code block, since markdown
 * allows a fence up to three spaces in.
 */
const BLOCK_INDENT = '  ';

const BLOCK_FENCE = /^ {0,3}(`{3,})(from|to)\s*$/i;

const PREAMBLE = [
	'# History',
	'',
	'<!-- Appended by BFAST. One `##` section per entry, oldest first. -->'
].join('\n');

/** The entry shape callers supply; the id is positional and never stored. */
export type NewHistoryEntry = Omit<HistoryEntry, 'id'>;

const FIELD_BULLET = /^-\s+(field|from|to)\s*:\s?(.*)$/i;

export function parseHistory(markdown: string | undefined, ticketId: string): HistoryEntry[] {
	if (!markdown) {
		return [];
	}

	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const entries: HistoryEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		// A header only counts at column 0, which is what keeps a `## ` inside a
		// quoted comment from splitting an entry in two.
		if (!lines[i].startsWith('## ')) {
			continue;
		}

		const header = parseHeader(lines[i]);
		if (!header) {
			continue;
		}

		const body: string[] = [];
		while (i + 1 < lines.length && !lines[i + 1].startsWith('## ')) {
			body.push(lines[++i]);
		}

		entries.push({
			id: `${ticketId}#${entries.length}`,
			...header,
			...parseBody(body)
		});
	}

	return entries;
}

/** The whole file, for a ticket that has none yet. */
export function serializeHistory(entries: readonly NewHistoryEntry[]): string {
	return [PREAMBLE, ...entries.map(formatHistoryEntry)].join('\n\n') + '\n';
}

export function appendHistory(markdown: string | undefined, entry: NewHistoryEntry): string {
	if (!markdown || markdown.trim() === '') {
		return serializeHistory([entry]);
	}
	return `${markdown.replace(/\s+$/, '')}\n\n${formatHistoryEntry(entry)}\n`;
}

export function formatHistoryEntry(entry: NewHistoryEntry): string {
	const lines = [
		`## ${entry.timestamp} — ${headerPart(entry.author)} — ${headerPart(entry.action)}`
	];

	// An undefined side is omitted entirely rather than written as a blank, so a
	// status change with no `from` records the field with no empty change row.
	if (entry.field !== undefined) {
		lines.push(`- field: ${entry.field}`);
	}

	const blocks: string[] = [];
	for (const [key, value] of [
		['from', entry.from],
		['to', entry.to]
	] as const) {
		if (value === undefined) {
			continue;
		}
		if (needsBlock(value)) {
			blocks.push(formatBlock(key, value));
		} else {
			lines.push(`- ${key}: ${value}`);
		}
	}

	if (blocks.length > 0) {
		lines.push('', blocks.join('\n\n'));
	}

	if (entry.comment !== undefined && entry.comment !== '') {
		lines.push('');
		lines.push(...entry.comment.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)));
	}

	return lines.join('\n');
}

function parseHeader(line: string): Omit<NewHistoryEntry, 'comment'> | undefined {
	const rest = line.slice('## '.length);

	const first = findSeparator(rest, 0);
	if (!first) {
		return undefined;
	}
	const second = findSeparator(rest, first.index + first.length);
	if (!second) {
		return undefined;
	}

	const timestamp = rest.slice(0, first.index).trim();
	const author = rest.slice(first.index + first.length, second.index).trim();
	const action = rest.slice(second.index + second.length).trim();

	return timestamp === '' ? undefined : { timestamp, author, action };
}

/**
 * The em dash is what BFAST writes, but a person editing by hand reaches for an
 * en dash, a double hyphen or a spaced hyphen — all four read the same here. A
 * bare hyphen only separates when spaced, so an ISO date stays in one piece.
 */
function findSeparator(text: string, from: number): { index: number; length: number } | undefined {
	for (let i = from; i < text.length; i++) {
		if (text[i] === '—' || text[i] === '–') {
			return { index: i, length: 1 };
		}
		if (text[i] === '-' && text[i + 1] === '-') {
			return { index: i, length: 2 };
		}
		if (text[i] === '-' && text[i - 1] === ' ' && text[i + 1] === ' ') {
			return { index: i, length: 1 };
		}
	}
	return undefined;
}

function parseBody(lines: string[]): Partial<NewHistoryEntry> {
	const parsed: Partial<NewHistoryEntry> = {};

	// The structured part: bullets and fenced blocks in any order, blank lines
	// between them. The first line that is neither ends it, and the rest is the
	// comment.
	let i = 0;
	for (; i < lines.length; i++) {
		if (lines[i].trim() === '') {
			continue;
		}

		const bullet = FIELD_BULLET.exec(lines[i].trim());
		if (bullet) {
			parsed[bullet[1].toLowerCase() as 'field' | 'from' | 'to'] = bullet[2].trim();
			continue;
		}

		const fence = BLOCK_FENCE.exec(lines[i]);
		if (fence) {
			const closing = new RegExp(`^ {0,3}\`{${fence[1].length},}\\s*$`);
			const content: string[] = [];
			while (i + 1 < lines.length && !closing.test(lines[++i])) {
				// Undo the indent that kept these lines out of column zero.
				content.push(lines[i].startsWith(BLOCK_INDENT) ? lines[i].slice(BLOCK_INDENT.length) : lines[i]);
			}
			parsed[fence[2].toLowerCase() as 'from' | 'to'] = content.join('\n');
			continue;
		}

		break;
	}

	// Strip exactly one level of quoting, so a comment that itself quoted
	// something comes back the way it went in.
	const comment = lines
		.slice(i)
		.map((line) => (line.startsWith('> ') ? line.slice(2) : line === '>' ? '' : line))
		.join('\n')
		.trim();

	if (comment !== '') {
		parsed.comment = comment;
	}
	return parsed;
}

function needsBlock(value: string): boolean {
	return value.includes('\n') || value.length > MAX_BULLET_VALUE;
}

/**
 * ```` ```from ```` … ```` ``` ````, indented, with a fence long enough to
 * survive content that contains backticks of its own.
 */
function formatBlock(label: 'from' | 'to', value: string): string {
	const longestRun = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	const fence = '`'.repeat(Math.max(3, longestRun + 1));

	return [
		`${BLOCK_INDENT}${fence}${label}`,
		// A blank line stays blank: indenting it would only add trailing spaces,
		// and an empty line cannot be mistaken for the next entry's header.
		...value.split('\n').map((line) => (line === '' ? '' : `${BLOCK_INDENT}${line}`)),
		`${BLOCK_INDENT}${fence}`
	].join('\n');
}

/** Flattens anything that would read as a separator inside a header field. */
function headerPart(value: string): string {
	return value
		.replace(/[\r\n]+/g, ' ')
		.replace(/—|–|--/g, ' ')
		.replace(/ - /g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
