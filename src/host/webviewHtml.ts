import * as vscode from 'vscode';

/** The esbuild entry points bundled into `out/webview`. */
export type WebviewEntry = 'main' | 'settings' | 'generate' | 'scan' | 'containerLog';

/**
 * The CSP + nonce boilerplate every BFAST webview shares. `entry` selects which
 * bundle the document loads; both live under `out/webview`, the only folder in
 * `localResourceRoots`.
 */
export function renderWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	entry: WebviewEntry,
	title: string
): string {
	const webviewRoot = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, `${entry}.js`));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, `${entry}.css`));
	const nonce = getNonce();

	// 'unsafe-inline' for styles is needed because React writes inline style
	// attributes (the resizable pane width).
	//
	// `media-src` is what lets the board play a test run's video. It is here for
	// every document rather than gated on `entry`, because reachability is decided
	// by `localResourceRoots`, not by this list: only the board lists the workspace
	// folders, so the settings, generate and scan documents can still load no
	// media whatever this says — a per-entry branch would be a rule with no effect.
	const csp = [
		`default-src 'none'`,
		`img-src ${webview.cspSource} data:`,
		// `blob:` is the board's own fallback: the bytes of a video the loader could
		// not serve, posted by the host and wrapped in a Blob by the webview.
		`media-src ${webview.cspSource} blob:`,
		`font-src ${webview.cspSource}`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>${title}</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}
