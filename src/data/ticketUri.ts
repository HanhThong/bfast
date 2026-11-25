// The resource a board is an editor of.
//
// A board is a custom editor, because that is the one kind of webview VS Code
// gives preview tabs to: `WebviewPanelOptions` has no `preview` flag and
// `Tab.isPreview` is read-only, while an editor *input* — a file, a notebook, a
// custom editor — gets the italic title, the tab reuse and the double-click
// promotion from the editor service for free. A custom editor needs a resource,
// so every ticket has one: `bfast-ticket:/<id>`.
//
// The id alone goes in the path. The tab's label comes from `panel.title`
// (`CustomEditorInput.getName()` prefers the webview title over the basename),
// so a rename changes nothing here, and a title with a `/` in it could not
// break the basename anyway. `Uri.from`, never `Uri.parse`: a rank's `#`
// (`EP-1#2`) has to be encoded, not read as a fragment.

import * as vscode from 'vscode';

export const TICKET_SCHEME = 'bfast-ticket';

export function ticketUri(id: string): vscode.Uri {
	return vscode.Uri.from({ scheme: TICKET_SCHEME, path: `/${id}` });
}

/** `undefined` for any resource that is not a ticket's — a foreign scheme, or more than one path segment. */
export function parseTicketUri(uri: vscode.Uri): string | undefined {
	if (uri.scheme !== TICKET_SCHEME) {
		return undefined;
	}
	const match = /^\/([^/]+)$/.exec(uri.path);
	return match?.[1];
}
