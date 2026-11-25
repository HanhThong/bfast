import * as assert from 'assert';
import { AiError, type AiProgress } from '../ai/aiProvider';
import { ClaudeAgentSdkProvider } from '../ai/claudeAgentSdkProvider';
import { ALLOWED_TOOLS } from '../ai/claudeCliProvider';
import {
	AgentStream,
	LineBuffer,
	parseAgentMessage,
	type AgentMessage
} from '../ai/messageStream';
import { FakeAiProvider } from './fakeAiProvider';

/** The shapes a real `stream-json` run emits, in the order it emits them. */
function assistant(...blocks: unknown[]): AgentMessage {
	return { type: 'assistant', message: { content: blocks } };
}

function feed(messages: AgentMessage[]) {
	const stream = new AgentStream();
	const progress: string[] = [];
	for (const message of messages) {
		stream.accept(message, (event) =>
			progress.push(event.kind === 'tool' ? `tool:${event.name}` : event.kind)
		);
	}
	return { stream, progress };
}

suite('BFAST AI message stream', () => {
	test('accumulates assistant text in order and reports the result', () => {
		const { stream, progress } = feed([
			{ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' },
			assistant({ type: 'thinking', thinking: 'ignored' }),
			assistant({ type: 'text', text: 'first ' }),
			assistant({ type: 'tool_use', name: 'Read' }),
			assistant({ type: 'text', text: 'second' }),
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'the description',
				num_turns: 3,
				total_cost_usd: 0.25
			}
		]);

		const result = stream.result();
		assert.strictEqual(result.text, 'the description');
		assert.deepStrictEqual(result.meta, {
			model: 'claude-opus-5',
			sessionId: 's1',
			turns: 3,
			costUsd: 0.25
		});
		assert.deepStrictEqual(progress, ['started', 'thinking', 'text', 'tool:Read', 'text']);
	});

	// The heartbeat. Without these a long run is indistinguishable from a hung
	// one, which is the whole reason they are surfaced.
	test('reports thinking as both a running counter and completed blocks', () => {
		const stream = new AgentStream();
		const seen: string[] = [];
		const record = (event: { kind: string; text?: string; tokens?: number; detail?: string }) =>
			seen.push(`${event.kind}:${event.text ?? event.detail ?? event.tokens ?? ''}`);

		for (const message of [
			{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 128 },
			{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 512 },
			assistant({ type: 'thinking', thinking: '  Let me read the store.  ' }),
			assistant({ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }),
			assistant({ type: 'tool_use', name: 'Grep', input: { pattern: 'TicketWriter' } }),
			assistant({ type: 'tool_use', name: 'Mystery', input: { unknown: 1 } }),
			{ type: 'result', subtype: 'success', result: 'done' }
		]) {
			stream.accept(message, record);
		}

		assert.deepStrictEqual(seen, [
			'thinking:128',
			'thinking:512',
			'thinking:Let me read the store.',
			'tool:src/a.ts',
			'tool:TicketWriter',
			'tool:'
		]);
		// Reasoning is never part of the answer.
		assert.strictEqual(stream.result().text, 'done');
	});

	test('an empty thinking block is not reported at all', () => {
		const { progress } = feed([
			assistant({ type: 'thinking', thinking: '   ' }),
			{ type: 'result', subtype: 'success', result: 'x' }
		]);
		assert.deepStrictEqual(progress, []);
	});

	test('falls back to the accumulated text when result is empty', () => {
		const { stream } = feed([
			assistant({ type: 'text', text: 'from the blocks' }),
			{ type: 'result', subtype: 'success', result: '   ' }
		]);
		assert.strictEqual(stream.result().text, 'from the blocks');
	});

	test('an error subtype becomes a provider-error', () => {
		const { stream } = feed([{ type: 'result', subtype: 'error_max_turns' }]);
		assert.throws(
			() => stream.result(),
			(error: unknown) => error instanceof AiError && error.code === 'provider-error'
		);
	});

	test('is_error on a success subtype is still a failure', () => {
		const { stream } = feed([{ type: 'result', subtype: 'success', is_error: true, result: 'x' }]);
		assert.throws(() => stream.result(), AiError);
	});

	test('a stream that never answered is a failure, not a hang', () => {
		const { stream } = feed([assistant({ type: 'text', text: 'thinking out loud' })]);
		assert.strictEqual(stream.done, false);
		assert.throws(
			() => stream.result(),
			(error: unknown) => error instanceof AiError && error.code === 'provider-error'
		);
	});

	test('an answer of nothing at all is empty-result', () => {
		const { stream } = feed([{ type: 'result', subtype: 'success', result: '' }]);
		assert.throws(
			() => stream.result(),
			(error: unknown) => error instanceof AiError && error.code === 'empty-result'
		);
	});

	// These messages come from a program that ships on its own schedule, so
	// anything unrecognised has to be ignored rather than throw.
	test('ignores unknown message types, subtypes and blocks', () => {
		const { stream, progress } = feed([
			{ type: 'rate_limit_event' },
			{ type: 'system', subtype: 'a_subtype_from_the_future' },
			{ type: 'brand_new_kind', payload: { nested: true } },
			assistant({ type: 'something_new' }, { type: 'text' }),
			{ type: 'result', subtype: 'success', result: 'fine' }
		]);
		assert.strictEqual(stream.result().text, 'fine');
		assert.deepStrictEqual(progress, []);
	});
});

suite('BFAST AI line buffer', () => {
	test('holds a partial line back until its newline arrives', () => {
		const buffer = new LineBuffer();
		assert.deepStrictEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
		assert.deepStrictEqual(buffer.push('":2}\n'), ['{"b":2}']);
		assert.deepStrictEqual(buffer.push(''), []);
		assert.deepStrictEqual(buffer.flush(), []);
	});

	test('a final line with no newline still comes out of flush', () => {
		const buffer = new LineBuffer();
		assert.deepStrictEqual(buffer.push('{"a":1}'), []);
		assert.deepStrictEqual(buffer.flush(), ['{"a":1}']);
	});

	test('a line that is not json is dropped rather than throwing', () => {
		assert.strictEqual(parseAgentMessage('warning: something'), undefined);
		assert.strictEqual(parseAgentMessage('"a string"'), undefined);
		assert.strictEqual(parseAgentMessage('null'), undefined);
		assert.deepStrictEqual(parseAgentMessage('{"type":"result"}'), { type: 'result' });
	});
});

suite('BFAST AI tool policy', () => {
	// `--restricted` removes the code-running tools, but this list is what
	// actually decides what a run may do. If someone ever adds `Bash` or `Write`
	// here, the AI button becomes arbitrary code execution driven by a
	// description that may have arrived in a `git pull` — so it gets a test,
	// not just a comment.
	test('a run may only read', () => {
		assert.deepStrictEqual([...ALLOWED_TOOLS], ['Read', 'Glob', 'Grep']);
	});
});

suite('BFAST agent stream — tool events', () => {
	function collect(messages: Record<string, unknown>[]) {
		const stream = new AgentStream();
		const progress: AiProgress[] = [];
		for (const message of messages) {
			stream.accept(message, (event) => progress.push(event));
		}
		return { stream, progress };
	}

	// Adoption needs the raw facts, not the display string: which file, what
	// replaced what, and — from the result — whether it happened.
	test('a tool call carries its id, file and edit, and its result says whether it happened', () => {
		const { progress } = collect([
			{
				type: 'assistant',
				message: {
					content: [
						{
							type: 'tool_use',
							id: 'toolu_1',
							name: 'Edit',
							input: { file_path: '/ws/.tracker/EP-1/Epic.mdx', old_string: 'a', new_string: 'b' }
						}
					]
				}
			},
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'denied' }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2' }] } }
		]);

		assert.deepStrictEqual(progress, [
			{
				kind: 'tool',
				name: 'Edit',
				detail: '/ws/.tracker/EP-1/Epic.mdx',
				id: 'toolu_1',
				filePath: '/ws/.tracker/EP-1/Epic.mdx',
				edit: { oldString: 'a', newString: 'b', replaceAll: false }
			},
			{ kind: 'tool-result', id: 'toolu_1', error: true },
			{ kind: 'tool-result', id: 'toolu_2', error: false }
		]);
	});

	test('a denial is surfaced as it happens and recorded on the result', () => {
		const { stream, progress } = collect([
			{ type: 'system', subtype: 'permission_denied', tool_name: 'Edit', decision_reason: 'mode' },
			{
				type: 'result',
				subtype: 'success',
				result: 'done',
				permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: '/ws/.tracker/EP-1/metadata.yaml' } }]
			}
		]);
		assert.deepStrictEqual(progress[0], { kind: 'denied', tool: 'Edit', reason: 'mode' });
		assert.deepStrictEqual(stream.result().meta?.denials, [
			{ tool: 'Edit', filePath: '/ws/.tracker/EP-1/metadata.yaml' }
		]);
	});

	test('a result with no denials records none', () => {
		const { stream } = collect([{ type: 'result', subtype: 'success', result: 'done' }]);
		assert.strictEqual(stream.result().meta?.denials, undefined);
	});
});

suite('BFAST fake AI provider', () => {
	test('satisfies AiProvider without knowing anything about templates', async () => {
		const provider = new FakeAiProvider({ answer: 'written' });
		assert.deepStrictEqual(await provider.availability(), { ok: true });

		const run = provider.run({
			instruction: '',
			prompt: 'do it',
			ticket: { id: 'EP-1', type: 'epic', title: 'Auth', status: 'todo', description: '' }
		});

		assert.strictEqual((await run.completed).text, 'written');
		assert.strictEqual(provider.requests[0].prompt, 'do it');
	});

	test('a hanging run settles only when the test says so', async () => {
		const provider = new FakeAiProvider({ hang: true });
		const run = provider.run({
			instruction: '',
			prompt: 'p',
			ticket: { id: 'EP-1', type: 'epic', title: 'Auth', status: 'todo', description: '' }
		});

		assert.ok(provider.pending, 'the run should still be live');
		run.cancel('closed');
		await assert.rejects(run.completed, { name: 'AiCancelledError' });

		// Cancelling twice, or after it settled, is a no-op.
		run.cancel();
		assert.strictEqual(provider.pending, undefined);
	});

	test('dispose cancels what is still in flight', async () => {
		const provider = new FakeAiProvider({ hang: true });
		const run = provider.run({
			instruction: '',
			prompt: 'p',
			ticket: { id: 'EP-1', type: 'epic', title: 'Auth', status: 'todo', description: '' }
		});

		provider.dispose();
		assert.strictEqual(provider.cancelled, 1);
		await assert.rejects(run.completed, { name: 'AiCancelledError' });
	});
});

suite('BFAST Claude Agent SDK provider', () => {
	const ticket = {
		id: 'EP-1',
		type: 'epic' as const,
		title: 'Auth',
		status: 'todo' as const,
		description: ''
	};

	/** A stub `AiContext`; nothing here touches `vscode` or the real SDK. */
	function context(credentials: { apiKey?: string; oauthToken?: string } = { apiKey: 'k' }) {
		return {
			workingDirectory: () => 'd:/work',
			credentials: () => Promise.resolve(credentials),
			settings: () => undefined
		};
	}

	/**
		 * Stands in for the SDK module, recording the options it was handed.
		 *
		 * `gapMs` spaces the messages out, which is what lets a test tell an idle
		 * window from a wall-clock one: the same stream, run slowly, must still
		 * finish. `stallAfter` then stops yielding entirely, which is a hang.
		 */
	function stubSdk(
		messages: AgentMessage[],
		pace?: { gapMs?: number; stallAfter?: number }
	) {
		const seen: { options?: Record<string, unknown> } = {};
		let loads = 0;
		const load = () => {
			loads += 1;
			return Promise.resolve({
				query: ({ options }: { options?: unknown }) => {
					seen.options = options as Record<string, unknown>;
					return (async function* () {
						for (const [index, message] of messages.entries()) {
							if (pace?.gapMs) {
								await new Promise((resolve) => setTimeout(resolve, pace.gapMs));
							}
							yield message;
							if (pace?.stallAfter !== undefined && index + 1 >= pace.stallAfter) {
								await new Promise(() => undefined);
							}
						}
					})();
				}
			});
		};
		return { seen, load, loads: () => loads };
	}

	function build(sdk: ReturnType<typeof stubSdk>, credentials?: { apiKey?: string }) {
		// The stub is deliberately narrower than the real module, which is the
		// whole point of the loader being injectable.
		return new ClaudeAgentSdkProvider(
			context(credentials) as never,
			sdk.load as never
		);
	}

	// The regression the idle window exists for. Under the old wall-clock timer
	// this stream — busy the whole way, just slow — was killed mid-flight.
	test('a slow but steady stream outlives the idle window', async () => {
		const sdk = stubSdk(
			[
				{ type: 'system', subtype: 'init', model: 'm' },
				{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 10 },
				{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 20 },
				{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 30 },
				{ type: 'result', subtype: 'success', result: 'written slowly' }
			],
			{ gapMs: 40 }
		);

		const run = build(sdk).run({ instruction: '', prompt: 'p', ticket, idleTimeoutMs: 120 });
		assert.strictEqual((await run.completed).text, 'written slowly');
	});

	test('a stream that stalls between messages is stopped as a timeout', async () => {
		const sdk = stubSdk(
			[{ type: 'system', subtype: 'init', model: 'm' }, { type: 'result', subtype: 'success', result: 'never' }],
			{ stallAfter: 1 }
		);

		const run = build(sdk).run({ instruction: '', prompt: 'p', ticket, idleTimeoutMs: 80 });
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof AiError);
		assert.strictEqual(error.code, 'timeout');
		assert.ok(error.message.includes('sent nothing'));
	});

	test('maps the SDK stream the same way the CLI stream is mapped', async () => {
		const sdk = stubSdk([
			{ type: 'system', subtype: 'init', model: 'claude-opus-5' },
			assistant({ type: 'text', text: 'ignored once result arrives' }),
			{ type: 'result', subtype: 'success', result: 'the description', num_turns: 2 }
		]);

		const result = await build(sdk).run({ instruction: '', prompt: 'p', ticket }).completed;
		assert.strictEqual(result.text, 'the description');
		assert.strictEqual(result.meta?.model, 'claude-opus-5');
	});

	// Deny, never ask, and read-only unless the request says otherwise. If
	// someone widens this list, the AI button becomes arbitrary code execution.
	test('never asks for a tool that can write or run anything', async () => {
		const sdk = stubSdk([{ type: 'result', subtype: 'success', result: 'x' }]);
		await build(sdk).run({ instruction: '', prompt: 'p', ticket }).completed;

		assert.deepStrictEqual(sdk.seen.options?.allowedTools, ['Read', 'Glob', 'Grep']);
		// Not `bypassPermissions`: that approves everything whatever the list says.
		assert.strictEqual(sdk.seen.options?.permissionMode, 'dontAsk');
		assert.ok(!('tools' in (sdk.seen.options ?? {})));
		assert.ok(!('settings' in (sdk.seen.options ?? {})));
		// No CLAUDE.md, no user settings, and above all no user hooks.
		assert.deepStrictEqual(sdk.seen.options?.settingSources, []);
	});

	// A board run that may edit other tickets: the closed tool set and the rules
	// file travel as options, the allow-list stays what it was, and the system
	// prompt stops saying "never modify a file".
	test('a run with edits gets Edit, the settings file and a system prompt that allows it', async () => {
		const sdk = stubSdk([{ type: 'result', subtype: 'success', result: 'x' }]);
		await build(sdk).run({
			instruction: '',
			prompt: 'p',
			ticket,
			edits: { settingsFile: '/tmp/bfast-run.json', tools: ['Read', 'Glob', 'Grep', 'Edit'] }
		}).completed;

		assert.deepStrictEqual(sdk.seen.options?.tools, ['Read', 'Glob', 'Grep', 'Edit']);
		assert.strictEqual(sdk.seen.options?.settings, '/tmp/bfast-run.json');
		assert.strictEqual(sdk.seen.options?.permissionMode, 'dontAsk');
		assert.deepStrictEqual(sdk.seen.options?.allowedTools, ['Read', 'Glob', 'Grep']);
		assert.ok(String(sdk.seen.options?.systemPrompt).includes('another'));
		assert.ok(!String(sdk.seen.options?.systemPrompt).includes('Never create, modify or delete'));
	});

	test('a resumed run hands the session to the SDK, and a fresh one does not', async () => {
		const sdk = stubSdk([{ type: 'result', subtype: 'success', result: 'x' }]);
		await build(sdk).run({ instruction: '', prompt: 'p', ticket }).completed;
		assert.ok(!('resume' in (sdk.seen.options ?? {})));
		// Left at its default: a session that is not kept cannot be resumed.
		assert.ok(!('persistSession' in (sdk.seen.options ?? {})));

		await build(sdk).run({ instruction: '', prompt: 'p', ticket, resumeSessionId: 's1' })
			.completed;
		assert.strictEqual(sdk.seen.options?.resume, 's1');
	});

	test('credentials reach the child only through env', async () => {
		const sdk = stubSdk([{ type: 'result', subtype: 'success', result: 'x' }]);
		await build(sdk, { apiKey: 'sk-secret' }).run({ instruction: '', prompt: 'p', ticket })
			.completed;

		const env = sdk.seen.options?.env as Record<string, string>;
		assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-secret');
		assert.notStrictEqual(process.env.ANTHROPIC_API_KEY, 'sk-secret');
	});

	test('a missing credential fails before the module is even loaded', async () => {
		const sdk = stubSdk([]);
		await assert.rejects(
			build(sdk, {}).run({ instruction: '', prompt: 'p', ticket }).completed,
			(error: unknown) => error instanceof AiError && error.code === 'no-credentials'
		);
		assert.strictEqual(sdk.loads(), 0, 'the loader should not have been called');
	});

	test('availability reports why it cannot run', async () => {
		const sdk = stubSdk([]);
		assert.deepStrictEqual(await build(sdk).availability(), { ok: true });

		const noKey = await build(sdk, {}).availability();
		assert.strictEqual(noKey.ok, false);
		assert.strictEqual(noKey.reason, 'no-credentials');
		assert.ok(noKey.message);
	});

	test('cancel rejects with AiCancelledError rather than a half result', async () => {
		const sdk = stubSdk([{ type: 'result', subtype: 'success', result: 'x' }]);
		const run = build(sdk).run({ instruction: '', prompt: 'p', ticket });
		run.cancel('closed');
		await assert.rejects(run.completed, { name: 'AiCancelledError' });
	});
});
