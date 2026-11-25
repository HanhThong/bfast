// What every feature module is handed, and what it hands back.
//
// `activate()` used to be one function that built every feature, knew which
// tree had to be told what on a settings change, and held each feature's
// one-off dialogs besides. A module is one feature's share of that: it builds
// its own stores, views and commands from `CoreServices` plus whatever it needs
// of other features — passed in explicitly, so a dependency between two
// features is an argument someone can read rather than a closure over a local.

import type * as vscode from 'vscode';
import type { WorkspaceContext } from '../host/workspaceContext';
import type { BfastSettings } from '../settings/bfastSettings';
import type { SettingsService } from '../settings/settingsService';

export interface CoreServices {
	extension: vscode.ExtensionContext;
	settings: SettingsService;
	/** The workspace and its settings, read at call time. */
	workspace: WorkspaceContext;
}

export interface FeatureModule {
	/** Everything to dispose with the extension, in the order it was made. */
	readonly disposables: readonly vscode.Disposable[];
	/**
	 * The settings were read — at activation, on a save, or on Refresh.
	 * `undefined` means there is no `bfast.json` yet. Called for every module
	 * in activation order, whether or not anything moved: a module that only
	 * cares about a change compares for itself.
	 */
	onSettingsApplied?(current: BfastSettings | undefined): void;
}
