// The scan server's state file: `server.json` inside BFAST's scan home.
//
// The deployed server's identity — which tool, which compose project, which
// allocated host port — written once at deploy. It is what makes the sidebar's
// inventory a disk read rather than a second registry that can fall out of step
// with Docker, exactly as `environmentMarker.ts` is for environments.
//
// It lives outside the workspace for the reason the whole scan home does: BFAST
// writes it, the user did not, and a generated file in their repo is a diff
// they have to explain. `sourceRoot` is what keeps a same-named *other*
// workspace's state file from being read as this one's — the bug the
// environment marker's own `sourceRoot` already fixes.
//
// Reading is forgiving, like every parser in the tracker: a hand-damaged file
// yields `undefined` and the server reads as absent, never an exception.

import {
	MAX_SCAN_PORT,
	MIN_SCAN_PORT,
	SCAN_MODES,
	SCAN_TOOL_IDS,
	type ScanMode,
	type ScanToolId
} from '../settings/scanSettings';
import type { ScanServerDescriptor } from './scanProvider';

export const SCAN_STATE_FILE = 'server.json';

export interface ScanServerState {
	version: 1;
	tool: ScanToolId;
	mode: ScanMode;
	/** The compose project name — `bfast-sonar-<workspace-slug>`. */
	projectName: string;
	/** The allocated host port. */
	port?: number;
	/** ISO 8601. */
	createdAt: string;
	/** The workspace this server belongs to; a different one's file is ignored. */
	sourceRoot?: string;
}

/**
 * Never throws. `undefined` when `tool` or `projectName` is unusable — without
 * those the folder describes no server. Everything else degrades field by field.
 */
export function parseScanServerState(raw: unknown): ScanServerState | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const source = raw as Partial<Record<keyof ScanServerState, unknown>>;

	if (!SCAN_TOOL_IDS.includes(source.tool as ScanToolId)) {
		return undefined;
	}
	const projectName =
		typeof source.projectName === 'string' ? source.projectName.trim() : '';
	if (projectName.length === 0) {
		return undefined;
	}

	// A mode that is not one of ours falls back rather than rejecting the file:
	// the server exists either way, and refusing to see it would leave a running
	// container the user cannot stop from the sidebar.
	const mode = SCAN_MODES.includes(source.mode as ScanMode) ? (source.mode as ScanMode) : 'auto';

	const port =
		typeof source.port === 'number' &&
		Number.isInteger(source.port) &&
		source.port >= MIN_SCAN_PORT &&
		source.port <= MAX_SCAN_PORT
			? source.port
			: undefined;

	const createdAt =
		typeof source.createdAt === 'string' && source.createdAt.trim().length > 0
			? source.createdAt.trim()
			: new Date(0).toISOString();

	const sourceRoot =
		typeof source.sourceRoot === 'string' && source.sourceRoot.trim().length > 0
			? source.sourceRoot.trim()
			: undefined;

	return {
		version: 1,
		tool: source.tool as ScanToolId,
		mode,
		projectName,
		...(port === undefined ? {} : { port }),
		createdAt,
		...(sourceRoot === undefined ? {} : { sourceRoot })
	};
}

/** 2-space JSON with a trailing newline, the way every file BFAST writes looks. */
export function serializeScanServerState(state: ScanServerState): string {
	return `${JSON.stringify(state, undefined, 2)}\n`;
}

export function stateToDescriptor(state: ScanServerState, home: string): ScanServerDescriptor {
	return {
		tool: state.tool,
		mode: state.mode,
		projectName: state.projectName,
		home,
		...(state.port === undefined ? {} : { port: state.port }),
		createdAt: state.createdAt
	};
}

/**
 * True when the state file belongs to this workspace.
 *
 * Absent `sourceRoot` counts as ours: a file written before the field existed
 * must not make an existing server vanish from the sidebar. Case-insensitive so
 * a workspace opened as `d:\proj` matches one recorded as `D:\Proj`.
 */
export function belongsTo(state: ScanServerState, workspaceRoot: string | undefined): boolean {
	if (state.sourceRoot === undefined || workspaceRoot === undefined) {
		return true;
	}
	return state.sourceRoot.toLowerCase() === workspaceRoot.toLowerCase();
}
