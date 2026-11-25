// What the Code Quality section, its commands and its results tab are handed.
//
// In the feature's own folder rather than beside the commands: the results tab
// takes these too, and a panel importing its services from the sidebar while
// the sidebar imported the panel was a cycle between two folders.

import type * as vscode from 'vscode';
import type { WritableTicketStore } from '../data/ticketStore';
import type { ScanSettings } from '../settings/scanSettings';
import type { ScanProvider } from './scanProvider';
import type { ScanRunDeps } from './scanRunner';
import type { ScanServerStore } from './scanServerStore';

export interface ScanServices {
	provider: ScanProvider;
	servers: ScanServerStore;
	store: WritableTicketStore;
	/** Read at call time, never captured — the settings may change between runs. */
	settings: () => ScanSettings | undefined;
	workspaceRoot: () => string | undefined;
	workspaceName: () => string | undefined;
	/** The ticket's environment worktree; see `ScanRunDeps.resolveDirectory`. */
	resolveDirectory?: (ticketId: string) => Promise<string | undefined>;
	/** The "BFAST Code Quality" channel, created in `activate()`. */
	output: vscode.OutputChannel;
	/** Repaints the Code Quality section. */
	refresh: () => void;
	/** Stores the token a user pastes. Wired to `SecretStorage` in `activate()`. */
	setToken: () => Promise<void>;
	/** Reveals the generated admin password. */
	showAdminPassword: () => Promise<void>;
	/** Offers each stored credential and copies the chosen one to the clipboard. */
	copyCredential: () => Promise<void>;
	clearCredentials: () => Promise<void>;
}

/**
 * The subset of a `ScanServices` the runner actually takes.
 *
 * Exported because the MCP server's `run_scan` resolves a target the same way
 * this file's `openScan` does, and two copies of this literal is exactly the
 * drift that would let one of them forget `resolveDirectory` and quietly scan
 * the workspace under a ticket's name.
 */
export function scanRunDeps(services: ScanServices): ScanRunDeps {
	return {
		provider: services.provider,
		server: services.servers,
		store: services.store,
		settings: services.settings,
		workspaceRoot: services.workspaceRoot,
		workspaceName: services.workspaceName,
		...(services.resolveDirectory ? { resolveDirectory: services.resolveDirectory } : {})
	};
}
