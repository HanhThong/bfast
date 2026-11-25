// The marker files.
//
// `.bfast/environment.json` inside a worktree is a ticket environment's
// identity — which ticket, which branch, which allocated port belongs to
// which variable, which port its own MCP server was moved to — written once
// at creation. It is what makes the worktree
// window self-describing (activation reads it to open the story's board) and
// what makes the sidebar's inventory a disk scan: the store lists whatever
// markers exist, so there is no second registry to fall out of step.
//
// `master.json` directly under the worktrees root is the **master**
// environment's: the stack that runs in the workspace folder itself. It lives
// beside the worktrees rather than in the repo so it can never be committed,
// and a worktree window finds it by the same parent-folder rule it uses to
// find its siblings. It is a file, not a folder, so `git worktree prune` and
// `resolveWorktreeHome` never mistake it for a checkout — and a master-shaped
// marker that turns up *inside* a worktree folder is a stray, never counted.
//
// Reading is forgiving, like every parser in the tracker: a hand-damaged
// marker yields `undefined` and the folder is skipped, never an exception.

import {
	ENVIRONMENT_PROVIDER_IDS,
	MAX_PORT,
	MIN_PORT,
	type EnvironmentProviderId
} from '../settings/environmentSettings';
import { MAX_MCP_PORT, MIN_MCP_PORT } from '../settings/mcpSettings';
import {
	MASTER_ENVIRONMENT_ID,
	environmentProjectName,
	type EnvironmentDescriptor
} from './environmentProvider';

export const MARKER_DIR = '.bfast';
export const MARKER_FILE = '.bfast/environment.json';
/** The master environment's marker, relative to the worktrees root. */
export const MASTER_MARKER_FILE = 'master.json';

/** What compose accepts as a project name — the stricter of compose and k8s. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

interface MarkerBase {
	version: 1;
	kind: EnvironmentProviderId;
	/** Port-variable name → allocated port. */
	ports: Record<string, number>;
	/** Which `ports` entry is the main one; explicit because JSON keys carry no order. */
	mainPort?: string;
	/** ISO 8601. */
	createdAt: string;
}

export interface TicketEnvironmentMarker extends MarkerBase {
	/**
	 * Never written: a ticket marker predates the field, and omitting it keeps
	 * every existing file byte-identical on its next read and write.
	 */
	scope?: 'ticket';
	ticketId: string;
	branch: string;
	/** The repo the worktree came from — lets `list()` skip another repo's markers. */
	sourceRoot?: string;
	/**
	 * The worktree's own MCP server port, when create gave it one — recorded so
	 * the next create keeps clear of it while this worktree's window is closed
	 * and nothing is listening on it. Absent when the server was off.
	 */
	mcpPort?: number;
}

export interface MasterEnvironmentMarker extends MarkerBase {
	scope: 'master';
	/**
	 * Recorded rather than derived: the compose project is the one thing Start
	 * and Delete must never disagree on, and a renamed workspace folder would
	 * otherwise orphan a stack with its volumes.
	 */
	projectName: string;
	/** Required here: it is also the folder the stack runs in. */
	sourceRoot: string;
}

export type EnvironmentMarker = TicketEnvironmentMarker | MasterEnvironmentMarker;

/**
 * Never throws. `undefined` when the marker cannot name an environment: an
 * unknown `kind`, a ticket marker with no `ticketId`, a master marker with no
 * usable `projectName` or `sourceRoot`. Everything else degrades field by
 * field.
 */
export function parseEnvironmentMarker(raw: unknown): EnvironmentMarker | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;

	if (!ENVIRONMENT_PROVIDER_IDS.includes(source.kind as EnvironmentProviderId)) {
		return undefined;
	}
	const kind = source.kind as EnvironmentProviderId;

	const ports: Record<string, number> = {};
	if (typeof source.ports === 'object' && source.ports !== null) {
		for (const [name, value] of Object.entries(source.ports)) {
			if (isPort(value)) {
				ports[name] = value;
			}
		}
	}

	// Own-property check, not `in` or a plain read — both walk the prototype
	// chain, so a marker naming `toString` would claim a main port that has no
	// allocated value.
	const mainPort =
		typeof source.mainPort === 'string' &&
		Object.prototype.hasOwnProperty.call(ports, source.mainPort)
			? source.mainPort
			: undefined;

	const sourceRoot =
		typeof source.sourceRoot === 'string' && source.sourceRoot.trim().length > 0
			? source.sourceRoot
			: undefined;

	const createdAt = typeof source.createdAt === 'string' ? source.createdAt : '';

	if (source.scope === 'master') {
		const projectName = typeof source.projectName === 'string' ? source.projectName.trim() : '';
		if (!PROJECT_NAME.test(projectName) || !sourceRoot) {
			return undefined;
		}
		return {
			version: 1,
			scope: 'master',
			kind,
			projectName,
			ports,
			...(mainPort ? { mainPort } : {}),
			createdAt,
			sourceRoot
		};
	}

	const ticketId = typeof source.ticketId === 'string' ? source.ticketId.trim() : '';
	if (ticketId.length === 0) {
		return undefined;
	}
	// The MCP server's own bounds, not the stack's: it may listen below 1024.
	const mcpPort = isPort(source.mcpPort, MIN_MCP_PORT, MAX_MCP_PORT) ? source.mcpPort : undefined;
	return {
		version: 1,
		ticketId,
		kind,
		branch: typeof source.branch === 'string' ? source.branch.trim() : '',
		ports,
		...(mainPort ? { mainPort } : {}),
		createdAt,
		...(sourceRoot ? { sourceRoot } : {}),
		...(mcpPort === undefined ? {} : { mcpPort })
	};
}

function isPort(value: unknown, min = MIN_PORT, max = MAX_PORT): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Stable two-space JSON with a trailing newline, like `bfast.json`. */
export function serializeEnvironmentMarker(marker: EnvironmentMarker): string {
	return `${JSON.stringify(marker, undefined, 2)}\n`;
}

/**
 * `worktreePath` is the folder the stack runs in — the worktree for a ticket,
 * the repo itself for the master environment (the caller passes the window's
 * live path, not the marker's `sourceRoot`; the two are the same folder). A
 * ticket's project name is derived here and nowhere else.
 */
export function markerToDescriptor(
	marker: EnvironmentMarker,
	worktreePath: string
): EnvironmentDescriptor {
	const shared = {
		kind: marker.kind,
		worktreePath,
		ports: marker.ports,
		...(marker.mainPort ? { mainPort: marker.mainPort } : {}),
		createdAt: marker.createdAt
	};
	if (marker.scope === 'master') {
		return {
			id: MASTER_ENVIRONMENT_ID,
			scope: 'master',
			branch: '',
			projectName: marker.projectName,
			...shared
		};
	}
	return {
		id: marker.ticketId,
		scope: 'ticket',
		ticketId: marker.ticketId,
		branch: marker.branch,
		projectName: environmentProjectName(marker.ticketId),
		...shared
	};
}
