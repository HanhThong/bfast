// Commit Ticket's share of activation: one command, handed the tracker's store
// and the `git` block read at call time — and the sidebar's marks for tickets
// with uncommitted changes.

import type * as vscode from 'vscode';
import type { TicketStore } from '../data/ticketStore';
import { registerCommitCommands } from '../commit/commitCommand';
import { TicketChangeDecorations } from '../commit/ticketChangeDecorations';
import { runProcess } from '../platform/runProcess';
import type { BfastSettings } from '../settings/bfastSettings';
import type { CoreServices, FeatureModule } from './core';

export interface CommitModuleDeps {
	store: TicketStore;
}

export interface CommitModule extends FeatureModule {
	/** Look for uncommitted changes again — the tracker refreshed. */
	refreshMarks(): void;
}

export function activateCommit(core: CoreServices, deps: CommitModuleDeps): CommitModule {
	let current: BfastSettings | undefined;
	const trackerFolder = (): vscode.Uri | undefined =>
		current ? core.settings.trackerFolderUri(current) : undefined;

	const marks = new TicketChangeDecorations({
		store: deps.store,
		runner: runProcess,
		trackerFolder
	});

	return {
		refreshMarks: () => marks.update(),
		onSettingsApplied(settings) {
			current = settings;
			marks.update();
		},
		disposables: [
			marks,
			...registerCommitCommands({
				store: deps.store,
				runner: runProcess,
				settings: () => core.workspace.block('git'),
				onCommitted: () => marks.update()
			})
		]
	};
}
