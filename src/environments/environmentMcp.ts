// A new environment's own MCP server port.
//
// The worktree is a second checkout of the repository, `.vscode/bfast.json`
// included, so the window opened on it would ask for the very port the
// workspace's own window listens on — and the committed `.mcp.json` would point
// every coding agent opened there at the workspace's server rather than the
// worktree's. Create therefore moves the worktree to a port of its own before
// anything opens it: `mcp.port` in its settings file and the `bfast` entry of
// each connection file `mcpClients.ts` knows, rewritten **in the worktree
// only**, then hidden from git there with skip-worktree so the port can never
// travel back with the branch.
//
// `vscode`-free, like the store that calls it: files through `fs/promises`,
// git through the injected `ProcessRunner`, the liveness check through the
// injected probe. docs/environments/README.md §The MCP server in an environment
// is the spec.

import { readFile, writeFile } from 'fs/promises';
import * as path from 'path';
import { MCP_CLIENTS, retargetMcpClientConfig } from '../mcp/mcpClients';
import { SETTINGS_FILE } from '../settings/bfastSettings';
import { MAX_MCP_PORT, mcpEnabled, mcpPort, parseMcpSettings } from '../settings/mcpSettings';
import { EnvironmentCancelledError } from './environmentProvider';
import { skipWorktree, type GitOutput } from './gitWorktree';
import { probePort, type PortProbe } from './portAllocator';
import type { ProcessRunner } from '../platform/runProcess';
import { errorMessage } from '../platform/errors';

export interface EnvironmentMcpRequest {
	/** Runs git, for the skip-worktree marks. */
	runner: ProcessRunner;
	worktreePath: string;
	/**
	 * Ports already claimed whether or not anything listens on them right now:
	 * every environment's stack ports and every other environment's MCP port.
	 * The configured port needs no entry — the search starts above it.
	 */
	reserved: ReadonlySet<number>;
	/** Defaults to a real bind attempt. */
	probe?: PortProbe;
	onOutput?: GitOutput;
}

export interface EnvironmentMcpPort {
	/** The port the checkout's settings named — the workspace's own. */
	from: number;
	/** The worktree's port from now on. */
	to: number;
	/** Every file rewritten, worktree-relative and `/`-separated, settings first. */
	files: string[];
	/** The subset git tracks, now marked skip-worktree in the worktree's index. */
	hidden: string[];
	/**
	 * What did not follow once the settings file had moved — a connection file
	 * that could not be written, git refusing the mark. Said, not thrown: the
	 * settings file already names `to`, so the caller must still record it.
	 */
	problems: string[];
}

/**
 * Moves the worktree's MCP server to a port of its own.
 *
 * `undefined` when there is nothing to move: no settings file in the checkout,
 * or a server that is switched off and so asks for no port. Throws — before
 * writing anything — when the settings file is not a JSON object or no port
 * above the configured one is free; and passes a cancel through from git.
 */
export async function giveEnvironmentMcpPort(
	request: EnvironmentMcpRequest
): Promise<EnvironmentMcpPort | undefined> {
	const { worktreePath } = request;
	const settingsPath = path.join(worktreePath, ...SETTINGS_FILE.split('/'));

	let text: string;
	try {
		text = await readFile(settingsPath, 'utf8');
	} catch {
		return undefined;
	}
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		throw new Error(`${SETTINGS_FILE} in the worktree could not be read as JSON`);
	}
	if (!isPlainObject(root)) {
		throw new Error(`${SETTINGS_FILE} in the worktree does not hold a JSON object`);
	}

	const mcp = parseMcpSettings(root.mcp);
	if (!mcpEnabled(mcp)) {
		return undefined;
	}
	const from = mcpPort(mcp);
	const to = await freePortAbove(from, request.reserved, request.probe ?? probePort);
	if (to === undefined) {
		throw new Error(`no port above ${from} is free`);
	}

	// Raw JSON rather than `normalizeSettings`, which rebuilds a literal and
	// would drop any key this version of BFAST does not know. Spreading keeps
	// every key where it was, `port` included.
	const block = isPlainObject(root.mcp) ? root.mcp : {};
	const moved = { ...root, mcp: { ...block, port: to } };
	await writeFile(settingsPath, `${JSON.stringify(moved, undefined, 2)}\n`, 'utf8');

	const files = [SETTINGS_FILE];
	const problems: string[] = [];
	for (const client of MCP_CLIENTS) {
		const file = client.projectFile;
		if (!file) {
			continue;
		}
		const target = path.join(worktreePath, ...file.path.split('/'));
		let existing: string;
		try {
			existing = await readFile(target, 'utf8');
		} catch {
			// Not in the checkout: nothing points at the old port.
			continue;
		}
		const retargeted = retargetMcpClientConfig(client.id, existing, from, to);
		if (retargeted === undefined) {
			continue;
		}
		try {
			await writeFile(target, retargeted, 'utf8');
			files.push(file.path);
		} catch (error) {
			problems.push(`${file.path} could not be written (${describe(error)})`);
		}
	}

	let hidden: string[] = [];
	try {
		hidden = await skipWorktree(request.runner, worktreePath, files, request.onOutput);
	} catch (error) {
		if (error instanceof EnvironmentCancelledError) {
			throw error;
		}
		problems.push(`git could not hide ${files.join(', ')} (${describe(error)}) — do not commit them`);
	}

	return { from, to, files, hidden, problems };
}

/**
 * The first port above `from` that nothing claims and that binds right now.
 * Above, never below: a workspace on 17711 hands out 17712, 17713, … in the
 * order environments are created, which reads as belonging to it.
 */
async function freePortAbove(
	from: number,
	reserved: ReadonlySet<number>,
	probe: PortProbe
): Promise<number | undefined> {
	for (let port = from + 1; port <= MAX_MCP_PORT; port++) {
		if (!reserved.has(port) && (await probe(port))) {
			return port;
		}
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return errorMessage(error);
}
