// The `vscode` half of letting a board run edit other tickets: what a run is
// allowed to touch, and what to do about what it touched.
//
// Thin on purpose. Every decision lives in `trackerEdits.ts` (pure) and in
// `FileTicketStore.adoptDescription` (tested against a scratch tracker); this
// file only reads the tickets on disk into rules, writes the settings file a
// run is started with, and afterwards walks the log through the store.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AiRequest } from './aiProvider';
import type { TrackerEditPolicy } from './promptTemplate';
import {
	contentFileUnder,
	editRulesFor,
	previousText,
	runSettingsJson,
	TrackerEditLog,
	type EditableFile
} from './trackerEdits';
import type { WritableTicketStore } from '../data/ticketStore';
import { TYPE_FILE } from '../data/trackerPaths';
import type { AiEditedTicket } from '../shared/protocol';

/** Everything a run needs to be allowed to edit, and the means to take it back. */
export interface RunEdits {
	request: NonNullable<AiRequest['edits']>;
	policy: TrackerEditPolicy;
	/** Removes the settings file. Best effort; a leftover is a small json in the temp folder. */
	dispose(): Promise<void>;
}

/**
 * The rules for one board run: one `Edit` allow per content file that exists
 * right now, written to a settings file in the temp folder.
 *
 * `undefined` when the store has no folders to name — a run then stays
 * read-only rather than being handed a rule that matches nothing.
 */
export async function prepareRunEdits(
	store: WritableTicketStore,
	workspace: vscode.Uri,
	trackerFolder: string,
	own: { id: string; parentId?: string }
): Promise<RunEdits | undefined> {
	if (!store.folderUri) {
		return undefined;
	}

	const files: EditableFile[] = [];
	const paths = new Map<string, string>();
	for (const ticket of await store.listSummaries()) {
		const folder = await store.folderUri(ticket.id);
		if (!folder) {
			continue;
		}
		const relative = path.posix.join(
			path.relative(workspace.fsPath, folder.fsPath).split(path.sep).join('/'),
			TYPE_FILE[ticket.type]
		);
		files.push({ id: ticket.id, type: ticket.type, path: relative });
		paths.set(ticket.id, relative);
	}
	if (files.length === 0) {
		return undefined;
	}

	const rules = editRulesFor(files, own.id);
	const settingsFile = vscode.Uri.file(
		path.join(os.tmpdir(), `bfast-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`)
	);
	await vscode.workspace.fs.writeFile(settingsFile, new TextEncoder().encode(runSettingsJson(rules)));

	const parent = own.parentId ? await store.getSummary(own.parentId) : undefined;
	const parentPath = own.parentId ? paths.get(own.parentId) : undefined;

	return {
		request: { settingsFile: settingsFile.fsPath, tools: rules.tools },
		policy: {
			trackerFolder,
			ownPath: paths.get(own.id),
			...(parent && parentPath ? { parent: { id: parent.id, title: parent.title, path: parentPath } } : {})
		},
		dispose: async () => {
			try {
				await vscode.workspace.fs.delete(settingsFile, { useTrash: false });
			} catch {
				// Already gone, or the temp folder refused; nothing to do about it.
			}
		}
	};
}

/** A log wired to this workspace's files and this store's `updatedAt`. */
export function trackerEditLog(
	store: WritableTicketStore,
	cwd: string,
	trackerFolder: string
): TrackerEditLog {
	return new TrackerEditLog({
		cwd,
		trackerRoot: trackerFolder,
		read: (file) => readText(file),
		updatedAt: async (file) => {
			const ticket = await store.ticketAt?.(vscode.Uri.file(file));
			return ticket ? (await store.getDetail(ticket.id))?.updatedAt : undefined;
		}
	});
}

/**
 * Records what the run changed. Runs on every exit — a stopped run's edits are
 * on disk all the same — and never on the ticket the run was writing: that one
 * comes back as the draft, and a file edit of it is ignored, not adopted.
 */
export async function adoptTrackerEdits(
	log: TrackerEditLog,
	store: WritableTicketStore,
	own: string,
	comment: string
): Promise<AiEditedTicket[]> {
	const edited: AiEditedTicket[] = [];
	for (const edit of await log.settle()) {
		const ticket = await store.ticketAt?.(vscode.Uri.file(edit.path));
		if (!ticket) {
			edited.push({ id: edit.path, title: path.basename(path.dirname(edit.path)), adopted: false, reason: 'unknown-ticket' });
			continue;
		}
		if (ticket.id === own) {
			edited.push({ id: ticket.id, title: ticket.title, adopted: false, reason: 'own-ticket' });
			continue;
		}

		// A snapshot taken on a read is the text before the edit. One taken on the
		// edit itself may already be after it, so the edits are reversed instead —
		// and when that is ambiguous, no `from` is claimed at all.
		const snapshot = edit.snapshot;
		const text = !snapshot
			? undefined
			: !snapshot.unsafe
				? snapshot.text
				: previousText((await readText(edit.path)) ?? '', edit.edits);
		const outcome = await store.adoptDescription(
			ticket.id,
			snapshot ? { text, updatedAt: snapshot.updatedAt } : undefined,
			{ comment }
		);
		edited.push({
			id: ticket.id,
			title: ticket.title,
			adopted: outcome.outcome === 'recorded',
			...(outcome.outcome === 'recorded' ? {} : { reason: outcome.outcome })
		});
	}
	return edited;
}

/** Whether a path a tool reported is a content file under the tracker. */
export function isTrackerContentFile(cwd: string, trackerFolder: string, filePath: string): boolean {
	return contentFileUnder(cwd, trackerFolder, filePath) !== undefined;
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
	} catch {
		return undefined;
	}
}
