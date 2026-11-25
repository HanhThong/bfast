// The Implement templates BFAST ships, tested as the files they actually are —
// the `bundledAgents.test.ts` posture: a bad edit to one fails the suite rather
// than the first click.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TICKET_TYPES } from '../data/types';
import {
	IMPLEMENT_RULES_FILE,
	IMPLEMENT_TEMPLATE_FILE,
	IMPLEMENT_TOKENS,
	implementTemplateType,
	parseImplementTemplate
} from '../implement/implementPrompt';

/** `out/test/` → the repository root, where `templates/` sits. */
const ROOT = path.join(__dirname, '..', '..', 'templates', 'implement');

/** No shipped template may name a coding agent: the agent is `implement.agent`'s to pick. */
const AGENT_NAMES = /claude|codex|copilot|cursor|opencode/i;

function read(type: (typeof TICKET_TYPES)[number]): { text: string; file: string } {
	const file = IMPLEMENT_TEMPLATE_FILE[type];
	return { text: fs.readFileSync(path.join(ROOT, file), 'utf8'), file };
}

suite('BFAST bundled implement templates', () => {
	test('ships one template per ticket type, the shared rules, and nothing else', () => {
		const shipped = fs.readdirSync(ROOT).sort();
		assert.deepStrictEqual(shipped, [...Object.values(IMPLEMENT_TEMPLATE_FILE), IMPLEMENT_RULES_FILE].sort());
	});

	test('the working rules carry the four guidelines and every template ends with them', () => {
		const text = fs.readFileSync(path.join(ROOT, IMPLEMENT_RULES_FILE), 'utf8');
		const rules = parseImplementTemplate(text, IMPLEMENT_RULES_FILE);
		assert.strictEqual(rules.name, 'implement-rules');
		assert.ok(rules.description && rules.description.length > 20);
		// A file called `rules` names no ticket type, so it covers none — it is not a template.
		assert.deepStrictEqual(rules.types, []);
		for (const heading of ['Think before coding', 'Simplicity first', 'Surgical changes', 'Goal-driven execution']) {
			assert.ok(rules.body.includes(heading), `rules.md should carry "${heading}"`);
		}
		assert.ok(!AGENT_NAMES.test(text), 'rules.md names a coding agent');
		assert.ok(!/\{\{\w+\}\}/.test(rules.body), 'the rules are text, never a template of their own');
		for (const type of TICKET_TYPES) {
			const { text: template, file } = read(type);
			assert.ok(/## Working rules\s+\{\{rules\}\}\s*$/.test(template), `${file} should end with the rules`);
		}
	});

	test('each template names its type in the frontmatter and in its file name', () => {
		for (const type of TICKET_TYPES) {
			const { text, file } = read(type);
			const template = parseImplementTemplate(text, file);
			assert.deepStrictEqual(template.types, [type], file);
			assert.strictEqual(implementTemplateType(file), type, file);
			assert.strictEqual(template.name, `implement-${file.replace(/\.md$/, '')}`);
			assert.ok(template.description && template.description.length > 20, `${file} needs a description`);
			assert.ok(template.body.length > 100, `${file} is too short to be a prompt`);
		}
	});

	test('each template names the ticket by id and by path, and keeps the agent out of the tracker', () => {
		for (const type of TICKET_TYPES) {
			const { text, file } = read(type);
			for (const token of ['{{id}}', '{{title}}', '{{folder}}', '{{file}}', '{{tracker}}', '{{description}}', '{{designs}}']) {
				assert.ok(text.includes(token), `${file} should use ${token}`);
			}
			assert.ok(/do not edit anything under `\{\{tracker\}\}`/i.test(text), `${file} should protect the tracker`);
		}
		// A story and a test case say how the tests run; an epic and a criterion
		// list what is below them.
		assert.ok(read('story').text.includes('{{testCommand}}'));
		assert.ok(read('testcase').text.includes('{{testCommand}}'));
		assert.ok(read('epic').text.includes('{{children}}'));
		assert.ok(read('ac').text.includes('{{children}}'));
		assert.ok(read('story').text.includes('{{ancestors}}'));
	});

	test('every placeholder a template uses is one the renderer knows', () => {
		for (const type of TICKET_TYPES) {
			const { text, file } = read(type);
			for (const [, token] of text.matchAll(/\{\{(\w+)\}\}/g)) {
				assert.ok(
					(IMPLEMENT_TOKENS as readonly string[]).includes(token),
					`${file} uses {{${token}}}, which is not a placeholder`
				);
			}
		}
	});

	test('the templates are agent-neutral', () => {
		for (const type of TICKET_TYPES) {
			const { text, file } = read(type);
			assert.ok(!AGENT_NAMES.test(text), `${file} names a coding agent`);
		}
	});
});
