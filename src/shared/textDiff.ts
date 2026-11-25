// A line diff, with a word diff inside a line that was rewritten rather than
// replaced.
//
// Hand-rolled for the reason `yaml.ts`, `zipFile.ts` and
// `sonarProjectProperties.ts` are hand-rolled readers: the extension host ships
// one optional dependency and the webview bundles React, `marked` and `mermaid`
// and nothing else, so a diff library would be the first runtime dependency
// added for one screen.
//
// Bundled into the webview, so no `vscode` and no `node:` import — and out of
// the components, because the webview has no DOM test runner: the rules live
// here so `textDiff.test.ts` can hold them, the `mediaError.ts` precedent.

/** What happened to one line. */
export type DiffOp = 'same' | 'added' | 'removed';

/** A run of characters inside a line, and whether it is part of the change. */
export interface DiffPart {
	text: string;
	changed: boolean;
}

export interface DiffLine {
	op: DiffOp;
	text: string;
	/**
	 * The word-level breakdown, set only on a removed/added pair that is the
	 * same sentence rewritten. Absent means the line is shown whole — two
	 * unrelated lines with every word highlighted are noise, not a diff.
	 */
	parts?: DiffPart[];
}

/** The unchanged lines a collapsed view is not showing. */
export interface DiffGap {
	op: 'gap';
	hidden: number;
}

export type DiffRow = DiffLine | DiffGap;

/**
 * The largest table the line diff will build.
 *
 * A guard rather than a feature: past this the two texts are reported as one
 * whole replacement, which is both honest and instant. A diff of two documents
 * that size is not one anybody reads anyway.
 */
export const MAX_CELLS = 1_000_000;

/** The same guard for the word diff, where the inputs are one line each. */
const MAX_WORD_CELLS = 40_000;

/**
 * How alike a removed line and the added line facing it must be before they are
 * shown as one rewritten line rather than two separate ones. Measured in shared
 * characters over the two lengths, so a half-rewritten sentence still pairs.
 */
export const SIMILARITY_FLOOR = 0.5;

/** Unchanged lines kept either side of a change when the rest is collapsed. */
export const CONTEXT_LINES = 3;

/**
 * The lines of a text, with the final newline's empty tail dropped.
 *
 * An empty text has no lines at all — not one empty line — so a first draft
 * reads as "everything was added" rather than as a change to a blank line.
 */
export function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/**
 * The unified diff of two texts: every line of both, in order, each marked.
 *
 * The common prefix and suffix are trimmed before the table is built, which is
 * what keeps a one-line edit to a long description cheap.
 */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);

	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) {
		head += 1;
	}
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail += 1;
	}

	const lines: DiffLine[] = [];
	for (let i = 0; i < head; i += 1) {
		lines.push({ op: 'same', text: a[i] });
	}
	lines.push(...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)));
	for (let i = a.length - tail; i < a.length; i += 1) {
		lines.push({ op: 'same', text: a[i] });
	}

	return pairRewrites(lines);
}

/** How many lines the diff added and removed — the `+12 −4` on the review. */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.op === 'added') {
			added += 1;
		} else if (line.op === 'removed') {
			removed += 1;
		}
	}
	return { added, removed };
}

/**
 * Replaces long runs of unchanged lines with a gap row, keeping `context`
 * lines either side of every change.
 *
 * A gap standing in for a single line is not worth it — it costs a row either
 * way and the reader loses the line — so that one is shown instead.
 */
export function collapseUnchanged(
	lines: readonly DiffLine[],
	context = CONTEXT_LINES
): DiffRow[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.op === 'same') {
			return;
		}
		const from = Math.max(0, index - context);
		const to = Math.min(lines.length - 1, index + context);
		for (let i = from; i <= to; i += 1) {
			keep[i] = true;
		}
	});

	const rows: DiffRow[] = [];
	let run: DiffLine[] = [];
	const flush = () => {
		if (run.length === 1) {
			rows.push(run[0]);
		} else if (run.length > 1) {
			rows.push({ op: 'gap', hidden: run.length });
		}
		run = [];
	};

	lines.forEach((line, index) => {
		if (keep[index]) {
			flush();
			rows.push(line);
			return;
		}
		run.push(line);
	});
	flush();

	return rows;
}

/** The changed middle, once the identical ends have been trimmed off. */
function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
	const whole = (): DiffLine[] => [
		...a.map((text): DiffLine => ({ op: 'removed', text })),
		...b.map((text): DiffLine => ({ op: 'added', text }))
	];

	if (a.length === 0 || b.length === 0) {
		return whole();
	}

	const common = longestCommon(a, b, MAX_CELLS);
	if (!common) {
		// Too big to diff: one whole replacement, which is the honest answer.
		return whole();
	}

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	for (const step of common) {
		while (i < step.a) {
			lines.push({ op: 'removed', text: a[i++] });
		}
		while (j < step.b) {
			lines.push({ op: 'added', text: b[j++] });
		}
		lines.push({ op: 'same', text: a[i] });
		i += 1;
		j += 1;
	}
	while (i < a.length) {
		lines.push({ op: 'removed', text: a[i++] });
	}
	while (j < b.length) {
		lines.push({ op: 'added', text: b[j++] });
	}
	return lines;
}

/**
 * The indices of a longest common subsequence, or `undefined` when the table
 * would be larger than the cap.
 *
 * A `Uint32Array` rather than nested arrays: at the cap that is four megabytes
 * flat instead of a million boxed numbers.
 */
function longestCommon(
	a: readonly string[],
	b: readonly string[],
	cap: number
): { a: number; b: number }[] | undefined {
	const n = a.length;
	const m = b.length;
	if ((n + 1) * (m + 1) > cap) {
		return undefined;
	}

	const width = m + 1;
	const table = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}

	const steps: { a: number; b: number }[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			steps.push({ a: i, b: j });
			i += 1;
			j += 1;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			i += 1;
		} else {
			j += 1;
		}
	}
	return steps;
}

/**
 * Gives each removed line facing an added line its word-level breakdown, when
 * the two are alike enough to be one sentence rewritten.
 *
 * Paired by position within the run: a block of three removed lines followed by
 * three added ones is three rewrites, and pairing them any other way would be
 * guessing.
 */
function pairRewrites(lines: DiffLine[]): DiffLine[] {
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].op !== 'removed') {
			continue;
		}
		let removedEnd = index;
		while (removedEnd < lines.length && lines[removedEnd].op === 'removed') {
			removedEnd += 1;
		}
		let addedEnd = removedEnd;
		while (addedEnd < lines.length && lines[addedEnd].op === 'added') {
			addedEnd += 1;
		}

		const pairs = Math.min(removedEnd - index, addedEnd - removedEnd);
		for (let offset = 0; offset < pairs; offset += 1) {
			const before = lines[index + offset];
			const after = lines[removedEnd + offset];
			const words = diffWords(before.text, after.text);
			if (words) {
				before.parts = words.before;
				after.parts = words.after;
			}
		}

		index = addedEnd - 1;
	}
	return lines;
}

/**
 * The word-level diff of two lines, or `undefined` when they are too unalike to
 * be the same line rewritten.
 *
 * Tokens keep the whitespace around them, so the parts rejoin into the original
 * line exactly — a test holds that, since a diff that loses a character is
 * worse than no diff at all.
 */
export function diffWords(
	before: string,
	after: string
): { before: DiffPart[]; after: DiffPart[] } | undefined {
	if (before.length === 0 || after.length === 0) {
		return undefined;
	}

	const a = splitWords(before);
	const b = splitWords(after);
	const common = longestCommon(a, b, MAX_WORD_CELLS);
	if (!common) {
		return undefined;
	}

	let shared = 0;
	for (const step of common) {
		shared += a[step.a].length;
	}
	if ((2 * shared) / (before.length + after.length) < SIMILARITY_FLOOR) {
		return undefined;
	}

	return {
		before: sideParts(a, common.map((step) => step.a)),
		after: sideParts(b, common.map((step) => step.b))
	};
}

/** One side's parts: every token, marked changed unless the diff kept it. */
function sideParts(tokens: readonly string[], kept: readonly number[]): DiffPart[] {
	const same = new Set(kept);
	const parts: DiffPart[] = [];
	tokens.forEach((text, index) => {
		const changed = !same.has(index);
		const last = parts[parts.length - 1];
		if (last && last.changed === changed) {
			last.text += text;
			return;
		}
		parts.push({ text, changed });
	});
	return parts;
}

/** Words and the whitespace between them, so the tokens rejoin exactly. */
function splitWords(line: string): string[] {
	return line.match(/\s+|\S+/g) ?? [];
}
