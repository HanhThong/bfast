// The `vscode` half of "may this be written to bfast.json?", shared by the
// settings form and the MCP server's settings tools — two writers, one rule.
//
// `validateSettings` is pure and the settings webview bundles it, so it cannot
// know where the workspace is. What needs that — the worktrees folder must sit
// *outside* the repository — lives here, and so does reading the compose
// chain's service names, which both the Services checklist and
// `list_compose_services` answer from.

import * as vscode from 'vscode';
import { composeConfigServicesArgs, parseComposeServices } from '../environments/composeCommand';
import { worktreesHome } from '../environments/environmentContext';
import { errorMessage } from '../platform/errors';
import { runProcess } from '../platform/runProcess';
import { validateSettings, type BfastSettings } from './bfastSettings';
import {
	environmentComposeFiles,
	normalizeEnvironmentsSettings,
	validateWorktreesFolder,
	type EnvironmentsSettings
} from './environmentSettings';

/**
 * Why this candidate cannot be written, or `undefined` when it can: every pure
 * rule, then the workspace-relative one the pure validator cannot reach.
 */
export function settingsRefusal(
	workspace: vscode.WorkspaceFolder | undefined,
	candidate: BfastSettings
): string | undefined {
	return (
		validateSettings(candidate) ??
		(candidate.environments?.worktreesFolder === undefined
			? undefined
			: worktreesFolderRefusal(workspace, vscode.Uri.file(worktreesHome(candidate.environments))))
	);
}

/**
 * Why this folder cannot be the worktrees home, or `undefined` when it can. A
 * worktree is disposable and must not sit in the repository, where a second
 * checkout turns up in every search, every file watcher and every `git status`.
 */
export function worktreesFolderRefusal(
	workspace: vscode.WorkspaceFolder | undefined,
	folder: vscode.Uri
): string | undefined {
	if (workspace && toWorkspaceRelative(workspace.uri, folder) !== undefined) {
		return 'The worktrees folder must be outside the workspace — a second checkout inside the repository would turn up in every search, every file watcher and every git status.';
	}
	return validateWorktreesFolder(folder.fsPath);
}

export interface ComposeServiceList {
	services: string[];
	/** The compose files that were read, in `--file` order. */
	files: string[];
	/** Why the list could not be read — the caller falls back to typed names. */
	error?: string;
}

/**
 * The compose chain's service names, by `docker compose config --services`.
 * The environments block is normalised first — the parse drops a path that is
 * absolute or leaves the workspace — so no unchecked path reaches `docker`. A
 * failure is an answer, never a throw.
 */
export async function readComposeServices(
	workspace: vscode.WorkspaceFolder | undefined,
	environments: EnvironmentsSettings | undefined
): Promise<ComposeServiceList> {
	const files = environmentComposeFiles(normalizeEnvironmentsSettings(environments));
	if (!workspace) {
		return { services: [], files, error: 'No workspace folder is open.' };
	}
	try {
		const result = await runProcess({
			executable: 'docker',
			args: composeConfigServicesArgs(files),
			cwd: workspace.uri.fsPath,
			idleTimeoutMs: 20_000
		}).completed;
		return { services: parseComposeServices(result.stdout), files };
	} catch (failure) {
		return {
			services: [],
			files,
			error: errorMessage(failure, 'docker compose could not read the compose files.')
		};
	}
}

/**
 * Workspace-relative, forward-slash path of `target`, or `undefined` when it
 * sits outside the workspace folder. Comparison is case-insensitive so a picked
 * `D:\Proj` still matches a workspace opened as `d:\proj` on Windows.
 */
export function toWorkspaceRelative(workspace: vscode.Uri, target: vscode.Uri): string | undefined {
	const root = workspace.path.replace(/\/+$/, '');
	const picked = target.path.replace(/\/+$/, '');

	if (picked.toLowerCase() === root.toLowerCase()) {
		return '.';
	}
	if (!picked.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
		return undefined;
	}
	return picked.slice(root.length + 1);
}
