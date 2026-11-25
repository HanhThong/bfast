// The `{{token}}` grammar `tests.command` and `scan.command` share.
//
// `testsSettings.test.ts` is deliberately **not** edited alongside this file:
// the extraction happens behind unchanged exports, so that suite passing
// untouched is the proof the move was transparent.

import * as assert from 'assert';
import { substituteCommand, unknownPlaceholders } from '../settings/commandTemplate';

const KNOWN = ['id', 'key', 'folder'];

suite('Command template grammar', () => {
	test('reports only the tokens the caller does not know', () => {
		assert.deepStrictEqual(unknownPlaceholders('run {{id}} in {{folder}}', KNOWN), []);
		assert.deepStrictEqual(unknownPlaceholders('run {{title}}', KNOWN), ['title']);
		assert.deepStrictEqual(unknownPlaceholders('{{a}} {{b}} {{a}}', KNOWN), ['a', 'b']);
		assert.deepStrictEqual(unknownPlaceholders('no tokens at all', KNOWN), []);
	});

	test('the same token set answers differently for a different caller', () => {
		// The whole point of taking `known` as a parameter: `{{projectKey}}` is a
		// stray token for a test command and a real one for a scan command.
		assert.deepStrictEqual(unknownPlaceholders('scan {{projectKey}}', KNOWN), ['projectKey']);
		assert.deepStrictEqual(
			unknownPlaceholders('scan {{projectKey}}', [...KNOWN, 'projectKey']),
			[]
		);
	});

	test('a shared /g regex does not carry lastIndex between calls', () => {
		// A module-level `/g` regex would make the second call start halfway
		// through and miss the token. The pattern is rebuilt per call for this.
		const line = '{{one}} {{two}}';
		assert.deepStrictEqual(unknownPlaceholders(line, []), ['one', 'two']);
		assert.deepStrictEqual(unknownPlaceholders(line, []), ['one', 'two']);
	});

	test('substitutes what it is given and leaves the rest alone', () => {
		assert.strictEqual(
			substituteCommand('npm test -- --grep {{id}}', { id: 'TC-1.2.1.1' }),
			'npm test -- --grep TC-1.2.1.1'
		);
		assert.strictEqual(
			substituteCommand('run {{id}} {{title}}', { id: 'TC-1' }),
			'run TC-1 {{title}}'
		);
		assert.strictEqual(substituteCommand('plain command', { id: 'TC-1' }), 'plain command');
	});

	test('a prototype member is an unknown token, not a value', () => {
		// `'toString' in vars` is true via the prototype chain; coercing
		// `Object.prototype.toString` into a shell line is how a "left untouched"
		// token would silently become garbage the shell runs.
		for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
			assert.strictEqual(
				substituteCommand(`run {{${name}}}`, { id: 'TC-1' }),
				`run {{${name}}}`,
				name
			);
			assert.deepStrictEqual(unknownPlaceholders(`run {{${name}}}`, KNOWN), [name]);
		}
	});

	test('an empty substitution is a value, not an unknown token', () => {
		// Scan Workspace has no ticket, so `{{id}}` renders empty rather than
		// staying in the line as literal braces.
		assert.strictEqual(substituteCommand('scan {{id}}', { id: '' }), 'scan ');
	});
});
