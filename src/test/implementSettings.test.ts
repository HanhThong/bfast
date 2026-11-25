import * as assert from 'assert';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';
import {
	CODING_AGENTS,
	codingAgentAvailable,
	codingAgentLabel,
	codingAgentOption
} from '../settings/codingAgents';
import {
	DEFAULT_IMPLEMENT_AGENT,
	IMPLEMENT_AGENT_IDS,
	implementAgentId,
	normalizeImplementSettings,
	parseImplementSettings,
	validateImplementSettings,
	type ImplementAgentId,
	type ImplementSettings
} from '../settings/implementSettings';

suite('Implement settings', () => {
	test('parseImplementSettings answers undefined when nothing usable survived', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { agent: 'vim' }, { agent: 7 }, { shell: 'zsh' }]) {
			assert.strictEqual(parseImplementSettings(raw), undefined, JSON.stringify(raw));
		}
	});

	test('every id the list offers parses, validates and round-trips — coming soon included', () => {
		for (const agent of IMPLEMENT_AGENT_IDS) {
			const parsed = parseImplementSettings({ agent });
			assert.deepStrictEqual(parsed, { agent });
			assert.strictEqual(validateImplementSettings(parsed), undefined, agent);
			assert.deepStrictEqual(normalizeImplementSettings(parsed), { agent });
		}
	});

	test('reading is forgiving, writing is strict', () => {
		// Anything the parse accepts, validate accepts too.
		for (const raw of [{ agent: 'vim' }, { agent: 'claude-code-cli' }, {}]) {
			assert.strictEqual(validateImplementSettings(parseImplementSettings(raw)), undefined);
		}
		// A value the form could only produce by hand is refused on the way out.
		const bogus: ImplementSettings = { agent: 'vim' as ImplementAgentId };
		assert.strictEqual(validateImplementSettings(bogus), 'Pick a coding agent from the list.');
		assert.strictEqual(validateImplementSettings(undefined), undefined);
	});

	test('the accessor defaults to the Claude Code extension', () => {
		assert.strictEqual(DEFAULT_IMPLEMENT_AGENT, 'claude-code');
		assert.strictEqual(implementAgentId(undefined), 'claude-code');
		assert.strictEqual(implementAgentId({}), 'claude-code');
		assert.strictEqual(implementAgentId({ agent: 'claude-code-cli' }), 'claude-code-cli');
	});

	test('normalizeSettings keeps a configured implement block', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Thu Ha',
			implement: { agent: 'claude-code-cli' }
		});
		assert.deepStrictEqual(normalized.implement, { agent: 'claude-code-cli' });
	});

	test('normalizeSettings omits an empty implement block entirely', () => {
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Thu Ha',
			implement: {}
		});
		assert.deepStrictEqual(normalized, { trackerFolder: '.tracker', userName: 'Thu Ha' });
		assert.ok(!('implement' in normalized));
		assert.ok(!('implement' in normalizeSettings({ trackerFolder: '.tracker', userName: 'Thu Ha' })));
	});

	test('parseSettings reads the block off the whole file, and leaves it absent otherwise', () => {
		const whole = parseSettings({
			trackerFolder: '.tracker',
			userName: 'Thu Ha',
			implement: { agent: 'codex', extra: true }
		});
		assert.deepStrictEqual(whole.implement, { agent: 'codex' });
		assert.strictEqual(parseSettings({ trackerFolder: '.tracker', userName: 'Thu Ha' }).implement, undefined);
	});
});

suite('Coding agents', () => {
	test('offers exactly the ids the settings accept, in the same order', () => {
		assert.deepStrictEqual(
			CODING_AGENTS.map((option) => option.id),
			[...IMPLEMENT_AGENT_IDS]
		);
	});

	test('the two Claude Code agents are available and the rest are coming soon', () => {
		assert.deepStrictEqual(
			CODING_AGENTS.filter((option) => option.available).map((option) => option.id),
			['claude-code', 'claude-code-cli']
		);
		assert.strictEqual(codingAgentAvailable('claude-code-cli'), true);
		assert.strictEqual(codingAgentAvailable('codex'), false);
	});

	test('every option carries a label and a hint', () => {
		for (const option of CODING_AGENTS) {
			assert.ok(option.label.length > 0, option.id);
			assert.ok(option.hint.length > 0, option.id);
			assert.strictEqual(codingAgentOption(option.id), option);
		}
		assert.strictEqual(codingAgentLabel('github-copilot'), 'GitHub Copilot');
		assert.strictEqual(codingAgentLabel('claude-code-cli'), 'Claude Code CLI');
	});
});
