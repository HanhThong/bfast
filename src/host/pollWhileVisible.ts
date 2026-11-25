// A timer that runs only while a view is on screen.

import * as vscode from 'vscode';

/**
 * Calls `tick` every `intervalMs` while `view` is visible, and not at all
 * while it is hidden.
 *
 * For a section whose truth lives outside the workspace — worktrees under the
 * OS temp folder, a container someone stopped from a terminal — where a file
 * watcher does not fire and every command already refreshes explicitly: the
 * timer is only what keeps an outside change from going unnoticed, so it is
 * not worth running for a section nobody is looking at.
 */
export function pollWhileVisible(
	view: { readonly visible: boolean; onDidChangeVisibility: vscode.Event<unknown> },
	intervalMs: number,
	tick: () => void
): vscode.Disposable {
	let timer: ReturnType<typeof setInterval> | undefined;
	const apply = (): void => {
		if (view.visible && timer === undefined) {
			timer = setInterval(tick, intervalMs);
		} else if (!view.visible && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	apply();
	const subscription = view.onDidChangeVisibility(apply);
	return {
		dispose: () => {
			subscription.dispose();
			if (timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		}
	};
}
