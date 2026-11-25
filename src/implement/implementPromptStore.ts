// The files under `.bfast/implement/`: the four templates, the working rules
// they share, and the rendered prompts every handoff points at.
//
// The `vscode` half of `implementPrompt.ts`, shaped like `AgentStore`: the
// bundled files are seeded **only when the folder has never existed** — an
// empty folder means someone deleted them on purpose, and putting them back
// would be the extension arguing with the user — and a missing file falls back
// to the shipped one silently. Nothing is cached: a template saved in an editor
// tab is in the very next prompt.

import * as vscode from 'vscode';
import { ticketTypeLabel } from '../ai/agent';
import { TICKET_TYPES, type TicketType } from '../data/types';
import { ImplementError } from './codingAgent';
import {
	HANDOFF_FOLDER,
	IMPLEMENT_FOLDER,
	IMPLEMENT_RULES_FILE,
	IMPLEMENT_TEMPLATE_FILE,
	handoffPath,
	parseImplementTemplate,
	type ImplementPromptInfo,
	type ImplementTemplateFile
} from './implementPrompt';

/** Where the extension ships the files it seeds from. */
const TEMPLATES_PATH = ['templates', 'implement'];

/** Everything seeded: the four templates, then the rules they share. */
const SEEDED_FILES = [...TICKET_TYPES.map((type) => IMPLEMENT_TEMPLATE_FILE[type]), IMPLEMENT_RULES_FILE];

export interface ImplementTemplateRead {
	template: ImplementTemplateFile;
	/** The workspace file's path, whether or not it exists: `.bfast/implement/story.md`. */
	path: string;
	source: 'workspace' | 'bundled';
}

export class ImplementPromptStore {
	constructor(
		private readonly workspace: () => vscode.WorkspaceFolder | undefined,
		/** The extension's own directory, which is where `templates/` is shipped. */
		private readonly extensionUri: vscode.Uri
	) {}

	/** The `.bfast/implement` folder, or `undefined` with no folder open. */
	folderUri(): vscode.Uri | undefined {
		const root = this.workspace();
		return root ? vscode.Uri.joinPath(root.uri, ...IMPLEMENT_FOLDER.split('/')) : undefined;
	}

	/** A type's template file in the workspace, whether or not it exists yet. */
	uriFor(type: TicketType): vscode.Uri | undefined {
		return this.uriForFile(IMPLEMENT_TEMPLATE_FILE[type]);
	}

	/** The shared rules file in the workspace, whether or not it exists yet. */
	rulesUri(): vscode.Uri | undefined {
		return this.uriForFile(IMPLEMENT_RULES_FILE);
	}

	/**
	 * Seeds the templates and the rules when the folder has never existed.
	 * Keyed on the folder being **absent**, not empty. A read-only workspace is
	 * not an error: the bundled files still work, they just cannot be edited.
	 */
	async ensureSeeded(): Promise<void> {
		const folder = this.folderUri();
		if (!folder || (await readDirectory(folder)) !== undefined) {
			return;
		}
		try {
			await vscode.workspace.fs.createDirectory(folder);
			for (const name of SEEDED_FILES) {
				await this.copyBundled(name);
			}
		} catch {
			// `read()` falls back to the bundled file.
		}
	}

	/**
	 * The template for a type: the workspace's file, else the shipped one. Never
	 * cached. Throws only when the shipped file itself is missing — a broken
	 * VSIX, which no fallback can answer.
	 */
	read(type: TicketType): Promise<ImplementTemplateRead> {
		return this.readFile(IMPLEMENT_TEMPLATE_FILE[type], `a ${ticketTypeLabel(type).toLowerCase()}`);
	}

	/** The working rules `{{rules}}` carries, the same way. */
	readRules(): Promise<ImplementTemplateRead> {
		return this.readFile(IMPLEMENT_RULES_FILE, 'the working rules');
	}

	/** One row per ticket type for the settings form. Seeds; never throws. */
	async list(): Promise<ImplementPromptInfo[]> {
		const rows: ImplementPromptInfo[] = [];
		for (const type of TICKET_TYPES) {
			try {
				const { template, path, source } = await this.read(type);
				rows.push({
					type,
					name: template.name,
					...(template.description ? { description: template.description } : {}),
					path,
					source
				});
			} catch {
				// A missing shipped template is reported at the click, not here.
			}
		}
		return rows;
	}

	/**
	 * The workspace file to open for a type — restored from the shipped one when
	 * that file alone is missing, so **Open** never opens nothing. `undefined`
	 * with no folder open.
	 */
	openTemplate(type: TicketType): Promise<vscode.Uri | undefined> {
		return this.openFile(IMPLEMENT_TEMPLATE_FILE[type]);
	}

	/** The rules file to open, restored the same way. */
	openRules(): Promise<vscode.Uri | undefined> {
		return this.openFile(IMPLEMENT_RULES_FILE);
	}

	/**
	 * Writes a ticket's rendered prompt to `.bfast/implement/prompts/<id>.md`,
	 * overwriting the last one, and returns the workspace-relative path — the
	 * file every agent's handoff sentence names, whichever route. Seeds first,
	 * so creating `prompts/` can never be what makes the templates folder
	 * "exist" without its templates.
	 */
	async writeHandoff(ticketId: string, prompt: string): Promise<string> {
		const root = this.workspace();
		if (!root) {
			throw new ImplementError('not-configured', 'Open a folder before implementing a ticket.');
		}
		await this.ensureSeeded();

		const relative = handoffPath(ticketId);
		const folder = vscode.Uri.joinPath(root.uri, ...IMPLEMENT_FOLDER.split('/'), HANDOFF_FOLDER);
		await vscode.workspace.fs.createDirectory(folder);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(root.uri, ...relative.split('/')),
			new TextEncoder().encode(prompt)
		);
		return relative;
	}

	private uriForFile(name: string): vscode.Uri | undefined {
		const folder = this.folderUri();
		return folder ? vscode.Uri.joinPath(folder, name) : undefined;
	}

	private bundledUri(name: string): vscode.Uri {
		return vscode.Uri.joinPath(this.extensionUri, ...TEMPLATES_PATH, name);
	}

	private async readFile(name: string, what: string): Promise<ImplementTemplateRead> {
		await this.ensureSeeded();
		const path = `${IMPLEMENT_FOLDER}/${name}`;

		const own = this.uriForFile(name);
		const text = own && (await readFile(own));
		if (text !== undefined) {
			return { template: parseImplementTemplate(text, name), path, source: 'workspace' };
		}

		const bundled = await readFile(this.bundledUri(name));
		if (bundled === undefined) {
			throw new ImplementError(
				'provider-error',
				`The shipped file for ${what} (${TEMPLATES_PATH.join('/')}/${name}) is missing.`
			);
		}
		return { template: parseImplementTemplate(bundled, name), path, source: 'bundled' };
	}

	private async openFile(name: string): Promise<vscode.Uri | undefined> {
		await this.ensureSeeded();
		const own = this.uriForFile(name);
		if (!own) {
			return undefined;
		}
		if ((await readFile(own)) === undefined) {
			await this.copyBundled(name);
		}
		return own;
	}

	/** Copies one shipped file into the workspace, verbatim. */
	private async copyBundled(name: string): Promise<void> {
		const target = this.uriForFile(name);
		const text = await readFile(this.bundledUri(name));
		if (target && text !== undefined) {
			await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
		}
	}
}

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

async function readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][] | undefined> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return undefined;
	}
}
