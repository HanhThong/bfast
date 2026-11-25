import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import { BUILT_IN_STYLES } from '../design/designDocument';
import { DesignStore } from '../design/designStore';
import { ImplementError } from '../implement/codingAgent';
import { buildImplementPrompt, type ImplementContextDeps } from '../implement/implementContext';
import {
	IMPLEMENT_TOKENS,
	NONE,
	TEST_COMMAND_UNSET,
	handoffPath,
	handoffSentence,
	parseImplementTemplate
} from '../implement/implementPrompt';
import type { ImplementPromptStore } from '../implement/implementPromptStore';
import {
	implementTicket,
	type ImplementServices,
	type ImplementUi
} from '../implement/implementCommand';
import type { TestsSettings } from '../settings/testsSettings';
import { FakeCodingAgent } from './fakeCodingAgent';

/** A scratch tracker of this suite's own, inside the fixture workspace. */
const WORKSPACE = vscode.workspace.workspaceFolders![0].uri;
const TRACKER = '.tracker-implement';
const ROOT = vscode.Uri.joinPath(WORKSPACE, TRACKER);

const tracker: TrackerContext = { rootUri: () => ROOT, author: () => 'Test Runner' };

/** Every token on its own line, so the rendered prompt can be read back per token. */
const TEMPLATE = IMPLEMENT_TOKENS.map((token) => `${token}=<{{${token}}}>`).join('\n');

const templates: Pick<ImplementPromptStore, 'read' | 'readRules'> = {
	read: async (type) => ({
		template: parseImplementTemplate(`---\ntypes: ${type}\n---\n${TEMPLATE}`, `${type}.md`),
		path: `.bfast/implement/${type}.md`,
		source: 'workspace'
	}),
	readRules: async () => ({
		template: parseImplementTemplate('---\nname: implement-rules\n---\nThink first.\nThen code.', 'rules.md'),
		path: '.bfast/implement/rules.md',
		source: 'workspace'
	})
};

let tests: TestsSettings | undefined;
let workspaceFolder: vscode.Uri | undefined = WORKSPACE;

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

/** `id=<value>` back out of the rendered prompt. */
function value(prompt: string, token: string): string {
	const match = new RegExp(`^${token}=<([\\s\\S]*?)>$`, 'm').exec(prompt);
	assert.ok(match, `${token} should be in the prompt`);
	return match[1];
}

suite('Implement context', () => {
	let store: FileTicketStore;
	let designs: DesignStore;
	let deps: ImplementContextDeps;
	let epic: string;
	let story: string;
	let ac: string;
	let testCase: string;
	let storyTest: string;

	setup(async () => {
		await reset();
		tests = undefined;
		workspaceFolder = WORKSPACE;
		store = new FileTicketStore(tracker);
		designs = new DesignStore(store, { styles: async () => [...BUILT_IN_STYLES], author: () => 'Test Runner' });
		deps = {
			store,
			designs,
			templates,
			workspaceFolder: () => workspaceFolder,
			trackerFolder: () => TRACKER,
			tests: () => tests
		};

		epic = (await store.createTicket({ type: 'epic', title: 'Authentication' })).id;
		story = (
			await store.createTicket({
				parentId: epic,
				type: 'story',
				title: 'Sign in with email',
				description: '**As a** visitor\n**I want** to sign in'
			})
		).id;
		ac = (await store.createTicket({ parentId: story, type: 'ac', title: 'Wrong password error' })).id;
		testCase = (await store.createTicket({ parentId: ac, type: 'testcase', title: 'Unknown email same error' })).id;
		storyTest = (await store.createTicket({ parentId: story, type: 'testcase', title: 'Smoke login' })).id;
	});

	suiteTeardown(reset);

	test('a story: its description inline, its epic above and its criteria and test cases below, by path', async () => {
		await designs.create(story, 'entity-relationship-diagram', 'Account model');
		const { prompt, ticket, templatePath } = await buildImplementPrompt(deps, story);

		assert.strictEqual(ticket.id, story);
		assert.strictEqual(templatePath, '.bfast/implement/story.md');
		assert.strictEqual(value(prompt, 'id'), 'ST-1.1');
		assert.strictEqual(value(prompt, 'key'), 'ST-1');
		assert.strictEqual(value(prompt, 'title'), 'Sign in with email');
		assert.strictEqual(value(prompt, 'type'), 'story');
		assert.strictEqual(value(prompt, 'status'), 'todo');
		assert.strictEqual(value(prompt, 'tracker'), TRACKER);
		assert.strictEqual(value(prompt, 'folder'), `${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email`);
		assert.strictEqual(value(prompt, 'file'), `${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email/Story.mdx`);
		assert.strictEqual(value(prompt, 'description'), '**As a** visitor\n**I want** to sign in');
		assert.strictEqual(
			value(prompt, 'ancestors'),
			`- \`EP-1\` Authentication — \`${TRACKER}/EP-1-Authentication/Epic.mdx\``
		);
		assert.strictEqual(
			value(prompt, 'children'),
			[
				`- \`${ac}\` Wrong password error — \`${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email/AC-1.1.1-Wrong_password_error/AC.mdx\``,
				`  - \`${testCase}\` Unknown email same error — \`${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email/AC-1.1.1-Wrong_password_error/TC-1.1.1.1-Unknown_email_same_error/TestCase.mdx\``,
				// Ordinals count per type within a parent, so the story's own test case is TC-1.1.1.
				`- \`${storyTest}\` Smoke login — \`${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email/${storyTest}-Smoke_login/TestCase.mdx\``
			].join('\n')
		);
		assert.strictEqual(storyTest, 'TC-1.1.1');
		assert.ok(value(prompt, 'designs').startsWith('- `ERD-1` Account model ('), value(prompt, 'designs'));
		assert.ok(value(prompt, 'designs').includes(`on \`${story}\`) — \`${TRACKER}/EP-1-Authentication/ST-1.1-Sign_in_with_email/ERD-1-Account_model.mdx\``));
		assert.strictEqual(value(prompt, 'testCommand'), TEST_COMMAND_UNSET);
		assert.strictEqual(value(prompt, 'rules'), 'Think first.\nThen code.');
	});

	test('an epic lists two levels — its stories and what sits directly under them', async () => {
		const { prompt } = await buildImplementPrompt(deps, epic);
		assert.strictEqual(value(prompt, 'ancestors'), NONE);
		assert.strictEqual(value(prompt, 'description'), '(empty)');
		const children = value(prompt, 'children');
		assert.ok(children.includes(`- \`${story}\` Sign in with email`));
		assert.ok(children.includes(`  - \`${ac}\` Wrong password error`));
		// A story's own test case sits directly under it, so it is at the second level too…
		assert.ok(children.includes(`  - \`${storyTest}\` Smoke login`));
		// …while a criterion's test case is three levels down and is not listed.
		assert.ok(!children.includes(`\`${testCase}\``), 'a criterion’s test case is three levels down');
	});

	test('a test case names its criterion, its story and its epic, and the test command substituted for it', async () => {
		tests = { command: 'npm test -- --grep {{id}} {{key}}' };
		const { prompt } = await buildImplementPrompt(deps, testCase);
		assert.strictEqual(value(prompt, 'type'), 'test case');
		assert.strictEqual(value(prompt, 'children'), NONE);
		assert.deepStrictEqual(
			value(prompt, 'ancestors').split('\n').map((line) => line.slice(0, line.indexOf('`', 3) + 1)),
			['- `EP-1`', `- \`${story}\``, `- \`${ac}\``]
		);
		assert.strictEqual(value(prompt, 'testCommand'), `npm test -- --grep ${testCase} TC-1`);

		// Any other ticket gets the template as configured, tokens and all.
		const above = await buildImplementPrompt(deps, ac);
		assert.strictEqual(value(above.prompt, 'type'), 'acceptance criterion');
		assert.strictEqual(value(above.prompt, 'testCommand'), 'npm test -- --grep {{id}} {{key}}');
	});

	test('design documents on an ancestor are listed too, with the ticket they sit on', async () => {
		await designs.create(epic, 'sequence-diagram', 'Password reset');
		const { prompt } = await buildImplementPrompt(deps, ac);
		assert.ok(value(prompt, 'designs').includes(`\`SEQ-1\` Password reset (`));
		assert.ok(value(prompt, 'designs').includes(`on \`${epic}\``));
	});

	test('no workspace or no tracker is not-configured; a vanished ticket is reported', async () => {
		workspaceFolder = undefined;
		await assert.rejects(buildImplementPrompt(deps, story), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'not-configured');
			return true;
		});
		workspaceFolder = WORKSPACE;
		await assert.rejects(buildImplementPrompt(deps, 'ST-9.9'), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'provider-error');
			assert.ok(error.message.includes('ST-9.9'));
			return true;
		});
	});

	test('implementTicket writes the prompt to the handoff file, hands the agent the sentence, and writes nothing into the ticket', async () => {
		const folder = (await store.folderUri(story))!;
		const before = await Promise.all(
			['history.md', 'metadata.yaml', 'Story.mdx'].map(async (name) =>
				new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name)))
			)
		);

		const agent = new FakeCodingAgent();
		const handoffs = recordingHandoffs();
		const ui = recordingUi();
		await implementTicket(services(agent, handoffs.writeHandoff), story, ui.ui);

		// The file carries the rendered prompt; the agent gets one sentence naming it.
		assert.strictEqual(handoffs.written.length, 1);
		assert.strictEqual(handoffs.written[0][0], story);
		assert.strictEqual(value(handoffs.written[0][1], 'title'), 'Sign in with email');
		assert.deepStrictEqual(agent.requests, [
			{
				ticketId: story,
				handoffPath: handoffPath(story),
				message: handoffSentence(handoffPath(story))
			}
		]);
		assert.ok(!agent.requests[0].message.includes('Sign in with email'));
		assert.deepStrictEqual(ui.errors, [], 'nothing on success');

		const after = await Promise.all(
			['history.md', 'metadata.yaml', 'Story.mdx'].map(async (name) =>
				new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name)))
			)
		);
		assert.deepStrictEqual(after, before);
	});

	test('a missing extension offers the Marketplace; a failed handoff offers the prompt', async () => {
		const missing = new FakeCodingAgent({
			availability: { ok: false, reason: 'not-installed', message: 'Not here.' },
			extensionId: 'anthropic.claude-code'
		});
		const first = recordingUi('Show in Marketplace');
		const firstHandoffs = recordingHandoffs();
		await implementTicket(services(missing, firstHandoffs.writeHandoff), story, first.ui);
		assert.deepStrictEqual(first.errors, [['Not here.', 'Show in Marketplace']]);
		assert.deepStrictEqual(first.marketplace, ['anthropic.claude-code']);
		assert.strictEqual(missing.requests.length, 0, 'no prompt is built for an agent that is not there');
		assert.strictEqual(firstHandoffs.written.length, 0, 'and no file is written');

		const refusing = new FakeCodingAgent({
			failWith: new ImplementError('unsupported', 'Renamed.')
		});
		const second = recordingUi('Copy Prompt');
		await implementTicket(services(refusing, recordingHandoffs().writeHandoff), story, second.ui);
		assert.deepStrictEqual(second.errors, [['Renamed.', 'Copy Prompt']]);
		// What is copied is the prompt itself, not the sentence.
		assert.strictEqual(second.copied.length, 1);
		assert.strictEqual(value(second.copied[0], 'id'), story);

		// A write failure is reported the same way: the prompt exists, only the file did not land.
		const fine = new FakeCodingAgent();
		const third = recordingUi('Copy Prompt');
		await implementTicket(
			services(fine, async () => {
				throw new Error('disk full');
			}),
			story,
			third.ui
		);
		assert.deepStrictEqual(third.errors, [['disk full', 'Copy Prompt']]);
		assert.strictEqual(fine.requests.length, 0, 'nothing is handed over without the file');

		const comingSoon = new FakeCodingAgent({
			availability: { ok: false, reason: 'not-implemented', message: 'Soon.' }
		});
		const fourth = recordingUi('Open Settings');
		await implementTicket(services(comingSoon, recordingHandoffs().writeHandoff), story, fourth.ui);
		assert.deepStrictEqual(fourth.errors, [['Soon.', 'Open Settings']]);
		assert.strictEqual(fourth.settingsOpened, 1);
	});

	function services(agent: FakeCodingAgent, writeHandoff: ImplementServices['writeHandoff']): ImplementServices {
		return { agent, writeHandoff, buildPrompt: (id) => buildImplementPrompt(deps, id) };
	}
});

/** A handoff writer that records rather than writes, answering the path the store would. */
function recordingHandoffs() {
	const written: [string, string][] = [];
	return {
		written,
		writeHandoff: async (ticketId: string, prompt: string) => {
			written.push([ticketId, prompt]);
			return handoffPath(ticketId);
		}
	};
}

function recordingUi(choice?: string) {
	const errors: string[][] = [];
	const copied: string[] = [];
	const marketplace: string[] = [];
	let settingsOpened = 0;
	const ui: ImplementUi = {
		error: async (message, ...actions) => {
			errors.push([message, ...actions]);
			return choice;
		},
		info: () => undefined,
		openSettings: () => {
			settingsOpened += 1;
		},
		showInMarketplace: (id) => {
			marketplace.push(id);
		},
		copy: async (text) => {
			copied.push(text);
		}
	};
	return {
		ui,
		errors,
		copied,
		marketplace,
		get settingsOpened() {
			return settingsOpened;
		}
	};
}
