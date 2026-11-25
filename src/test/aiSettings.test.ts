import * as assert from 'assert';
import {
	aiConcurrency,
	aiIdleTimeoutMs,
	aiLanguageName,
	aiModel,
	DEFAULT_CONCURRENCY,
	DEFAULT_IDLE_SECONDS,
	MAX_CONCURRENCY,
	MAX_IDLE_SECONDS,
	MAX_TURNS,
	MIN_CONCURRENCY,
	MIN_IDLE_SECONDS,
	MIN_TURNS,
	normalizeAiSettings,
	parseAiSettings,
	validateAiSettings
} from '../settings/aiSettings';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';

suite('BFAST AI settings', () => {
	test('returns undefined when nothing usable survives', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { provider: 'gpt' }, { model: '  ' }]) {
			assert.strictEqual(parseAiSettings(raw), undefined, `${JSON.stringify(raw)} should be dropped`);
		}
	});

	test('keeps only a known provider', () => {
		assert.strictEqual(parseAiSettings({ provider: 'claude-cli' })?.provider, 'claude-cli');
		assert.strictEqual(parseAiSettings({ provider: 'claude-agent-sdk' })?.provider, 'claude-agent-sdk');
		assert.strictEqual(parseAiSettings({ provider: 'claude-cli-2' }), undefined);
	});

	test('drops a maxTurns that is not a whole number in range', () => {
		for (const maxTurns of [-1, 0, 999, 1.5, '4', null, NaN]) {
			assert.strictEqual(
				parseAiSettings({ maxTurns })?.maxTurns,
				undefined,
				`${String(maxTurns)} should be dropped`
			);
		}
		assert.strictEqual(parseAiSettings({ maxTurns: 4 })?.maxTurns, 4);
	});

	test('drops a concurrency that is not a whole number in range', () => {
		for (const concurrency of [-1, 0, 99, 1.5, '2', null, NaN]) {
			assert.strictEqual(
				parseAiSettings({ concurrency })?.concurrency,
				undefined,
				`${String(concurrency)} should be dropped`
			);
		}
		assert.strictEqual(parseAiSettings({ concurrency: 4 })?.concurrency, 4);
		// Absent is the whole point: a workspace that never sets it writes no key.
		assert.strictEqual(aiConcurrency(undefined), DEFAULT_CONCURRENCY);
		assert.strictEqual(aiConcurrency({ concurrency: 5 }), 5);
	});

	test('drops an idle timeout that is not a whole number of seconds in range', () => {
		// The floor matters more here than elsewhere: a window short enough to fire
		// between two heartbeats would reintroduce the bug it replaced.
		for (const idleTimeout of [-1, 0, 5, 99999, 60.5, '120', null, NaN]) {
			assert.strictEqual(
				parseAiSettings({ idleTimeout })?.idleTimeout,
				undefined,
				`${String(idleTimeout)} should be dropped`
			);
		}
		assert.strictEqual(parseAiSettings({ idleTimeout: 600 })?.idleTimeout, 600);
	});

	test('aiIdleTimeoutMs converts to the unit a provider holds', () => {
		assert.strictEqual(aiIdleTimeoutMs(undefined), DEFAULT_IDLE_SECONDS * 1000);
		assert.strictEqual(aiIdleTimeoutMs({ idleTimeout: 600 }), 600_000);
	});

	test('trims text fields and drops them when blank', () => {
		assert.deepStrictEqual(parseAiSettings({ model: ' claude-opus-5 ', executablePath: '' }), {
			model: 'claude-opus-5'
		});
	});

	// Agent instructions used to live here as `templates`; they are files now.
	test('ignores keys it does not know, including the old templates block', () => {
		assert.strictEqual(parseAiSettings({ templates: { epic: 'write it' } }), undefined);
		assert.deepStrictEqual(parseAiSettings({ templates: { epic: 'x' }, maxTurns: 5 }), {
			maxTurns: 5
		});
	});

	test('keeps only an ISO 639-1 language, lower-cased', () => {
		assert.strictEqual(parseAiSettings({ language: 'vi' })?.language, 'vi');
		assert.strictEqual(parseAiSettings({ language: ' VI ' })?.language, 'vi');
		for (const language of ['', '  ', 'xx', 'vie', 'Vietnamese', 42, null, {}]) {
			assert.strictEqual(
				parseAiSettings({ language })?.language,
				undefined,
				`${JSON.stringify(language)} should be dropped`
			);
		}
	});

	test('round-trips through JSON', () => {
		const ai = {
			provider: 'claude-agent-sdk' as const,
			model: 'claude-opus-5',
			executablePath: '/usr/local/bin/claude',
			maxTurns: 7,
			language: 'vi'
		};
		assert.deepStrictEqual(parseAiSettings(JSON.parse(JSON.stringify(ai))), ai);
	});

	// The regression the whole design turns on: `normalizeSettings` returns a
	// fresh literal, so an unnamed field is dropped on every write.
	test('normalizeSettings keeps a configured ai block', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Hanh Thong',
			ai: { provider: 'claude-agent-sdk' }
		});
		assert.deepStrictEqual(normalized.ai, { provider: 'claude-agent-sdk' });
	});

	// The fresh-literal trap again, one level down: `parseAiSettings` also
	// rebuilds from scratch, so a field it does not name is lost on every write.
	test('normalizeSettings keeps a language through a write', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Hanh Thong',
			ai: { language: 'vi' }
		});
		assert.deepStrictEqual(normalized.ai, { language: 'vi' });
	});

	test('normalizeSettings drops the ai block when only a bad language was in it', () => {
		assert.deepStrictEqual(
			normalizeSettings({ trackerFolder: '.tracker', userName: 'Thu Ha', ai: { language: 'xx' } }),
			{ trackerFolder: '.tracker', userName: 'Thu Ha' }
		);
	});

	// The other half: a workspace that never touches the assistant must keep
	// `bfast.json` byte-identical, which is what the two older suites assume.
	test('normalizeSettings omits an empty ai block entirely', () => {
		assert.deepStrictEqual(normalizeSettings({ trackerFolder: './a/', userName: ' Thu Ha ' }), {
			trackerFolder: 'a',
			userName: 'Thu Ha'
		});
		assert.deepStrictEqual(
			normalizeSettings({ trackerFolder: '.tracker', userName: 'Thu Ha', ai: {} }),
			{ trackerFolder: '.tracker', userName: 'Thu Ha' }
		);
	});

	test('parseSettings reads the ai block off the whole file', () => {
		const parsed = parseSettings({
			trackerFolder: 'docs/tracker',
			userName: 'Hanh Thong',
			ai: { model: 'claude-opus-5' }
		});
		assert.deepStrictEqual(parsed.ai, { model: 'claude-opus-5' });
		assert.strictEqual(parseSettings({ trackerFolder: '.tracker', userName: 'x' }).ai, undefined);
	});

	// Reading is forgiving, writing is strict: the same out-of-range value is
	// dropped on the way in and refused on the way out.
	test('validation rejects only what a write must not accept', () => {
		assert.strictEqual(validateAiSettings(undefined), undefined);
		assert.strictEqual(validateAiSettings({}), undefined);
		assert.strictEqual(validateAiSettings({ maxTurns: DEFAULT_OK }), undefined);
		assert.ok(validateAiSettings({ maxTurns: MIN_TURNS - 1 }));
		assert.ok(validateAiSettings({ maxTurns: MAX_TURNS + 1 }));
		assert.ok(validateAiSettings({ maxTurns: 1.5 }));
		assert.strictEqual(validateAiSettings({ language: 'vi' }), undefined);
		assert.strictEqual(validateAiSettings({ language: '' }), undefined);
		assert.ok(validateAiSettings({ language: 'klingon' }));
		assert.strictEqual(validateAiSettings({ concurrency: MAX_CONCURRENCY }), undefined);
		assert.ok(validateAiSettings({ concurrency: MIN_CONCURRENCY - 1 }));
		assert.ok(validateAiSettings({ concurrency: MAX_CONCURRENCY + 1 }));
		assert.strictEqual(validateAiSettings({ idleTimeout: MAX_IDLE_SECONDS }), undefined);
		assert.ok(validateAiSettings({ idleTimeout: MIN_IDLE_SECONDS - 1 }));
		assert.ok(validateAiSettings({ idleTimeout: MAX_IDLE_SECONDS + 1 }));
		// A format rule, never a membership test: an id the list does not know
		// is a model that shipped after the extension did.
		assert.strictEqual(validateAiSettings({ model: 'opus' }), undefined);
		assert.strictEqual(validateAiSettings({ model: 'made-up-id' }), undefined);
		assert.strictEqual(validateAiSettings({ model: '' }), undefined);
		assert.ok(validateAiSettings({ model: 'a b' }));
		assert.ok(validateAiSettings({ model: 'x'.repeat(101) }));
	});

	// The one address for "a tab's pick, else the setting, else the provider's
	// default" — and the pick came from a webview, so it is checked, not trusted.
	test('aiModel ranks a usable pick over the setting and ignores an unusable one', () => {
		assert.strictEqual(aiModel({ model: 'sonnet' }, ' opus '), 'opus');
		assert.strictEqual(aiModel({ model: 'sonnet' }, ''), 'sonnet');
		assert.strictEqual(aiModel({ model: 'sonnet' }, undefined), 'sonnet');
		assert.strictEqual(aiModel({ model: 'sonnet' }, 'a b'), 'sonnet');
		assert.strictEqual(aiModel(undefined, 'haiku'), 'haiku');
		assert.strictEqual(aiModel(undefined, undefined), undefined);
		assert.strictEqual(aiModel({}, 'a b'), undefined);
	});

	// What is stored is the code; what a model needs is the name.
	test('aiLanguageName translates the stored code for the prompt', () => {
		assert.strictEqual(aiLanguageName({ language: 'vi' }), 'Vietnamese');
		assert.strictEqual(aiLanguageName({ language: 'JA' }), 'Japanese');
		assert.strictEqual(aiLanguageName(undefined), undefined);
		assert.strictEqual(aiLanguageName({}), undefined);
		assert.strictEqual(aiLanguageName({ language: 'xx' }), undefined);
	});

	test('normalizeAiSettings is the parse rules applied to a live object', () => {
		assert.strictEqual(normalizeAiSettings(undefined), undefined);
		assert.strictEqual(normalizeAiSettings({ model: '   ' }), undefined);
		assert.deepStrictEqual(normalizeAiSettings({ model: ' x ', maxTurns: 99 }), { model: 'x' });
	});
});

const DEFAULT_OK = 12;
