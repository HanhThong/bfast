// The Streamable HTTP transport: one endpoint, JSON-RPC over POST.
//
// Hand-rolled on Node's `http` for the reason `yaml.ts` and `zipFile.ts` are
// hand-rolled: the extension host has exactly one dependency (the optional
// Agent SDK) and `vsix` packages with `--no-dependencies`, so an MCP SDK would
// not reach a user's machine even if it were added.
//
// No `vscode` import — the status is published through a listener set, the
// `EnvironmentStore` shape — so `mcpServer.test.ts` can start a real server on
// an ephemeral port and talk to it over real HTTP. `extension.ts` is what turns
// `onDidChangeStatus` into a message for the settings tab.
//
// docs/mcp/README.md is the spec; the protocol itself is `mcpProtocol.ts`.

import * as http from 'http';
import * as os from 'os';
import {
	mcpAddress,
	mcpBindHost,
	mcpEnabled,
	mcpFunctions,
	mcpPort,
	mcpReach,
	MCP_ENDPOINT_PATH,
	type McpReach,
	type McpSettings
} from '../settings/mcpSettings';
import {
	errorResponse,
	handleMcpMessage,
	JSON_RPC_INVALID_REQUEST,
	JSON_RPC_PARSE_ERROR,
	MCP_PROTOCOL_VERSION,
	type JsonRpcResponse
} from './mcpProtocol';
import type { McpServerStatus } from './mcpStatus';
import type { McpToolContext } from './mcpTools';
import { errorMessage } from '../platform/errors';

export interface McpServerDeps {
	/** Read at call time, like every other setting in this extension. */
	settings(): McpSettings | undefined;
	context: McpToolContext;
	/** Reported to a client in `initialize`; the extension's own version. */
	version: string;
	/** Diagnostics, into the "BFAST MCP" channel. Optional so tests can stay quiet. */
	log?(line: string): void;
}

/** A body larger than this is refused rather than buffered — a description is prose. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SERVER_NAME = 'bfast';

export class McpServer {
	private server: http.Server | undefined;
	private current: McpServerStatus = { state: 'stopped' };
	private readonly listeners = new Set<(status: McpServerStatus) => void>();
	/**
	 * Live sessions, minted by `initialize`.
	 *
	 * A plain set of ids and nothing else: a session carries no state of its own,
	 * it exists only so that a restart can invalidate one. That is what makes
	 * "settings were saved, so reconnect" something a client is told rather than
	 * something it has to notice — its next call answers 404 and every conforming
	 * client re-initializes.
	 */
	private sessions = new Set<string>();

	constructor(private readonly deps: McpServerDeps) {}

	get status(): McpServerStatus {
		return this.current;
	}

	onDidChangeStatus(listener: (status: McpServerStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Brings the server in line with the settings on disk: stops what is
	 * listening, then starts again when the server is switched on.
	 *
	 * Always a full stop first, even when only the function list changed. A
	 * client that had already called `tools/list` would otherwise go on
	 * believing a function is available after it was switched off, and dropping
	 * the connection is the only way to tell it that is no longer true.
	 */
	async apply(): Promise<McpServerStatus> {
		await this.stop();

		const settings = this.deps.settings();
		if (!mcpEnabled(settings)) {
			return this.current;
		}

		const port = mcpPort(settings);
		const reach = mcpReach(settings);
		const functions = mcpFunctions(settings);

		try {
			await this.listen(mcpBindHost(reach), port);
		} catch (failure) {
			const code = isAddressInUse(failure) ? 'port-in-use' : 'listen-failed';
			const message =
				code === 'port-in-use'
					? `Port ${port} is already in use. Another window with this workspace open, or another program, is listening on it — change the port and save again.`
					: `The MCP server could not listen on port ${port}: ${describe(failure)}`;
			this.deps.log?.(`— ${message}`);
			return this.publish({ state: 'error', code, message, port, reach, functions });
		}

		const address = mcpAddress(reachableHost(reach), port);
		this.deps.log?.(
			`— MCP server listening on ${address} (${functions.length > 0 ? functions.join(', ') : 'no functions switched on'})`
		);
		return this.publish({ state: 'running', address, port, reach, functions });
	}

	/** Stops listening and drops every session, so no client keeps an old tool list. */
	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.sessions = new Set();

		if (server) {
			await new Promise<void>((resolve) => {
				// Keep-alive sockets would hold `close` open indefinitely — and
				// dropping them *is* the "reconnect, the functions may have changed"
				// signal, so this is the behaviour, not a tidy-up.
				server.closeAllConnections?.();
				server.close(() => resolve());
			});
			this.deps.log?.('— MCP server stopped');
		}

		if (this.current.state !== 'stopped') {
			this.publish({ state: 'stopped' });
		}
	}

	dispose(): void {
		void this.stop();
		this.listeners.clear();
	}

	private listen(host: string, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((request, response) => {
				void this.handle(request, response);
			});

			const onError = (failure: unknown) => {
				server.removeListener('listening', onListening);
				server.close();
				reject(failure);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				// From here on a socket error must not reject a settled promise;
				// one bad connection is not the server failing.
				server.on('error', (failure) => this.deps.log?.(`— MCP server error: ${describe(failure)}`));
				this.server = server;
				resolve();
			};

			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, host);
		});
	}

	private async handle(
		request: http.IncomingMessage,
		response: http.ServerResponse
	): Promise<void> {
		try {
			await this.route(request, response);
		} catch (failure) {
			this.deps.log?.(`— MCP request failed: ${describe(failure)}`);
			if (!response.headersSent) {
				sendJson(response, 500, errorResponse(null, -32603, describe(failure)));
			} else {
				response.end();
			}
		}
	}

	private async route(
		request: http.IncomingMessage,
		response: http.ServerResponse
	): Promise<void> {
		// The DNS-rebinding defence the transport specification requires: a
		// browser attaches `Origin` and a real MCP client does not, so this only
		// ever refuses a page trying to reach the port through someone's browser.
		// It is not authentication — there is none, by design.
		const origin = header(request, 'origin');
		if (origin !== undefined && !isLoopbackOrigin(origin)) {
			sendJson(response, 403, errorResponse(null, JSON_RPC_INVALID_REQUEST, 'Origin not allowed.'));
			return;
		}

		if (pathOf(request.url) !== MCP_ENDPOINT_PATH) {
			sendJson(
				response,
				404,
				errorResponse(
					null,
					JSON_RPC_INVALID_REQUEST,
					`BFAST serves MCP on ${MCP_ENDPOINT_PATH} and nothing else.`
				)
			);
			return;
		}

		if (request.method === 'DELETE') {
			const session = header(request, 'mcp-session-id');
			if (session !== undefined) {
				this.sessions.delete(session);
			}
			response.writeHead(204).end();
			return;
		}

		if (request.method !== 'POST') {
			// No SSE stream to listen to: nothing BFAST serves is server-initiated,
			// so a GET would only be a connection to keep alive.
			sendJson(
				response,
				405,
				errorResponse(
					null,
					JSON_RPC_INVALID_REQUEST,
					'BFAST answers POST only — it opens no server-initiated stream.'
				)
			);
			return;
		}

		let body: string;
		try {
			body = await readBody(request);
		} catch (failure) {
			sendJson(response, 413, errorResponse(null, JSON_RPC_INVALID_REQUEST, describe(failure)));
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			sendJson(response, 400, errorResponse(null, JSON_RPC_PARSE_ERROR, 'The body is not JSON.'));
			return;
		}

		const messages = Array.isArray(parsed) ? parsed : [parsed];
		const initializing = messages.some((message) => methodOf(message) === 'initialize');

		if (!initializing) {
			const session = header(request, 'mcp-session-id');
			if (session === undefined || !this.sessions.has(session)) {
				// 404 rather than 401: the session is gone, and every conforming
				// client answers that by starting a new one — which is exactly what
				// should happen after the settings were saved.
				sendJson(
					response,
					404,
					errorResponse(
						null,
						JSON_RPC_INVALID_REQUEST,
						'No such MCP session. BFAST restarts its server whenever settings are saved, so start a new session with `initialize`.'
					)
				);
				return;
			}
		}

		const deps = {
			serverName: SERVER_NAME,
			serverVersion: this.deps.version,
			functions: () => mcpFunctions(this.deps.settings()),
			context: this.deps.context
		};

		const answers: JsonRpcResponse[] = [];
		for (const message of messages) {
			const answer = await handleMcpMessage(message, deps);
			if (answer) {
				answers.push(answer);
			}
		}

		if (initializing) {
			const session = newSessionId();
			this.sessions.add(session);
			response.setHeader('Mcp-Session-Id', session);
		}
		response.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);

		if (answers.length === 0) {
			// Notifications and responses only: the transport's "accepted, nothing
			// to say" answer.
			response.writeHead(202).end();
			return;
		}

		sendJson(response, 200, Array.isArray(parsed) ? answers : answers[0]);
	}

	private publish(status: McpServerStatus): McpServerStatus {
		this.current = status;
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch {
				// One surface's bug must not stop the others being told.
			}
		}
		return status;
	}
}

/**
 * The host a client should aim at, which is not always the one we bound.
 *
 * `0.0.0.0` is an interface to listen on, never an address to paste into a
 * client, so a network-reachable server is named by its LAN address — and by
 * the machine's name when it has none, which is still something a person can
 * act on.
 */
function reachableHost(reach: McpReach): string {
	if (reach === 'local') {
		return '127.0.0.1';
	}
	for (const addresses of Object.values(os.networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === 'IPv4' && !address.internal) {
				return address.address;
			}
		}
	}
	return os.hostname();
}

function readBody(request: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('The request body is too large.'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(text)
	});
	response.end(text);
}

function header(request: http.IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	const first = Array.isArray(value) ? value[0] : value;
	return first === undefined || first.trim().length === 0 ? undefined : first.trim();
}

function pathOf(url: string | undefined): string {
	const path = (url ?? '').split('?')[0].split('#')[0];
	// `/mcp/` and `/mcp` are the same endpoint; nothing else is.
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function methodOf(message: unknown): string | undefined {
	if (typeof message !== 'object' || message === null) {
		return undefined;
	}
	const method = (message as { method?: unknown }).method;
	return typeof method === 'string' ? method : undefined;
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		const { hostname } = new URL(origin);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
	} catch {
		return false;
	}
}

function isAddressInUse(failure: unknown): boolean {
	return (
		typeof failure === 'object' &&
		failure !== null &&
		(failure as { code?: unknown }).code === 'EADDRINUSE'
	);
}

function newSessionId(): string {
	// Not a secret and not a credential — the server has none. It only has to be
	// unlikely to repeat across a restart, so that an old client's id is refused.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function describe(failure: unknown): string {
	return errorMessage(failure);
}
