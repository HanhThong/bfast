// The settings form.
//
// One file per webview concern, joined in `index.ts`. See the note there.

import type { AgentDefinition } from '../../ai/agent';
import type { TicketType } from '../../data/types';
import type { BfastSettings } from '../../settings/bfastSettings';
import type { EnvironmentsSettings } from '../../settings/environmentSettings';
// Node-free, for the same reason: the settings form lists Implement's templates.
import type { ImplementPromptInfo } from '../../implement/implementPrompt';
// And again: `mcpServer.ts` opens sockets, so the status it publishes lives in
// its own Node-free module for the settings tab to paint.
import type { McpServerStatus } from '../../mcp/mcpStatus';
import type { McpClientId } from '../../mcp/mcpClients';

/** What this part of the webview sends to the extension host. */
export type SettingsToHost =
	/** Open an agent's role file, or one of its skills, in an ordinary editor tab. */
	| { type: 'openAgent'; slug: string }
	| { type: 'openSkill'; agent: string; skill: string }
	/**
	 * One of a skill's `resources/`, by name. A name rather than a path: the host
	 * resolves the file from the store and never takes a path from the webview.
	 */
	| { type: 'openSkillResource'; agent: string; skill: string; name: string }
	/**
	 * One of Implement's prompt templates, by ticket type. A type rather than a
	 * path, the `openSkillResource` rule: the host resolves the file from the
	 * store, restoring the shipped one when it is missing.
	 */
	| { type: 'openImplementPrompt'; ticketType: TicketType }
	/** The working rules every Implement template shares (`{{rules}}`). */
	| { type: 'openImplementRules' }
	| { type: 'newAgent' }
	| { type: 'newSkill'; agent: string }
	/**
	 * A new design style: the host asks which role, what it is called and what
	 * prefix its files take, then scaffolds the skill and its resource. The
	 * dialogs are the host's, the way `newAgent`'s are.
	 */
	| { type: 'newDesignStyle' }
	/** Give another role an existing style; the host picks which, among those lacking it. */
	| { type: 'addDesignStyle'; style: string }
	| { type: 'settingsReady' }
	| { type: 'pickTrackerFolder' }
	| { type: 'pickWorktreesFolder' }
	/** A folder for the service at `index` of `tests.services` — inside the workspace only. */
	| { type: 'pickServiceFolder'; index: number }
	/**
	 * The service names the compose chain declares, for the Services checklist.
	 * Carries the form's **unsaved** environments block, so a compose file typed
	 * a moment ago is the one read; the host normalises it before using a path.
	 */
	| { type: 'listComposeServices'; environments?: EnvironmentsSettings }
	| { type: 'saveSettings'; settings: BfastSettings }
	| { type: 'cancelSettings' }
	/**
	 * Copy the MCP server's address to the clipboard.
	 *
	 * The host holds the address — it is the listening server's, not something
	 * the form computed — so the webview asks for "the address" rather than
	 * sending one back to be copied, the `openSkillResource` rule.
	 */
	| { type: 'copyMcpAddress' }
	/**
	 * The same rule for one tool's connection snippet, and for saving it into
	 * that tool's project config file: the webview names the tool, the host
	 * builds the snippet from the address it is actually serving on.
	 */
	| { type: 'copyMcpClientSnippet'; client: McpClientId }
	| { type: 'saveMcpClientConfig'; client: McpClientId };

/** What the extension host sends back. */
export type HostToSettings =
	| {
			type: 'settings';
			settings: BfastSettings;
			configured: boolean;
			/** Listed in the form; the files themselves are edited in an editor tab. */
			agents?: AgentDefinition[];
			/** Implement's templates, one per ticket type — listed, edited in an editor tab. */
			implementPrompts?: ImplementPromptInfo[];
			/**
			 * `<os temp>/bfast-worktrees` resolved on **this** machine, for the
			 * worktrees field's placeholder. The webview cannot call `os.tmpdir()`,
			 * and a literal `<os temp>` placeholder tells a user nothing about where
			 * their worktrees actually land.
			 */
			worktreesDefault?: string;
			/**
			 * The running extension's version (`package.json`), shown at the foot of
			 * the form so a user reporting a problem can say which BFAST they have.
			 */
			version?: string;
	  }
	| { type: 'trackerFolderPicked'; folder: string }
	| { type: 'worktreesFolderPicked'; folder: string }
	| { type: 'serviceFolderPicked'; index: number; folder: string }
	/**
	 * `docker compose config --services` over `files`. `error` when it could not
	 * be read — no docker, a missing file — and the form falls back to free text.
	 */
	| { type: 'composeServices'; services: string[]; files: string[]; error?: string }
	| { type: 'settingsSaved' }
	| { type: 'settingsError'; message: string }
	/**
	 * Where the MCP server has got to — pushed on `settingsReady`, after every
	 * save, and whenever the server itself changes state.
	 *
	 * The whole status rather than a flag, because the tab has to say three
	 * different things: that it is running and at what address, that the port is
	 * in use and the settings the user typed are still there to change, or that
	 * it is not listening at all.
	 */
	| { type: 'mcpStatus'; status: McpServerStatus };
