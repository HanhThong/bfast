// Bringing a webview tab back after a window reload.

import * as vscode from 'vscode';

/**
 * Registers the serializer for one kind of webview tab.
 *
 * `revive` is handed the panel VS Code kept and whatever the webview last
 * `setState`d, and answers whether it could bring the tab back. When it could
 * not — the state names nothing, or what it named is gone — the tab is closed:
 * an empty tab is worse than none.
 *
 * The state is `unknown` on purpose. It was written by a webview in an earlier
 * session, so each `revive` checks the fields it needs rather than trusting a
 * type.
 */
export function registerRevivable(
	viewType: string,
	revive: (panel: vscode.WebviewPanel, state: unknown) => boolean | Promise<boolean>
): vscode.Disposable {
	return vscode.window.registerWebviewPanelSerializer(viewType, {
		async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
			if (!(await revive(panel, state))) {
				panel.dispose();
			}
		}
	});
}
