import * as assert from 'assert';
import {
	appendHistory,
	formatHistoryEntry,
	parseHistory,
	serializeHistory
} from '../data/historyFile';
import { HistoryEntry } from '../data/types';

const ENTRIES = [
	{ timestamp: '2026-07-05T10:00:00.000Z', author: 'Hanh Thong', action: 'created' },
	{
		timestamp: '2026-07-09T16:20:00.000Z',
		author: 'Minh Anh',
		action: 'changed',
		field: 'status',
		from: 'todo',
		to: 'in-progress'
	},
	{
		timestamp: '2026-07-10T08:00:00.000Z',
		author: 'Minh Anh',
		action: 'changed',
		field: 'description'
	},
	{
		timestamp: '2026-07-11T08:40:00.000Z',
		author: 'Minh Anh',
		action: 'commented',
		comment: 'Agreed to drop SSO.\n\nTracked separately.'
	}
];

/** What comes back has ids; what goes in does not. */
function withoutIds(entries: HistoryEntry[]): unknown[] {
	return entries.map(({ id, ...rest }) => rest);
}

suite('History file', () => {
	// An adopted edit may not know what the text was before: the entry then
	// carries `to` alone, and has to read back as exactly that — not as an entry
	// with an empty `from`.
	test('an entry with only a `to` side round-trips', () => {
		const written = serializeHistory([
			{
				timestamp: '2026-09-06T10:00:00.000Z',
				author: 'ada',
				action: 'changed',
				field: 'description',
				to: 'What it became.\n\nOver two lines.',
				comment: 'Edited by an agent while writing ST-1.1.'
			}
		]);
		assert.ok(!/- from:|```from/.test(written), written);
		const [entry] = parseHistory(written, 'EP-1');
		assert.strictEqual(entry.from, undefined);
		assert.strictEqual(entry.to, 'What it became.\n\nOver two lines.');
		assert.strictEqual(entry.field, 'description');
		assert.strictEqual(entry.comment, 'Edited by an agent while writing ST-1.1.');
	});

	test('round-trips every entry shape', () => {
		const parsed = parseHistory(serializeHistory(ENTRIES), 'ST-1.1');

		assert.deepStrictEqual(withoutIds(parsed), ENTRIES);
	});

	test('derives ids from the position in the file', () => {
		const parsed = parseHistory(serializeHistory(ENTRIES), 'ST-1.1');

		assert.deepStrictEqual(
			parsed.map((entry) => entry.id),
			['ST-1.1#0', 'ST-1.1#1', 'ST-1.1#2', 'ST-1.1#3']
		);
	});

	test('a field with no from/to writes no change bullets', () => {
		const text = serializeHistory([ENTRIES[2]]);

		assert.ok(text.includes('- field: description'), text);
		assert.ok(!text.includes('- from:'), text);
		assert.ok(!text.includes('- to:'), text);
	});

	test('a comment survives markdown that looks like structure', () => {
		const comment = '## not a header\n> already quoted\n- not a bullet field';
		const parsed = parseHistory(
			serializeHistory([
				{ timestamp: '2026-07-11T08:40:00.000Z', author: 'Thu Ha', action: 'commented', comment }
			]),
			'TC-1'
		);

		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0].comment, comment);
	});

	test('reads the separators a person is likely to type', () => {
		const text = [
			'# History',
			'',
			'## 2026-07-05T10:00:00.000Z - Hanh Thong - created',
			'',
			'## 2026-07-06T10:00:00.000Z -- Thu Ha -- changed',
			'- field: status',
			'',
			'## 2026-07-07T10:00:00.000Z \u2013 Minh Anh \u2013 commented'
		].join('\n');

		assert.deepStrictEqual(withoutIds(parseHistory(text, 'EP-1')), [
			{ timestamp: '2026-07-05T10:00:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ timestamp: '2026-07-06T10:00:00.000Z', author: 'Thu Ha', action: 'changed', field: 'status' },
			{ timestamp: '2026-07-07T10:00:00.000Z', author: 'Minh Anh', action: 'commented' }
		]);
	});

	test('an action containing a dash stays whole', () => {
		const parsed = parseHistory(
			serializeHistory([
				{ timestamp: '2026-07-05T10:00:00.000Z', author: 'Thu Ha', action: 'changed - twice' }
			]),
			'EP-1'
		);

		assert.strictEqual(parsed[0].action, 'changed twice');
	});

	test('missing, empty and junk files read as no history', () => {
		assert.deepStrictEqual(parseHistory(undefined, 'EP-1'), []);
		assert.deepStrictEqual(parseHistory('', 'EP-1'), []);
		assert.deepStrictEqual(parseHistory('# History\n\njust prose\n', 'EP-1'), []);
		// A header missing its separators is skipped, not half-read.
		assert.deepStrictEqual(parseHistory('## 2026-07-05 created\n', 'EP-1'), []);
	});

	test('appends to a file that already has entries', () => {
		const first = serializeHistory([ENTRIES[0]]);
		const both = appendHistory(first, ENTRIES[1]);

		assert.deepStrictEqual(withoutIds(parseHistory(both, 'EP-1')), [ENTRIES[0], ENTRIES[1]]);
		// Append-only: the bytes already written are untouched.
		assert.ok(both.startsWith(first.trimEnd()), both);
	});

	test('appending to a missing file produces a valid one', () => {
		const created = appendHistory(undefined, ENTRIES[0]);

		assert.ok(created.startsWith('# History'), created);
		assert.deepStrictEqual(withoutIds(parseHistory(created, 'EP-1')), [ENTRIES[0]]);
	});

	test('tolerates CRLF and a missing trailing newline', () => {
		const text = serializeHistory(ENTRIES).replace(/\n/g, '\r\n').trimEnd();

		assert.deepStrictEqual(withoutIds(parseHistory(text, 'EP-1')), ENTRIES);
	});

	test('a short value still uses the one-line bullet it always has', () => {
		const entry = {
			timestamp: '2026-01-01T00:00:00.000Z',
			author: 'Ada',
			action: 'changed',
			field: 'status',
			from: 'todo',
			to: 'in-progress'
		};

		// The file format for a status change is unchanged, so existing history
		// files and hand-written entries keep reading the same.
		assert.ok(formatHistoryEntry(entry).includes('- from: todo'));
		assert.deepStrictEqual(withoutIds(parseHistory(serializeHistory([entry]), 'EP-1')), [entry]);
	});

	test('a multi-line value round-trips through a fenced block', () => {
		const entry = {
			timestamp: '2026-01-01T00:00:00.000Z',
			author: 'Ada',
			action: 'changed',
			field: 'description',
			from: 'Old first line\n\nOld second paragraph.',
			to: 'New text\nover two lines.'
		};

		const text = serializeHistory([entry]);
		assert.ok(text.includes('```from'), text);
		assert.deepStrictEqual(withoutIds(parseHistory(text, 'EP-1')), [entry]);
	});

	test('a description carrying markdown of its own does not break the file', () => {
		const entry = {
			timestamp: '2026-01-01T00:00:00.000Z',
			author: 'Ada',
			action: 'changed',
			field: 'description',
			// A heading would end the entry if the block were not indented, and a
			// fence inside the value would close the block early if the surrounding
			// fence were not made longer than it.
			from: '## A heading\n\n```js\nconst x = 1;\n```\n\n- a bullet',
			to: '## Another heading\n\n> quoted'
		};

		const parsed = parseHistory(serializeHistory([entry]), 'EP-1');
		assert.strictEqual(parsed.length, 1, 'the entry split itself in two');
		assert.deepStrictEqual(withoutIds(parsed), [entry]);
	});

	test('a long single-line value gets a block, and a comment still follows it', () => {
		const entry = {
			timestamp: '2026-01-01T00:00:00.000Z',
			author: 'Ada',
			action: 'changed',
			field: 'description',
			from: '',
			to: 'x'.repeat(300),
			comment: 'Filled in the body.'
		};

		assert.deepStrictEqual(withoutIds(parseHistory(serializeHistory([entry]), 'EP-1')), [entry]);
	});

	test('one long value beside one short one keeps both forms in the same entry', () => {
		const entry = {
			timestamp: '2026-01-01T00:00:00.000Z',
			author: 'Ada',
			action: 'changed',
			field: 'description',
			from: 'Short before.',
			to: 'A much longer after,\nspanning lines.'
		};

		const text = serializeHistory([entry]);
		assert.ok(text.includes('- from: Short before.'), text);
		assert.ok(text.includes('```to'), text);
		assert.deepStrictEqual(withoutIds(parseHistory(text, 'EP-1')), [entry]);
	});
});
