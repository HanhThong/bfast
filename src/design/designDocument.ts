// The on-disk format of a technical design document, and the style table that
// names them. `docs/designs/` is the specification.
//
// Node-free and `vscode`-free on purpose: this module is imported by the webview
// and by `shared/protocol/`, the way `testing/testReport.ts` is. Anything that
// touches the file system belongs in `designStore.ts`.
//
// A design document is a `.mdx` file sitting beside the ticket's own content
// file, named `<PREFIX>-<ordinal>-<Slug>.mdx`. The name is the identity: the
// prefix says which style it is, the ordinal orders it among that style's
// documents on the same ticket, and the slug is the title made safe. That is
// the same grammar `folderName` gives a ticket folder, and for the same reason —
// a file that identifies itself needs nothing else read to place it.

import { deslugify, slugifyTitle, TYPE_PREFIX } from '../data/trackerPaths';
import type { TicketType } from '../data/types';
import { parseYamlMap, serializeYamlMap, type YamlMap } from '../data/yaml';

/** A kind of technical design document. */
export interface DesignStyle {
	/**
	 * Slug carried in each document's frontmatter, and how a design skill says
	 * which style it shapes.
	 */
	id: string;
	/** What the board's "+" menu shows. */
	label: string;
	/** Starts the file name of every document in this style. Unique. */
	prefix: string;
	/**
	 * Slug of the design skill to run, when it is not the `design-<id>` default.
	 */
	skill?: string;
}

/**
 * The styles that always exist, whatever skills a workspace holds.
 *
 * Every other style is declared by a **design skill** — see `stylesFromAgents`
 * in `ai/agent.ts` — and the shipped skill for each of them carries the same
 * label and prefix (a test pins that). They stay a constant rather than being read
 * out of the library so a workspace whose agents were hand-trimmed of every
 * design skill still offers them: `AgentStore.designSkill` falls back to the
 * bundled skill, so the AI can always write one.
 */
export const BUILT_IN_STYLES: readonly DesignStyle[] = [
	{
		id: 'entity-relationship-diagram',
		label: 'Entity-Relationship Diagram',
		prefix: 'ERD'
	},
	{ id: 'sequence-diagram', label: 'Sequence Diagram', prefix: 'SEQ' },
	{ id: 'low-level-design', label: 'Low Level Design', prefix: 'LLD' }
];

/** The ticket types a design document may hang under. */
export const DESIGN_TYPES: readonly TicketType[] = ['epic', 'story'];

/** Whether this ticket type may carry design documents. */
export function allowsDesigns(type: TicketType | undefined): boolean {
	return type !== undefined && DESIGN_TYPES.includes(type);
}

/** Which skill runs for a style. */
export function designSkillSlug(style: DesignStyle): string {
	return style.skill ?? `design-${style.id}`;
}

/** A style's id: a slug, because it goes in a file's frontmatter and names a skill folder. */
const STYLE_ID = /^[a-z][a-z0-9-]*$/;

/**
 * A style's prefix: what every one of its documents' file names starts with.
 * Upper case and short, so a design file is recognisable at a glance beside
 * `Story.mdx`.
 */
const STYLE_PREFIX = /^[A-Z][A-Z0-9]{0,7}$/;

/** Reserved: a ticket folder's name is parsed by exactly these. */
const TICKET_PREFIXES: readonly string[] = Object.values(TYPE_PREFIX);

/** `c4-context` → `C4 Context`: the label a style gets when its skill names none. */
export function labelFromStyleId(id: string): string {
	return id
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/** An error message, or `undefined` when the id is usable. */
export function validateStyleId(id: string): string | undefined {
	if (!STYLE_ID.test(id)) {
		return 'A style id is lower-case letters, digits and hyphens, starting with a letter.';
	}
	if (BUILT_IN_STYLES.some((style) => style.id === id)) {
		return `“${id}” is a built-in style.`;
	}
	return undefined;
}

/**
 * An error message, or `undefined` when the prefix is usable. `taken` is every
 * prefix already in use, built-ins included.
 */
export function validateStylePrefix(prefix: string, taken: readonly string[] = []): string | undefined {
	if (!STYLE_PREFIX.test(prefix)) {
		return 'A prefix is 1–8 upper-case letters or digits, starting with a letter.';
	}
	if (TICKET_PREFIXES.includes(prefix)) {
		// A folder name is parsed by these, so a design file would read as a ticket.
		return `${prefix} is a ticket prefix.`;
	}
	if (taken.includes(prefix)) {
		return `${prefix} is already used by another style.`;
	}
	return undefined;
}

export const DESIGN_EXTENSION = '.mdx';

/**
 * Shorter than a ticket folder's slug: this name sits *inside* a folder that
 * already carries the ticket's full id, and Windows path length is finite.
 */
const MAX_DESIGN_SLUG = 40;

/** `ERD-1-Account_model.mdx`. The `-<slug>` is present even when empty-ish. */
const FILE_NAME = /^([A-Z][A-Z0-9]{0,7})-(\d+)(?:-(.*))?\.mdx$/;

/** The frontmatter block, if there is one. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Serialisation order, and the keys this module owns. */
const KEY_ORDER = ['title', 'style', 'createdBy', 'createdAt', 'updatedAt'] as const;

export interface DesignSummary {
	/** `ERD-1` — unique within its ticket. */
	id: string;
	/** The ticket this belongs to. */
	ticketId: string;
	/** The style's id, as claimed by the frontmatter or inferred from the prefix. */
	style: string;
	/** The file name's prefix, which is what actually decides the style. */
	prefix: string;
	ordinal: number;
	title: string;
	fileName: string;
	/** ISO 8601. The optimistic-concurrency token, this document's own. */
	updatedAt?: string;
}

export interface DesignDocument extends DesignSummary {
	/** Markdown, frontmatter already stripped. */
	body: string;
	createdBy?: string;
	createdAt?: string;
	/** Frontmatter keys BFAST does not own, carried through a rewrite untouched. */
	extra: YamlMap;
}

export function designId(prefix: string, ordinal: number): string {
	return `${prefix}-${ordinal}`;
}

export function parseDesignId(id: string): { prefix: string; ordinal: number } | undefined {
	const match = /^([A-Z][A-Z0-9]{0,7})-(\d+)$/.exec(id);
	if (!match) {
		return undefined;
	}
	return { prefix: match[1], ordinal: Number(match[2]) };
}

export function designFileName(prefix: string, ordinal: number, title: string): string {
	return `${designId(prefix, ordinal)}-${slugifyTitle(title, MAX_DESIGN_SLUG)}${DESIGN_EXTENSION}`;
}

/** `undefined` for any file that is not a design document. */
export function parseDesignFileName(
	name: string
): { prefix: string; ordinal: number; slug: string } | undefined {
	const match = FILE_NAME.exec(name);
	if (!match) {
		return undefined;
	}
	return { prefix: match[1], ordinal: Number(match[2]), slug: match[3] ?? '' };
}

/**
 * One past the highest ordinal that style already uses on this ticket.
 *
 * Never reuses a retired one, exactly as `nextOrdinal` does for tickets: an id
 * that once meant something else is worse than a gap.
 */
export function nextDesignOrdinal(existing: readonly DesignSummary[], prefix: string): number {
	let highest = 0;
	for (const design of existing) {
		if (design.prefix === prefix && design.ordinal > highest) {
			highest = design.ordinal;
		}
	}
	return highest + 1;
}

/**
 * The style a document is in.
 *
 * Keyed on the **prefix**, because that is what the file name carries and the
 * file name is the identity. A prefix nobody configures any more still resolves,
 * to a style synthesised from itself — a style removed from settings must not
 * make the documents written in it disappear; it only leaves the "+" menu.
 */
export function resolveStyle(styles: readonly DesignStyle[], prefix: string): DesignStyle {
	return (
		styles.find((style) => style.prefix === prefix) ?? {
			id: prefix.toLowerCase(),
			label: prefix,
			prefix
		}
	);
}

/** The style with this id, if any is configured. */
export function styleById(
	styles: readonly DesignStyle[],
	id: string
): DesignStyle | undefined {
	return styles.find((style) => style.id === id);
}

/**
 * Documents in the order the tab bar shows them: by their style's position in
 * the effective list, then by ordinal. A document in a style nobody configures
 * sorts after every configured one rather than vanishing.
 */
export function compareDesigns(
	styles: readonly DesignStyle[],
	a: DesignSummary,
	b: DesignSummary
): number {
	const rank = (design: DesignSummary) => {
		const index = styles.findIndex((style) => style.prefix === design.prefix);
		return index === -1 ? styles.length : index;
	};
	return rank(a) - rank(b) || a.ordinal - b.ordinal || a.fileName.localeCompare(b.fileName);
}

/**
 * Reads one design document. Never throws.
 *
 * The file name is the authority for the prefix and the ordinal; the
 * frontmatter is the authority for the title, since a slug is lossy. When the
 * frontmatter's `style` disagrees with the prefix the **file name wins** and the
 * next write heals the file — structure beats a claim, the same rule a ticket's
 * id follows against its nesting.
 */
export function parseDesignDocument(
	text: string,
	fileName: string,
	ticketId: string,
	styles: readonly DesignStyle[] = BUILT_IN_STYLES
): DesignDocument | undefined {
	const parsed = parseDesignFileName(fileName);
	if (!parsed) {
		return undefined;
	}

	const match = FRONTMATTER.exec(text);
	const front = match ? parseYamlMap(match[1]) : {};
	// Strip the blank line the frontmatter is followed by, so `body` is the
	// markdown itself and `serializeDesignDocument` is its exact inverse.
	const body = (match ? text.slice(match[0].length) : text).replace(/^\r?\n+/, '');

	const extra: YamlMap = {};
	for (const [key, value] of Object.entries(front)) {
		if (!(KEY_ORDER as readonly string[]).includes(key)) {
			extra[key] = value;
		}
	}

	return {
		id: designId(parsed.prefix, parsed.ordinal),
		ticketId,
		style: resolveStyle(styles, parsed.prefix).id,
		prefix: parsed.prefix,
		ordinal: parsed.ordinal,
		title: front.title?.trim() || deslugify(parsed.slug),
		fileName,
		body,
		createdBy: front.createdBy || undefined,
		createdAt: front.createdAt || undefined,
		updatedAt: front.updatedAt || undefined,
		extra
	};
}

/** The whole file: frontmatter, a blank line, then the body. */
export function serializeDesignDocument(document: DesignDocument): string {
	const map: YamlMap = { ...document.extra, title: document.title, style: document.style };
	for (const key of ['createdBy', 'createdAt', 'updatedAt'] as const) {
		const value = document[key];
		if (value) {
			map[key] = value;
		} else {
			delete map[key];
		}
	}

	const front = serializeYamlMap(map, { order: [...KEY_ORDER] });
	const body = document.body.replace(/^\n+/, '');
	return `---\n${front}---\n\n${body}`;
}

/** Diagram keywords a bare mermaid answer would begin with. */
const MERMAID_START =
	/^\s*(erDiagram|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|flowchart|graph|journey|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|architecture-beta|block-beta)\b/;

/** A fence opening or closing line, with its marker and info string. */
const FENCE_LINE = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/;

/**
 * Makes an AI answer renderable, on the AI path only — a hand-written document
 * is saved exactly as typed.
 *
 * `sanitizeAiDescription` cannot do this job. Its `unwrapFence` refuses to strip
 * an outer wrapper when a fence of the same kind appears in the middle, because
 * for a description that means the answer contains its own code blocks and
 * unwrapping would corrupt them. A design document *always* contains a fence, so
 * a model that wraps its whole answer in ```markdown lands a code block holding
 * a mermaid fence, and nothing renders. The mirror case is an answer that is a
 * bare diagram with no fence at all.
 *
 * Both are shapes a skill's output contract already forbids; this is the
 * forgiveness that keeps one disobedient run from producing a blank tab.
 */
export function ensureMermaidFence(text: string): string {
	const unwrapped = unwrapMarkdownWrapper(text.trim());
	if (FENCE_LINE.test(unwrapped.split('\n')[0] ?? '') || unwrapped.includes('```mermaid')) {
		return unwrapped;
	}
	return MERMAID_START.test(unwrapped) ? `\`\`\`mermaid\n${unwrapped}\n\`\`\`` : unwrapped;
}

/** Removes a ```markdown wrapper around the whole answer, fences inside and all. */
function unwrapMarkdownWrapper(text: string): string {
	const lines = text.split('\n');
	if (lines.length < 3) {
		return text;
	}

	const opening = FENCE_LINE.exec(lines[0]);
	if (!opening || !/^(markdown|md|mdx)$/i.test(opening[2])) {
		return text;
	}

	const marker = opening[1];
	const closing = lines.length - 1;
	if (!new RegExp(`^${marker[0]}{${marker.length},}[ \t]*$`).test(lines[closing])) {
		return text;
	}

	// Deliberately *not* the guard `unwrapFence` uses. That one refuses to strip
	// a wrapper when a fence of the same kind appears in the middle, because for
	// a description that means the answer contains its own code blocks. Here the
	// inner fence is the whole point, and by strict markdown rules the outer
	// block would end at it — the text is genuinely ambiguous, and a model that
	// wrapped its answer is the far likelier reading. So the condition is narrow
	// instead: unwrap only when doing so rescues a mermaid diagram.
	const inside = lines.slice(1, closing).join('\n').trim();
	return inside.includes('```mermaid') ? inside : text;
}
