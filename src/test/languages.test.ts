import * as assert from 'assert';
import { LANGUAGE_CODES, LANGUAGES, languageName } from '../settings/languages';

suite('BFAST languages', () => {
	// The list is data, and data rots quietly: a duplicated code would make one
	// entry unreachable in the dropdown, and a bad one would be dropped on read
	// with nothing to show for it.
	test('every entry is a distinct, well-formed ISO 639-1 code', () => {
		assert.ok(LANGUAGES.length > 150, `expected the full list, got ${LANGUAGES.length}`);
		for (const language of LANGUAGES) {
			assert.match(language.code, /^[a-z]{2}$/, `${language.name} has a bad code`);
			assert.ok(language.name.trim().length > 0, `${language.code} has no English name`);
			assert.ok(language.native.trim().length > 0, `${language.code} has no native name`);
		}
		assert.strictEqual(LANGUAGE_CODES.size, LANGUAGES.length, 'a code is duplicated');
		assert.strictEqual(
			new Set(LANGUAGES.map((language) => language.name)).size,
			LANGUAGES.length,
			'an English name is duplicated'
		);
	});

	// The dropdown renders the array in order, so the order is the UI.
	test('is sorted by English name', () => {
		const names = LANGUAGES.map((language) => language.name);
		assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
	});

	test('languageName looks up a code and refuses anything else', () => {
		assert.strictEqual(languageName('vi'), 'Vietnamese');
		assert.strictEqual(languageName(' EN '), 'English');
		assert.strictEqual(languageName('ja'), 'Japanese');
		assert.strictEqual(languageName('zh'), 'Chinese');
		for (const code of [undefined, '', 'xx', 'vie', 'Vietnamese']) {
			assert.strictEqual(languageName(code), undefined, `${String(code)} should not resolve`);
		}
	});
});
