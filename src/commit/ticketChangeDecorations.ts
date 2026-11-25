// The sidebar's git marks: a ticket with uncommitted changes wears git's own
// colour and an `M` (or `U` when it was never committed), the way a file does
// in the Explorer, and every ticket above it a `•` — so a change is findable
// with the tree collapsed. docs/commit/README.md §Uncommitted changes is the
// spec.
//
// A `FileDecorationProvider` on the `bfast-ticket:` scheme rather than a `*`
// in the label, for three reasons: it is the convention every VS Code user
// already reads (colour + letter, from the Explorer and Source Control); it
// leaves the label — what a filter matches and a screen reader speaks — alone;
// and the board is a custom editor on that very resource, so its tab gets the
// same mark for nothing.
//
// When to look: the tracker refreshed (a BFAST write, a watcher event), or the
// git extension's model moved — a commit, a stage, a checkout, a change made
// outside the tracker's watcher. Without the git extension only the first
// applies. Each ask is debounced, and asks during a run collapse into one more.

import * as vscode from 'vscode';
import type { TicketStore } from '../data/ticketStore';
import { TICKET_SCHEME, parseTicketUri } from '../data/ticketUri';
import type { ProcessRunner } from '../platform/runProcess';
import { changedTicketFolders, type ChangeMark } from './changeMarks';
import { trackerStatus } from './ticketCommit';

export interface ChangeDecorationServices {
	store: Pick<TicketStore, 'getSummary' | 'ticketAt'>;
	runner: ProcessRunner;
	/** The tracker folder, read at call time; `undefined` while unconfigured. */
	trackerFolder: () => vscode.Uri | undefined;
}

/** The subset of the built-in git extension's API this reads. */
interface GitApi {
	readonly repositories: readonly GitRepository[];
	readonly onDidOpenRepository: vscode.Event<GitRepository>;
}
interface GitRepository {
	readonly state: { readonly onDidChange: vscode.Event<void> };
}

const DEBOUNCE_MS = 300;

const MODIFIED_COLOR = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
const ADDED_COLOR = new vscode.ThemeColor('gitDecoration.untrackedResourceForeground');

export class TicketChangeDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<undefined>();
	readonly onDidChangeFileDecorations = this.changed.event;

	/** A ticket's own mark, by id. */
	private marks = new Map<string, ChangeMark>();
	/** Tickets holding a changed ticket somewhere below them. */
	private containers = new Set<string>();

	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private again = false;
	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly services: ChangeDecorationServices) {
		this.disposables.push(vscode.window.registerFileDecorationProvider(this), this.changed);
		void this.followGit();
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const id = uri.scheme === TICKET_SCHEME ? parseTicketUri(uri) : undefined;
		if (id === undefined) {
			return undefined;
		}
		switch (this.marks.get(id)) {
			case 'modified':
				return { badge: 'M', color: MODIFIED_COLOR, tooltip: 'Uncommitted changes' };
			case 'added':
				return { badge: 'U', color: ADDED_COLOR, tooltip: 'New — never committed' };
		}
		return this.containers.has(id)
			? { badge: '•', color: MODIFIED_COLOR, tooltip: 'Contains uncommitted changes' }
			: undefined;
	}

	/** Look again, soon. Cheap to call on every refresh. */
	update(): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
	}

	private async run(): Promise<void> {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			await this.compute();
		} finally {
			this.running = false;
			if (this.again && !this.disposed) {
				this.again = false;
				this.update();
			}
		}
	}

	private async compute(): Promise<void> {
		const tracker = this.services.trackerFolder();
		const marks = new Map<string, ChangeMark>();
		const containers = new Set<string>();

		if (tracker) {
			try {
				const { top, prefix, entries } = await trackerStatus(this.services.runner, tracker.fsPath);
				const topUri = vscode.Uri.file(top);
				for (const [folder, mark] of changedTicketFolders(entries, prefix)) {
					// `ticketAt` walks the nesting, so a ranked or drifted folder
					// resolves as the tree does; a folder that is gone resolves to nothing.
					const ticket = await this.services.store.ticketAt?.(
						vscode.Uri.joinPath(topUri, ...folder.split('/'), 'metadata.yaml')
					);
					if (ticket) {
						marks.set(ticket.id, mark);
					}
				}
				for (const id of marks.keys()) {
					let parentId = (await this.services.store.getSummary(id))?.parentId;
					while (parentId !== undefined && !containers.has(parentId)) {
						containers.add(parentId);
						parentId = (await this.services.store.getSummary(parentId))?.parentId;
					}
				}
			} catch {
				// No git, no repository, a tracker git ignores: no marks. Nothing
				// here is worth a notification — Commit Ticket says it in words.
			}
		}

		if (this.disposed || (sameMarks(marks, this.marks) && sameSet(containers, this.containers))) {
			return;
		}
		this.marks = marks;
		this.containers = containers;
		this.changed.fire(undefined);
	}

	/** Re-look whenever the git extension's model of any repository moves. */
	private async followGit(): Promise<void> {
		try {
			const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
			if (!extension) {
				return;
			}
			const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
			if (this.disposed) {
				return;
			}
			const follow = (repository: GitRepository): void => {
				this.disposables.push(repository.state.onDidChange(() => this.update()));
			};
			api.repositories.forEach(follow);
			this.disposables.push(api.onDidOpenRepository(follow));
			this.update();
		} catch {
			// The git extension disabled (`git.enabled: false`) — refreshes still mark.
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		vscode.Disposable.from(...this.disposables).dispose();
	}
}

function sameMarks(a: ReadonlyMap<string, ChangeMark>, b: ReadonlyMap<string, ChangeMark>): boolean {
	return a.size === b.size && [...a].every(([id, mark]) => b.get(id) === mark);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((id) => b.has(id));
}
