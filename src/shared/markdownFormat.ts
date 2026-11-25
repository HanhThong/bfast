// The string maths behind the description editor's B / I / U buttons.
//
// Pure on purpose, like `bfastSettings.ts`: imported by the webview but with no
// DOM and no React in it, so the rules are unit-testable from `src/test/` and
// the toolbar and the keyboard shortcuts cannot disagree about them.
//
// Every function here follows the house rule and never throws: an out-of-range
// offset or a selection that makes no sense yields an edit that changes nothing
// surprising rather than an exception in the middle of someone's typing.

export type WrapStyle = 'bold' | 'italic' | 'underline';

/**
 * Markdown has no underline, so `<u>` it is. That is the only html the board's
 * renderer accepts, which is what keeps the description safe to render without
 * ever touching `innerHTML`.
 */
export const MARKERS: Record<WrapStyle, readonly [string, string]> = {
	bold: ['**', '**'],
	italic: ['*', '*'],
	underline: ['<u>', '</u>']
};

/**
 * A replacement expressed the way `document.execCommand('insertText')` wants
 * it — a range plus what goes in it — rather than as a whole new string. That
 * is what lets the caller keep the browser's own undo stack: a toolbar click
 * then becomes one undo step, exactly like typing.
 */
export interface TextEdit {
	replaceStart: number;
	replaceEnd: number;
	replacement: string;
	/** Where the selection lands afterwards, as offsets into the resulting text. */
	selectionStart: number;
	selectionEnd: number;
}

/** Applies an edit. Only the tests and the `setRangeText` fallback need this. */
export function applyTextEdit(text: string, edit: TextEdit): string {
	return text.slice(0, edit.replaceStart) + edit.replacement + text.slice(edit.replaceEnd);
}

/**
 * Toggles `style` around the selection.
 *
 * - Markers just *outside* the selection count as applied, so selecting the word
 *   inside `**word**` and pressing bold un-bolds it instead of nesting.
 * - So do markers the selection swallowed, for when the user dragged over them.
 * - Whitespace at either edge of the selection is pushed outside the markers;
 *   `**word **` is not bold in any dialect.
 * - An empty selection writes both markers and leaves the caret between them.
 */
export function toggleWrap(text: string, start: number, end: number, style: WrapStyle): TextEdit {
	const [from, to] = normalizeRange(text, start, end);
	const [open, close] = MARKERS[style];

	// Trailing whitespace inside the selection would sit between the marker and
	// the word and stop the emphasis from parsing at all.
	const [innerStart, innerEnd] = trimRange(text, from, to);
	const inner = text.slice(innerStart, innerEnd);

	const outside = wrappedOutside(text, innerStart, innerEnd, style);
	if (outside) {
		const [openLength, closeLength] = outside;
		const from = innerStart - openLength;
		return replace(from, innerEnd + closeLength, inner, from);
	}

	const inside = wrappedInside(inner, style);
	if (inside) {
		const [openLength, closeLength] = inside;
		const stripped = inner.slice(openLength, inner.length - closeLength);
		return replace(innerStart, innerEnd, stripped, innerStart);
	}

	const replacement = `${open}${inner}${close}`;
	const caret = innerStart + open.length;
	return {
		replaceStart: innerStart,
		replaceEnd: innerEnd,
		replacement,
		// An empty selection leaves the caret between the markers, ready to type;
		// otherwise the text stays selected so the style can be toggled straight off.
		selectionStart: caret,
		selectionEnd: caret + inner.length
	};
}

/** 0 is an ordinary paragraph; 1–6 are `#` through `######`. */
export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The block shape of the lines a selection touches, for the toolbar to show. */
export interface BlockState {
	heading: HeadingLevel;
	bulleted: boolean;
}

const HEADING_PREFIX = /^(#{1,6})[ \t]+/;
const BULLET_PREFIX = /^[-*+][ \t]+/;

/**
 * What the toolbar should be showing for the current selection: the level of
 * the first line it touches, and whether every line it touches is a bullet.
 */
export function blockStateAt(text: string, start: number, end: number): BlockState {
	const lines = selectedLines(text, start, end);
	const heading = HEADING_PREFIX.exec(lines[0] ?? '');
	const written = lines.filter((line) => line.trim() !== '');

	return {
		heading: (heading ? heading[1].length : 0) as HeadingLevel,
		// An empty selection in blank space is not a list, however you read it.
		bulleted: written.length > 0 && written.every((line) => BULLET_PREFIX.test(line))
	};
}

/**
 * Makes every line the selection touches a heading of `level`, or a plain
 * paragraph at level 0.
 *
 * A heading is not a list item, so becoming one drops any bullet — `# - thing`
 * renders as a heading whose text begins with a dash, which nobody means.
 */
export function setHeading(
	text: string,
	start: number,
	end: number,
	level: HeadingLevel
): TextEdit {
	return lineEdit(text, start, end, (line) => {
		const bare = line.replace(HEADING_PREFIX, '');
		if (level === 0) {
			return bare;
		}
		return `${'#'.repeat(level)} ${bare.replace(BULLET_PREFIX, '')}`;
	});
}

/**
 * Bullets every line the selection touches, or un-bullets them when they all
 * already are. Blank lines are left alone, so bulleting a paragraph and the
 * gap after it does not leave a stray `-` behind.
 */
export function toggleBullet(text: string, start: number, end: number): TextEdit {
	const already = blockStateAt(text, start, end).bulleted;

	return lineEdit(text, start, end, (line) => {
		if (line.trim() === '') {
			return line;
		}
		if (already) {
			return line.replace(BULLET_PREFIX, '');
		}
		// A selection that is only partly a list gains bullets on the rest of it,
		// and the lines that already had one are left as they are rather than
		// ending up with two.
		return BULLET_PREFIX.test(line) ? line : `- ${line.replace(HEADING_PREFIX, '')}`;
	});
}

/** Drops `insert` in at the selection, replacing whatever it covered. */
export function insertText(text: string, start: number, end: number, insert: string): TextEdit {
	const [from, to] = normalizeRange(text, start, end);
	const after = from + insert.length;
	return {
		replaceStart: from,
		replaceEnd: to,
		replacement: insert,
		selectionStart: after,
		selectionEnd: after
	};
}

/**
 * `![alt](assets/x.png)`. `assetFileName` has already stripped the characters
 * that break a link, but a name that reached us another way might not have, so
 * the angle-bracket form is used whenever the path needs it.
 */
export function imageMarkdown(alt: string, path: string): string {
	const safeAlt = alt.replace(/[[\]]/g, '').trim();
	return /[\s()<>]/.test(path)
		? `![${safeAlt}](<${path}>)`
		: `![${safeAlt}](${path})`;
}

function replace(
	replaceStart: number,
	replaceEnd: number,
	replacement: string,
	selectionStart: number
): TextEdit {
	return {
		replaceStart,
		replaceEnd,
		replacement,
		selectionStart,
		selectionEnd: selectionStart + replacement.length
	};
}

/** Rewrites every line the selection touches, one at a time. */
function lineEdit(
	text: string,
	start: number,
	end: number,
	transform: (line: string) => string
): TextEdit {
	const [from, to] = lineRange(text, start, end);
	const before = text.slice(from, to);
	const replacement = before.split('\n').map(transform).join('\n');

	if (start !== end) {
		return replace(from, to, replacement, from);
	}

	// A caret stays a caret, or picking a heading and carrying on typing would
	// overwrite the line that was just styled. One line in, one line out, so the
	// length change is exactly what the prefix did.
	const caret = clamp(text, start + replacement.length - before.length);
	return { replaceStart: from, replaceEnd: to, replacement, selectionStart: caret, selectionEnd: caret };
}

/** The lines a selection touches, as text. */
function selectedLines(text: string, start: number, end: number): string[] {
	const [from, to] = lineRange(text, start, end);
	return text.slice(from, to).split('\n');
}

/** Widens a selection to whole lines, the unit every block style works in. */
function lineRange(text: string, start: number, end: number): [number, number] {
	const [from, to] = normalizeRange(text, start, end);

	// `lastIndexOf` treats a negative index as 0, which would misread a text that
	// opens with a newline, so the start of the buffer is handled on its own.
	const lineStart = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;

	// A selection ending just after a newline stops at that line, the way
	// dragging to column zero does not pull in the line below.
	const searchFrom = to > from && text[to - 1] === '\n' ? to - 1 : to;
	const lineEnd = text.indexOf('\n', searchFrom);

	return [lineStart, lineEnd === -1 ? text.length : lineEnd];
}

function clamp(text: string, value: number): number {
	return Math.min(Math.max(value, 0), text.length);
}

/** Clamps and orders the offsets, so a bogus selection cannot throw. */
function normalizeRange(text: string, start: number, end: number): [number, number] {
	const clamp = (value: number): number =>
		Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), text.length) : 0;
	const a = clamp(start);
	const b = clamp(end);
	return a <= b ? [a, b] : [b, a];
}

/** Shrinks the range past whitespace at either edge, unless that empties it. */
function trimRange(text: string, start: number, end: number): [number, number] {
	let from = start;
	let to = end;
	while (from < to && /\s/.test(text[from])) {
		from++;
	}
	while (to > from && /\s/.test(text[to - 1])) {
		to--;
	}
	// An all-whitespace selection has nothing to emphasise; treat it as a caret
	// where it started rather than wrapping the spaces.
	return from === to ? [start, start] : [from, to];
}

/**
 * How many characters to strip from each side when `style`'s markers sit
 * immediately outside the range, or `undefined` when it is not wrapped. The two
 * counts differ for `<u>` and `</u>`, which is the whole reason for the pair.
 */
function wrappedOutside(
	text: string,
	start: number,
	end: number,
	style: WrapStyle
): [number, number] | undefined {
	const [open, close] = MARKERS[style];

	if (style === 'underline') {
		const wrapped =
			text.slice(start - open.length, start) === open &&
			text.slice(end, end + close.length) === close;
		return wrapped ? [open.length, close.length] : undefined;
	}

	return asteriskDepth(starRun(text, start - 1, -1), starRun(text, end, 1), style);
}

/** The same question for markers the selection itself swallowed. */
function wrappedInside(inner: string, style: WrapStyle): [number, number] | undefined {
	const [open, close] = MARKERS[style];

	if (style === 'underline') {
		const wrapped =
			inner.length > open.length + close.length &&
			inner.startsWith(open) &&
			inner.endsWith(close);
		return wrapped ? [open.length, close.length] : undefined;
	}

	// Both runs are counted from the same short string, so a lone `***` would be
	// read from both ends at once; require enough text to hold two markers.
	const needed = style === 'bold' ? 4 : 2;
	if (inner.length <= needed) {
		return undefined;
	}

	return asteriskDepth(starRun(inner, 0, 1), starRun(inner, inner.length - 1, -1), style);
}

/**
 * Emphasis nests, so counting runs of `*` is the only way to tell the styles
 * apart: `***word***` is italic *and* bold, `**word**` is only bold. An odd run
 * means the innermost `*` is an italic marker; a run of two or more means the
 * pair just inside it is a bold marker.
 */
function asteriskDepth(
	before: number,
	after: number,
	style: 'bold' | 'italic'
): [number, number] | undefined {
	if (style === 'bold') {
		return before >= 2 && after >= 2 ? [2, 2] : undefined;
	}
	return before % 2 === 1 && after % 2 === 1 ? [1, 1] : undefined;
}

/** How many `*` run consecutively from `index`, walking by `step`. */
function starRun(text: string, index: number, step: -1 | 1): number {
	let count = 0;
	for (let i = index; i >= 0 && i < text.length && text[i] === '*'; i += step) {
		count++;
	}
	return count;
}
