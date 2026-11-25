// The Claude Code **extension** as a coding agent: a new session tab with the
// handoff sentence in its input, unsent — the same sentence the CLI route
// types, naming the file the rendered prompt was written to.
//
// It reaches the extension (`anthropic.claude-code`) through the command that
// extension registers for exactly that — `claude-vscode.editor.open(sessionId,
// initialPrompt, …)`. Three facts about it shape this file, all read from the
// extension rather than from a document, and each pinned by a test:
//
// - The text **fills the input and is not submitted** — the contract Implement
//   wants, and the extension's to change.
// - The first argument is a session id and must be `undefined`: naming an open
//   session reveals that tab and *drops the prompt* with a toast.
// - The id is undocumented and has moved once (`claude-code.*` →
//   `claude-vscode.*`), so availability checks `getCommands(true)` for it and
//   answers `unsupported` when it is gone — an error naming the command rather
//   than a click that does nothing.
//
// Rejected: the documented URI handler (`vscode://anthropic.claude-code/open`),
// for its 5,000-character cap, its first-use confirmation dialog, and the
// re-encoding that ends the query at a `#`. See
// docs/implement/provider-interface.md.

import * as vscode from 'vscode';
import {
	ImplementError,
	unavailable,
	type CodingAgent,
	type CodingAgentAvailability,
	type ImplementRequest
} from './codingAgent';
import { errorMessage } from '../platform/errors';

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

/** `(sessionId?, initialPrompt?, viewColumn?, groupId?, isPrimary?)` in 2.1.x. */
export const CLAUDE_CODE_OPEN_COMMAND = 'claude-vscode.editor.open';

/** The slice of `vscode.Extension` this agent reads. */
export interface ClaudeCodeExtension {
	readonly isActive: boolean;
	activate(): Thenable<unknown>;
}

/** Every `vscode` call, injectable so the suite drives the agent with fakes. */
export interface ClaudeCodeDeps {
	getExtension(id: string): ClaudeCodeExtension | undefined;
	getCommands(): Thenable<readonly string[]>;
	executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
}

const realDeps: ClaudeCodeDeps = {
	getExtension: (id) => vscode.extensions.getExtension(id),
	getCommands: () => vscode.commands.getCommands(true),
	executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args)
};

const NOT_INSTALLED =
	`The Claude Code extension (${CLAUDE_CODE_EXTENSION_ID}) is not installed. ` +
	'Install it from the Marketplace, or pick Claude Code CLI in Settings → Implement.';

const UNSUPPORTED =
	`The installed Claude Code extension no longer offers \`${CLAUDE_CODE_OPEN_COMMAND}\`, ` +
	'which BFAST hands the prompt to. Update BFAST, or copy the prompt and paste it yourself.';

export class ClaudeCodeAgent implements CodingAgent {
	readonly id = 'claude-code' as const;
	readonly label = 'Claude Code';
	readonly extensionId = CLAUDE_CODE_EXTENSION_ID;

	constructor(private readonly deps: ClaudeCodeDeps = realDeps) {}

	/**
	 * In order: not installed → `not-installed`; not yet active → activate it (a
	 * failure is `provider-error`); the command absent → `unsupported`. Not
	 * cached: an install or an update takes effect on the next click.
	 */
	async availability(): Promise<CodingAgentAvailability> {
		const extension = this.deps.getExtension(CLAUDE_CODE_EXTENSION_ID);
		if (!extension) {
			return { ok: false, reason: 'not-installed', message: NOT_INSTALLED };
		}

		if (!extension.isActive) {
			try {
				await extension.activate();
			} catch (error) {
				return {
					ok: false,
					reason: 'provider-error',
					message: `The Claude Code extension failed to activate: ${describe(error)}`
				};
			}
		}

		const commands = await this.deps.getCommands();
		if (!commands.includes(CLAUDE_CODE_OPEN_COMMAND)) {
			return { ok: false, reason: 'unsupported', message: UNSUPPORTED };
		}

		return { ok: true };
	}

	/**
	 * Availability again — the settings may have changed since the command
	 * asked — then the handoff. The session id is **always `undefined`**.
	 */
	async open(request: ImplementRequest): Promise<void> {
		const availability = await this.availability();
		if (!availability.ok) {
			throw unavailable(this, availability);
		}

		try {
			await this.deps.executeCommand(CLAUDE_CODE_OPEN_COMMAND, undefined, request.message);
		} catch (error) {
			// The extension's message, never the prompt.
			throw new ImplementError(
				'provider-error',
				`Claude Code did not take the prompt: ${describe(error)}`,
				error
			);
		}
	}
}

function describe(error: unknown): string {
	return errorMessage(error);
}
