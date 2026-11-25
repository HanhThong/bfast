import * as assert from 'assert';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TICKET_TYPES } from '../data/types';
import { ImplementError } from '../implement/codingAgent';
import { IMPLEMENT_RULES_FILE, IMPLEMENT_TEMPLATE_FILE } from '../implement/implementPrompt';
import { ImplementPromptStore } from '../implement/implementPromptStore';

/** A scratch workspace under the OS temp folder — never the fixture workspace. */
const SCRATCH = path.join(os.tmpdir(), `bfast-test-implement-${process.pid}`);
const IMPLEMENT = path.join(SCRATCH, '.bfast', 'implement');

/** `out/test/` → the repository root, where `templates/` sits. */
const EXTENSION = vscode.Uri.file(path.join(__dirname, '..', '..'));

let workspace: vscode.WorkspaceFolder | undefined;

function makeStore(): ImplementPromptStore {
	return new ImplementPromptStore(() => workspace, EXTENSION);
}

async function shipped(type: (typeof TICKET_TYPES)[number]): Promise<string> {
	return shippedFile(IMPLEMENT_TEMPLATE_FILE[type]);
}

async function shippedFile(name: string): Promise<string> {
	return readFile(path.join(EXTENSION.fsPath, 'templates', 'implement', name), 'utf8');
}

suite('Implement prompt store', () => {
	setup(async () => {
		await rm(SCRATCH, { recursive: true, force: true });
		await mkdir(SCRATCH, { recursive: true });
		workspace = { uri: vscode.Uri.file(SCRATCH), name: 'scratch', index: 0 };
	});

	suiteTeardown(async () => {
		await rm(SCRATCH, { recursive: true, force: true });
	});

	test('seeds the four templates and the rules when the folder has never existed', async () => {
		const store = makeStore();
		const read = await store.read('story');
		assert.strictEqual(read.source, 'workspace');
		assert.strictEqual(read.path, '.bfast/implement/story.md');
		for (const type of TICKET_TYPES) {
			const text = await readFile(path.join(IMPLEMENT, IMPLEMENT_TEMPLATE_FILE[type]), 'utf8');
			assert.strictEqual(text, await shipped(type), type);
		}
		assert.strictEqual(
			await readFile(path.join(IMPLEMENT, IMPLEMENT_RULES_FILE), 'utf8'),
			await shippedFile(IMPLEMENT_RULES_FILE)
		);
	});

	test('the rules are read like a template: the workspace file first, the shipped one behind it', async () => {
		const store = makeStore();
		const seeded = await store.readRules();
		assert.strictEqual(seeded.source, 'workspace');
		assert.strictEqual(seeded.path, '.bfast/implement/rules.md');
		assert.ok(seeded.template.body.includes('Think before coding'));

		await writeFile(path.join(IMPLEMENT, IMPLEMENT_RULES_FILE), '---\nname: implement-rules\n---\nBe brief.\n');
		assert.strictEqual((await store.readRules()).template.body, 'Be brief.');

		await rm(path.join(IMPLEMENT, IMPLEMENT_RULES_FILE));
		const fallback = await store.readRules();
		assert.strictEqual(fallback.source, 'bundled');
		assert.ok(fallback.template.body.includes('Think before coding'));

		// Open restores the one file, the way a template's Open does.
		const uri = await store.openRules();
		assert.strictEqual(uri?.toString(), vscode.Uri.file(path.join(IMPLEMENT, IMPLEMENT_RULES_FILE)).toString());
		assert.strictEqual(await readFile(uri!.fsPath, 'utf8'), await shippedFile(IMPLEMENT_RULES_FILE));
	});

	test('an emptied folder is left alone, and the shipped template stands in', async () => {
		await mkdir(IMPLEMENT, { recursive: true });
		const store = makeStore();
		const read = await store.read('ac');
		assert.strictEqual(read.source, 'bundled');
		assert.strictEqual(read.template.types[0], 'ac');
		assert.ok(read.template.body.length > 100);
		// Still empty: nothing was put back.
		await assert.rejects(readFile(path.join(IMPLEMENT, 'acceptance-criterion.md')));
	});

	test('the workspace file wins, and is read at call time', async () => {
		const store = makeStore();
		await store.read('epic');
		await writeFile(path.join(IMPLEMENT, 'epic.md'), '---\ndescription: Mine.\n---\nDo {{id}} my way.\n');
		const read = await store.read('epic');
		assert.strictEqual(read.source, 'workspace');
		assert.strictEqual(read.template.body, 'Do {{id}} my way.');
		assert.strictEqual(read.template.description, 'Mine.');
	});

	test('openTemplate restores the one file it opens', async () => {
		const store = makeStore();
		await store.read('story');
		await rm(path.join(IMPLEMENT, 'test-case.md'));
		const uri = await store.openTemplate('testcase');
		// Compared as uris: `fsPath` lower-cases a Windows drive letter.
		assert.strictEqual(uri?.toString(), vscode.Uri.file(path.join(IMPLEMENT, 'test-case.md')).toString());
		assert.strictEqual(await readFile(uri!.fsPath, 'utf8'), await shipped('testcase'));
	});

	test('list has one row per ticket type, in order, with the description', async () => {
		const rows = await makeStore().list();
		assert.deepStrictEqual(
			rows.map((row) => row.type),
			[...TICKET_TYPES]
		);
		for (const row of rows) {
			assert.ok(row.description, row.type);
			assert.strictEqual(row.source, 'workspace');
			assert.strictEqual(row.path, `.bfast/implement/${IMPLEMENT_TEMPLATE_FILE[row.type]}`);
		}
	});

	test('writeHandoff writes the rendered prompt by id, overwriting the last one', async () => {
		const store = makeStore();
		const first = await store.writeHandoff('ST-1#2.1', 'first');
		assert.strictEqual(first, '.bfast/implement/prompts/ST-1_2.1.md');
		assert.strictEqual(await readFile(path.join(IMPLEMENT, 'prompts', 'ST-1_2.1.md'), 'utf8'), 'first');
		await store.writeHandoff('ST-1#2.1', 'second');
		assert.strictEqual(await readFile(path.join(IMPLEMENT, 'prompts', 'ST-1_2.1.md'), 'utf8'), 'second');
		// Writing a handoff first never leaves the templates folder without its templates.
		assert.strictEqual(await readFile(path.join(IMPLEMENT, 'story.md'), 'utf8'), await shipped('story'));
	});

	test('with no folder open the shipped templates answer, and a handoff is refused', async () => {
		workspace = undefined;
		const store = makeStore();
		assert.strictEqual((await store.read('story')).source, 'bundled');
		assert.strictEqual((await store.list()).length, TICKET_TYPES.length);
		assert.strictEqual(await store.openTemplate('story'), undefined);
		await assert.rejects(store.writeHandoff('ST-1.2', 'x'), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'not-configured');
			return true;
		});
	});
});
