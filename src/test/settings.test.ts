import * as assert from 'assert';
import {
	DEFAULT_TRACKER_FOLDER,
	normalizeSettings,
	normalizeTrackerFolder,
	parseSettings,
	validateTrackerFolder,
	validateUserName
} from '../settings/bfastSettings';

suite('BFAST settings', () => {
	test('falls back to defaults for a missing or malformed file', () => {
		const expected = { trackerFolder: DEFAULT_TRACKER_FOLDER, userName: '' };

		assert.deepStrictEqual(parseSettings(undefined), expected);
		assert.deepStrictEqual(parseSettings(null), expected);
		assert.deepStrictEqual(parseSettings('nonsense'), expected);
		assert.deepStrictEqual(parseSettings({}), expected);
		assert.deepStrictEqual(parseSettings({ trackerFolder: 42, userName: [] }), expected);
		assert.deepStrictEqual(parseSettings({ trackerFolder: '   ' }), expected);
	});

	test('round-trips what was written', () => {
		const settings = { trackerFolder: 'docs/tracker', userName: 'Hanh Thong' };
		assert.deepStrictEqual(parseSettings(JSON.parse(JSON.stringify(settings))), settings);
	});

	test('normalizes a folder to a relative forward-slash path', () => {
		assert.strictEqual(normalizeTrackerFolder('  .tracker  '), '.tracker');
		assert.strictEqual(normalizeTrackerFolder('.\\tracker\\'), 'tracker');
		assert.strictEqual(normalizeTrackerFolder('./docs/tracker/'), 'docs/tracker');
		assert.deepStrictEqual(normalizeSettings({ trackerFolder: './a/', userName: ' Thu Ha ' }), {
			trackerFolder: 'a',
			userName: 'Thu Ha'
		});
	});

	test('accepts a relative folder inside the workspace', () => {
		assert.strictEqual(validateTrackerFolder('.tracker'), undefined);
		assert.strictEqual(validateTrackerFolder('./docs/tracker'), undefined);
	});

	test('rejects empty, absolute and escaping folders', () => {
		for (const folder of ['', '   ', '/var/tracker', 'C:\\tracker', '../tracker', 'a/../../b', 'tra?cker']) {
			assert.ok(validateTrackerFolder(folder), `${JSON.stringify(folder)} should be rejected`);
		}
	});

	test('requires a user name', () => {
		assert.ok(validateUserName(''));
		assert.ok(validateUserName('   '));
		assert.strictEqual(validateUserName('Minh Anh'), undefined);
	});
});
