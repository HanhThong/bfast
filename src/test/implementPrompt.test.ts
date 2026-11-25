import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TICKET_TYPES } from '../data/types';
import {
	EMPTY_DESCRIPTION,
	HANDOFF_FOLDER,
	IMPLEMENT_FOLDER,
	IMPLEMENT_TEMPLATE_FILE,
	IMPLEMENT_TOKENS,
	NONE,
	TEST_COMMAND_UNSET,
	formatAncestors,
	formatChildren,
	formatDesigns,
	handoffFileName,
	handoffPath,
	handoffSentence,
	implementTemplateType,
	implementTypeName,
	parseImplementTemplate,
	renderImplementPrompt,
	type ImplementVars
} from '../implement/implementPrompt';

/** `out/test/` → the repository root, where `docs/` sits. */
const DOCS = path.join(__dirname, '..', '..', 'docs', 'implement', 'README.md');

const VARS: ImplementVars = {
	id: 'ST-1.2',
	key: 'ST-2',
	title: 'Sign in with email',
	type: 'story',
	status: 'todo',
	folder: '.tracker/EP-1-Authentication/ST-1.2-Sign_in_with_email',
	file: '.tracker/EP-1-Authentication/ST-1.2-Sign_in_with_email/Story.mdx',
	description: '**As a** visitor',
	ancestors: '- `EP-1` Authentication — `.tracker/EP-1-Authentication/Epic.mdx`',
	children: NONE,
	designs: NONE,
	testCommand: 'npm test -- --grep {{id}}',
	tracker: '.tracker',
	rules: '### 1. Think before coding'
};

suite('Implement prompt', () => {
	test('the template file name infers the ticket type, the skill rule', () => {
		for (const type of TICKET_TYPES) {
			assert.strictEqual(implementTemplateType(IMPLEMENT_TEMPLATE_FILE[type]), type);
		}
		assert.strictEqual(implementTemplateType('Acceptance Criterion.md'), 'ac');
		assert.strictEqual(implementTemplateType('notes.md'), undefined);
	});

	test('parseImplementTemplate reads the frontmatter and strips it from the body', () => {
		const file = parseImplementTemplate(
			'---\nname: implement-story\ndescription: One story.\ntypes: story\n---\n\nImplement {{id}}.\n',
			'story.md'
		);
		assert.deepStrictEqual(file, {
			name: 'implement-story',
			description: 'One story.',
			types: ['story'],
			body: 'Implement {{id}}.'
		});
	});

	test('a template with no frontmatter is all body, named and typed by its file', () => {
		const file = parseImplementTemplate('Implement {{id}}.', 'acceptance-criterion.md');
		assert.deepStrictEqual(file, {
			name: 'implement-acceptance-criterion',
			types: ['ac'],
			body: 'Implement {{id}}.'
		});
		// A file whose name says nothing covers nothing, never everything.
		assert.deepStrictEqual(parseImplementTemplate('x', 'notes.md').types, []);
	});

	test('an explicit types line wins over the file name', () => {
		assert.deepStrictEqual(
			parseImplementTemplate('---\ntypes: epic\n---\nbody', 'story.md').types,
			['epic']
		);
	});

	test('renders every token and leaves an unknown one untouched', () => {
		const template = IMPLEMENT_TOKENS.map((token) => `${token}=<{{${token}}}>`).join('\n') + '\n{{example}}';
		const prompt = renderImplementPrompt(template, VARS);
		for (const token of IMPLEMENT_TOKENS) {
			assert.ok(prompt.includes(`${token}=<${VARS[token]}>`), token);
		}
		assert.ok(prompt.endsWith('{{example}}'));
		// No token was left in place — the `{{id}}` inside the raw test command is a value, not a token.
		assert.ok(!prompt.includes('<{{'));
	});

	test('the placeholder table in the docs names every token, and only those', () => {
		const readme = fs.readFileSync(DOCS, 'utf8');
		for (const token of IMPLEMENT_TOKENS) {
			assert.ok(readme.includes(`| \`{{${token}}}\` |`), `docs/implement/README.md should table {{${token}}}`);
		}
		const tabled = [...readme.matchAll(/^\| `\{\{(\w+)\}\}` \|/gm)].map((match) => match[1]);
		assert.deepStrictEqual(tabled.sort(), [...IMPLEMENT_TOKENS].sort());
	});

	test('formats ancestors, children and designs as id, title and path', () => {
		assert.strictEqual(
			formatAncestors([{ id: 'EP-1', title: 'Authentication', path: 'a/Epic.mdx' }]),
			'- `EP-1` Authentication — `a/Epic.mdx`'
		);
		assert.strictEqual(
			formatChildren([
				{ id: 'AC-1.2.1', title: 'Wrong password', path: 'a/AC.mdx', depth: 0 },
				{ id: 'TC-1.2.1.1', title: 'Unknown email', path: 'a/b/TestCase.mdx', depth: 1 }
			]),
			'- `AC-1.2.1` Wrong password — `a/AC.mdx`\n  - `TC-1.2.1.1` Unknown email — `a/b/TestCase.mdx`'
		);
		assert.strictEqual(
			formatDesigns([
				{ id: 'ERD-1', title: 'Account model', style: 'Entity Relationship Diagram', ticketId: 'ST-1.2', path: 'a/ERD-1-Account_model.mdx' }
			]),
			'- `ERD-1` Account model (Entity Relationship Diagram, on `ST-1.2`) — `a/ERD-1-Account_model.mdx`'
		);
		assert.strictEqual(formatAncestors([]), NONE);
		assert.strictEqual(formatChildren([]), NONE);
		assert.strictEqual(formatDesigns([]), NONE);
	});

	test('the prose type name and the standing placeholders', () => {
		assert.strictEqual(implementTypeName('ac'), 'acceptance criterion');
		assert.strictEqual(implementTypeName('testcase'), 'test case');
		assert.strictEqual(EMPTY_DESCRIPTION, '(empty)');
		assert.strictEqual(TEST_COMMAND_UNSET, '(not configured — see Settings → Tests)');
	});

	test('the handoff file is named by id, a rank’s # written as _', () => {
		assert.strictEqual(handoffFileName('ST-1.2'), 'ST-1.2.md');
		assert.strictEqual(handoffFileName('ST-1#2.1'), 'ST-1_2.1.md');
		assert.strictEqual(handoffPath('ST-1.2'), `${IMPLEMENT_FOLDER}/${HANDOFF_FOLDER}/ST-1.2.md`);
		assert.strictEqual(handoffPath('ST-1.2'), '.bfast/implement/prompts/ST-1.2.md');
	});

	test('the handoff sentence is one fixed string around the path, refused outside its alphabet', () => {
		assert.strictEqual(
			handoffSentence(handoffPath('ST-1.2')),
			'Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says.'
		);
		assert.ok(handoffSentence(handoffPath('ST-1#2.1')).includes('ST-1_2.1.md'));
		for (const path of ['a b.md', 'a;b.md', 'a"b.md', 'a$b.md', 'a`b.md', 'a\\b.md']) {
			assert.throws(() => handoffSentence(path), path);
		}
	});
});
