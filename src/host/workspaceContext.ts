// The workspace and its settings, read at call time.
//
// Every feature needs the same handful of answers — where is the workspace,
// what does `bfast.json` say about my block, who is the author — and each used
// to be handed its own closures for them, one `() => settings.current?.tests`
// at a time. This is those closures once.
//
// Nothing here is captured: settings are read asynchronously after
// `activate()` returns and change on every save, so every member goes back to
// the `SettingsService` when it is called. That is what makes the order things
// are built in irrelevant.

import * as vscode from 'vscode';
import type { BfastSettings, SettingsBlockKey } from '../settings/bfastSettings';
import type { SettingsService } from '../settings/settingsService';

export interface WorkspaceContext {
	/** The workspace folder BFAST is configured in, if a folder is open. */
	folder(): vscode.WorkspaceFolder | undefined;
	/** That folder's absolute path. */
	root(): string | undefined;
	/** Its name, as the explorer shows it. */
	name(): string | undefined;
	/** The settings as last read; `undefined` until `bfast.json` exists. */
	settings(): BfastSettings | undefined;
	/** One optional block of the settings — `block('tests')`, `block('ai')`. */
	block<K extends SettingsBlockKey>(key: K): BfastSettings[K];
	/** The tracker folder, workspace-relative. */
	trackerFolder(): string | undefined;
	/** The name stamped on what this user writes; never empty. */
	author(): string;
}

export function workspaceContext(settings: SettingsService): WorkspaceContext {
	return {
		folder: () => settings.workspaceFolder,
		root: () => settings.workspaceFolder?.uri.fsPath,
		name: () => settings.workspaceFolder?.name,
		settings: () => settings.current,
		block: (key) => settings.current?.[key],
		trackerFolder: () => settings.current?.trackerFolder,
		author: () => settings.current?.userName?.trim() || 'Unknown'
	};
}
