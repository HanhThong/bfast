import * as assert from 'assert';
import {
	applyTextEdit,
	blockStateAt,
	imageMarkdown,
	insertText,
	setHeading,
	toggleBullet,
	toggleWrap,
	type WrapStyle
} from '../shared/markdownFormat';

/** What the textarea would hold after the toolbar button ran. */
function wrap(text: string, start: number, end: number, style: WrapStyle): string {
	return applyTextEdit(text, toggleWrap(text, start, end, style));
}

/** The same, plus where the selection ends up, written as `«selected»`. */
function wrapWithSelection(text: string, start: number, end: number, style: WrapStyle): string {
	const edit = toggleWrap(text, start, end, style);
	const result = applyTextEdit(text, edit);
	return (
		result.slice(0, edit.selectionStart) +
		'«' +
		result.slice(edit.selectionStart, edit.selectionEnd) +
		'»' +
		result.slice(edit.selectionEnd)
	);
}

/** The offsets of `word` in a string that contains it exactly once. */
function range(text: string, word: string): [number, number] {
	const start = text.indexOf(word);
	return [start, start + word.length];
}

suite('Markdown formatting', () => {
	test('wraps the selection in the style markers', () => {
		assert.strictEqual(wrap('a word b', ...range('a word b', 'word'), 'bold'), 'a **word** b');
		assert.strictEqual(wrap('a word b', ...range('a word b', 'word'), 'italic'), 'a *word* b');
		assert.strictEqual(
			wrap('a word b', ...range('a word b', 'word'), 'underline'),
			'a <u>word</u> b'
		);
	});

	test('leaves the wrapped text selected, so the style toggles straight back off', () => {
		assert.strictEqual(
			wrapWithSelection('a word b', ...range('a word b', 'word'), 'bold'),
			'a **«word»** b'
		);
	});

	test('toggling twice returns the original string', () => {
		for (const style of ['bold', 'italic', 'underline'] as const) {
			const text = 'a word b';
			const once = toggleWrap(text, ...range(text, 'word'), style);
			const wrapped = applyTextEdit(text, once);
			const twice = toggleWrap(wrapped, once.selectionStart, once.selectionEnd, style);

			assert.strictEqual(applyTextEdit(wrapped, twice), text, style);
		}
	});

	test('markers just outside the selection unwrap rather than nest', () => {
		// The user selected the word, not the markers — the common case, because
		// double-clicking a bold word selects exactly this.
		assert.strictEqual(wrap('a **word** b', ...range('a **word** b', 'word'), 'bold'), 'a word b');
		assert.strictEqual(wrap('a *word* b', ...range('a *word* b', 'word'), 'italic'), 'a word b');
		assert.strictEqual(
			wrap('a <u>word</u> b', ...range('a <u>word</u> b', 'word'), 'underline'),
			'a word b'
		);
	});

	test('markers the selection swallowed unwrap too', () => {
		const text = 'a **word** b';
		assert.strictEqual(wrap(text, ...range(text, '**word**'), 'bold'), 'a word b');

		const underlined = 'a <u>word</u> b';
		assert.strictEqual(wrap(underlined, ...range(underlined, '<u>word</u>'), 'underline'), 'a word b');
	});

	test('emphasis nests, and the styles stay told apart', () => {
		// Counting runs of `*` is the only way: `***word***` is both, `**word**`
		// is only bold, and each button must peel off its own layer.
		assert.strictEqual(
			wrap('a ***word*** b', ...range('a ***word*** b', 'word'), 'italic'),
			'a **word** b'
		);
		assert.strictEqual(
			wrap('a ***word*** b', ...range('a ***word*** b', 'word'), 'bold'),
			'a *word* b'
		);
		// Italic over an already bold word adds a layer instead of breaking the pair.
		assert.strictEqual(
			wrap('a **word** b', ...range('a **word** b', 'word'), 'italic'),
			'a ***word*** b'
		);
		// And bold over an italic word likewise.
		assert.strictEqual(
			wrap('a *word* b', ...range('a *word* b', 'word'), 'bold'),
			'a ***word*** b'
		);
	});

	test('an empty selection writes both markers and puts the caret between them', () => {
		assert.strictEqual(wrapWithSelection('ab', 1, 1, 'bold'), 'a**«»**b');
		assert.strictEqual(wrapWithSelection('ab', 1, 1, 'underline'), 'a<u>«»</u>b');
	});

	test('whitespace at the edges is pushed outside the markers', () => {
		// `**word **` is not bold in any dialect, so the space has to stay out.
		const text = 'a word b';
		assert.strictEqual(wrap(text, 1, 7, 'bold'), 'a **word** b');

		// An all-whitespace selection has nothing to emphasise; it acts as a caret.
		assert.strictEqual(wrapWithSelection('a   b', 1, 4, 'bold'), 'a**«»**   b');
	});

	test('a reversed or out-of-range selection is handled, not thrown on', () => {
		const text = 'a word b';
		assert.strictEqual(wrap(text, 6, 2, 'bold'), 'a **word** b');
		assert.strictEqual(applyTextEdit(text, toggleWrap(text, -5, 999, 'bold')), '**a word b**');
		assert.strictEqual(applyTextEdit('', toggleWrap('', 0, 0, 'italic')), '**');
	});

	test('insertText replaces the selection and leaves the caret after it', () => {
		const text = 'a word b';
		const edit = insertText(text, ...range(text, 'word'), 'X');
		assert.strictEqual(applyTextEdit(text, edit), 'a X b');
		assert.strictEqual(edit.selectionStart, edit.selectionEnd);
		assert.strictEqual(edit.selectionStart, 3);
	});

	test('a heading applies to the whole line the caret is on', () => {
		const text = 'Intro\nA title\nBody';
		const caret = text.indexOf('title');

		assert.strictEqual(
			applyTextEdit(text, setHeading(text, caret, caret, 2)),
			'Intro\n## A title\nBody'
		);
	});

	test('changing level replaces the markers rather than stacking them', () => {
		const text = '## A title';

		assert.strictEqual(applyTextEdit(text, setHeading(text, 4, 4, 4)), '#### A title');
		assert.strictEqual(applyTextEdit(text, setHeading(text, 4, 4, 0)), 'A title');
	});

	test('a heading is not a list item, so it drops the bullet', () => {
		const text = '- a point';

		assert.strictEqual(applyTextEdit(text, setHeading(text, 4, 4, 1)), '# a point');
	});

	test('picking a level leaves a caret, not a selection', () => {
		// Otherwise carrying on typing would overwrite the line just styled.
		const text = 'A title';
		const edit = setHeading(text, 2, 2, 3);

		assert.strictEqual(edit.selectionStart, edit.selectionEnd);
		// The caret kept its place in the text, pushed along by the `### `.
		assert.strictEqual(applyTextEdit(text, edit).slice(0, edit.selectionStart), '### A ');
	});

	test('a heading spanning a selection covers every line it touches', () => {
		const text = 'one\ntwo\nthree';
		const edit = setHeading(text, 1, text.indexOf('three') + 1, 1);

		assert.strictEqual(applyTextEdit(text, edit), '# one\n# two\n# three');
	});

	test('bullets toggle across the selected lines', () => {
		const text = 'one\ntwo';
		const bulleted = applyTextEdit(text, toggleBullet(text, 0, text.length));
		assert.strictEqual(bulleted, '- one\n- two');

		// All bulleted already, so the same click takes them off again.
		assert.strictEqual(applyTextEdit(bulleted, toggleBullet(bulleted, 0, bulleted.length)), text);
	});

	test('bulleting leaves blank lines alone', () => {
		const text = 'one\n\ntwo';

		assert.strictEqual(applyTextEdit(text, toggleBullet(text, 0, text.length)), '- one\n\n- two');
	});

	test('a part-bulleted selection bullets the rest rather than clearing it', () => {
		const text = '- one\ntwo';

		assert.strictEqual(applyTextEdit(text, toggleBullet(text, 0, text.length)), '- one\n- two');
	});

	test('a selection ending at column zero does not pull in the line below', () => {
		const text = 'one\ntwo\nthree';
		// Selects `one\n` exactly, the way dragging down one line does.
		const edit = toggleBullet(text, 0, 4);

		assert.strictEqual(applyTextEdit(text, edit), '- one\ntwo\nthree');
	});

	test('the block state reports what the toolbar should show', () => {
		assert.deepStrictEqual(blockStateAt('### A title', 5, 5), { heading: 3, bulleted: false });
		assert.deepStrictEqual(blockStateAt('plain', 0, 0), { heading: 0, bulleted: false });
		assert.deepStrictEqual(blockStateAt('- one\n- two', 0, 11), { heading: 0, bulleted: true });
		// Not every line, so the button is not lit.
		assert.deepStrictEqual(blockStateAt('- one\ntwo', 0, 9), { heading: 0, bulleted: false });
		// Blank space is not a list however you read it.
		assert.deepStrictEqual(blockStateAt('', 0, 0), { heading: 0, bulleted: false });
		// A `#` needs its space to be a heading.
		assert.deepStrictEqual(blockStateAt('#nope', 0, 0), { heading: 0, bulleted: false });
	});

	test('a text opening with a newline is not misread', () => {
		// `lastIndexOf` treats a negative index as 0, which this guards against.
		const text = '\nsecond';

		assert.strictEqual(applyTextEdit(text, setHeading(text, 0, 0, 1)), '# \nsecond');
	});

	test('image markdown escapes what would break the link syntax', () => {
		assert.strictEqual(imageMarkdown('diagram', 'assets/diagram.png'), '![diagram](assets/diagram.png)');
		// Brackets in the alt text would close it early.
		assert.strictEqual(imageMarkdown('a [b] c', 'assets/x.png'), '![a b c](assets/x.png)');
		// A path that needs it takes the angle-bracket form.
		assert.strictEqual(imageMarkdown('x', 'assets/a b.png'), '![x](<assets/a b.png>)');
		assert.strictEqual(imageMarkdown('x', 'assets/a(1).png'), '![x](<assets/a(1).png>)');
	});
});
