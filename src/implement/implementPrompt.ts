// Implement's prompt: the template grammar, the placeholder set and the
// rendering — the pure half of the feature. docs/implement/README.md is the
// spec; the placeholder table there and `IMPLEMENT_TOKENS` here must match.
//
// No `vscode` and no `node:` import: the settings webview bundles this module
// for the prompt list it shows, and `typecheck:web` fails on a Node import even
// through `import type`. The `vscode` half — reading the files, walking the
// tracker — is `implementPromptStore.ts` and `implementContext.ts`.
//
// A template is a file per ticket type under `.bfast/implement/`, seeded from
// `templates/implement/`, with the `SKILL.md` frontmatter grammar in front of
// the text. The prompt is the text with `{{tokens}}` substituted through the
// same reader `tests.command` uses (`substituteCommand`), so an unknown token
// is left untouched here for the reason it is there.

import { parseTypes, splitFrontmatter, ticketTypeLabel, typeFromName } from '../ai/agent';
import type { TicketType } from '../data/types';
import { substituteCommand } from '../settings/commandTemplate';

/** The folder the templates live in, relative to the workspace root. */
export const IMPLEMENT_FOLDER = '.bfast/implement';

/**
 * Where the CLI route writes the rendered prompt — a subfolder of the
 * templates', so the feature's files stay under one roof. Output, not input:
 * the store's seeding and listing ignore it.
 */
export const HANDOFF_FOLDER = 'prompts';

/** One template per ticket type; the file name is what infers the type. */
export const IMPLEMENT_TEMPLATE_FILE: Record<TicketType, string> = {
	epic: 'epic.md',
	story: 'story.md',
	ac: 'acceptance-criterion.md',
	testcase: 'test-case.md'
};

/**
 * The working rules every template carries through `{{rules}}` — how to
 * approach any ticket, as opposed to what this kind of ticket asks for. One
 * file shared by the four templates, the role/skill split restated: the
 * standard is the same whatever is being implemented, and a change to it
 * should be made once.
 */
export const IMPLEMENT_RULES_FILE = 'rules.md';

/** `acceptance-criterion.md` → `ac`: the skill rule, by word rather than substring. */
export function implementTemplateType(fileName: string): TicketType | undefined {
	return typeFromName(fileName.replace(/\.md$/i, ''));
}

/** The placeholders a template may use; docs/implement/README.md §Placeholders is the table. */
export const IMPLEMENT_TOKENS = [
	'id',
	'key',
	'title',
	'type',
	'status',
	'folder',
	'file',
	'description',
	'ancestors',
	'children',
	'designs',
	'testCommand',
	'tracker',
	'rules'
] as const;

export type ImplementToken = (typeof IMPLEMENT_TOKENS)[number];

/** Every value substituted into a template. A record, so it spreads into `substituteCommand`. */
export type ImplementVars = Record<ImplementToken, string>;

/** What `{{description}}` says when the ticket has none. */
export const EMPTY_DESCRIPTION = '(empty)';
/** What a list token says when there is nothing to list. */
export const NONE = '(none)';
/** What `{{testCommand}}` says when `tests.command` is unset. */
export const TEST_COMMAND_UNSET = '(not configured — see Settings → Tests)';

export interface ImplementTemplateFile {
	/** From the frontmatter, else `implement-<stem>`. */
	name: string;
	description?: string;
	/** Explicit `types:` wins; otherwise inferred from the file name. */
	types: TicketType[];
	/** The template itself, frontmatter stripped. */
	body: string;
}

/**
 * Reads a template file. Forgiving, like every reader in BFAST: no frontmatter
 * is all body, and a stem that names no type covers nothing rather than
 * everything — a template that quietly applied to every ticket would override
 * the ones that were deliberate.
 */
export function parseImplementTemplate(text: string, fileName: string): ImplementTemplateFile {
	const { front, body } = splitFrontmatter(text ?? '');
	const stem = fileName.replace(/\.md$/i, '');
	const explicit = parseTypes(front.types);
	const inferred = implementTemplateType(fileName);

	return {
		name: front.name?.trim() || `implement-${stem}`,
		...(front.description?.trim() ? { description: front.description.trim() } : {}),
		types: explicit.length > 0 ? explicit : inferred ? [inferred] : [],
		body
	};
}

/** One ticket named by path — an ancestor, or a descendant at `depth` below the ticket. */
export interface ImplementTicketLine {
	id: string;
	title: string;
	/** Workspace-relative, forward slashes: the description file. */
	path: string;
	/** 0 for a direct child; absent for an ancestor. */
	depth?: number;
}

export interface ImplementDesignLine {
	id: string;
	title: string;
	/** The style's label — "Entity Relationship Diagram". */
	style: string;
	/** Which ticket it sits on: the clicked one, or an ancestor. */
	ticketId: string;
	path: string;
}

/** Epic first, one line each: ``- `EP-1` Authentication — `<path>` ``. */
export function formatAncestors(rows: readonly ImplementTicketLine[]): string {
	return rows.length === 0 ? NONE : rows.map((row) => ticketLine(row)).join('\n');
}

/** The same line, indented two spaces per level below the ticket. */
export function formatChildren(rows: readonly ImplementTicketLine[]): string {
	return rows.length === 0
		? NONE
		: rows.map((row) => `${'  '.repeat(row.depth ?? 0)}${ticketLine(row)}`).join('\n');
}

/** ``- `ERD-1` Account model (Entity Relationship Diagram, on `ST-1.2`) — `<path>` ``. */
export function formatDesigns(rows: readonly ImplementDesignLine[]): string {
	return rows.length === 0
		? NONE
		: rows
				.map(
					(row) =>
						`- \`${row.id}\` ${row.title} (${row.style}, on \`${row.ticketId}\`) — \`${row.path}\``
				)
				.join('\n');
}

function ticketLine(row: ImplementTicketLine): string {
	return `- \`${row.id}\` ${row.title} — \`${row.path}\``;
}

/** `{{type}}` as prose: "acceptance criterion", never "ac". */
export function implementTypeName(type: TicketType): string {
	return ticketTypeLabel(type).toLowerCase();
}

/**
 * The prompt: the template with every token substituted. An unknown `{{token}}`
 * is left in the text untouched, so a template can carry a literal
 * `{{example}}` for the agent to fill.
 */
export function renderImplementPrompt(template: string, vars: ImplementVars): string {
	return substituteCommand(template, vars);
}

/**
 * The file the CLI route writes a ticket's rendered prompt to, by id: a
 * duplicate's `#` (`ST-1#2.1`) becomes `_` — `#` breaks a shell line, and no
 * other id carries an underscore, so the name still cannot collide. The
 * `testCaseResultsFolder` rule, restated here rather than imported from the
 * testing feature, because the two folders are unrelated.
 */
export function handoffFileName(ticketId: string): string {
	return `${ticketId.replace(/#/g, '_')}.md`;
}

/** Workspace-relative, forward slashes: `.bfast/implement/prompts/ST-1.2.md`. */
export function handoffPath(ticketId: string): string {
	return `${IMPLEMENT_FOLDER}/${HANDOFF_FOLDER}/${handoffFileName(ticketId)}`;
}

/**
 * Every character the handoff sentence may carry besides its constant words:
 * the path's letters, digits, `.`, `-`, `_` and `/`. Anything else is refused,
 * never quoted — the alphabet is the whole safety argument for the CLI's shell
 * line, and a quote would be a second one.
 */
const HANDOFF_ALPHABET = /^[A-Za-z0-9._/-]+$/;

/**
 * What every agent receives, verbatim: one sentence naming the file the
 * rendered prompt was written to. The same string in a chat input and on a
 * shell line, so the two routes hand over the same thing and the prompt's
 * prose — a title that arrived from a `git pull` — never reaches a shell.
 */
export function handoffSentence(path: string): string {
	if (!HANDOFF_ALPHABET.test(path)) {
		throw new Error(`\`${path}\` cannot be named in a handoff sentence.`);
	}
	return `Your task is in ${path}. Read that file first, then do what it says.`;
}

/** What the settings form lists per ticket type. */
export interface ImplementPromptInfo {
	type: TicketType;
	name: string;
	description?: string;
	/** Where the workspace's file is, or would be: `.bfast/implement/story.md`. */
	path: string;
	/** Whether that file exists, or the shipped template is standing in. */
	source: 'workspace' | 'bundled';
}
