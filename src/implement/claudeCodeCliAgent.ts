// The Claude Code **CLI** as a coding agent: a terminal with one line typed —
// not run — that carries the same handoff sentence the extension route puts in
// its input.
//
// A terminal takes a *shell line*, and the only safe shell line is one whose
// alphabet BFAST controls. So the rendered prompt never touches the line: the
// command layer has written it to `.bfast/implement/prompts/<id>.md`, and the
// line is `claude "<sentence>"` — a constant sentence around a constant path
// around an id whose alphabet is `A-Z 0-9 . - _` — the same string on every
// shell this could be typing into. Enter is left to the user, which keeps the
// contract the extension route has: filled, not sent.
//
// Rejected, and why, in docs/implement/provider-interface.md: quoting the
// prompt onto the line (a quoting rule per shell, none for `cmd.exe`, two
// screens of markdown echoed as a command), typing it into the running TUI (no
// readiness signal, and text arriving at a shell prompt instead is executed
// line by line), `ai.executablePath` (a spawn path, not a shell word), and the
// extension's own `claude-vscode.terminal.open` (quotes for you, runs at once).

import * as vscode from 'vscode';
import { runProcess, type ProcessRunner } from '../platform/runProcess';
import { shellCommand } from '../platform/shellCommand';
import {
	ImplementError,
	unavailable,
	type CodingAgent,
	type CodingAgentAvailability,
	type CodingAgentContext,
	type ImplementRequest
} from './codingAgent';

/** Run as the terminal's shell finds it — never a path, which is a shell word. */
export const CLAUDE_CLI = 'claude';

/** How long `claude --version` may stay silent before the CLI is called missing. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Every character the line may carry between its quotes: the sentence's words,
 * spaces, comma and full stop, the path's `.`, `-`, `_` and `/` — all literal
 * inside double quotes on every shell. `handoffSentence` already guarantees
 * this; the check here is the defence in depth for the one place a string
 * meets a shell, and it refuses rather than quotes.
 */
const LINE_ALPHABET = /^[A-Za-z0-9 .,_/-]+$/;

const NOT_INSTALLED =
	'Could not run `claude`. Install the Claude Code CLI so that `claude` is on the PATH ' +
	'your terminal has, then click again — or pick Claude Code (the extension) in Settings → Implement.';

/**
 * The one line typed into the terminal: the handoff sentence as `claude`'s
 * positional prompt. Throws on a sentence outside the alphabet.
 */
export function claudeCliHandoffLine(message: string): string {
	if (!LINE_ALPHABET.test(message)) {
		throw new ImplementError('provider-error', 'The handoff sentence cannot go on a shell line.');
	}
	return `${CLAUDE_CLI} "${message}"`;
}

export interface HandoffTerminal {
	/** `Claude Code — ST-1.2`. */
	name: string;
	/** The workspace folder, so the sentence's relative path resolves. */
	cwd: string;
	/** Typed, never executed: the user presses Enter. */
	line: string;
}

/** Everything that touches the world, injectable so the suite asserts the exact line. */
export interface ClaudeCodeCliDeps {
	/** For `claude --version`. */
	runner: ProcessRunner;
	openTerminal(terminal: HandoffTerminal): void;
}

/** `createTerminal` + `show` + `sendText(line, false)` — the `false` is the whole point. */
export function openHandoffTerminal(terminal: HandoffTerminal): void {
	const created = vscode.window.createTerminal({ name: terminal.name, cwd: terminal.cwd });
	created.show();
	created.sendText(terminal.line, false);
}

export function claudeCodeCliDeps(): ClaudeCodeCliDeps {
	return { runner: runProcess, openTerminal: openHandoffTerminal };
}

export class ClaudeCodeCliAgent implements CodingAgent {
	readonly id = 'claude-code-cli' as const;
	readonly label = 'Claude Code CLI';

	/** A pass is remembered for the window; a failure is asked again next click. */
	private probedOk = false;

	constructor(
		private readonly context: CodingAgentContext,
		private readonly deps: ClaudeCodeCliDeps = claudeCodeCliDeps()
	) {}

	/**
	 * `claude --version` through the platform shell — **not** a bare `spawn`,
	 * because that is how the terminal will resolve `claude` too, `.cmd` shims
	 * included — with a non-zero exit or a missing binary as `not-installed`.
	 */
	async availability(): Promise<CodingAgentAvailability> {
		const cwd = this.context.workspaceFolder();
		if (!cwd) {
			return {
				ok: false,
				reason: 'not-configured',
				message: 'Open a folder before implementing a ticket.'
			};
		}
		if (this.probedOk) {
			return { ok: true };
		}

		const invocation = shellCommand(`${CLAUDE_CLI} --version`, process.platform);
		try {
			await this.deps.runner({
				executable: invocation.executable,
				args: invocation.args,
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				cwd,
				idleTimeoutMs: PROBE_TIMEOUT_MS,
				maxBufferedOutput: 4_000
			}).completed;
		} catch {
			return { ok: false, reason: 'not-installed', message: NOT_INSTALLED };
		}

		this.probedOk = true;
		return { ok: true };
	}

	/** Availability again, then the terminal with the line typed. The file is already there. */
	async open(request: ImplementRequest): Promise<void> {
		const availability = await this.availability();
		if (!availability.ok) {
			throw unavailable(this, availability);
		}
		// `availability` said there is one.
		const cwd = this.context.workspaceFolder() as string;

		this.deps.openTerminal({
			name: `Claude Code — ${request.ticketId}`,
			cwd,
			line: claudeCliHandoffLine(request.message)
		});
	}
}
