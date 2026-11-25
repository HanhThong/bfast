// Save for the team: the `vscode` half of `mcpClients.ts`.
//
// Reads the tool's project config file as it stands, hands it to the pure
// merge, and writes the result — or throws the merge's own reason, so a file
// that could not be read as JSON is never overwritten. The address is the
// caller's to supply: it is the listening server's, never one a webview sent.

import * as vscode from 'vscode';
import { mcpClient, mergeMcpClientConfig, type McpClientId } from './mcpClients';

/**
 * Writes the `bfast` entry into `client`'s project config file under `folder`.
 * Answers the workspace-relative path written. Throws when the tool has no
 * project file, or the file's content cannot be merged into.
 */
export async function saveMcpClientConfig(
	folder: vscode.Uri,
	client: McpClientId,
	address: string
): Promise<string> {
	const file = mcpClient(client).projectFile;
	if (!file) {
		throw new Error(`${mcpClient(client).label} has no project-scoped config file BFAST can write to.`);
	}
	const uri = vscode.Uri.joinPath(folder, ...file.path.split('/'));

	let existing: string | undefined;
	try {
		existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch (failure) {
		if (!(failure instanceof vscode.FileSystemError) || failure.code !== 'FileNotFound') {
			// Unreadable is not the same as absent: nothing may be written over it.
			throw new Error(`${file.path} could not be read, so nothing was written.`);
		}
	}

	const merge = mergeMcpClientConfig(client, existing, address);
	if (!merge.ok) {
		throw new Error(merge.reason);
	}

	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(merge.text));
	return file.path;
}
