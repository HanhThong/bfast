// What a provider needs from the rest of the extension, read at call time.
//
// The same shape and the same reasoning as `src/data/trackerContext.ts`: every
// accessor is a function, so construction order in `activate()` does not
// matter, settings can still be unread when a provider is built, and a test can
// point a provider at a scratch directory without touching `SettingsService`.

// `import type`, not a plain import: `vscode` is only named here as a type, and
// erasing the require keeps every provider loadable outside the extension host.
import type * as vscode from 'vscode';
import type { AiSettings } from '../settings/aiSettings';
import type { SettingsService } from '../settings/settingsService';

export interface AiCredentials {
	apiKey?: string;
	/** A Claude Code OAuth token, for a machine already signed in to the CLI. */
	oauthToken?: string;
}

export interface AiContext {
	/**
	 * Where file tools resolve — the **workspace folder**, not the tracker
	 * folder. The point of giving the agent a filesystem is that it can read the
	 * source the ticket is about.
	 */
	workingDirectory(): string | undefined;
	credentials(): Promise<AiCredentials>;
	settings(): AiSettings | undefined;
}

/**
 * Secret-storage keys.
 *
 * Credentials live here and nowhere else: `.vscode/bfast.json` is committed to
 * git, so `BfastSettings` deliberately has no field one could be typed into.
 */
export const AI_API_KEY_SECRET = 'bfast.anthropicApiKey';
export const AI_OAUTH_TOKEN_SECRET = 'bfast.claudeCodeOauthToken';

export function bfastAiContext(
	settings: SettingsService,
	secrets: vscode.SecretStorage
): AiContext {
	return {
		workingDirectory: () => settings.workspaceFolder?.uri.fsPath,

		// Stored secrets win, then the ambient environment — so anyone who already
		// exports a key for the CLI gets a working assistant with no setup, and
		// the CLI's own keychain login still works when neither is set.
		credentials: async () => ({
			apiKey:
				(await secrets.get(AI_API_KEY_SECRET))?.trim() || process.env.ANTHROPIC_API_KEY?.trim(),
			oauthToken:
				(await secrets.get(AI_OAUTH_TOKEN_SECRET))?.trim() ||
				process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
		}),

		settings: () => settings.current?.ai
	};
}

/**
 * The environment a child agent runs in.
 *
 * Credentials reach the subprocess only this way. Never assign to
 * `process.env` — the extension host is shared with every other extension in
 * the window.
 */
export function agentEnvironment(credentials: AiCredentials): NodeJS.ProcessEnv {
	return {
		...process.env,
		...(credentials.apiKey ? { ANTHROPIC_API_KEY: credentials.apiKey } : {}),
		...(credentials.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken } : {})
	};
}
