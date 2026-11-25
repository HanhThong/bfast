import * as assert from 'assert';
import * as http from 'http';
import { MCP_PROTOCOL_VERSION } from '../mcp/mcpProtocol';
import { McpServer } from '../mcp/mcpServer';
import { MCP_ENDPOINT_PATH, type McpSettings } from '../settings/mcpSettings';
import { FakeMcpContext } from './fakeMcpContext';

interface Reply {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** One HTTP request against the server under test. No dependency, like the server. */
function request(
	port: number,
	options: {
		method?: string;
		path?: string;
		body?: unknown;
		session?: string;
		origin?: string;
	} = {}
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
		const call = http.request(
			{
				host: '127.0.0.1',
				port,
				method: options.method ?? 'POST',
				path: options.path ?? MCP_ENDPOINT_PATH,
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
					...(options.session === undefined ? {} : { 'Mcp-Session-Id': options.session }),
					...(options.origin === undefined ? {} : { Origin: options.origin })
				}
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
			}
		);
		call.on('error', reject);
		if (payload !== undefined) {
			call.write(payload);
		}
		call.end();
	});
}

function json(reply: Reply): any {
	return JSON.parse(reply.body);
}

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = http.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

suite('MCP server', () => {
	let server: McpServer | undefined;
	let context: FakeMcpContext;
	let settings: McpSettings | undefined;

	setup(() => {
		context = new FakeMcpContext();
		settings = undefined;
	});

	teardown(async () => {
		await server?.stop();
		server = undefined;
	});

	/** Starts a server on a free port with the given settings, and returns the port. */
	async function start(block: Omit<McpSettings, 'port'>): Promise<number> {
		const port = await freePort();
		settings = { ...block, port };
		server = new McpServer({
			settings: () => settings,
			context,
			version: '1.2.3'
		});
		const status = await server.apply();
		assert.strictEqual(status.state, 'running', status.message);
		return port;
	}

	/** `initialize` plus the session id it minted. */
	async function initialize(port: number): Promise<string> {
		const reply = await request(port, {
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'test', version: '0' }
				}
			}
		});
		assert.strictEqual(reply.status, 200, reply.body);
		const session = reply.headers['mcp-session-id'];
		assert.strictEqual(typeof session, 'string', 'initialize must mint a session');
		return session as string;
	}

	test('the server is off until it is switched on', async () => {
		const port = await freePort();
		settings = { port };
		server = new McpServer({ settings: () => settings, context, version: '1.2.3' });

		const status = await server.apply();
		assert.strictEqual(status.state, 'stopped');
		await assert.rejects(() => request(port, { body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
	});

	test('initialize answers the handshake and mints a session', async () => {
		const port = await start({ enabled: true });
		const reply = await request(port, {
			body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
		});

		const result = json(reply).result;
		assert.strictEqual(result.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.deepStrictEqual(result.capabilities, { tools: { listChanged: false } });
		assert.deepStrictEqual(result.serverInfo, { name: 'bfast', version: '1.2.3' });
		assert.strictEqual(typeof reply.headers['mcp-session-id'], 'string');
	});

	test('a version the server knows is echoed back; one it does not falls back', async () => {
		const port = await start({ enabled: true });
		const older = await request(port, {
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2024-11-05' }
			}
		});
		assert.strictEqual(json(older).result.protocolVersion, '2024-11-05');

		const future = await request(port, {
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2099-01-01' }
			}
		});
		assert.strictEqual(json(future).result.protocolVersion, MCP_PROTOCOL_VERSION);
	});

	test('a request without a live session is refused with 404, so a client re-initializes', async () => {
		const port = await start({ enabled: true });

		const none = await request(port, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
		assert.strictEqual(none.status, 404);

		const stale = await request(port, {
			body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
			session: 'a-session-from-before'
		});
		assert.strictEqual(stale.status, 404);
		assert.match(json(stale).error.message, /initialize/);
	});

	test('a notification is accepted with no body', async () => {
		const port = await start({ enabled: true });
		const session = await initialize(port);
		const reply = await request(port, {
			body: { jsonrpc: '2.0', method: 'notifications/initialized' },
			session
		});
		assert.strictEqual(reply.status, 202);
		assert.strictEqual(reply.body, '');
	});

	test('tools/list offers exactly the switched-on functions', async () => {
		const port = await start({ enabled: true, functions: ['read', 'tests'] });
		const session = await initialize(port);

		const reply = await request(port, {
			body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
			session
		});
		const names = json(reply).result.tools.map((tool: { name: string }) => tool.name);
		assert.deepStrictEqual(names, ['list_tickets', 'get_ticket', 'run_tests', 'set_test_case_service']);
	});

	test('everything switched off is a server with no tools, not a server that refuses to start', async () => {
		const port = await start({ enabled: true, functions: [] });
		const session = await initialize(port);
		const reply = await request(port, {
			body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
			session
		});
		assert.deepStrictEqual(json(reply).result.tools, []);
	});

	test('tools/call reaches the context and answers its JSON', async () => {
		const port = await start({ enabled: true, functions: ['read'] });
		const session = await initialize(port);
		context.tickets.set('EP-1', {
			id: 'EP-1',
			key: 'EP-1',
			type: 'epic',
			title: 'Auth',
			status: 'todo'
		});

		const reply = await request(port, {
			body: {
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'get_ticket', arguments: { id: 'EP-1' } }
			},
			session
		});
		assert.strictEqual(reply.status, 200);
		assert.strictEqual(JSON.parse(json(reply).result.content[0].text).title, 'Auth');
		assert.strictEqual(context.countOf('get_ticket'), 1);
	});

	test('a function switched off between two calls cannot be called by a client that listed it', async () => {
		// The switches are read at call time, not captured when the session
		// opened — "even by a client that knew about it a moment ago".
		const port = await start({ enabled: true, functions: ['read', 'status'] });
		const session = await initialize(port);

		const listed = await request(port, {
			body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
			session
		});
		assert.ok(
			json(listed).result.tools.some((tool: { name: string }) => tool.name === 'set_ticket_status')
		);

		settings = { ...settings, functions: ['read'] };

		const refused = await request(port, {
			body: {
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'set_ticket_status', arguments: { id: 'EP-1', status: 'done' } }
			},
			session
		});
		assert.strictEqual(refused.status, 200);
		assert.match(json(refused).error.message, /switched off/);
		assert.strictEqual(context.countOf('set_ticket_status'), 0);
	});

	test('saving settings restarts the server and drops the session', async () => {
		const port = await start({ enabled: true });
		const session = await initialize(port);

		const before = await request(port, {
			body: { jsonrpc: '2.0', id: 2, method: 'ping' },
			session
		});
		assert.strictEqual(before.status, 200);

		// What `applyConfigured` does on every save.
		await server?.apply();

		const after = await request(port, {
			body: { jsonrpc: '2.0', id: 3, method: 'ping' },
			session
		});
		assert.strictEqual(after.status, 404, 'the old session must not survive a restart');
	});

	test('switching the server off stops it listening', async () => {
		const port = await start({ enabled: true });
		settings = { ...settings, enabled: undefined };

		const status = await server?.apply();
		assert.strictEqual(status?.state, 'stopped');
		assert.strictEqual(status?.address, undefined);
		await assert.rejects(() => request(port, { body: { jsonrpc: '2.0', id: 1, method: 'ping' } }));
	});

	test('a port already in use fails to start and says so, keeping the settings', async () => {
		// The two-windows case, and the something-else-has-it case: only one
		// server holds the port, and the second must not silently run a copy.
		const port = await start({ enabled: true });

		const second = new McpServer({
			settings: () => ({ enabled: true, port }),
			context,
			version: '1.2.3'
		});
		try {
			const status = await second.apply();
			assert.strictEqual(status.state, 'error');
			assert.strictEqual(status.code, 'port-in-use');
			assert.match(status.message ?? '', new RegExp(String(port)));
			// The settings the user typed are still what the status reports back.
			assert.strictEqual(status.port, port);
		} finally {
			await second.stop();
		}

		// …and the first one is untouched.
		const session = await initialize(port);
		assert.ok(session);
	});

	test('the status is published to whoever is watching', async () => {
		const port = await freePort();
		settings = { enabled: true, port };
		server = new McpServer({ settings: () => settings, context, version: '1.2.3' });

		const seen: string[] = [];
		server.onDidChangeStatus((status) => seen.push(status.state));

		await server.apply();
		await server.stop();
		assert.deepStrictEqual(seen, ['running', 'stopped']);
	});

	test('GET has no stream to offer, and another path is not the endpoint', async () => {
		const port = await start({ enabled: true });

		const get = await request(port, { method: 'GET' });
		assert.strictEqual(get.status, 405);

		const elsewhere = await request(port, {
			path: '/admin',
			body: { jsonrpc: '2.0', id: 1, method: 'ping' }
		});
		assert.strictEqual(elsewhere.status, 404);

		// A trailing slash is the same endpoint, and nothing else is.
		const session = await initialize(port);
		const slash = await request(port, {
			path: `${MCP_ENDPOINT_PATH}/`,
			body: { jsonrpc: '2.0', id: 2, method: 'ping' },
			session
		});
		assert.strictEqual(slash.status, 200);
	});

	test('DELETE ends the session', async () => {
		const port = await start({ enabled: true });
		const session = await initialize(port);

		const deleted = await request(port, { method: 'DELETE', session });
		assert.strictEqual(deleted.status, 204);

		const after = await request(port, {
			body: { jsonrpc: '2.0', id: 2, method: 'ping' },
			session
		});
		assert.strictEqual(after.status, 404);
	});

	test('a browser origin is refused, and a client that sends none is not', async () => {
		// The DNS-rebinding defence the transport specification asks for. It is
		// not authentication: a real MCP client sends no Origin at all.
		const port = await start({ enabled: true });

		const evil = await request(port, {
			origin: 'https://evil.example',
			body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
		});
		assert.strictEqual(evil.status, 403);

		const local = await request(port, {
			origin: 'http://localhost:3000',
			body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
		});
		assert.strictEqual(local.status, 200);
	});

	test('malformed input is answered, never crashed on', async () => {
		const port = await start({ enabled: true });

		const notJson = await request(port, { body: undefined });
		assert.strictEqual(notJson.status, 400);

		const session = await initialize(port);
		const notAnObject = await request(port, { body: 'just a string', session });
		assert.strictEqual(json(notAnObject).error.code, -32600);

		const unknownMethod = await request(port, {
			body: { jsonrpc: '2.0', id: 4, method: 'resources/list' },
			session
		});
		assert.strictEqual(json(unknownMethod).error.code, -32601);

		// Still alive.
		const ping = await request(port, { body: { jsonrpc: '2.0', id: 5, method: 'ping' }, session });
		assert.deepStrictEqual(json(ping).result, {});
	});

	test('a batch is answered with a batch, and notifications in it get no entry', async () => {
		const port = await start({ enabled: true, functions: ['read'] });
		const session = await initialize(port);

		const reply = await request(port, {
			body: [
				{ jsonrpc: '2.0', id: 10, method: 'ping' },
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				{ jsonrpc: '2.0', id: 11, method: 'tools/list' }
			],
			session
		});
		const answers = json(reply);
		assert.ok(Array.isArray(answers));
		assert.deepStrictEqual(
			answers.map((answer: { id: number }) => answer.id),
			[10, 11]
		);
	});
});
