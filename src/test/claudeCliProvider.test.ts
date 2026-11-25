// The CLI provider against a real child process.
//
// Separate from `aiProvider.test.ts`, which is deliberately about the pure
// mapping and a stubbed SDK: this is the one suite that spawns. It drives a
// fake agent through the `AgentSpawner` seam — `spawnAgent` builds the argv
// itself, since the allow-list and `--restricted` are policy, so there is no
// other way to point a run at anything but a real `claude`.

import * as assert from 'assert';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { AiCancelledError, AiError, type AiRequest } from '../ai/aiProvider';
import { ClaudeCliProvider, agentArguments, type AgentSpawner } from '../ai/claudeCliProvider';

const ticket = {
	id: 'EP-1',
	type: 'epic' as const,
	title: 'Auth',
	status: 'todo' as const,
	description: ''
};

/**
 * The test host is Electron, so `process.execPath` is VS Code itself;
 * `ELECTRON_RUN_AS_NODE` turns it back into a plain node — the same trick
 * `runProcess.test.ts` uses, and it needs no `node` on the PATH.
 */
function fakeAgent(script: string): AgentSpawner {
	return (): ChildProcessWithoutNullStreams =>
		spawn(process.execPath, ['-e', script], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			shell: false,
			windowsHide: true
		});
}

/** A stub `AiContext`; nothing here reads settings or credentials for real. */
const context = {
	workingDirectory: () => process.cwd(),
	credentials: () => Promise.resolve({}),
	settings: () => undefined
};

function provider(script: string): ClaudeCliProvider {
	return new ClaudeCliProvider(context as never, fakeAgent(script));
}

function request(extra?: Partial<AiRequest>): AiRequest {
	return { instruction: '', prompt: 'p', ticket, ...extra };
}

/** One line of `stream-json`, as the fake agent would print it. */
function line(value: unknown): string {
	return JSON.stringify(JSON.stringify(value) + '\n');
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => assert.fail('should have rejected'),
		(failure: unknown) => failure
	);

suite('BFAST Claude CLI provider', () => {
	// The spawner seam never takes an argv, so this is the only place the flags
	// a run gets can be read back.
	test('the argv carries the policy flags, and a resumed run adds only --resume', () => {
		const fresh = agentArguments(request());
		assert.ok(fresh.includes('-p'));
		assert.ok(fresh.includes('--restricted'));
		assert.ok(fresh.includes('--strict-mcp-config'));
		const tools = fresh.indexOf('--allowedTools');
		assert.deepStrictEqual(fresh.slice(tools + 1, tools + 4), ['Read', 'Glob', 'Grep']);
		assert.ok(!fresh.includes('--resume'));
		// Left at its default: a session that is not kept cannot be resumed.
		assert.ok(!fresh.includes('--no-session-persistence'));

		assert.deepStrictEqual(agentArguments(request({ resumeSessionId: 's1' })), [
			...fresh,
			'--resume',
			's1'
		]);
		// Deny rather than ask — a headless child has nowhere to answer.
		assert.deepStrictEqual(fresh.slice(fresh.indexOf('--permission-mode'), fresh.indexOf('--permission-mode') + 2), [
			'--permission-mode',
			'dontAsk'
		]);
		// And nothing about editing unless the request asked.
		assert.ok(!fresh.includes('--tools'));
		assert.ok(!fresh.includes('--settings'));
	});

	// A picked model is one flag, and it sits before `--resume` so a continued
	// conversation is answered by the model the user chose this time.
	test('a model rides as --model, before --resume', () => {
		const fresh = agentArguments(request());
		assert.ok(!fresh.includes('--model'));
		assert.deepStrictEqual(agentArguments(request({ model: 'sonnet' })), [...fresh, '--model', 'sonnet']);
		assert.deepStrictEqual(agentArguments(request({ model: 'sonnet', resumeSessionId: 's1' })), [
			...fresh,
			'--model',
			'sonnet',
			'--resume',
			's1'
		]);
	});

	// A board run that may edit other tickets: the closed tool set and the
	// settings file, after the read-only allow-list — never in place of it.
	test('a run with edits adds the tool set and the settings file, and refuses any other tool', () => {
		const argv = agentArguments(
			request({ edits: { settingsFile: '/tmp/bfast-run.json', tools: ['Read', 'Glob', 'Grep', 'Edit'] } })
		);
		const tools = argv.indexOf('--allowedTools');
		assert.deepStrictEqual(argv.slice(tools + 1, tools + 4), ['Read', 'Glob', 'Grep']);
		assert.deepStrictEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), [
			'--tools',
			'Read,Glob,Grep,Edit'
		]);
		assert.deepStrictEqual(argv.slice(argv.indexOf('--settings'), argv.indexOf('--settings') + 2), [
			'--settings',
			'/tmp/bfast-run.json'
		]);
		assert.ok(!argv.includes('Write') && !argv.includes('Bash'));

		for (const tool of ['Write', 'Bash', 'NotebookEdit']) {
			assert.throws(
				() => agentArguments(request({ edits: { settingsFile: '/tmp/x.json', tools: ['Read', tool] } })),
				new RegExp(tool)
			);
		}
	});

	// The regression the whole change exists for. Under the old wall-clock timer
	// this run — streaming its heartbeat the entire time — was killed anyway.
	test('a run that keeps talking outlives the idle window', async () => {
		const heartbeat = line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1 });
		const answer = line({ type: 'result', subtype: 'success', result: 'the description' });

		const run = provider(
			`let n = 0; const t = setInterval(() => { process.stdout.write(${heartbeat}); ` +
				`if (++n === 20) { clearInterval(t); process.stdout.write(${answer}); process.exit(0); } }, 20);`
		).run(request({ idleTimeoutMs: 120 }));

		assert.strictEqual((await run.completed).text, 'the description');
	});

	test('a run that goes quiet is stopped, and says so', async () => {
		const init = line({ type: 'system', subtype: 'init', model: 'm' });
		const run = provider(
			`process.stdout.write(${init}); setTimeout(() => undefined, 60000);`
		).run(request({ idleTimeoutMs: 150 }));

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiError);
		assert.strictEqual(error.code, 'timeout');
		assert.ok(error.message.includes('sent nothing'));
	});

	// The one case a watchdog armed by the first sign of life would wait on for
	// ever, which is why it is armed at construction instead.
	test('a run that never says anything at all is stopped', async () => {
		const run = provider('setTimeout(() => undefined, 60000);').run(
			request({ idleTimeoutMs: 150 })
		);

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiError);
		assert.strictEqual(error.code, 'timeout');
	});

	test('cancel rejects with the reason and is idempotent', async () => {
		const run = provider('setTimeout(() => undefined, 60000);').run(request());
		run.cancel('enough');
		run.cancel('twice is fine');

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiCancelledError);
		assert.strictEqual(error.message, 'enough');
	});

	// `kill()` reaches only the direct child, and `claude` spawns children of its
	// own; on Windows those keep the inherited pipes open and `close` never
	// fires. Without the tree-kill and the settle fallback the board's Stop
	// button would do nothing visible at all.
	test('stop settles even when a grandchild is holding the pipes', async function () {
		this.timeout(20_000);

		const init = line({ type: 'system', subtype: 'init', model: 'm' });
		const run = provider(
			"const { spawn } = require('child_process');" +
				"spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], " +
				"{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });" +
				`process.stdout.write(${init}); setTimeout(() => undefined, 60000);`
		).run(request());

		// After the child has certainly spawned its own, so the kill has a tree to
		// deal with rather than a single process.
		await new Promise((resolve) => setTimeout(resolve, 400));
		run.cancel('enough');

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiCancelledError);
	});

	test('a stream that never answered reports the diagnostic, not a hang', async () => {
		const run = provider(
			// Two writes rather than one with an escape: the summary takes the *last*
			// line, because a CLI puts its actual complaint at the end.
			"process.stderr.write('first' + String.fromCharCode(10) + 'the actual complaint');" +
				'process.exit(3);'
		).run(request());

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiError);
		assert.strictEqual(error.code, 'provider-error');
		assert.ok(error.message.includes('the actual complaint'));
	});

	test('dispose stops what is still in flight', async () => {
		const cli = provider('setTimeout(() => undefined, 60000);');
		const run = cli.run(request());
		cli.dispose();

		const error = await rejection(run.completed);
		assert.ok(error instanceof AiCancelledError);
	});
});
