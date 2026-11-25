import * as path from 'path';
import * as vscode from 'vscode';

/** Long enough to collapse a burst (a `git pull`, a multi-file save) into one refresh. */
const DEBOUNCE_MS = 300;

/**
 * Watches the tracker folder so the sidebar and board follow what is actually on
 * disk. The tracker lives in git and is meant to be edited by hand, so a branch
 * switch, a merge or a save in a normal editor tab all change tickets with no
 * other signal that anything happened.
 *
 * Three things keep it quiet: a trailing debounce; `isBusy` — the store sets
 * that while it is writing, and its own writes already refresh the tree, so
 * reacting to them would only cause a second redundant scan; and `ignore`, for
 * the files that never change the tree at all — a ticket's `assets/` and
 * `evidence/`. A test run copies several megabytes into the latter, and their
 * events land after the store's write has settled, past `isBusy`'s reach.
 */
export class TrackerWatcher implements vscode.Disposable {
	private watcher: vscode.FileSystemWatcher | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly onChange: () => void,
		private readonly isBusy: () => boolean,
		/** Given the path relative to the tracker root; true drops the event. */
		private readonly ignore: (relativePath: string) => boolean = () => false
	) {}

	/**
	 * Points the watch at a different folder, which is needed whenever the
	 * configured `trackerFolder` changes — a watcher is bound to its pattern and
	 * cannot be retargeted in place.
	 */
	retarget(root: vscode.Uri | undefined): void {
		this.watcher?.dispose();
		this.watcher = undefined;

		if (!root) {
			return;
		}

		// A relative pattern is happy with a folder that does not exist yet, so
		// this also covers the tracker being created after the fact.
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(root, '**/*')
		);

		// Relative to the root that is being watched — never the absolute path,
		// which for a workspace under `/home/x/assets/` would match everything.
		const schedule = (uri: vscode.Uri) => {
			if (this.ignore(path.relative(root.fsPath, uri.fsPath))) {
				return;
			}
			this.schedule();
		};
		this.watcher.onDidCreate(schedule);
		this.watcher.onDidChange(schedule);
		this.watcher.onDidDelete(schedule);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.watcher?.dispose();
		this.watcher = undefined;
	}

	private schedule(): void {
		if (this.isBusy()) {
			return;
		}

		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			// Re-check: a write may have started while the timer was pending.
			if (!this.isBusy()) {
				this.onChange();
			}
		}, DEBOUNCE_MS);
	}
}
