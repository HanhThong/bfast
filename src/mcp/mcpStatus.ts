// Where the MCP server has got to — the one type both halves share.
//
// Its own module for the reason `scanReport.ts` and `testReport.ts` are theirs:
// the settings webview bundles this to paint the MCP tab, and `shared/protocol/`
// imports it for the `mcpStatus` message, so it must carry no `vscode` and no
// `node:` import — not even an `import type`, which `typecheck:web` refuses just
// as hard. `mcpServer.ts`, which does open sockets, imports it from here.

import type { McpFunctionId, McpReach } from '../settings/mcpSettings';

export type McpServerState = 'stopped' | 'running' | 'error';

export interface McpServerStatus {
	state: McpServerState;
	/** Set while running: the address to paste into a client. */
	address?: string;
	port?: number;
	reach?: McpReach;
	/**
	 * The functions actually being served. An **empty array is a real answer** —
	 * the user switched every one off — and is why this is not `functions?: ...`
	 * standing in for "none".
	 */
	functions?: McpFunctionId[];
	/**
	 * Why it is not running. `port-in-use` is worded specially by the tab,
	 * because it is the one failure the user fixes by changing a number and
	 * saving again rather than by reading a log.
	 */
	code?: 'port-in-use' | 'listen-failed';
	message?: string;
}
