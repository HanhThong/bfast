import * as assert from 'assert';
import {
	CONTEXT_LINES,
	collapseUnchanged,
	diffLines,
	diffStats,
	diffWords,
	splitLines,
	type DiffLine
} from '../shared/textDiff';

/** `op` and `text` only, which is what a rendering assertion is about. */
function shape(lines: DiffLine[]): string[] {
	return lines.map((line) => `${line.op[0]} ${line.text}`);
}

suite('text diff', () => {
	test('an empty text has no lines at all, so a first draft is all additions', () => {
		assert.deepStrictEqual(splitLines(''), []);
		assert.deepStrictEqual(splitLines('one\n'), ['one']);
		assert.deepStrictEqual(splitLines('one\n\n'), ['one', '']);
		assert.deepStrictEqual(shape(diffLines('', 'one')), ['a one']);
	});

	test('identical texts diff to every line unchanged', () => {
		const lines = diffLines('one\ntwo', 'one\ntwo');
		assert.deepStrictEqual(shape(lines), ['s one', 's two']);
		assert.deepStrictEqual(diffStats(lines), { added: 0, removed: 0 });
	});

	test('an insertion keeps the surrounding lines unchanged', () => {
		const lines = diffLines('one\nthree', 'one\ntwo\nthree');
		assert.deepStrictEqual(shape(lines), ['s one', 'a two', 's three']);
		assert.deepStrictEqual(diffStats(lines), { added: 1, removed: 0 });
	});

	test('a removal is reported as one, not as a rewrite of the line after it', () => {
		const lines = diffLines('one\ntwo\nthree', 'one\nthree');
		assert.deepStrictEqual(shape(lines), ['s one', 'r two', 's three']);
		assert.deepStrictEqual(diffStats(lines), { added: 0, removed: 1 });
	});

	// The reason the word diff exists: a criterion whose wording moved should
	// read as one line rewritten, with the words that moved marked.
	test('a rewritten line carries its word-level parts on both sides', () => {
		const lines = diffLines(
			'Given the user is logged out\nWhen they submit',
			'Given the user is signed out\nWhen they submit'
		);
		assert.deepStrictEqual(shape(lines), [
			'r Given the user is logged out',
			'a Given the user is signed out',
			's When they submit'
		]);

		const [before, after] = lines;
		assert.ok(before.parts && after.parts, 'both sides are broken into parts');
		assert.deepStrictEqual(
			before.parts!.filter((part) => part.changed).map((part) => part.text),
			['logged']
		);
		assert.deepStrictEqual(
			after.parts!.filter((part) => part.changed).map((part) => part.text),
			['signed']
		);
	});

	// A diff that loses a character is worse than no diff: the parts are what
	// the pane renders, so they have to rejoin into the line exactly.
	test('the parts of a line rejoin into that line, whitespace and all', () => {
		const words = diffWords('  Given   the user  is logged out', '  Given the user  is signed  out');
		assert.ok(words);
		assert.strictEqual(
			words!.before.map((part) => part.text).join(''),
			'  Given   the user  is logged out'
		);
		assert.strictEqual(
			words!.after.map((part) => part.text).join(''),
			'  Given the user  is signed  out'
		);
	});

	// Two unrelated lines with every word highlighted are noise, not a diff.
	test('two unrelated lines are not paired as one rewrite', () => {
		assert.strictEqual(
			diffWords('Given the user is logged out', 'The report totals by month'),
			undefined
		);
		const lines = diffLines('Given the user is logged out', 'The report totals by month');
		assert.ok(lines.every((line) => line.parts === undefined));
	});

	test('a block of rewrites pairs by position within the block', () => {
		const lines = diffLines(
			'Given the user is logged out\nWhen the user submits the form',
			'Given the user is signed out\nWhen the user submits the login form'
		);
		assert.deepStrictEqual(shape(lines), [
			'r Given the user is logged out',
			'r When the user submits the form',
			'a Given the user is signed out',
			'a When the user submits the login form'
		]);
		// The first removed line pairs with the first added one, not with the
		// nearest: pairing them any other way would be guessing.
		assert.deepStrictEqual(
			lines[0].parts?.filter((part) => part.changed).map((part) => part.text),
			['logged']
		);
		assert.deepStrictEqual(
			lines[3].parts?.filter((part) => part.changed).map((part) => part.text),
			['login ']
		);
	});

	// The floor is what keeps the word diff meaningful, and on two short lines it
	// bites: `one alpha` → `one beta` shares 8 of 17 characters, so the pair is
	// shown as two whole lines rather than one word-level rewrite.
	test('a short line that shares too little is left whole', () => {
		assert.strictEqual(diffWords('one alpha', 'one beta'), undefined);
	});

	test('collapsing keeps context either side of a change and counts the rest', () => {
		const before = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
		const after = before.replace('line 15', 'line fifteen');
		const rows = collapseUnchanged(diffLines(before, after));

		const gaps = rows.filter((row) => row.op === 'gap');
		assert.strictEqual(gaps.length, 2, 'one gap above the change and one below');
		const shown = rows.filter((row) => row.op !== 'gap');
		// Three context lines either side, plus the removed and added line.
		assert.strictEqual(shown.length, CONTEXT_LINES * 2 + 2);
		assert.strictEqual(
			gaps.reduce((total, row) => total + (row.op === 'gap' ? row.hidden : 0), 0),
			29 - CONTEXT_LINES * 2
		);
	});

	// A gap row costs a row either way, and the reader loses the line.
	test('a single hidden line is shown rather than collapsed', () => {
		const lines = diffLines('a\nb\nc\nd\ne\nf\ng\nh\ni', 'A\nb\nc\nd\ne\nf\ng\nh\nI');
		const rows = collapseUnchanged(lines, 3);
		assert.ok(rows.every((row) => row.op !== 'gap'));
	});
});
