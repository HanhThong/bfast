import * as assert from 'assert';
import {
	isModelId,
	MAX_MODEL_ID_LENGTH,
	MODEL_IDS,
	MODELS,
	modelLabel,
	sanitizeModelId
} from '../settings/models';

suite('BFAST models', () => {
	// The list is data, and data rots quietly: a duplicated id would make one
	// entry unreachable in the dropdown, and one that fails the format rule would
	// be refused by the very validator the dropdown feeds.
	test('every entry is a distinct id that passes the format rule', () => {
		for (const model of MODELS) {
			assert.ok(isModelId(model.id), `${model.id} fails isModelId`);
			assert.ok(model.label.trim().length > 0, `${model.id} has no label`);
			assert.ok(model.hint.trim().length > 0, `${model.id} has no hint`);
		}
		assert.strictEqual(MODEL_IDS.size, MODELS.length, 'an id is duplicated');
		assert.strictEqual(
			new Set(MODELS.map((model) => model.label)).size,
			MODELS.length,
			'a label is duplicated'
		);
	});

	// "Absent" already means the provider default; a second spelling is a trap.
	test('ships no default entry', () => {
		assert.ok(!MODEL_IDS.has('default'));
		assert.ok(!MODEL_IDS.has(''));
	});

	// The dropdown renders the array in order, and the aliases lead because
	// Claude Code re-points them at each release.
	test('aliases precede pinned ids, and the CLI aliases are all there', () => {
		const kinds = MODELS.map((model) => model.kind);
		const firstId = kinds.indexOf('id');
		assert.ok(firstId > 0, 'expected at least one alias before the ids');
		assert.ok(!kinds.slice(firstId).includes('alias'), 'an alias sits after the ids');
		for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan', 'opus[1m]', 'sonnet[1m]']) {
			assert.ok(MODEL_IDS.has(alias), `${alias} is missing`);
		}
		for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1']) {
			assert.ok(MODEL_IDS.has(id), `${id} is missing`);
		}
	});

	// A format rule, not a membership test: a name that shipped after the
	// extension did must pass, while anything that would break an argv must not.
	test('isModelId is a format rule, not a membership test', () => {
		for (const good of ['opus', 'opus[1m]', 'claude-opus-5', 'anthropic.claude-opus-5', 'my-future-model']) {
			assert.ok(isModelId(good), `${good} should pass`);
		}
		const tooLong = 'x'.repeat(MAX_MODEL_ID_LENGTH + 1);
		for (const bad of ['', ' ', 'a b', 'claude\n', ' opus', 'opus ', '\tsonnet', tooLong, 'thé']) {
			assert.ok(!isModelId(bad), `${JSON.stringify(bad)} should fail`);
		}
		for (const notText of [undefined, null, 42, {}, ['opus']]) {
			assert.ok(!isModelId(notText), `${String(notText)} should fail`);
		}
		assert.ok(isModelId('x'.repeat(MAX_MODEL_ID_LENGTH)));
	});

	test('sanitizeModelId trims and refuses the rest', () => {
		assert.strictEqual(sanitizeModelId(' sonnet '), 'sonnet');
		assert.strictEqual(sanitizeModelId('claude-opus-5'), 'claude-opus-5');
		for (const bad of [undefined, null, '', '   ', 'a b', 42]) {
			assert.strictEqual(sanitizeModelId(bad), undefined, `${String(bad)} should be refused`);
		}
	});

	test('modelLabel names a known id, echoes an unknown one and says so for none', () => {
		assert.strictEqual(modelLabel('opus'), 'Opus');
		assert.strictEqual(modelLabel('claude-haiku-4-5'), 'Claude Haiku 4.5');
		assert.strictEqual(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5');
		assert.strictEqual(modelLabel('my-future-model'), 'my-future-model');
		assert.strictEqual(modelLabel(undefined), 'provider default');
		assert.strictEqual(modelLabel(''), 'provider default');
	});
});
