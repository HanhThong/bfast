// Cleaning up what a model returns before it reaches the board.
//
// Presentation policy shared by *every* provider, so it lives out here rather
// than inside one of them. Pure, and run on the host before `aiResult` is
// posted, so the draft the user reviews and the `to:` recorded in `history.md`
// hold the same bytes.

import type { AiResultMeta } from './aiProvider';

/**
 * Strips the three things a model reliably adds even when told not to: one
 * fence wrapping the whole answer, a `# Title` repeating the ticket's own
 * title, and surrounding blank lines.
 *
 * Deliberately conservative — it only unwraps a fence that opens on the first
 * line and closes on the last, so a description that legitimately *is* mostly
 * one code block keeps it.
 */
export function sanitizeAiDescription(text: string, title?: string): string {
	return dropTitleHeading(unwrapFence(text.trim()), title).trim();
}

/** Removes one ```` ```markdown ```` … ```` ``` ```` wrapper around the entire answer. */
function unwrapFence(text: string): string {
	const lines = text.split('\n');
	if (lines.length < 2) {
		return text;
	}

	const opening = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*$/.exec(lines[0]);
	if (!opening) {
		return text;
	}

	const [, marker, language] = opening;
	// Only a markdown-ish or unlabelled fence is a wrapper; ```ts is real content.
	if (language !== '' && !/^(markdown|md|mdx|text|txt)$/i.test(language)) {
		return text;
	}

	const closing = lines.length - 1;
	if (!new RegExp(`^${marker[0]}{${marker.length},}[ \t]*$`).test(lines[closing])) {
		return text;
	}

	// A fence of the same kind in the middle means these two are not a pair —
	// the answer contains its own code blocks and we would corrupt them.
	for (let index = 1; index < closing; index += 1) {
		if (new RegExp(`^${marker[0]}{${marker.length},}`).test(lines[index])) {
			return text;
		}
	}

	return lines.slice(1, closing).join('\n');
}

/**
 * Removes a leading `# <title>` that just repeats the ticket title. The board
 * already shows the title above the description, so it would render twice.
 */
function dropTitleHeading(text: string, title?: string): string {
	if (!title) {
		return text;
	}

	const lines = text.split('\n');
	const heading = /^#{1,2}[ \t]+(.*?)[ \t]*$/.exec(lines[0] ?? '');
	if (!heading || !sameTitle(heading[1], title)) {
		return text;
	}

	return lines.slice(1).join('\n');
}

/**
 * A title flattened for comparison: lower-case, punctuation and spacing
 * collapsed. Exported so the breakdown compares a proposed title against the
 * children that already exist with exactly the looseness a repeated heading is
 * recognised with here.
 */
export function titleKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Loose comparison: punctuation and case differences still count as a repeat. */
function sameTitle(a: string, b: string): boolean {
	const key = titleKey(a);
	return key === titleKey(b) && key.length > 0;
}

/**
 * How many titles one breakdown may propose.
 *
 * A guard against a model that decides an epic contains forty stories, not a
 * product decision: the skills ask for three to ten, and the user unticks what
 * they do not want. Creating forty folders because one answer ran away is the
 * failure worth preventing.
 */
export const MAX_PROPOSED_CHILDREN = 20;

/** Longest a proposed title may be, before it is cut. Folder slugs cap at 60. */
const MAX_TITLE_CHARS = 120;

/**
 * The titles out of a list a model returned.
 *
 * Tolerant for the same reason `sanitizeAiDescription` is: the plan skill asks
 * for `- one per line` and a model periodically numbers them, bolds them, wraps
 * the lot in a fence, or opens with "Here are five stories:".
 *
 * A line that is not a list item is **dropped**, never appended to the one
 * before it — that is what makes a preamble and a trailing "Let me know if…"
 * free, and a stray sentence turned into a ticket is worse than a missing one.
 * Never throws; an unparseable answer is `[]`, which the caller reports.
 */
export function parseTitleList(text: string, max = MAX_PROPOSED_CHILDREN): string[] {
	// Fence markers are dropped, but what is inside one is still read. The skill
	// asks for no fence at all, so a model that wrapped the list in ```text has
	// made the one mistake this has to survive — and a title list has no
	// legitimate code block to protect, unlike a description.
	const lines = sanitizeAiDescription(text)
		.split('\n')
		.filter((line) => !/^\s*(`{3,}|~{3,})/.test(line));

	const bullets: string[] = [];
	for (const line of lines) {
		const item = /^\s*(?:[-*+•–—]|\d+[.)])\s+(.*)$/.exec(line);
		if (item) {
			bullets.push(item[1]);
		}
	}

	// Nothing was marked up as a list. If what is left still *looks* like one —
	// short lines, few of them — take it; a paragraph is one long line, so it
	// cannot be mistaken for a list this way.
	const source = bullets.length > 0 ? bullets : plainLines(lines, max);

	const seen = new Set<string>();
	const titles: string[] = [];
	for (const raw of source) {
		const title = cleanTitle(raw);
		const key = title.toLowerCase();
		if (title.length === 0 || seen.has(key)) {
			continue;
		}
		seen.add(key);
		titles.push(title);
		if (titles.length >= max) {
			break;
		}
	}

	return titles;
}

/** The fallback source: every non-empty line, when they all read like titles. */
function plainLines(lines: readonly string[], max: number): string[] {
	const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0);
	return kept.length > 0 && kept.length <= max && kept.every((line) => line.length <= MAX_TITLE_CHARS)
		? kept
		: [];
}

/** Strips the decoration a model puts around a title but never means as part of it. */
function cleanTitle(raw: string): string {
	let title = raw.trim();

	// `[ ]` / `[x]` — a task list is still a list.
	title = title.replace(/^\[[ xX]?\]\s*/, '');
	// `**Sign in**` or `_Sign in_` wrapping the whole title.
	title = title.replace(/^(\*\*|__|\*|_)(.+?)\1$/, '$2').trim();
	// `Story 1:` / `AC 2 -` — the model numbering what it was told not to number.
	title = title.replace(/^(story|stories|ac|acceptance criterion|criterion|test case|tc)\s*\d*\s*[:.\-–—]\s*/i, '');
	// A trailing sentence terminator; a title is a fragment.
	title = title.replace(/\s*[:.]$/, '').trim();

	return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS).trimEnd() : title;
}

/**
 * The blockquote that goes in `history.md` beside an AI-authored change.
 *
 * The author stays the human — they pressed the button, chose the instruction,
 * read the result and pressed Save. This line is what says a model was involved,
 * which one, and what it cost, so spend is auditable in git.
 *
 * Out here rather than in `bfastPanel.ts` so the board and the sidebar's
 * generate commands stamp a ticket identically; the board is no longer the only
 * thing that runs the assistant.
 */
export function provenance(
	agent: string,
	skill: string | undefined,
	label: string,
	meta: AiResultMeta | undefined,
	instruction: string
): string {
	return withInstruction(
		`Written by the BFAST “${agent}” agent${skill ? ` — ${skill}` : ''} (${runDetails(label, meta)}).`,
		instruction
	);
}

/**
 * The history comment on a ticket an AI run edited *while writing another* —
 * the same facts as `provenance`, with the verb that is true: nobody pressed
 * Save on this one, and the turns and cost are the whole run's.
 */
export function editProvenance(
	agent: string,
	skill: string | undefined,
	label: string,
	meta: AiResultMeta | undefined,
	instruction: string,
	whileWriting: string
): string {
	return withInstruction(
		`Edited by the BFAST “${agent}” agent${skill ? ` — ${skill}` : ''}, while writing ${whileWriting} ` +
			`(${runDetails(label, meta)}).`,
		instruction
	);
}

function runDetails(label: string, meta: AiResultMeta | undefined): string {
	return [
		label,
		meta?.model,
		meta?.turns !== undefined ? `${meta.turns} turns` : undefined,
		meta?.costUsd !== undefined ? `$${meta.costUsd.toFixed(3)}` : undefined
	]
		.filter((part): part is string => part !== undefined)
		.join(', ');
}

function withInstruction(head: string, instruction: string): string {
	const trimmed = instruction.trim();
	return trimmed.length > 0 ? `${head}\nInstruction: ${JSON.stringify(trimmed)}` : head;
}
