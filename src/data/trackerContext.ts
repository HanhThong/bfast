import * as vscode from 'vscode';
import { SettingsService } from '../settings/settingsService';

/**
 * Everything `FileTicketStore` needs from the outside world, which is only the
 * tracker's location and a name to stamp on history entries.
 *
 * Both are read at call time rather than captured, so the store can be built
 * before settings have been read from disk — and so a test can point it at a
 * scratch folder without writing a real `bfast.json`.
 */
export interface TrackerContext {
	/** Absolute uri of the tracker root, or `undefined` while unconfigured. */
	rootUri(): vscode.Uri | undefined;
	/** The author recorded against changes this session makes. */
	author(): string;
}

export function settingsTrackerContext(settings: SettingsService): TrackerContext {
	return {
		rootUri: () => {
			const current = settings.current;
			return current ? settings.trackerFolderUri(current) : undefined;
		},
		author: () => settings.current?.userName?.trim() || 'unknown'
	};
}
