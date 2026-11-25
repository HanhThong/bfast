// Gathering a ticket's prompt: the `vscode` half of `implementPrompt.ts`.
//
// Every value a template may name comes from here — the ticket, its ancestors
// (by walking `parentId` upward, never by parsing the id), its subtree two
// levels down (`listSummaries` + `buildTree`, the Run Tests triple), the design
// documents on it and its ancestors, the workspace-relative paths, and the test
// command — and then the template is rendered. The agent that receives the
// result knows none of this: it is handed text.

import * as path from 'path';
import type * as vscode from 'vscode';
import { labelFromStyleId } from '../design/designDocument';
import type { DesignStore } from '../design/designStore';
import { buildTree, findNode, type TicketNode } from '../data/ticketTree';
import type { TicketStore } from '../data/ticketStore';
import { allowedChildTypes, TYPE_FILE } from '../data/trackerPaths';
import type { TicketSummary } from '../data/types';
import { substituteCommand, testsCommand, type TestsSettings } from '../settings/testsSettings';
import { ImplementError } from './codingAgent';
import {
	EMPTY_DESCRIPTION,
	NONE,
	TEST_COMMAND_UNSET,
	formatAncestors,
	formatChildren,
	formatDesigns,
	implementTypeName,
	renderImplementPrompt,
	type ImplementDesignLine,
	type ImplementTicketLine,
	type ImplementVars
} from './implementPrompt';
import type { ImplementPromptStore } from './implementPromptStore';

/** How many levels below the ticket `{{children}}` lists; docs/implement/README.md says why two. */
export const CHILDREN_DEPTH = 2;

export interface ImplementContextDeps {
	store: TicketStore;
	designs: Pick<DesignStore, 'list'>;
	templates: Pick<ImplementPromptStore, 'read' | 'readRules'>;
	workspaceFolder(): vscode.Uri | undefined;
	/** `trackerFolder` from the settings, workspace-relative. */
	trackerFolder(): string | undefined;
	tests(): TestsSettings | undefined;
}

export interface ImplementPromptResult {
	prompt: string;
	/** The template that rendered it, for a message. */
	templatePath: string;
	ticket: TicketSummary;
}

const NOT_CONFIGURED = 'Open a folder and save BFAST settings before implementing a ticket.';

/** The rendered prompt for a ticket. Throws `ImplementError`. */
export async function buildImplementPrompt(
	deps: ImplementContextDeps,
	ticketId: string
): Promise<ImplementPromptResult> {
	const workspace = deps.workspaceFolder();
	const tracker = deps.trackerFolder();
	if (!workspace || !tracker) {
		throw new ImplementError('not-configured', NOT_CONFIGURED);
	}

	const ticket = await deps.store.getDetail(ticketId);
	if (!ticket) {
		throw new ImplementError('provider-error', `${ticketId} is not in the tracker any more.`);
	}

	const folderUri = await deps.store.folderUri?.(ticketId);
	if (!folderUri) {
		throw new ImplementError(
			'not-configured',
			'Implement needs a folder-backed tracker: the prompt names the ticket by its files.'
		);
	}

	const relative = (uri: vscode.Uri) =>
		path.relative(workspace.fsPath, uri.fsPath).split(path.sep).join('/');
	const contentFile = (summary: TicketSummary, uri: vscode.Uri) =>
		`${relative(uri)}/${TYPE_FILE[summary.type]}`;

	// Ancestors: parent by parent, epic first. The id is never parsed for this.
	const ancestors: ImplementTicketLine[] = [];
	const chain: TicketSummary[] = [];
	for (let parentId = ticket.parentId; parentId; ) {
		const parent = await deps.store.getSummary(parentId);
		if (!parent) {
			break;
		}
		const parentFolder = await deps.store.folderUri?.(parent.id);
		if (parentFolder) {
			ancestors.unshift({ id: parent.id, title: parent.title, path: contentFile(parent, parentFolder) });
		}
		chain.unshift(parent);
		parentId = parent.parentId;
	}

	// Children, two levels down. A test case has none by the hierarchy, so its
	// prompt costs no tracker scan.
	const children: ImplementTicketLine[] = [];
	if (allowedChildTypes(ticket.type).length > 0) {
		const node = findNode(buildTree(await deps.store.listSummaries()), ticketId);
		if (node) {
			const walk = async (nodes: TicketNode[], depth: number): Promise<void> => {
				for (const child of nodes) {
					const childFolder = await deps.store.folderUri?.(child.ticket.id);
					if (childFolder) {
						children.push({
							id: child.ticket.id,
							title: child.ticket.title,
							path: contentFile(child.ticket, childFolder),
							depth
						});
					}
					if (depth + 1 < CHILDREN_DEPTH) {
						await walk(child.children, depth + 1);
					}
				}
			};
			await walk(node.children, 0);
		}
	}

	// Design documents on the ticket and on every ancestor, ancestors first.
	const designs: ImplementDesignLine[] = [];
	for (const owner of [...chain, ticket]) {
		const ownerFolder = owner.id === ticket.id ? folderUri : await deps.store.folderUri?.(owner.id);
		if (!ownerFolder) {
			continue;
		}
		for (const design of await deps.designs.list(owner.id)) {
			designs.push({
				id: design.id,
				title: design.title,
				style: labelFromStyleId(design.style),
				ticketId: owner.id,
				path: `${relative(ownerFolder)}/${design.fileName}`
			});
		}
	}

	const command = testsCommand(deps.tests());
	const testCommand =
		command === undefined
			? TEST_COMMAND_UNSET
			: ticket.type === 'testcase'
				? substituteCommand(command, { id: ticket.id, key: ticket.key, folder: folderUri.fsPath })
				: command;

	const read = await deps.templates.read(ticket.type);
	const rules = await deps.templates.readRules();

	const vars: ImplementVars = {
		id: ticket.id,
		key: ticket.key,
		title: ticket.title,
		type: implementTypeName(ticket.type),
		status: ticket.status,
		folder: relative(folderUri),
		file: contentFile(ticket, folderUri),
		description: ticket.description.trim().length > 0 ? ticket.description.trim() : EMPTY_DESCRIPTION,
		ancestors: formatAncestors(ancestors),
		children: formatChildren(children),
		designs: formatDesigns(designs),
		testCommand,
		tracker,
		rules: rules.template.body.trim().length > 0 ? rules.template.body : NONE
	};

	return {
		prompt: renderImplementPrompt(read.template.body, vars),
		templatePath: read.path,
		ticket
	};
}
