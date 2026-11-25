// JSON-RPC 2.0 and the handful of MCP methods BFAST answers.
//
// The Node-free half again: no `http`, no sockets, no `vscode`. Everything
// here is "a message in, a message out", which is what lets
// `mcpProtocol.test.ts` drive an `initialize` / `tools/list` / `tools/call`
// conversation without opening a port. `mcpServer.ts` is the transport that
// carries these over HTTP.
//
// BFAST advertises `tools` and nothing else — no resources, no prompts, no
// sampling — so there is no method here that the tool table does not explain.

import type { McpFunctionId } from '../settings/mcpSettings';
import {
	callMcpTool,
	enabledTools,
	McpToolCallError,
	type McpToolContext,
	type McpToolResult
} from './mcpTools';
import { errorMessage } from '../platform/errors';

/** The transport revision BFAST implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Versions BFAST will answer `initialize` with unchanged.
 *
 * The specification says a server that does not support the version a client
 * asked for answers with one it does; echoing a version we genuinely speak is
 * what keeps an older client working, and anything else falls back to the
 * newest. Kept newest-first for the same reason the offer lists are.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
	'2025-06-18',
	'2025-03-26',
	'2024-11-05'
];

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	/** Absent on a notification, which is answered with nothing at all. */
	id?: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: JsonRpcId | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface McpHandlerDeps {
	serverName: string;
	serverVersion: string;
	/** Read at call time: a `tools/call` is checked against the switches as they are now. */
	functions(): readonly McpFunctionId[];
	context: McpToolContext;
}

/**
 * Answers one JSON-RPC message, or `undefined` when it is a notification (or a
 * response, which a client has no business sending us).
 *
 * Never throws: a handler that fails becomes an internal-error response, so one
 * bad call can never take the server's listener down with it.
 */
export async function handleMcpMessage(
	raw: unknown,
	deps: McpHandlerDeps
): Promise<JsonRpcResponse | undefined> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return errorResponse(null, JSON_RPC_INVALID_REQUEST, 'A JSON-RPC message must be an object.');
	}

	const message = raw as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
	const id = isId(message.id) ? message.id : undefined;

	// A response the client sent us: nothing to answer, and nothing to do —
	// BFAST never sends a client a request of its own.
	if (typeof message.method !== 'string') {
		return id === undefined
			? undefined
			: errorResponse(id, JSON_RPC_INVALID_REQUEST, 'A JSON-RPC request must name a method.');
	}

	// Notifications are answered with nothing, whatever the method is: an
	// unknown one is the client telling us something we did not ask about.
	if (id === undefined) {
		return undefined;
	}

	try {
		return { jsonrpc: '2.0', id, result: await route(message.method, message.params, deps) };
	} catch (failure) {
		if (failure instanceof McpMethodError) {
			return errorResponse(id, failure.code, failure.message);
		}
		return errorResponse(
			id,
			JSON_RPC_INTERNAL_ERROR,
			errorMessage(failure)
		);
	}
}

/** A JSON-RPC error this module raises on purpose, with the code it should carry. */
export class McpMethodError extends Error {
	constructor(
		readonly code: number,
		message: string
	) {
		super(message);
		this.name = 'McpMethodError';
	}
}

export function errorResponse(
	id: JsonRpcId | null,
	code: number,
	message: string
): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

async function route(method: string, params: unknown, deps: McpHandlerDeps): Promise<unknown> {
	switch (method) {
		case 'initialize':
			return initialize(params, deps);
		case 'ping':
			// The specification's liveness check: an empty result is the whole answer.
			return {};
		case 'tools/list':
			return {
				tools: enabledTools(deps.functions()).map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema
				}))
			};
		case 'tools/call':
			return toolsCall(params, deps);
		default:
			throw new McpMethodError(
				JSON_RPC_METHOD_NOT_FOUND,
				`BFAST does not implement “${method}”. It offers tools only — no resources, no prompts.`
			);
	}
}

function initialize(params: unknown, deps: McpHandlerDeps): unknown {
	const requested = readParams(params).protocolVersion;
	const version =
		typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
			? requested
			: MCP_PROTOCOL_VERSION;

	return {
		protocolVersion: version,
		// `listChanged: false` is the honest answer: a settings save restarts the
		// server and drops the session, so a client is told by being disconnected
		// rather than by a notification it would never receive.
		capabilities: { tools: { listChanged: false } },
		serverInfo: { name: deps.serverName, version: deps.serverVersion },
		instructions:
			'BFAST is this workspace’s ticket tracker: epics hold sub-epics and stories, stories hold acceptance criteria, and a test case can sit under any of them — under a criterion it proves that criterion, under a story or an epic it crosses several functions. Ids carry the whole ancestry (ST-1.2 is the second story of the first epic). Any two tickets can also be linked — blocks / is blocked by, relates to, duplicates / is duplicated by, clones / is cloned by — and each link is recorded on both tickets. Only the tools listed are switched on; the rest are off in this workspace’s BFAST settings.'
	};
}

async function toolsCall(params: unknown, deps: McpHandlerDeps): Promise<McpToolResult> {
	const { name, arguments: args } = readParams(params);
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new McpMethodError(JSON_RPC_INVALID_PARAMS, '“name” is required.');
	}

	try {
		return await callMcpTool(deps.context, deps.functions(), name, args);
	} catch (failure) {
		if (failure instanceof McpToolCallError) {
			throw new McpMethodError(JSON_RPC_INVALID_PARAMS, failure.message);
		}
		throw failure;
	}
}

function readParams(params: unknown): Record<string, unknown> {
	return typeof params === 'object' && params !== null && !Array.isArray(params)
		? (params as Record<string, unknown>)
		: {};
}

function isId(value: unknown): value is JsonRpcId {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
