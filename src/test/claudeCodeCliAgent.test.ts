import * as assert from 'assert';
import {
	CLAUDE_CLI,
	ClaudeCodeCliAgent,
	claudeCliHandoffLine,
	type ClaudeCodeCliDeps,
	type HandoffTerminal
} from '../implement/claudeCodeCliAgent';
import { ImplementError, type CodingAgentContext, type ImplementRequest } from '../implement/codingAgent';
import { handoffPath, handoffSentence } from '../implement/implementPrompt';
import { FakeProcessRunner, type FakeProcessOptions } from './fakeProcessRunner';

const PATH = handoffPath('ST-1.2');
const REQUEST: ImplementRequest = {
	ticketId: 'ST-1.2',
	handoffPath: PATH,
	message: handoffSentence(PATH)
};

function makeAgent(options: { runner?: FakeProcessOptions; workspace?: string | undefined } = {}) {
	const runner = new FakeProcessRunner(options.runner);
	const terminals: HandoffTerminal[] = [];
	const deps: ClaudeCodeCliDeps = {
		runner: runner.runner,
		openTerminal: (terminal) => terminals.push(terminal)
	};
	const context: CodingAgentContext = {
		settings: () => ({ agent: 'claude-code-cli' }),
		workspaceFolder: () => ('workspace' in options ? options.workspace : '/ws')
	};
	return { agent: new ClaudeCodeCliAgent(context, deps), runner, terminals };
}

suite('Claude Code CLI agent', () => {
	test('the line is the handoff sentence as claude’s positional prompt, and nothing else', () => {
		assert.strictEqual(
			claudeCliHandoffLine(REQUEST.message),
			'claude "Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says."'
		);
		// A duplicate's rank is written as `_`, which is inside the alphabet.
		assert.ok(claudeCliHandoffLine(handoffSentence(handoffPath('ST-1#2.1'))).includes('prompts/ST-1_2.1.md'));
		assert.strictEqual(CLAUDE_CLI, 'claude');
	});

	test('a sentence outside the alphabet is refused, never quoted', () => {
		for (const message of ['Your task; rm -rf /', 'a "quoted" word', 'a $var', 'a `tick`', 'line\nbreak']) {
			assert.throws(() => claudeCliHandoffLine(message), (error: unknown) => {
				assert.ok(error instanceof ImplementError);
				assert.strictEqual(error.code, 'provider-error');
				return true;
			}, message);
		}
	});

	test('no workspace folder is not-configured, and no probe runs', async () => {
		const { agent, runner } = makeAgent({ workspace: undefined });
		const availability = await agent.availability();
		assert.strictEqual(availability.reason, 'not-configured');
		assert.strictEqual(runner.requests.length, 0);
	});

	test('probes `claude --version` through the platform shell, in the workspace', async () => {
		const { agent, runner } = makeAgent();
		assert.deepStrictEqual(await agent.availability(), { ok: true });
		assert.strictEqual(runner.requests.length, 1);
		const [request] = runner.requests;
		assert.ok(request.args.join(' ').includes('claude --version'), request.args.join(' '));
		assert.strictEqual(request.cwd, '/ws');
		// Through the shell, so a `.cmd` shim resolves as it would in a terminal.
		assert.notStrictEqual(request.executable, 'claude');
	});

	test('a pass is remembered for the window; a failure is asked again', async () => {
		const passing = makeAgent();
		await passing.agent.availability();
		await passing.agent.availability();
		assert.strictEqual(passing.runner.requests.length, 1);

		const missing = makeAgent({ runner: { missingAt: [0] } });
		const first = await missing.agent.availability();
		assert.strictEqual(first.reason, 'not-installed');
		assert.ok(first.message?.includes('PATH'));
		assert.deepStrictEqual(await missing.agent.availability(), { ok: true });
		assert.strictEqual(missing.runner.requests.length, 2);

		const failing = makeAgent({ runner: { failAt: [0] } });
		assert.strictEqual((await failing.agent.availability()).reason, 'not-installed');
	});

	test('open opens a terminal in the workspace with the line typed', async () => {
		const { agent, terminals } = makeAgent();
		await agent.open(REQUEST);

		assert.deepStrictEqual(terminals, [
			{
				name: 'Claude Code — ST-1.2',
				cwd: '/ws',
				line: 'claude "Your task is in .bfast/implement/prompts/ST-1.2.md. Read that file first, then do what it says."'
			}
		]);
	});

	test('open refuses when the CLI is missing, and opens nothing', async () => {
		const { agent, terminals } = makeAgent({ runner: { missingAt: [0] } });
		await assert.rejects(agent.open(REQUEST), (error: unknown) => {
			assert.ok(error instanceof ImplementError);
			assert.strictEqual(error.code, 'not-installed');
			return true;
		});
		assert.deepStrictEqual(terminals, []);
	});
});
