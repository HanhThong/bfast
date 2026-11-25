import * as assert from 'assert';
import { TICKET_STATUSES, TICKET_TYPES } from '../data/types';
import {
	callMcpTool,
	enabledTools,
	McpToolCallError,
	MCP_FUNCTION_DESCRIPTIONS,
	MCP_TOOLS,
	READ_OFF_NOTE,
	toolsOf,
	type McpToolResult
} from '../mcp/mcpTools';
import { MCP_FUNCTION_IDS, type McpFunctionId } from '../settings/mcpSettings';
import { FakeMcpContext } from './fakeMcpContext';

/** The JSON a tool answered with, parsed back. */
function payload(result: McpToolResult): unknown {
	assert.strictEqual(result.content.length, 1);
	assert.strictEqual(result.content[0].type, 'text');
	return JSON.parse(result.content[0].text);
}

const ALL = MCP_FUNCTION_IDS;

suite('MCP tools', () => {
	test('every tool belongs to a real function, and every function carries tools', () => {
		for (const tool of MCP_TOOLS) {
			assert.ok(MCP_FUNCTION_IDS.includes(tool.group), `${tool.name} → ${tool.group}`);
			assert.ok(tool.description.length > 0, tool.name);
			assert.strictEqual(tool.inputSchema.additionalProperties, false, tool.name);
			// Every required argument has to be in `properties`, or a client
			// cannot know what to send.
			for (const required of tool.inputSchema.required ?? []) {
				assert.ok(tool.inputSchema.properties[required], `${tool.name}.${required}`);
			}
		}
		for (const id of MCP_FUNCTION_IDS) {
			assert.ok(toolsOf(id).length > 0, id);
		}
		// The settings tab lists one row per function; a function with no row
		// would be a switch nobody could find.
		assert.deepStrictEqual(
			MCP_FUNCTION_DESCRIPTIONS.map((fn) => fn.id),
			[...MCP_FUNCTION_IDS]
		);
	});

	test('tool names are unique', () => {
		const names = MCP_TOOLS.map((tool) => tool.name);
		assert.strictEqual(new Set(names).size, names.length);
	});

	test('deleting a ticket, a design document or an environment is deliberately not offered', () => {
		// Each takes data with it and there is no undo: a gesture for a person in
		// the sidebar, not for a client over a port. (Removing a *service* from
		// the settings is a line in bfast.json, and git has it.)
		assert.ok(
			!MCP_TOOLS.some((tool) => /(delete|remove|destroy)_(ticket|design|environment)/.test(tool.name))
		);
		assert.ok(!MCP_TOOLS.some((tool) => /delete|destroy/.test(tool.name)));
	});

	test('enabledTools offers exactly the tools of the switched-on functions', () => {
		assert.deepStrictEqual(
			enabledTools([]).map((tool) => tool.name),
			[]
		);
		assert.deepStrictEqual(
			enabledTools(['read']).map((tool) => tool.name),
			['list_tickets', 'get_ticket']
		);
		assert.strictEqual(enabledTools(ALL).length, MCP_TOOLS.length);
	});

	test('a tool whose function is switched off cannot be called', async () => {
		const context = new FakeMcpContext();
		// The rule that makes the switches mean anything: a client that listed
		// `run_tests` a moment before the user switched `tests` off must not be
		// able to call it.
		await assert.rejects(
			() => callMcpTool(context, ['read'], 'run_tests', { id: 'ST-1.1' }),
			(failure: unknown) =>
				failure instanceof McpToolCallError && /tests.*switched off/s.test(failure.message)
		);
		assert.strictEqual(context.calls.length, 0);
	});

	test('an unknown tool is refused before anything is touched', async () => {
		const context = new FakeMcpContext();
		await assert.rejects(
			() => callMcpTool(context, ALL, 'rm_rf', {}),
			(failure: unknown) => failure instanceof McpToolCallError
		);
		assert.strictEqual(context.calls.length, 0);
	});

	test('a missing or wrongly typed argument is a call fault, not a tool failure', async () => {
		const context = new FakeMcpContext();
		for (const args of [{}, { id: '   ' }, { id: 42 }, 'nonsense', []]) {
			await assert.rejects(
				() => callMcpTool(context, ALL, 'get_ticket', args),
				(failure: unknown) => failure instanceof McpToolCallError,
				JSON.stringify(args)
			);
		}
		assert.strictEqual(context.calls.length, 0);
	});

	test('an enum argument only takes the values the schema lists', async () => {
		const context = new FakeMcpContext();
		await assert.rejects(
			() => callMcpTool(context, ALL, 'set_ticket_status', { id: 'ST-1.1', status: 'nearly' }),
			(failure: unknown) => failure instanceof McpToolCallError
		);
		for (const status of TICKET_STATUSES) {
			await callMcpTool(context, ALL, 'set_ticket_status', { id: 'ST-1.1', status });
		}
		for (const type of TICKET_TYPES) {
			await callMcpTool(context, ALL, 'create_ticket', { type, title: 'A thing' });
		}
		assert.strictEqual(context.countOf('set_ticket_status'), TICKET_STATUSES.length);
		assert.strictEqual(context.countOf('create_ticket'), TICKET_TYPES.length);
	});

	test('work that fails comes back as an error result, not a thrown call fault', async () => {
		// An MCP client shows `isError` content to its model; a throw would
		// become a JSON-RPC error, which says the *request* was malformed.
		const context = new FakeMcpContext();
		context.failWith.set('rename_ticket', new Error('This ticket changed on disk.'));
		const result = await callMcpTool(context, ALL, 'rename_ticket', {
			id: 'ST-1.1',
			title: 'New'
		});
		assert.strictEqual(result.isError, true);
		assert.match(result.content[0].text, /changed on disk/);
	});

	test('a ticket that does not exist is an error result naming it', async () => {
		const context = new FakeMcpContext();
		const result = await callMcpTool(context, ALL, 'get_ticket', { id: 'ST-9.9' });
		assert.strictEqual(result.isError, true);
		assert.match(result.content[0].text, /ST-9\.9/);
	});

	test('list_tickets reads one level, and an absent parent means the epics', async () => {
		const context = new FakeMcpContext();
		context.tickets.set('EP-1', {
			id: 'EP-1',
			key: 'EP-1',
			type: 'epic',
			title: 'Auth',
			status: 'todo'
		});
		context.tickets.set('ST-1.1', {
			id: 'ST-1.1',
			key: 'ST-1',
			type: 'story',
			title: 'Sign in',
			status: 'todo',
			parentId: 'EP-1'
		});

		const roots = payload(await callMcpTool(context, ALL, 'list_tickets', {})) as {
			tickets: { id: string }[];
		};
		assert.deepStrictEqual(
			roots.tickets.map((ticket) => ticket.id),
			['EP-1']
		);

		const children = payload(
			await callMcpTool(context, ALL, 'list_tickets', { parentId: 'EP-1' })
		) as { tickets: { id: string }[] };
		assert.deepStrictEqual(
			children.tickets.map((ticket) => ticket.id),
			['ST-1.1']
		);
	});

	test('create_ticket passes the parent through, and omits it for a top-level epic', async () => {
		const context = new FakeMcpContext();
		await callMcpTool(context, ALL, 'create_ticket', { type: 'epic', title: 'Auth' });
		assert.deepStrictEqual(context.calls[0].args, { type: 'epic', title: 'Auth' });

		await callMcpTool(context, ALL, 'create_ticket', {
			parentId: 'EP-1',
			type: 'story',
			title: 'Sign in',
			description: '# Body'
		});
		assert.deepStrictEqual(context.calls[1].args, {
			parentId: 'EP-1',
			type: 'story',
			title: 'Sign in',
			description: '# Body'
		});
	});

	test('the four long-running tools answer at once and report a refusal as a non-failure', async () => {
		// A client that gave up waiting and retried must be told "nothing was
		// started a second time", not handed an error.
		const context = new FakeMcpContext();
		context.report = { started: false, message: 'Already running.' };
		for (const [name, args] of [
			['run_tests', { id: 'ST-1.1' }],
			['run_scan', {}],
			['start_environment', { id: 'ST-1.1' }],
			['stop_environment', { id: 'ST-1.1' }]
		] as const) {
			const result = await callMcpTool(context, ALL, name, args);
			assert.notStrictEqual(result.isError, true, name);
			assert.deepStrictEqual(payload(result), { started: false, message: 'Already running.' });
		}
	});

	test('run_tests tells a client whose read is off that it cannot read the verdicts back', async () => {
		// The verdicts are read through get_ticket. With `read` off the run still
		// starts — the switch is the user's — but the client is told rather than
		// left guessing why every status it looks for is unreachable.
		const context = new FakeMcpContext();
		const blind = payload(await callMcpTool(context, ['tests'], 'run_tests', { id: 'ST-1.1' })) as {
			started: boolean;
			message: string;
		};
		assert.strictEqual(blind.started, true);
		assert.ok(blind.message.endsWith(READ_OFF_NOTE), blind.message);

		const sighted = payload(
			await callMcpTool(context, ['read', 'tests'], 'run_tests', { id: 'ST-1.1' })
		) as { message: string };
		assert.strictEqual(sighted.message, 'started');

		// A refusal carries no such note: nothing started, so there is nothing to read.
		context.report = { started: false, message: 'Already running.' };
		const refused = payload(await callMcpTool(context, ['tests'], 'run_tests', { id: 'ST-1.1' }));
		assert.deepStrictEqual(refused, { started: false, message: 'Already running.' });
	});

	test('the design tools carry a body verbatim, and only the designs function reaches them', async () => {
		const context = new FakeMcpContext();
		const body = '  indented\n\n```mermaid\nerDiagram\n```\n';
		await callMcpTool(context, ['designs'], 'update_design', {
			ticketId: 'EP-1',
			designId: 'ERD-1',
			body
		});
		assert.deepStrictEqual(context.calls[0].args, { ticketId: 'EP-1', designId: 'ERD-1', body });

		// An empty body is a real answer — clear the document — not a missing one.
		await callMcpTool(context, ['designs'], 'update_design', {
			ticketId: 'EP-1',
			designId: 'ERD-1',
			body: ''
		});
		assert.strictEqual((context.calls[1].args as { body: string }).body, '');
		await assert.rejects(
			callMcpTool(context, ['designs'], 'update_design', { ticketId: 'EP-1', designId: 'ERD-1' }),
			McpToolCallError
		);

		const missing = await callMcpTool(context, ['designs'], 'get_design', {
			ticketId: 'EP-1',
			designId: 'ERD-9'
		});
		assert.strictEqual(missing.isError, true);
		assert.match(missing.content[0].text, /No design document “ERD-9” on EP-1/);

		// Reading designs is the designs function's, not read's: switched off, it is refused.
		await assert.rejects(
			callMcpTool(context, ['read', 'write'], 'list_designs', { ticketId: 'EP-1' }),
			/the “designs” function is switched off/
		);
		assert.deepStrictEqual(
			enabledTools(['designs']).map((tool) => tool.name),
			['list_designs', 'get_design', 'create_design', 'update_design']
		);
	});

	test('run_scan without a ticket means the workspace', async () => {
		const context = new FakeMcpContext();
		await callMcpTool(context, ALL, 'run_scan', {});
		assert.deepStrictEqual(context.calls[0].args, { id: undefined });
		await callMcpTool(context, ALL, 'run_scan', { id: 'ST-1.1' });
		assert.deepStrictEqual(context.calls[1].args, { id: 'ST-1.1' });
	});

	test('every tool is reachable when its own function is the only one switched on', async () => {
		// A function switched on alone must be usable alone — no tool may depend
		// on a second switch being on.
		for (const group of MCP_FUNCTION_IDS) {
			const context = new FakeMcpContext();
			const only: McpFunctionId[] = [group];
			for (const tool of toolsOf(group)) {
				const args = sampleArguments(tool.name);
				await callMcpTool(context, only, tool.name, args);
			}
			assert.strictEqual(context.calls.length, toolsOf(group).length, group);
		}
	});
});

/** Valid arguments for one tool, so the table above can drive every one. */
function sampleArguments(name: string): Record<string, unknown> {
	switch (name) {
		case 'get_ticket':
		case 'run_tests':
		case 'start_environment':
		case 'stop_environment':
			return { id: 'ST-1.1' };
		case 'create_ticket':
			return { type: 'story', title: 'A thing' };
		case 'rename_ticket':
			return { id: 'ST-1.1', title: 'A thing' };
		case 'set_ticket_status':
			return { id: 'ST-1.1', status: 'done' };
		case 'link_tickets':
		case 'unlink_tickets':
			return { id: 'ST-1.1', relation: 'blocks', targetId: 'ST-1.2' };
		case 'list_designs':
			return { ticketId: 'ST-1.1' };
		case 'get_design':
			return { ticketId: 'ST-1.1', designId: 'LLD-1' };
		case 'create_design':
			return { ticketId: 'ST-1.1', style: 'LLD', title: 'Design' };
		case 'update_design':
			return { ticketId: 'ST-1.1', designId: 'LLD-1', body: 'x' };
		case 'set_test_case_service':
			return { id: 'TC-1.1', service: 'orders' };
		case 'update_environment_settings':
		case 'update_test_settings':
			return { changes: { command: 'x' } };
		case 'set_test_service':
			return { service: { id: 'orders', folder: 'services/orders' } };
		case 'remove_test_service':
			return { id: 'orders' };
		default:
			return {};
	}
}
