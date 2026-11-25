// What the code-scan feature needs from the outside world.
//
// The same shape and the same reasoning as `AiContext` and `EnvironmentContext`:
// every accessor is a function, read at call time rather than captured, so the
// store and the providers can be built before settings have been read from
// disk, and a test can point them at a scratch directory without touching
// `SettingsService`.
//
// One member goes beyond both, and the feature is why: `storeCredentials`. The
// AI half only ever *reads* a credential the user supplied, while `auto` mode
// **mints** one. Something has to write it, and it must not be the store (which
// is `vscode`-free) or the provider (which must not learn where a secret lives),
// so it is here — the one place that knows about `SecretStorage`.

// `import type`, not a plain import: `vscode` is only named here as a type, and
// erasing the require keeps everything downstream loadable outside the host.
import type * as vscode from 'vscode';
import { workspaceSlug } from '../platform/workspaceSlug';
import type { ScanSettings } from '../settings/scanSettings';
import type { SettingsService } from '../settings/settingsService';
import type { ScanCredentials } from './scanProvider';

/**
 * Secret-storage keys, **scoped by workspace**.
 *
 * Unlike the AI keys, which are global on purpose — an Anthropic API key is the
 * user's, not a workspace's — a Sonar token is minted for one particular server.
 * `SecretStorage` is global to the extension, so two workspaces each deploying
 * their own SonarQube would overwrite each other's token on one global key and
 * both stop working, with nothing on screen that says so. The slug is the same
 * one `scanHome()` uses, so a workspace's secrets and its scan folder are named
 * identically.
 */
export const scanAnalysisTokenSecret = (slug: string): string =>
	`bfast.scan.sonarqube.analysisToken:${slug}`;
export const scanResultsTokenSecret = (slug: string): string =>
	`bfast.scan.sonarqube.resultsToken:${slug}`;
export const scanAdminPasswordSecret = (slug: string): string =>
	`bfast.scan.sonarqube.adminPassword:${slug}`;

/** Every key this feature owns, for `bfast.clearScanCredentials`. */
export function scanSecretKeys(slug: string): string[] {
	return [
		scanAnalysisTokenSecret(slug),
		scanResultsTokenSecret(slug),
		scanAdminPasswordSecret(slug)
	];
}

/** The folder holding BFAST's scan homes, one subfolder per workspace. */
export const SCAN_HOME_FOLDER = 'bfast-scan';

export interface ScanContext {
	/** The repo being scanned; `undefined` while no folder is open. */
	workspaceRoot(): string | undefined;
	/** The workspace folder's own name — the default project key comes from it. */
	workspaceName(): string | undefined;
	/** For the compose project name and the secret scope. */
	workspaceSlug(): string | undefined;
	/**
	 * `<os temp>/bfast-scan/<workspace-slug>` — the generated compose file and
	 * the server's state file.
	 *
	 * Outside the workspace on purpose, exactly as `worktreesRoot()` is: BFAST
	 * writes the compose file, the user did not, and a generated file in their
	 * repo is a diff they have to explain in every pull request.
	 */
	scanHome(): string | undefined;
	settings(): ScanSettings | undefined;
	credentials(): Promise<ScanCredentials>;
	/**
	 * Persists what provisioning minted. A **partial** value updates only the
	 * fields it carries, so re-minting a token does not clear the admin password
	 * — which is the difference between "re-provision" and "lock me out".
	 */
	storeCredentials(credentials: ScanCredentials): Promise<void>;
	clearCredentials(): Promise<void>;
}

export function bfastScanContext(
	settings: SettingsService,
	secrets: vscode.SecretStorage,
	tempDir: () => string
): ScanContext {
	const slugOf = (): string | undefined => {
		const folder = settings.workspaceFolder;
		return folder ? workspaceSlug(folder.name) : undefined;
	};

	/** Reads and writes go through the same key set; there is one address for it. */
	const keys = (): {
		analysis: string;
		results: string;
		admin: string;
	} | undefined => {
		const slug = slugOf();
		return slug === undefined
			? undefined
			: {
					analysis: scanAnalysisTokenSecret(slug),
					results: scanResultsTokenSecret(slug),
					admin: scanAdminPasswordSecret(slug)
				};
	};

	return {
		workspaceRoot: () => settings.workspaceFolder?.uri.fsPath,

		workspaceName: () => settings.workspaceFolder?.name,

		workspaceSlug: slugOf,

		scanHome: () => {
			const slug = slugOf();
			// Joined with '/' rather than `path.join`: this module must stay free
			// of Node imports so it can be reached from anywhere, and the callers
			// that touch the filesystem normalise it themselves.
			return slug === undefined ? undefined : `${tempDir()}/${SCAN_HOME_FOLDER}/${slug}`;
		},

		settings: () => settings.current?.scan,

		// Stored secrets win, then the ambient environment — so a CI-shaped
		// machine that already exports `SONAR_TOKEN` gets a working scan with no
		// setup at all. No ambient fallback for the admin password: an ambient
		// one would be a stranger's password reaching BFAST's provisioning.
		credentials: async () => {
			const key = keys();
			if (!key) {
				return {};
			}
			const ambient = process.env.SONAR_TOKEN?.trim();
			const analysisToken = (await secrets.get(key.analysis))?.trim() || ambient;
			const resultsToken = (await secrets.get(key.results))?.trim() || ambient;
			const adminPassword = (await secrets.get(key.admin))?.trim();
			return {
				...(analysisToken ? { analysisToken } : {}),
				...(resultsToken ? { resultsToken } : {}),
				...(adminPassword ? { adminPassword } : {})
			};
		},

		storeCredentials: async (credentials) => {
			const key = keys();
			if (!key) {
				return;
			}
			// `undefined` leaves a field alone; an empty string clears it. That
			// distinction is what makes a partial update safe.
			for (const [name, value] of [
				[key.analysis, credentials.analysisToken],
				[key.results, credentials.resultsToken],
				[key.admin, credentials.adminPassword]
			] as const) {
				if (value === undefined) {
					continue;
				}
				if (value.length > 0) {
					await secrets.store(name, value);
				} else {
					await secrets.delete(name);
				}
			}
		},

		clearCredentials: async () => {
			const slug = slugOf();
			if (slug === undefined) {
				return;
			}
			for (const name of scanSecretKeys(slug)) {
				await secrets.delete(name);
			}
		}
	};
}

/**
 * The environment a scanner child runs in.
 *
 * Credentials reach the subprocess only this way. Never assign to `process.env`
 * — the extension host is shared with every other extension in the window. The
 * same rule, and the same shape, as `agentEnvironment`.
 */
export function scannerEnvironment(options: {
	hostUrl: string;
	projectKey: string;
	organization?: string;
	ticketId?: string;
	credentials: ScanCredentials;
}): NodeJS.ProcessEnv {
	return {
		...process.env,
		SONAR_HOST_URL: options.hostUrl,
		SONAR_PROJECT_KEY: options.projectKey,
		...(options.credentials.analysisToken
			? { SONAR_TOKEN: options.credentials.analysisToken }
			: {}),
		...(options.organization ? { SONAR_ORGANIZATION: options.organization } : {}),
		...(options.ticketId ? { BFAST_TICKET_ID: options.ticketId } : {})
	};
}
