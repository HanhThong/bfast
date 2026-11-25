import * as assert from 'assert';
import {
	CLAUDE_CODE_EXTENSION_ID,
	CLAUDE_CODE_OPEN_COMMAND,
	ClaudeCodeAgent,
	type ClaudeCodeDeps
} from '../implement/claudeCodeAgent';
import { ImplementError, type ImplementRequest } from '../implement/codingAgent';
import { handoffPath, handoffSentence } from '../implement/implementPrompt';

interface Script {
	installed?: boolean;
	active?: boolean;
	commands?: string[];
	activateFails?: boolean;
	executeFails?: boolean;
}

function makeDeps(script: Script = {}) {
	const calls: unknown[][] = [];
	let activated = 0;
	let active = script.active ?? true;
	const deps: ClaudeCodeDeps = {
		getExtension: (id) => {
			assert.strictEqual(id, CLAUDE_CODE_EXTENSION_ID);
			if (script.installed === false) {
				return undefined;
			}
			return {
				get isActive() {
					return active;
				},
				activate: async () => {
					activated += 1;
					if (script.activateFails) {
						throw new Error('boom');
					}
					active = true;
				}
			};
		},
		getCommands: async () => script.commands ?? [CLAUDE_CODE_OPEN_COMMAND, 'workbench.action.files.save'],
		executeCommand: async (...args) => {
			calls.push(args);
			if (script.executeFails) {
				throw new Error('the extension said no');
			}
		}
	};
	return { deps, calls, activated: () => activated };
}

const PATH = handoffPath('ST-1.2');
const REQUEST: ImplementRequest = { ticketId: 'ST-1.2', handoffPath: PATH, message: handoffSentence(PATH) };

suite('Claude Code agent (the extension)', () => {
	test('is the default agent and names its extension', () => {
		const agent = new ClaudeCodeAgent(makeDeps().deps);
		assert.strictEqual(agent.id, 'claude-code');
		assert.strictEqual(agent.extensionId, 'anthropic.claude-code');
	});

	test('a missing extension is not-installed, and open refuses with the same code', async () => {
		const { deps, calls } = makeDeps({ installed: false });
		const agent = new ClaudeCodeAgent(deps);
		const availability = await agent.availability();
		assert.strictEqual(availability.ok, false);
		assert.strictEqual(availability.reason, 'not-installed');
		assert.ok(availability.message?.includes(CLAUDE_CODE_EXTENSION_ID));

		await assert.rejects(agent.open(REQUEST), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'not-installed');
			return true;
		});
		assert.deepStrictEqual(calls, []);
	});

	test('an inactive extension is activated first, once', async () => {
		const { deps, activated } = makeDeps({ active: false });
		const agent = new ClaudeCodeAgent(deps);
		assert.deepStrictEqual(await agent.availability(), { ok: true });
		assert.strictEqual(activated(), 1);
		// Active now, so a second ask activates nothing.
		assert.deepStrictEqual(await agent.availability(), { ok: true });
		assert.strictEqual(activated(), 1);
	});

	test('an activation failure is a provider error', async () => {
		const { deps } = makeDeps({ active: false, activateFails: true });
		const availability = await new ClaudeCodeAgent(deps).availability();
		assert.strictEqual(availability.reason, 'provider-error');
		assert.ok(availability.message?.includes('boom'));
	});

	test('an extension that no longer offers the command is unsupported, naming the command', async () => {
		const { deps } = makeDeps({ commands: ['claude-vscode.sidebar.open'] });
		const availability = await new ClaudeCodeAgent(deps).availability();
		assert.strictEqual(availability.reason, 'unsupported');
		assert.ok(availability.message?.includes(CLAUDE_CODE_OPEN_COMMAND));
	});

	test('open hands the command exactly (undefined session, the sentence) — the session-id trap', async () => {
		const { deps, calls } = makeDeps();
		await new ClaudeCodeAgent(deps).open(REQUEST);
		assert.deepStrictEqual(calls, [[CLAUDE_CODE_OPEN_COMMAND, undefined, REQUEST.message]]);
		// The same string the CLI route types, and never the prompt's own text.
		assert.strictEqual(
			REQUEST.message,
			'Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says.'
		);
	});

	test('a rejected command is a provider error carrying the extension’s message', async () => {
		const { deps } = makeDeps({ executeFails: true });
		await assert.rejects(new ClaudeCodeAgent(deps).open(REQUEST), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'provider-error');
			assert.ok(error.message.includes('the extension said no'));
			return true;
		});
	});
});
