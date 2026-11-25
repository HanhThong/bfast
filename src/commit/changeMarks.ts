// Which ticket folders carry uncommitted changes — the pure half of the
// sidebar's git marks. docs/commit/README.md §Uncommitted changes is the spec.
//
// No `vscode` import: the input is `git status` already parsed, the answer is
// repository-relative folder paths. Turning a folder into a ticket is the
// host's job (`ticketAt`, walked by nesting), because a folder name's id is
// only a claim.

import { parseFolderName } from '../data/trackerPaths';
import type { StatusEntry } from './ticketCommit';

/** `added`: everything in the folder is new to git — a ticket never committed. */
export type ChangeMark = 'modified' | 'added';

type ChangeKind = 'added' | 'deleted' | 'modified';

function kindOf(entry: StatusEntry): ChangeKind {
	if (entry.index === 'D' || entry.worktree === 'D') {
		return 'deleted';
	}
	if (entry.index === '?' || entry.index === 'A') {
		return 'added';
	}
	return 'modified';
}

/**
 * The ticket folder a path belongs to: the deepest run of ticket-named folders
 * under the tracker, so `assets/x.png` and a design document belong to the
 * ticket around them. `undefined` for a file at the tracker's root or under a
 * folder that is not a ticket's.
 */
function ticketFolderOf(path: string, trackerPrefix: string): string | undefined {
	if (!path.startsWith(trackerPrefix)) {
		return undefined;
	}
	const segments = path.slice(trackerPrefix.length).split('/').slice(0, -1);
	const folders: string[] = [];
	for (const segment of segments) {
		if (parseFolderName(segment).id === undefined) {
			break;
		}
		folders.push(segment);
	}
	return folders.length > 0 ? trackerPrefix + folders.join('/') : undefined;
}

function parentAndId(folder: string): { parent: string; id: string | undefined } {
	const slash = folder.lastIndexOf('/');
	return {
		parent: folder.slice(0, slash + 1),
		id: parseFolderName(folder.slice(slash + 1)).id
	};
}

/**
 * Repository-relative ticket folders (no trailing slash) with uncommitted
 * changes of their **own** — a change inside a child folder marks the child.
 *
 * A folder whose every change is an addition is `added`, unless a sibling
 * claiming the same id lost files: BFAST renames a slug with a plain rename,
 * so git sees the old folder deleted and the new one untracked, and a renamed
 * ticket is modified, not new. A folder with only deletions is kept as
 * `modified` — a deleted design document — and the host drops it when no
 * ticket lives there any more.
 */
export function changedTicketFolders(
	entries: readonly StatusEntry[],
	trackerPrefix: string
): Map<string, ChangeMark> {
	const kinds = new Map<string, Set<ChangeKind>>();
	const note = (path: string, kind: ChangeKind): void => {
		const folder = ticketFolderOf(path, trackerPrefix);
		if (folder !== undefined) {
			kinds.set(folder, (kinds.get(folder) ?? new Set()).add(kind));
		}
	};
	for (const entry of entries) {
		note(entry.path, entry.origin === undefined ? kindOf(entry) : 'modified');
		if (entry.origin !== undefined) {
			note(entry.origin, 'deleted');
		}
	}

	/** `parent + id` of every folder that lost a file — where a renamed ticket used to be. */
	const lostFiles = new Set<string>();
	for (const [folder, set] of kinds) {
		const { parent, id } = parentAndId(folder);
		if (set.has('deleted') && id !== undefined) {
			lostFiles.add(`${parent}\0${id}`);
		}
	}

	const marks = new Map<string, ChangeMark>();
	for (const [folder, set] of kinds) {
		const { parent, id } = parentAndId(folder);
		const renamed = id !== undefined && lostFiles.has(`${parent}\0${id}`) && !set.has('deleted');
		marks.set(folder, set.size === 1 && set.has('added') && !renamed ? 'added' : 'modified');
	}
	return marks;
}
