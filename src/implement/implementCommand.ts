// The "Implement…" command: right-click a ticket, build its prompt, write it to
// the handoff file, hand the configured coding agent one sentence naming that
// file. That is all — no run, no result, no ticket write.
// docs/implement/README.md §Outcomes is the table this must keep matching.
//
// The file is written **here**, for every agent, and the agent receives only
// `handoffSentence(path)`: that is what makes the extension route and the CLI
// route hand over the same thing, and what keeps the prompt's prose off every
// shell line without an agent having to know why.
//
// A file of its own rather than more of `ticketCommands.ts`, whose every
// command is a plain store write; this one needs the agent, the prompt builder
// and the handoff writer. Nothing here opens an output channel: nothing
// streams, and the tab or terminal opening *is* the report. A failure is one
// error message with the action that fixes it.

import * as vscode from 'vscode';
import type { TicketNode } from '../data/ticketTree';
import { ImplementError, type CodingAgent, unavailable } from './codingAgent';
import type { ImplementPromptResult } from './implementContext';
import { handoffSentence } from './implementPrompt';
import { errorMessage } from '../platform/errors';

export interface ImplementServices {
	agent: CodingAgent;
	buildPrompt(ticketId: string): Promise<ImplementPromptResult>;
	/** Writes the rendered prompt and answers its workspace-relative path. */
	writeHandoff(ticketId: string, prompt: string): Promise<string>;
}

/** The dialogs, injectable so the suite drives the command without a window. */
export interface ImplementUi {
	error(message: string, ...actions: string[]): Thenable<string | undefined>;
	info(message: string): void;
	openSettings(): void;
	/** The Extensions view, searching for one id. */
	showInMarketplace(extensionId: string): void;
	copy(text: string): Thenable<void>;
}

const realUi: ImplementUi = {
	error: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
	info: (message) => void vscode.window.showInformationMessage(message),
	openSettings: () => void vscode.commands.executeCommand('bfast.openSettings'),
	showInMarketplace: (extensionId) =>
		void vscode.commands.executeCommand('workbench.extensions.search', `@id:${extensionId}`),
	copy: (text) => vscode.env.clipboard.writeText(text)
};

const OPEN_SETTINGS = 'Open Settings';
const SHOW_IN_MARKETPLACE = 'Show in Marketplace';
const COPY_PROMPT = 'Copy Prompt';

/**
 * Availability first — a missing program costs no tracker read — then the
 * prompt, then the file, then the handoff. Nothing on success: the tab or
 * terminal is the report.
 */
export async function implementTicket(
	services: ImplementServices,
	ticketId: string,
	ui: ImplementUi = realUi
): Promise<void> {
	const availability = await services.agent.availability();
	if (!availability.ok) {
		await report(services.agent, unavailable(services.agent, availability), undefined, ui);
		return;
	}

	let built: ImplementPromptResult;
	try {
		built = await services.buildPrompt(ticketId);
	} catch (error) {
		await report(services.agent, asImplementError(error), undefined, ui);
		return;
	}

	// From here on the prompt exists, so a failure offers it for pasting.
	try {
		const handoffPath = await services.writeHandoff(ticketId, built.prompt);
		const message = handoffSentence(handoffPath);
		await services.agent.open({ ticketId, handoffPath, message });
	} catch (error) {
		await report(services.agent, asImplementError(error), built.prompt, ui);
	}
}

/** One error message, with the action its code calls for — the outcome table's third column. */
async function report(
	agent: CodingAgent,
	error: ImplementError,
	prompt: string | undefined,
	ui: ImplementUi
): Promise<void> {
	const actions: string[] = [];
	switch (error.code) {
		case 'not-installed':
			if (agent.extensionId) {
				actions.push(SHOW_IN_MARKETPLACE);
			}
			break;
		case 'not-implemented':
		case 'not-configured':
			actions.push(OPEN_SETTINGS);
			break;
		case 'unsupported':
		case 'provider-error':
			// The prompt exists and only the delivery failed: hand it over by hand.
			if (prompt !== undefined) {
				actions.push(COPY_PROMPT);
			}
			break;
	}

	const choice = await ui.error(error.message, ...actions);
	if (choice === OPEN_SETTINGS) {
		ui.openSettings();
	} else if (choice === SHOW_IN_MARKETPLACE && agent.extensionId) {
		ui.showInMarketplace(agent.extensionId);
	} else if (choice === COPY_PROMPT && prompt !== undefined) {
		await ui.copy(prompt);
		ui.info('The prompt is on the clipboard.');
	}
}

function asImplementError(error: unknown): ImplementError {
	if (error instanceof ImplementError) {
		return error;
	}
	return new ImplementError(
		'provider-error',
		errorMessage(error),
		error
	);
}

export function registerImplementCommands(services: ImplementServices): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('bfast.implement', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			// Unreachable from the menu, whose `when` clause requires a ticket row;
			// it guards a keybinding or a palette invocation with no node.
			if (!ticket) {
				void vscode.window.showWarningMessage('Right-click a ticket to implement it.');
				return;
			}
			await implementTicket(services, ticket.id);
		})
	];
}
