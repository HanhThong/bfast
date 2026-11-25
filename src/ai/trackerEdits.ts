// What a board run may edit in the tracker, and what it actually did.
//
// Pure — Node's `path` and nothing else — so the two halves of the feature are
// testable without a provider or a webview: `editRulesFor` turns the tickets on
// disk into the permission rules a run is handed, and `TrackerEditLog` turns
// the run's tool events into the list of files the host has to adopt.
//
// Two facts from the permission spike shape everything here:
//
//   - `Edit` on a path that does not exist **creates** the file (an empty
//     `old_string`), and an `Edit(...)` rule is a write-path rule that admits
//     it. So "only existing tickets" cannot be a glob — the allow list names
//     every content file that exists when the run starts, one rule each, and a
//     path that is not on it is refused by `dontAsk` before anything is written.
//   - A rule inside a `--settings` file survives commas and parentheses in a
//     folder name; the same rule on the command line is split on the comma.
//     Ticket slugs keep both characters, so the rules travel in a file.

import * as path from 'node:path';
import { TYPE_FILE } from '../data/trackerPaths';
import type { TicketType } from '../data/types';

/** The built-in tools a board run gets: the read-only three, plus `Edit`. */
export const EDIT_RUN_TOOLS = ['Read', 'Glob', 'Grep', 'Edit'] as const;

/**
 * The file-writing tools that must not exist for the run at all. `Edit` is
 * bounded by its rules; these are not, and a deny rule beats every allow.
 */
export const DENIED_TOOLS = ['Write', 'NotebookEdit', 'MultiEdit'] as const;

/** A ticket's content file, as the run will see it. */
export interface EditableFile {
	id: string;
	type: TicketType;
	/** Workspace-relative, forward slashes: `.tracker/EP-1-Auth/Epic.mdx`. */
	path: string;
}

/** The `permissions` block of the settings file a run is started with. */
export interface RunPermissions {
	tools: readonly string[];
	allow: string[];
	deny: string[];
}

/**
 * One allow rule per content file, and a deny rule for the ticket being
 * written — its description is the run's *answer*, and two sources of truth
 * for one document is the failure every conflict check exists to prevent.
 *
 * Strict on the way in: a path that is absolute, escapes the workspace or is
 * not a content file is a programming error, not a file to skip.
 */
export function editRulesFor(files: readonly EditableFile[], ownId?: string): RunPermissions {
	const allow: string[] = [];
	const deny: string[] = [...DENIED_TOOLS];

	for (const file of files) {
		assertContentPath(file);
		const rule = `Edit(${file.path})`;
		if (file.id === ownId) {
			deny.push(rule);
		} else {
			allow.push(rule);
		}
	}

	return { tools: EDIT_RUN_TOOLS, allow, deny };
}

/** The settings file itself, ready to be written and named to the provider. */
export function runSettingsJson(permissions: RunPermissions): string {
	return JSON.stringify(
		{ permissions: { allow: permissions.allow, deny: permissions.deny } },
		null,
		'\t'
	);
}

function assertContentPath(file: EditableFile): void {
	const segments = file.path.split('/');
	if (
		path.isAbsolute(file.path) ||
		file.path.includes('\\') ||
		segments.some((segment) => segment === '..' || segment === '') ||
		segments[segments.length - 1] !== TYPE_FILE[file.type]
	) {
		throw new Error(`${file.path} is not a workspace-relative content file of a ${file.type}.`);
	}
}

/**
 * Whether `filePath` — as a tool reported it, relative or absolute — is a
 * content file under the tracker, and where. `undefined` for everything else,
 * including a file the rules would never have admitted: the log is the second
 * check, not the only one.
 */
export function contentFileUnder(
	cwd: string,
	trackerRoot: string,
	filePath: string
): string | undefined {
	const absolute = path.resolve(cwd, filePath);
	const root = path.resolve(cwd, trackerRoot);
	const relative = path.relative(root, absolute);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	const contentFiles = Object.values(TYPE_FILE) as string[];
	return contentFiles.includes(path.basename(absolute)) ? absolute : undefined;
}

/** A tool call as the stream reports it, reduced to what adoption needs. */
export type ToolEvent =
	| {
			kind: 'use';
			id: string;
			name: string;
			filePath?: string;
			edit?: { oldString: string; newString: string; replaceAll: boolean };
	  }
	| { kind: 'result'; id: string; error: boolean };

/** What the log knew about a file before the run touched it. */
export interface Snapshot {
	text: string;
	/** The ticket's `updatedAt` at the same moment, or `undefined` when unread. */
	updatedAt?: string;
	/**
	 * Taken on an `Edit` rather than a `Read`, so it may already be the edited
	 * text: the host reads asynchronously, and the CLI runs the tool the moment
	 * it has announced it.
	 */
	unsafe: boolean;
}

/** One content file the run edited, with what the host can say about it. */
export interface TrackerEdit {
	/** Absolute. */
	path: string;
	snapshot?: Snapshot;
	/** The successful `Edit`s, in order, for reconstructing `previous`. */
	edits: { oldString: string; newString: string; replaceAll: boolean }[];
}

export interface TrackerEditLogOptions {
	cwd: string;
	trackerRoot: string;
	/** The raw bytes of a file, decoded — `undefined` when it cannot be read. */
	read: (absolutePath: string) => Promise<string | undefined>;
	/** The `updatedAt` of the ticket whose content file this is. */
	updatedAt: (absolutePath: string) => Promise<string | undefined>;
}

/**
 * Observes a run's tool events and answers, at the end, which content files
 * it changed and what they held before.
 *
 * Two rules, both from the spike:
 *
 *   - **The first event naming a file takes the snapshot, and nothing overwrites
 *     it.** On a `Read` it is certainly the pre-edit text (a read changes nothing,
 *     and the edit that follows is a whole model turn away); on an `Edit` it may
 *     not be, and is marked `unsafe`. A later `Read` — the agent checking its own
 *     work — must never replace it, or the file would look unchanged.
 *   - **A file counts as edited only when an `Edit` of it succeeded**, read off
 *     the `tool_result`. A rule denial and a mismatched `old_string` both look
 *     like an `Edit` in the request stream.
 */
export class TrackerEditLog {
	private readonly snapshots = new Map<string, Promise<Snapshot | undefined>>();
	private readonly pending = new Map<string, { path: string; edit: TrackerEdit['edits'][number] }>();
	private readonly edits = new Map<string, TrackerEdit['edits']>();

	constructor(private readonly options: TrackerEditLogOptions) {}

	observe(event: ToolEvent): void {
		if (event.kind === 'result') {
			const use = this.pending.get(event.id);
			this.pending.delete(event.id);
			if (use && !event.error) {
				const list = this.edits.get(use.path) ?? [];
				list.push(use.edit);
				this.edits.set(use.path, list);
			}
			return;
		}

		if (!event.filePath) {
			return;
		}
		const file = contentFileUnder(this.options.cwd, this.options.trackerRoot, event.filePath);
		if (!file) {
			return;
		}

		if (!this.snapshots.has(file)) {
			this.snapshots.set(file, this.snapshot(file, event.name === 'Edit'));
		}
		if (event.name === 'Edit' && event.edit) {
			this.pending.set(event.id, { path: file, edit: event.edit });
		}
	}

	/** Every file at least one `Edit` succeeded on. */
	async settle(): Promise<TrackerEdit[]> {
		const settled: TrackerEdit[] = [];
		for (const [file, edits] of this.edits) {
			settled.push({ path: file, snapshot: await this.snapshots.get(file), edits });
		}
		return settled;
	}

	private async snapshot(file: string, unsafe: boolean): Promise<Snapshot | undefined> {
		const [text, updatedAt] = await Promise.all([
			this.options.read(file),
			this.options.updatedAt(file)
		]);
		return text === undefined ? undefined : { text, updatedAt, unsafe };
	}
}

/**
 * The text a file held before a run of successful `Edit`s, reconstructed by
 * applying them in reverse — the fallback for a snapshot taken too late.
 *
 * Honest about its limits: an `Edit` replaces one occurrence of `old_string`
 * (or every one, with `replace_all`), so reversing it is only unambiguous when
 * `new_string` occurs exactly once in the text as it now stands. Anything else
 * is `undefined`, and the history entry records `to` alone.
 */
export function previousText(
	current: string,
	edits: readonly { oldString: string; newString: string; replaceAll: boolean }[]
): string | undefined {
	let text = current;
	for (let index = edits.length - 1; index >= 0; index -= 1) {
		const { oldString, newString, replaceAll } = edits[index];
		if (newString === '') {
			return undefined;
		}
		if (replaceAll) {
			text = text.split(newString).join(oldString);
			continue;
		}
		const first = text.indexOf(newString);
		if (first === -1 || text.indexOf(newString, first + 1) !== -1) {
			return undefined;
		}
		text = text.slice(0, first) + oldString + text.slice(first + newString.length);
	}
	return text;
}
