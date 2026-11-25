import * as assert from 'assert';
import * as vscode from 'vscode';
import { renderWebviewHtml } from '../host/webviewHtml';

/** Only `cspSource` and `asWebviewUri` are read, so a stub is a webview. */
const webview = {
	cspSource: 'https://webview.test',
	asWebviewUri: (uri: vscode.Uri) => uri
} as unknown as vscode.Webview;

suite('Webview html', () => {
	test('the CSP lets the board play a run video and still forbids everything else', () => {
		const html = renderWebviewHtml(webview, vscode.Uri.file('/ext'), 'main', 'BFAST');
		const csp = /content="([^"]+)"/.exec(html)?.[1] ?? '';
		assert.ok(csp.includes(`media-src https://webview.test blob:`), csp);
		assert.ok(csp.includes(`default-src 'none'`), csp);
		assert.ok(!csp.includes('connect-src'), csp);
		assert.ok(/script-src 'nonce-[A-Za-z0-9]{32}'/.test(csp), csp);
	});
});
