import * as assert from 'assert';
import { parseYamlMap, serializeYamlMap } from '../data/yaml';

const SAMPLE = [
	'# BFAST ticket metadata',
	'',
	'id: AC-1.1.2',
	"title: 'Five failures lock the account'",
	'status: in-progress',
	'sprint: 12',
	''
].join('\n');

suite('YAML map', () => {
	test('reads a flat map', () => {
		assert.deepStrictEqual(parseYamlMap(SAMPLE), {
			id: 'AC-1.1.2',
			title: 'Five failures lock the account',
			status: 'in-progress',
			sprint: '12'
		});
	});

	test('splits on the first colon only', () => {
		assert.strictEqual(parseYamlMap('title: Fix: the login bug').title, 'Fix: the login bug');
	});

	test('drops a trailing comment but keeps a hash inside a word', () => {
		assert.strictEqual(parseYamlMap('title: Ship it # for now').title, 'Ship it');
		assert.strictEqual(parseYamlMap('id: TC-1#0').id, 'TC-1#0');
		assert.strictEqual(parseYamlMap("title: 'Ship it # for now'").title, 'Ship it # for now');
	});

	test('unquotes both quote styles', () => {
		assert.strictEqual(parseYamlMap("a: 'it''s here'").a, "it's here");
		const escaped = 'a: "line' + String.fromCharCode(92) + 'nbreak"';
		assert.strictEqual(parseYamlMap(escaped).a, ['line', 'break'].join(String.fromCharCode(10)));
		// An unterminated quote is content, not a parse failure.
		assert.strictEqual(parseYamlMap("a: 'unterminated").a, "'unterminated");
	});

	test('skips blank lines, comments, markers and lines with no colon', () => {
		const map = parseYamlMap(['---', '# note', '', 'just some prose', 'a: 1', '...'].join('\n'));
		assert.deepStrictEqual(map, { a: '1' });
	});

	test('handles CRLF and lets the last duplicate win', () => {
		assert.deepStrictEqual(parseYamlMap('a: 1\r\nb: 2\r\na: 3'), { a: '3', b: '2' });
	});

	test('round-trips, keeping unknown keys', () => {
		const map = parseYamlMap(SAMPLE);
		const again = parseYamlMap(serializeYamlMap(map, { order: ['id', 'title'], header: '# hi' }));

		assert.deepStrictEqual(again, map);
		assert.strictEqual(again.sprint, '12');
	});

	test('writes known keys first, under the header', () => {
		const text = serializeYamlMap(
			{ status: 'todo', id: 'EP-1' },
			{ order: ['id', 'status'], header: '# hi' }
		);

		assert.strictEqual(text, '# hi\n\nid: EP-1\nstatus: todo\n');
	});

	test('quotes only what would otherwise change meaning', () => {
		const quoted = (value: string): string =>
			serializeYamlMap({ a: value }).slice('a: '.length).trimEnd();

		assert.strictEqual(quoted('plain title'), 'plain title');
		assert.strictEqual(quoted('2026-07-05T10:00:00.000Z'), '2026-07-05T10:00:00.000Z');
		assert.strictEqual(quoted(''), "''");
		assert.strictEqual(quoted(' padded '), "' padded '");
		assert.strictEqual(quoted('true'), "'true'");
		assert.strictEqual(quoted('# not a comment'), "'# not a comment'");
		assert.strictEqual(quoted('- item'), "'- item'");
		assert.strictEqual(quoted("it's"), "it's");
		assert.strictEqual(quoted("'quoted'"), "'''quoted'''");
		assert.strictEqual(
			quoted(['two', 'lines'].join(String.fromCharCode(10))),
			'"two' + String.fromCharCode(92) + 'nlines"'
		);
	});

	test('values needing quotes survive a round trip', () => {
		const awkward = ['', ' padded ', 'true', '# hash', '- item', "it's", 'a: b', 'two\nlines'];

		for (const value of awkward) {
			assert.strictEqual(parseYamlMap(serializeYamlMap({ a: value })).a, value, value);
		}
	});

	test('never throws, whatever it is handed', () => {
		const backslash = String.fromCharCode(92);
		const mutations = [SAMPLE, '', ':', ': :', 'a:', '"', "'", `a: "${backslash}`];
		for (let cut = 0; cut < SAMPLE.length; cut += 7) {
			mutations.push(SAMPLE.slice(0, cut));
		}

		for (const text of mutations) {
			assert.doesNotThrow(() => parseYamlMap(text), JSON.stringify(text));
		}
	});
});
