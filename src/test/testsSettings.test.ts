import * as assert from 'assert';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';
import {
	DEFAULT_TEST_CONCURRENCY,
	DEFAULT_TEST_IDLE_SECONDS,
	DEFAULT_TEST_RESULTS_FOLDER,
	MAX_TEST_CONCURRENCY,
	MAX_TEST_IDLE_SECONDS,
	MIN_TEST_CONCURRENCY,
	MIN_TEST_IDLE_SECONDS,
	normalizeTestsSettings,
	parseTestsSettings,
	substituteCommand,
	testsCommand,
	testsConcurrency,
	testsCwd,
	testsEvidence,
	testsEvidenceCommand,
	testsIdleTimeoutMs,
	testsResultsFolder,
	testsTraceFrames,
	unknownEvidenceCommandPlaceholders,
	unknownEvidencePlaceholders,
	unknownPlaceholders,
	validateTestsSettings
} from '../settings/testsSettings';

suite('BFAST tests settings', () => {
	test('returns undefined when nothing usable survives', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { command: '  ' }, { cwd: '/abs' }]) {
			assert.strictEqual(
				parseTestsSettings(raw),
				undefined,
				`${JSON.stringify(raw)} should be dropped`
			);
		}
	});

	test('trims the command and drops it when blank', () => {
		assert.deepStrictEqual(parseTestsSettings({ command: ' npm test -- --grep {{id}} ' }), {
			command: 'npm test -- --grep {{id}}'
		});
		assert.strictEqual(testsCommand({ command: '  ' }), undefined);
		assert.strictEqual(testsCommand(undefined), undefined);
		assert.strictEqual(testsCommand({ command: ' npm test ' }), 'npm test');
	});

	test('keeps only a cwd that stays inside the workspace', () => {
		assert.deepStrictEqual(parseTestsSettings({ cwd: '.\\apps\\web\\' }), { cwd: 'apps/web' });
		for (const cwd of ['/abs', 'C:/abs', '../out', '..\\shared\\web', 'a<b', '', '  ', 42]) {
			assert.strictEqual(
				parseTestsSettings({ cwd })?.cwd,
				undefined,
				`${JSON.stringify(cwd)} should be dropped`
			);
		}
		assert.strictEqual(testsCwd({ cwd: './apps/web/' }), 'apps/web');
		assert.strictEqual(testsCwd(undefined), undefined);
	});

	test('drops a concurrency that is not a whole number in range', () => {
		for (const concurrency of [-1, 0, 99, 1.5, '2', null, NaN]) {
			assert.strictEqual(
				parseTestsSettings({ concurrency })?.concurrency,
				undefined,
				`${String(concurrency)} should be dropped`
			);
		}
		assert.strictEqual(parseTestsSettings({ concurrency: 4 })?.concurrency, 4);
		// Sequential by default: parallel runs sharing one database are an opt-in.
		assert.strictEqual(testsConcurrency(undefined), DEFAULT_TEST_CONCURRENCY);
		assert.strictEqual(testsConcurrency({ concurrency: 3 }), 3);
	});

	test('drops an idle timeout that is not a whole number of seconds in range', () => {
		for (const idleTimeout of [-1, 0, 5, 99999, 60.5, '120', null, NaN]) {
			assert.strictEqual(
				parseTestsSettings({ idleTimeout })?.idleTimeout,
				undefined,
				`${String(idleTimeout)} should be dropped`
			);
		}
		assert.strictEqual(parseTestsSettings({ idleTimeout: 600 })?.idleTimeout, 600);
	});

	test('keeps a trace frame source that forces one layout; auto and anything else read as absent', () => {
		assert.deepStrictEqual(parseTestsSettings({ traceFrames: 'screencast' }), { traceFrames: 'screencast' });
		assert.deepStrictEqual(parseTestsSettings({ traceFrames: 'resources' }), { traceFrames: 'resources' });
		for (const raw of ['auto', 'Screencast', 'sha1', 9, null]) {
			assert.strictEqual(parseTestsSettings({ traceFrames: raw }), undefined, JSON.stringify(raw));
		}
		assert.strictEqual(testsTraceFrames(undefined), 'auto');
		assert.strictEqual(testsTraceFrames({ traceFrames: 'resources' }), 'resources');
		assert.strictEqual(validateTestsSettings({ traceFrames: 'auto' }), undefined);
		assert.match(
			validateTestsSettings({ traceFrames: 'sha1' as never }) ?? '',
			/Trace screenshots must be one of auto, resources, screencast/
		);
	});

	test('testsIdleTimeoutMs converts to the unit the runner holds', () => {
		assert.strictEqual(testsIdleTimeoutMs(undefined), DEFAULT_TEST_IDLE_SECONDS * 1000);
		assert.strictEqual(testsIdleTimeoutMs({ idleTimeout: 600 }), 600_000);
	});

	test('ignores keys it does not know', () => {
		assert.strictEqual(parseTestsSettings({ shell: 'zsh' }), undefined);
		assert.deepStrictEqual(parseTestsSettings({ shell: 'zsh', concurrency: 2 }), {
			concurrency: 2
		});
	});

	test('the results folder defaults, normalises, and never lands inside the tracker', () => {
		assert.strictEqual(testsResultsFolder(undefined), DEFAULT_TEST_RESULTS_FOLDER);
		assert.strictEqual(testsResultsFolder({}), DEFAULT_TEST_RESULTS_FOLDER);
		assert.strictEqual(testsResultsFolder({ resultsFolder: ' .\\test-results\\ ' }), 'test-results');
		assert.deepStrictEqual(parseTestsSettings({ resultsFolder: './out/runs/' }), { resultsFolder: 'out/runs' });
		for (const folder of ['/abs', 'C:/abs', '../out', '', 42]) {
			assert.strictEqual(parseTestsSettings({ resultsFolder: folder }), undefined, JSON.stringify(folder));
		}
		// Reading is forgiving: a hand-edited folder inside the tracker is not
		// used, so `TC-…` folders never land where the scanner looks for tickets.
		assert.strictEqual(testsResultsFolder({ resultsFolder: '.tracker/runs' }, '.tracker'), DEFAULT_TEST_RESULTS_FOLDER);
		assert.strictEqual(testsResultsFolder({ resultsFolder: '.tracker' }, '.tracker'), DEFAULT_TEST_RESULTS_FOLDER);
		assert.strictEqual(testsResultsFolder({ resultsFolder: '.tracker-results' }, '.tracker'), '.tracker-results');
		// Writing is strict: the same value is refused, with the tracker in hand.
		assert.ok(validateTestsSettings({ resultsFolder: '.tracker/runs' }, '.tracker'));
		assert.ok(validateTestsSettings({ resultsFolder: '.tracker' }, './.tracker/'));
		assert.strictEqual(validateTestsSettings({ resultsFolder: '.tracker-results' }, '.tracker'), undefined);
		assert.strictEqual(validateTestsSettings({ resultsFolder: '.tracker/runs' }), undefined);
		assert.ok(validateTestsSettings({ resultsFolder: '/abs' }));
		assert.ok(validateTestsSettings({ resultsFolder: '../out' }));
	});

	test('round-trips through JSON', () => {
		const tests = {
			command: 'npm test -- --grep {{id}}',
			cwd: 'apps/web',
			resultsFolder: 'test-results',
			evidence: 'e2e/evidence/**/{{id}}.*',
			evidenceCommand: 'npx playwright show-trace {{file}}',
			traceFrames: 'screencast',
			concurrency: 2,
			idleTimeout: 600
		};
		assert.deepStrictEqual(parseTestsSettings(JSON.parse(JSON.stringify(tests))), tests);
	});

	// The regression the whole design turns on: `normalizeSettings` returns a
	// fresh literal, so an unnamed field is dropped on every write.
	test('normalizeSettings keeps a configured tests block', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Hanh Thong',
			tests: { command: 'npm test -- --grep {{id}}' }
		});
		assert.deepStrictEqual(normalized.tests, { command: 'npm test -- --grep {{id}}' });
	});

	// The fresh-literal trap again, one level down: `parseTestsSettings` also
	// rebuilds from scratch, so a field it does not name is lost on every write.
	test('normalizeSettings keeps each field through a write', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Hanh Thong',
			tests: {
				command: 'npm test',
				cwd: 'apps/web',
				resultsFolder: 'test-results',
				evidence: 'e2e/**/{{id}}.*',
				evidenceCommand: 'open {{file}}',
				traceFrames: 'resources',
				concurrency: 2,
				idleTimeout: 600
			}
		});
		assert.deepStrictEqual(normalized.tests, {
			command: 'npm test',
			cwd: 'apps/web',
			resultsFolder: 'test-results',
			evidence: 'e2e/**/{{id}}.*',
			evidenceCommand: 'open {{file}}',
			traceFrames: 'resources',
			concurrency: 2,
			idleTimeout: 600
		});
	});

	// The other half: a workspace that never runs tests must keep `bfast.json`
	// byte-identical, which is what the two older suites assume.
	test('normalizeSettings omits an empty tests block entirely', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Thu Ha',
			tests: {}
		});
		assert.deepStrictEqual(normalized, { trackerFolder: '.tracker', userName: 'Thu Ha' });
		assert.ok(!('tests' in normalized));
		assert.ok(
			!('tests' in normalizeSettings({ trackerFolder: '.tracker', userName: 'Thu Ha' }))
		);
	});

	test('parseSettings reads the tests block off the whole file', () => {
		const parsed = parseSettings({
			trackerFolder: '.tracker',
			userName: 'Hanh Thong',
			tests: { command: 'npm test -- --grep {{id}}' }
		});
		assert.deepStrictEqual(parsed.tests, { command: 'npm test -- --grep {{id}}' });
		assert.strictEqual(parseSettings({ trackerFolder: '.tracker', userName: 'x' }).tests, undefined);
	});

	// Reading is forgiving, writing is strict: the same out-of-range value is
	// dropped on the way in and refused on the way out.
	test('validation rejects only what a write must not accept', () => {
		assert.strictEqual(validateTestsSettings(undefined), undefined);
		assert.strictEqual(validateTestsSettings({}), undefined);
		assert.strictEqual(validateTestsSettings({ cwd: 'apps/web' }), undefined);
		assert.strictEqual(validateTestsSettings({ cwd: '' }), undefined);
		assert.ok(validateTestsSettings({ cwd: '/abs' }));
		assert.ok(validateTestsSettings({ cwd: 'C:/abs' }));
		assert.ok(validateTestsSettings({ cwd: '..\\shared\\web' }));
		assert.strictEqual(validateTestsSettings({ concurrency: MAX_TEST_CONCURRENCY }), undefined);
		assert.ok(validateTestsSettings({ concurrency: MIN_TEST_CONCURRENCY - 1 }));
		assert.ok(validateTestsSettings({ concurrency: MAX_TEST_CONCURRENCY + 1 }));
		assert.strictEqual(validateTestsSettings({ idleTimeout: MAX_TEST_IDLE_SECONDS }), undefined);
		assert.ok(validateTestsSettings({ idleTimeout: MIN_TEST_IDLE_SECONDS - 1 }));
		assert.ok(validateTestsSettings({ idleTimeout: MAX_TEST_IDLE_SECONDS + 1 }));
	});

	// The invariant every block keeps: what the forgiving parse lets through, the
	// strict validator accepts — a pulled file never opens the form pre-invalid.
	test('a parsed block always validates', () => {
		for (const raw of [
			{ command: 'npm test -- --grep {{typo}}' },
			{ cwd: '../escapes' },
			{ concurrency: 99, idleTimeout: 1 },
			{ command: ' x ', cwd: ' apps\\web ' },
			{ evidence: '/abs/**/*.webm' },
			{ evidence: 'C:/x/{{id}}.*' },
			{ evidence: '../out/{{id}}.*', evidenceCommand: '   ' },
			{ evidence: ' .\\e2e\\evidence\\**\\{{id}}.* ' },
			{ resultsFolder: '/abs/runs' },
			{ resultsFolder: ' ./runs/ ' }
		]) {
			assert.strictEqual(validateTestsSettings(parseTestsSettings(raw)), undefined);
		}
	});

	// Advisory, never blocking: an unknown token is left in the line at render.
	test('unknownPlaceholders names only what substitution will not touch', () => {
		assert.deepStrictEqual(unknownPlaceholders('npm test -- --grep {{id}}'), []);
		assert.deepStrictEqual(unknownPlaceholders('run {{id}} {{key}} "{{folder}}"'), []);
		assert.deepStrictEqual(unknownPlaceholders('run {{title}} {{id}} {{title}}'), ['title']);
		assert.deepStrictEqual(unknownPlaceholders('npm test'), []);
	});

	test('substituteCommand replaces known tokens and leaves the rest', () => {
		assert.strictEqual(
			substituteCommand('run {{id}} of {{key}} at "{{folder}}"', {
				id: 'TC-1.2.1.1',
				key: 'TC-1',
				folder: 'd:/repo/TC-1'
			}),
			'run TC-1.2.1.1 of TC-1 at "d:/repo/TC-1"'
		);
		assert.strictEqual(
			substituteCommand('run {{id}} {{unknown}}', { id: 'TC-1' }),
			'run TC-1 {{unknown}}'
		);
	});

	// The two halves of the grammar must agree, including on prototype members:
	// what the form calls unknown, substitution must leave untouched — `in`
	// would splice `Object.prototype.toString` into a line the shell then runs.
	test('a prototype member is an unknown token, not a substitution', () => {
		for (const token of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
			const command = `run {{id}} {{${token}}}`;
			assert.deepStrictEqual(unknownPlaceholders(command), [token]);
			assert.strictEqual(
				substituteCommand(command, { id: 'TC-1' }),
				`run TC-1 {{${token}}}`
			);
		}
	});

	test('keeps only an evidence pattern that stays inside the workspace; the glob characters are its own', () => {
		assert.deepStrictEqual(parseTestsSettings({ evidence: ' .\\e2e\\evidence\\**\\{{id}}.* ' }), {
			evidence: 'e2e/evidence/**/{{id}}.*'
		});
		assert.deepStrictEqual(parseTestsSettings({ evidence: 'shots/{{key}}-?.png' }), {
			evidence: 'shots/{{key}}-?.png'
		});
		for (const evidence of ['/abs/**', 'C:/abs/*', '../out/*', 'a<b', '', '   ', 42]) {
			assert.strictEqual(
				parseTestsSettings({ evidence })?.evidence,
				undefined,
				`${JSON.stringify(evidence)} should be dropped`
			);
		}
		assert.strictEqual(testsEvidence({ evidence: './e2e/**/{{id}}.*/' }), 'e2e/**/{{id}}.*');
		assert.strictEqual(testsEvidence(undefined), undefined);
		assert.ok(validateTestsSettings({ evidence: '/abs/**' }));
		assert.ok(validateTestsSettings({ evidence: '../x/*' }));
		assert.ok(validateTestsSettings({ evidence: 'a|b/*' }));
		assert.strictEqual(validateTestsSettings({ evidence: 'e2e/**/{{id}}.*' }), undefined);
		assert.strictEqual(validateTestsSettings({ evidence: '' }), undefined);
	});

	test('the evidence command is trimmed and never validated, like the command', () => {
		assert.deepStrictEqual(parseTestsSettings({ evidenceCommand: ' open {{file}} ' }), {
			evidenceCommand: 'open {{file}}'
		});
		assert.strictEqual(parseTestsSettings({ evidenceCommand: '  ' }), undefined);
		assert.strictEqual(testsEvidenceCommand({ evidenceCommand: ' x ' }), 'x');
		assert.strictEqual(testsEvidenceCommand(undefined), undefined);
		assert.strictEqual(validateTestsSettings({ evidenceCommand: 'anything {{typo}}' }), undefined);
	});

	// Each template has its own token set, and the form's hint follows it.
	test('the evidence pattern and command each warn about their own unknown tokens', () => {
		assert.deepStrictEqual(unknownEvidencePlaceholders('e2e/**/{{id}}.*'), []);
		assert.deepStrictEqual(unknownEvidencePlaceholders('{{key}}/{{folder}}/{{id}}.*'), ['folder']);
		assert.deepStrictEqual(unknownEvidenceCommandPlaceholders('open {{file}}'), []);
		assert.deepStrictEqual(unknownEvidenceCommandPlaceholders('open {{file}} {{id}}'), ['id']);
	});

	test('normalizeTestsSettings is the parse rules applied to a live object', () => {
		assert.strictEqual(normalizeTestsSettings(undefined), undefined);
		assert.strictEqual(normalizeTestsSettings({ command: '   ' }), undefined);
		assert.deepStrictEqual(normalizeTestsSettings({ command: ' x ', concurrency: 99 }), {
			command: 'x'
		});
	});
});
