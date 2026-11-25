// The AI coding tools BFAST knows how to connect to its MCP server.
//
// One row per tool: the shape *that tool* expects a server in — not BFAST's
// generic `http://host:port/mcp` — and, for a tool that reads its server list
// from a file committed to the project, where that file is and how the `bfast`
// entry folds into it. The table is the whole feature: a tool BFAST has no
// shape for is not offered, deliberately (see docs/mcp/README.md §Connecting).
//
// Node-free and `vscode`-free, the `mcpTools.ts` rule: the settings webview
// bundles this to paint the picker and preview the snippet, and the host calls
// the same functions with the *live* address — so what is previewed, copied and
// saved can never be three different strings. The host half that touches disk
// is `mcpClientFiles.ts`.

/** The key every tool's config files a server under. */
export const MCP_SERVER_NAME = 'bfast';

export type McpClientId = 'vscode' | 'claude-code' | 'codex';

export interface McpClientProjectFile {
	/** Workspace-relative, forward slashes: where the tool reads a project's servers. */
	path: string;
	/** The top-level JSON key holding the server map — `servers`, `mcpServers`. */
	container: string;
}

export interface McpClient {
	id: McpClientId;
	label: string;
	/** What the snippet is and where it goes, for the line under the preview. */
	hint: string;
	/**
	 * Absent when the tool keeps its servers only in a personal or machine-wide
	 * file: then only Copy is offered, never Save for the team.
	 */
	projectFile?: McpClientProjectFile;
}

export const MCP_CLIENTS: readonly McpClient[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		hint: 'The command that adds the server to Claude Code; saving writes the project’s .mcp.json instead.',
		projectFile: { path: '.mcp.json', container: 'mcpServers' }
	},
	{
		id: 'vscode',
		label: 'VS Code',
		hint: 'The servers block VS Code’s own MCP client reads from .vscode/mcp.json.',
		projectFile: { path: '.vscode/mcp.json', container: 'servers' }
	},
	{
		id: 'codex',
		label: 'Codex',
		hint: 'A block for ~/.codex/config.toml. Codex reads its servers from that personal file only, so there is nothing to save for the team.'
	}
];

/**
 * What Connect a tool has picked when the tab opens: the coding agent
 * Implement hands work to by default (`DEFAULT_IMPLEMENT_AGENT`), so the
 * snippet on screen is the one most workspaces need.
 */
export const DEFAULT_MCP_CLIENT: McpClientId = 'claude-code';

export function isMcpClientId(value: unknown): value is McpClientId {
	return MCP_CLIENTS.some((client) => client.id === value);
}

export function mcpClient(id: McpClientId): McpClient {
	const found = MCP_CLIENTS.find((client) => client.id === id);
	if (!found) {
		throw new Error(`Unknown MCP client ${id}`);
	}
	return found;
}

/** The entry both JSON-configured tools take: an HTTP server at the address. */
function serverEntry(address: string): { type: 'http'; url: string } {
	return { type: 'http', url: address };
}

/**
 * The tool's own connection snippet for a server at `address` — what Copy puts
 * on the clipboard and what the tab previews.
 */
export function mcpClientSnippet(id: McpClientId, address: string): string {
	switch (id) {
		case 'vscode':
			return JSON.stringify({ servers: { [MCP_SERVER_NAME]: serverEntry(address) } }, null, 2);
		case 'claude-code':
			return `claude mcp add --transport http ${MCP_SERVER_NAME} ${address}`;
		case 'codex':
			return `[mcp_servers.${MCP_SERVER_NAME}]\nurl = ${JSON.stringify(address)}`;
	}
}

export type McpClientMerge = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The project config file's new content with the `bfast` entry in it.
 *
 * `existing` is the file as it stands, or `undefined` when there is none yet.
 * Every other key survives — a team's other MCP servers are in that file too —
 * and anything that cannot be read as a JSON object, or whose server map is
 * not one, is **refused** rather than overwritten: the caller writes nothing
 * and says why. Only the `bfast` entry is ever replaced.
 */
export function mergeMcpClientConfig(
	id: McpClientId,
	existing: string | undefined,
	address: string
): McpClientMerge {
	const client = mcpClient(id);
	const file = client.projectFile;
	if (!file) {
		return {
			ok: false,
			reason: `${client.label} has no project-scoped config file BFAST can write to. Copy the snippet instead.`
		};
	}

	let root: unknown = {};
	if (existing !== undefined && existing.trim().length > 0) {
		try {
			root = JSON.parse(existing);
		} catch {
			return {
				ok: false,
				reason: `${file.path} could not be read as JSON, so nothing was written. Add the entry by hand or fix the file and save again.`
			};
		}
	}
	if (!isPlainObject(root)) {
		return {
			ok: false,
			reason: `${file.path} does not hold a JSON object, so nothing was written.`
		};
	}
	const servers = root[file.container] ?? {};
	if (!isPlainObject(servers)) {
		return {
			ok: false,
			reason: `${file.path} has a "${file.container}" that is not an object, so nothing was written.`
		};
	}

	const merged = { ...root, [file.container]: { ...servers, [MCP_SERVER_NAME]: serverEntry(address) } };
	return { ok: true, text: JSON.stringify(merged, null, 2) + '\n' };
}

/**
 * The project config file's new content with the `bfast` entry moved from
 * port `from` to port `to` — what a new environment's worktree needs, since
 * its window serves on a port of its own (docs/environments/README.md §The MCP
 * server in an environment).
 *
 * `undefined` means "leave the file alone", and covers everything that is not
 * exactly that entry pointing at that port: a tool with no project file, text
 * that is not a JSON object, no `bfast` entry, or one whose `url` names
 * another port or is not a url at all — an entry aimed elsewhere was aimed
 * there on purpose. Only the url's port changes; its host, its path and every
 * other key in the file survive.
 */
export function retargetMcpClientConfig(
	id: McpClientId,
	existing: string,
	from: number,
	to: number
): string | undefined {
	const file = mcpClient(id).projectFile;
	if (!file) {
		return undefined;
	}
	let root: unknown;
	try {
		root = JSON.parse(existing);
	} catch {
		return undefined;
	}
	if (!isPlainObject(root)) {
		return undefined;
	}
	const servers = root[file.container];
	if (!isPlainObject(servers)) {
		return undefined;
	}
	const entry = servers[MCP_SERVER_NAME];
	if (!isPlainObject(entry) || typeof entry.url !== 'string') {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(entry.url);
	} catch {
		return undefined;
	}
	// `URL.port` is '' for a scheme's default port, which BFAST never serves on.
	if (url.port !== String(from)) {
		return undefined;
	}
	url.port = String(to);

	const retargeted = {
		...root,
		[file.container]: { ...servers, [MCP_SERVER_NAME]: { ...entry, url: url.toString() } }
	};
	return JSON.stringify(retargeted, null, 2) + '\n';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
