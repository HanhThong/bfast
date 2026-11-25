// The MCP server's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `implementSettings.ts`: no `vscode` and no Node import
// (the host validates before writing, the settings webview validates as you
// type), reading is forgiving while writing is strict, and `parseMcpSettings`
// returns `undefined` — not an empty object — when nothing survived, so a
// workspace that never switches the server on keeps `bfast.json` byte-identical.
//
// Nothing here is ever a credential, and not because the file is committed to
// git: the server has none. It has no accounts, no tokens and no per-client
// permissions — exposing it beyond this machine is a warned choice, not a
// protected one. docs/mcp/ is the spec.

/** Who may reach the server. `local` binds loopback; `network` binds every interface. */
export type McpReach = 'local' | 'network';

export const MCP_REACHES: readonly McpReach[] = ['local', 'network'];

/** Loopback only, so switching the server on exposes nothing by itself. */
export const DEFAULT_MCP_REACH: McpReach = 'local';

/**
 * One switchable group of tools — what the settings tab lists one by one and
 * what a `tools/call` is checked against. The tools themselves are in
 * `mcp/mcpTools.ts`, which is where a group's membership is declared.
 */
export type McpFunctionId =
	| 'read'
	| 'write'
	| 'designs'
	| 'status'
	| 'tests'
	| 'scan'
	| 'environments'
	| 'settings';

export const MCP_FUNCTION_IDS: readonly McpFunctionId[] = [
	'read',
	'write',
	'designs',
	'status',
	'tests',
	'scan',
	'environments',
	'settings'
];

/** Reading only: switching the server on must not hand a client the write half. */
export const DEFAULT_MCP_FUNCTIONS: readonly McpFunctionId[] = ['read'];

export const MIN_MCP_PORT = 1;
export const MAX_MCP_PORT = 65535;
/** Unregistered, and memorable beside the environments' own range. */
export const DEFAULT_MCP_PORT = 7711;

/** The one path the server answers on — the Streamable HTTP transport's single endpoint. */
export const MCP_ENDPOINT_PATH = '/mcp';

export interface McpSettings {
	/** Absent means off. Only `true` is ever written. */
	enabled?: boolean;
	/** Absent means `DEFAULT_MCP_PORT`; only another value is ever written. */
	port?: number;
	/** Absent means `local`; only `network` is ever written. */
	reach?: McpReach;
	/**
	 * Which functions the server offers. Absent means `DEFAULT_MCP_FUNCTIONS`.
	 *
	 * An **empty** array is meaningful and is written: the user switched
	 * everything off, the server still starts, and a client connects to find
	 * nothing to do. That is why this is a list rather than a flag per function —
	 * "none" and "the default" have to be tellable apart, and a list of the ones
	 * that are on reads in a git diff.
	 */
	functions?: McpFunctionId[];
}

/**
 * Reads the `mcp` block out of whatever `JSON.parse` produced.
 *
 * Never throws. An out-of-range port, an unknown reach and an unknown function
 * name are dropped so the defaults apply, and `undefined` comes back when
 * nothing usable survived.
 */
export function parseMcpSettings(raw: unknown): McpSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof McpSettings, unknown>>;

	const port =
		typeof source.port === 'number' && isPortNumber(source.port) && source.port !== DEFAULT_MCP_PORT
			? source.port
			: undefined;
	const reach = source.reach === 'network' ? ('network' as const) : undefined;
	const functions = parseFunctions(source.functions);

	// Every field is named here, or it is silently dropped on every write.
	const settings: McpSettings = {
		...(source.enabled === true ? { enabled: true } : {}),
		...(port === undefined ? {} : { port }),
		...(reach === undefined ? {} : { reach }),
		...(functions === undefined ? {} : { functions })
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Drops default-valued and unusable fields, ready to be written. `undefined` when nothing is left. */
export function normalizeMcpSettings(mcp: McpSettings | undefined): McpSettings | undefined {
	return mcp === undefined ? undefined : parseMcpSettings(mcp);
}

/**
 * Returns an error message, or `undefined` when the whole block is usable.
 *
 * The port the *form* refuses — empty, or not a number — cannot reach here:
 * the webview sends a number or nothing, and nothing means the default. This
 * is the host's own check on a value it must not trust, and the reason an
 * out-of-range port is refused rather than quietly defaulted on the way out.
 */
export function validateMcpSettings(mcp: McpSettings | undefined): string | undefined {
	if (mcp === undefined) {
		return undefined;
	}
	if (mcp.port !== undefined && !isPortNumber(mcp.port)) {
		return `The MCP server port must be a whole number between ${MIN_MCP_PORT} and ${MAX_MCP_PORT}.`;
	}
	if (mcp.reach !== undefined && !MCP_REACHES.includes(mcp.reach)) {
		return 'Choose whether the MCP server is reachable from this machine only or from the network.';
	}
	if (
		mcp.functions !== undefined &&
		(!Array.isArray(mcp.functions) || mcp.functions.some((id) => !MCP_FUNCTION_IDS.includes(id)))
	) {
		return 'Pick the MCP functions from the list.';
	}
	return undefined;
}

/**
 * The port field's own check, against the **raw text** the form holds.
 *
 * The parse silently turns an unusable value into "use the default", so the
 * text needs a check of its own or an erased field would save fine and only
 * surface as a server on a port nobody asked for — the reason
 * `validatePortVariableText` exists beside `parsePortVariableList`. Only asked
 * while the server is switched on: an empty field under a server that is off
 * is not a mistake.
 */
export function validateMcpPortText(text: string, enabled: boolean): string | undefined {
	if (!enabled) {
		return undefined;
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return 'Enter the port the MCP server listens on.';
	}
	if (!/^\d+$/.test(trimmed)) {
		return 'The port must be a whole number.';
	}
	if (!isPortNumber(Number(trimmed))) {
		return `The port must be between ${MIN_MCP_PORT} and ${MAX_MCP_PORT}.`;
	}
	return undefined;
}

/** Whether the server should be listening at all. */
export function mcpEnabled(mcp: McpSettings | undefined): boolean {
	return mcp?.enabled === true;
}

/** The configured port, or the default. Never `undefined`: the server listens somewhere. */
export function mcpPort(mcp: McpSettings | undefined): number {
	return mcp?.port !== undefined && isPortNumber(mcp.port) ? mcp.port : DEFAULT_MCP_PORT;
}

/** Who may reach it. */
export function mcpReach(mcp: McpSettings | undefined): McpReach {
	return mcp?.reach === 'network' ? 'network' : DEFAULT_MCP_REACH;
}

/**
 * The functions on offer, in `MCP_FUNCTION_IDS` order. An empty array is a real
 * answer — everything switched off — and is not the same as an absent one.
 */
export function mcpFunctions(mcp: McpSettings | undefined): McpFunctionId[] {
	const configured = mcp?.functions;
	if (configured === undefined) {
		return [...DEFAULT_MCP_FUNCTIONS];
	}
	return MCP_FUNCTION_IDS.filter((id) => configured.includes(id));
}

/** Whether one function is on offer. */
export function mcpFunctionEnabled(mcp: McpSettings | undefined, id: McpFunctionId): boolean {
	return mcpFunctions(mcp).includes(id);
}

/**
 * The interface the server binds. The single address for the reach → host rule,
 * so the form's warning and the listener can never disagree about what
 * `network` means.
 */
export function mcpBindHost(reach: McpReach): string {
	return reach === 'network' ? '0.0.0.0' : '127.0.0.1';
}

/** `http://127.0.0.1:7711/mcp` — what a client is given, from the host it can reach. */
export function mcpAddress(host: string, port: number): string {
	// An IPv6 literal has to be bracketed in a url; nothing else is touched.
	const authority = host.includes(':') ? `[${host}]` : host;
	return `http://${authority}:${port}${MCP_ENDPOINT_PATH}`;
}

function isPortNumber(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_MCP_PORT && value <= MAX_MCP_PORT;
}

/**
 * Forgiving on the way in: a non-array is "not configured", and an unknown name
 * inside one is dropped rather than making the whole list unusable. The result
 * keeps `MCP_FUNCTION_IDS` order and drops duplicates, so the file reads the
 * same however it was filled in — `pickTicketTypes`' rule.
 */
function parseFunctions(raw: unknown): McpFunctionId[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const wanted = MCP_FUNCTION_IDS.filter((id) => raw.includes(id));
	return sameFunctions(wanted, DEFAULT_MCP_FUNCTIONS) ? undefined : wanted;
}

function sameFunctions(a: readonly McpFunctionId[], b: readonly McpFunctionId[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}
