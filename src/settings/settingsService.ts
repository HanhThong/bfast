import * as os from 'os';
import * as vscode from 'vscode';
import { testsResultsFolder } from './testsSettings';
import {
	BfastSettings,
	DEFAULT_TRACKER_FOLDER,
	normalizeSettings,
	parseSettings,
	SETTINGS_FILE
} from './bfastSettings';

/**
 * Reads and writes `.vscode/bfast.json` for the first workspace folder, and
 * caches the result. Anything that needs the current user name (ticket history)
 * or the tracker folder goes through `current` / `onDidChange` rather than
 * touching the file itself.
 *
 * Without an open folder there is nowhere to store settings, so every method
 * degrades to "not configured".
 */
export class SettingsService {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<BfastSettings>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	private cached: BfastSettings | undefined;

	/** The workspace folder settings are stored in, if a folder is open at all. */
	get workspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	/** Last known settings, or `undefined` until `read()` finds a valid file. */
	get current(): BfastSettings | undefined {
		return this.cached;
	}

	/** What the settings form starts from when nothing is configured yet. */
	defaults(): BfastSettings {
		let userName = '';
		try {
			userName = os.userInfo().username;
		} catch {
			// userInfo() throws when the OS has no entry for the uid; a blank name
			// just means the user fills the field in themselves.
		}
		return { trackerFolder: DEFAULT_TRACKER_FOLDER, userName };
	}

	get settingsUri(): vscode.Uri | undefined {
		const folder = this.workspaceFolder;
		return folder ? vscode.Uri.joinPath(folder.uri, ...SETTINGS_FILE.split('/')) : undefined;
	}

	/** Absolute uri of the configured tracker folder. */
	trackerFolderUri(settings: BfastSettings): vscode.Uri | undefined {
		const folder = this.workspaceFolder;
		return folder
			? vscode.Uri.joinPath(folder.uri, ...settings.trackerFolder.split('/'))
			: undefined;
	}

	/**
	 * Absolute uri of the folder test runs are filed under — `tests.resultsFolder`,
	 * or its default. Workspace-relative like the tracker, and validated the same
	 * way, so it is provably inside a workspace folder the board may load from.
	 */
	testResultsFolderUri(settings: BfastSettings): vscode.Uri | undefined {
		const folder = this.workspaceFolder;
		return folder
			? vscode.Uri.joinPath(folder.uri, ...testsResultsFolder(settings.tests, settings.trackerFolder).split('/'))
			: undefined;
	}

	async exists(): Promise<boolean> {
		const uri = this.settingsUri;
		if (!uri) {
			return false;
		}
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	/** Reads the file into the cache; `undefined` when it is missing or unreadable. */
	async read(): Promise<BfastSettings | undefined> {
		const uri = this.settingsUri;
		if (!uri) {
			return undefined;
		}

		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const settings = parseSettings(JSON.parse(new TextDecoder().decode(bytes)));
			this.cached = settings;
			return settings;
		} catch {
			// Missing file, or JSON we cannot parse — either way there is nothing
			// usable to work from, so the workspace counts as unconfigured.
			this.cached = undefined;
			return undefined;
		}
	}

	/**
	 * Writes the settings file, creating `.vscode` and the tracker folder if they
	 * do not exist yet, then publishes the new values.
	 */
	async write(settings: BfastSettings): Promise<BfastSettings> {
		const uri = this.settingsUri;
		if (!uri) {
			throw new Error('Open a folder before configuring BFAST.');
		}

		const normalized = normalizeSettings(settings);
		const content = `${JSON.stringify(normalized, undefined, 2)}\n`;

		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

		const trackerUri = this.trackerFolderUri(normalized);
		if (trackerUri) {
			await vscode.workspace.fs.createDirectory(trackerUri);
		}

		this.cached = normalized;
		this.onDidChangeEmitter.fire(normalized);
		return normalized;
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}
