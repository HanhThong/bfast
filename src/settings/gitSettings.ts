// Commit Ticket's slice of `.vscode/bfast.json`.
//
// Shaped exactly like `implementSettings.ts`: no `vscode` import (the host
// validates before writing, the settings webview validates as you type),
// reading is forgiving while writing is strict, and `parseGitSettings` returns
// `undefined` — not an empty object — when nothing survived, so a workspace
// that never sets a template keeps `bfast.json` byte-identical.
// docs/commit/README.md is the spec.

import { substituteCommand, unknownPlaceholders } from './commandTemplate';

/**
 * The tokens a commit message template may use. `{{title}}` is offered here
 * and not in `tests.command` because a message is an argv element handed to
 * `git` directly, never a shell line.
 */
export const COMMIT_MESSAGE_TOKENS = ['id', 'key', 'title', 'type', 'status'] as const;
export type CommitMessageToken = (typeof COMMIT_MESSAGE_TOKENS)[number];

export const DEFAULT_COMMIT_MESSAGE = '{{id}}: {{title}}';

export interface GitSettings {
	/** The pre-filled commit message for Commit Ticket. Absent means `DEFAULT_COMMIT_MESSAGE`. */
	commitMessage?: string;
}

/** Never throws; `undefined` when nothing usable survived. */
export function parseGitSettings(raw: unknown): GitSettings | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const source = raw as Partial<Record<keyof GitSettings, unknown>>;
	const commitMessage =
		typeof source.commitMessage === 'string' && source.commitMessage.trim().length > 0
			? source.commitMessage.trim()
			: undefined;

	// Every field is named here, or it is silently dropped on every write.
	const settings: GitSettings = {
		...(commitMessage !== undefined ? { commitMessage } : {})
	};

	return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Drops empty fields, ready to be written. `undefined` when nothing is left. */
export function normalizeGitSettings(git: GitSettings | undefined): GitSettings | undefined {
	return git === undefined ? undefined : parseGitSettings(git);
}

/**
 * Returns an error message, or `undefined` when the block is usable. An empty
 * template is not an error — it means "use the default" and is dropped on
 * write; an unknown `{{token}}` is a form hint, never a refusal.
 */
export function validateGitSettings(git: GitSettings | undefined): string | undefined {
	if (git?.commitMessage !== undefined && typeof git.commitMessage !== 'string') {
		return 'The commit message template must be text.';
	}
	return undefined;
}

export function commitMessageTemplate(git: GitSettings | undefined): string {
	return git?.commitMessage?.trim() || DEFAULT_COMMIT_MESSAGE;
}

/** The `{{token}}`s the form warns about; they are left in the message untouched. */
export function unknownCommitMessagePlaceholders(template: string): string[] {
	return unknownPlaceholders(template, COMMIT_MESSAGE_TOKENS);
}

/** The template with a ticket's values substituted, collapsed to one line. */
export function renderCommitMessage(
	template: string,
	values: Record<CommitMessageToken, string>
): string {
	return substituteCommand(template, values).replace(/\s*\r?\n\s*/g, ' ').trim();
}
