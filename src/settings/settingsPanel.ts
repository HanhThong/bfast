import * as vscode from 'vscode';
import { validateStyleId, validateStylePrefix } from '../design/designDocument';
import { skillKind, ticketTypeLabel, resolveDesignSkill, type AgentDefinition } from '../ai/agent';
import type { AgentStore } from '../ai/agentStore';
import { TICKET_TYPES, type TicketType } from '../data/types';
import type { ImplementPromptStore } from '../implement/implementPromptStore';
import { IMPLEMENT_RULES_FILE, IMPLEMENT_TEMPLATE_FILE } from '../implement/implementPrompt';
import {
	normalizeWorktreesFolder,
	validateWorktreesFolder
} from './environmentSettings';
import {
	collapseTilde,
	defaultWorktreesHome,
	worktreesHome
} from '../environments/environmentContext';
import {
	mcpEnabled,
	mcpPort,
	mcpReach
} from './mcpSettings';
import type { McpServerStatus } from '../mcp/mcpStatus';
import { isMcpClientId, type McpClientId } from '../mcp/mcpClients';
import {
	BfastSettings,
	normalizeSettings,
	SETTINGS_FILE,
	validateSettings
} from './bfastSettings';
import { SettingsService } from './settingsService';
import { HostToSettings, SettingsToHost } from '../shared/protocol';
import { renderWebviewHtml } from '../host/webviewHtml';
import { errorMessage } from '../platform/errors';
import { unhandled } from '../platform/exhaustive';
import { type EnvironmentsSettings } from './environmentSettings';
import {
	readComposeServices,
	settingsRefusal,
	toWorkspaceRelative,
	worktreesFolderRefusal
} from './settingsChecks';

/**
 * What the form needs from the MCP server: where it has got to, a subscription
 * so the tab follows it, and the clipboard.
 *
 * An interface rather than the `McpServer` itself, the `BoardServices` posture —
 * the panel has no business reaching a listener, and a test can hand it a
 * literal.
 */
export interface McpPanelServices {
	status(): McpServerStatus;
	onDidChangeStatus(listener: (status: McpServerStatus) => void): () => void;
	/** Copies the live address, which is the host's to know — never one the webview sent back. */
	copyAddress(): Promise<void>;
	/** Copies one tool's connection snippet, built from that same live address. */
	copyClientSnippet(client: McpClientId): Promise<void>;
	/**
	 * Writes the `bfast` entry into the tool's project config file. Resolves to
	 * the path written; rejects with the reason nothing was written.
	 */
	saveClientConfig(client: McpClientId): Promise<string>;
}

/**
 * The BFAST settings form, shown as a webview editor tab. Like the board it is
 * a singleton — asking for settings again reveals the open tab.
 */
export class SettingsPanel {
	public static readonly viewType = 'bfast.settings';

	private static currentPanel: SettingsPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		settings: SettingsService,
		agents: AgentStore,
		implementPrompts: ImplementPromptStore,
		mcp: McpPanelServices,
		version: string
	): SettingsPanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (SettingsPanel.currentPanel) {
			SettingsPanel.currentPanel.panel.reveal(column);
			return SettingsPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			SettingsPanel.viewType,
			'BFAST Settings',
			column,
			SettingsPanel.webviewOptions(extensionUri)
		);

		SettingsPanel.currentPanel = new SettingsPanel(
			panel,
			extensionUri,
			settings,
			agents,
			implementPrompts,
			mcp,
			version
		);
		return SettingsPanel.currentPanel;
	}

	/** Called by the serializer when VS Code restores the tab after a reload. */
	public static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		settings: SettingsService,
		agents: AgentStore,
		implementPrompts: ImplementPromptStore,
		mcp: McpPanelServices,
		version: string
	): void {
		SettingsPanel.currentPanel?.dispose();
		panel.webview.options = SettingsPanel.webviewOptions(extensionUri);
		SettingsPanel.currentPanel = new SettingsPanel(
			panel,
			extensionUri,
			settings,
			agents,
			implementPrompts,
			mcp,
			version
		);
	}

	private static webviewOptions(
		extensionUri: vscode.Uri
	): vscode.WebviewOptions & vscode.WebviewPanelOptions {
		return {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly settings: SettingsService,
		private readonly agents: AgentStore,
		private readonly implementPrompts: ImplementPromptStore,
		private readonly mcp: McpPanelServices,
		/** The running extension's version, for the form's footer. */
		private readonly version: string
	) {
		this.panel.webview.html = renderWebviewHtml(
			this.panel.webview,
			extensionUri,
			'settings',
			'BFAST Settings'
		);

		this.panel.webview.onDidReceiveMessage(
			(message: SettingsToHost) => this.handleMessage(message),
			undefined,
			this.disposables
		);

		// The tab follows the server rather than only being told after a save:
		// the port may be taken by a window that opens later, and a status that
		// only ever moved on Save would be stale the moment it did.
		this.disposables.push({
			dispose: this.mcp.onDidChangeStatus((status) => this.post({ type: 'mcpStatus', status }))
		});

		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	public dispose(): void {
		if (SettingsPanel.currentPanel === this) {
			SettingsPanel.currentPanel = undefined;
		}

		this.panel.dispose();

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleMessage(message: SettingsToHost): Promise<void> {
		switch (message.type) {
			case 'settingsReady':
				await this.sendSettings();
				break;
			case 'pickWorktreesFolder':
				await this.pickWorktreesFolder();
				break;
			case 'pickTrackerFolder':
				await this.pickTrackerFolder();
				break;
			case 'pickServiceFolder':
				await this.pickServiceFolder(message.index);
				break;
			case 'listComposeServices':
				await this.listComposeServices(message.environments);
				break;
			case 'saveSettings':
				await this.save(message.settings);
				break;
			case 'openAgent':
				await this.openFile(this.agents.uriFor(message.slug), message.slug);
				break;
			case 'openSkill':
				await this.openSkill(message.agent, message.skill);
				break;
			case 'newAgent':
				await this.newAgent();
				break;
			case 'newSkill':
				await this.newSkill(message.agent);
				break;
			case 'openSkillResource':
				await this.openSkillResource(message.agent, message.skill, message.name);
				break;
			case 'openImplementPrompt':
				await this.openImplementPrompt(message.ticketType);
				break;
			case 'openImplementRules':
				await this.openImplementRules();
				break;
			case 'newDesignStyle':
				await this.newDesignStyle();
				break;
			case 'addDesignStyle':
				await this.addDesignStyle(message.style);
				break;
			case 'copyMcpAddress':
				await this.mcp.copyAddress();
				break;
			case 'copyMcpClientSnippet':
				if (isMcpClientId(message.client)) {
					await this.mcp.copyClientSnippet(message.client);
				}
				break;
			case 'saveMcpClientConfig':
				await this.saveMcpClientConfig(message.client);
				break;
			case 'cancelSettings':
				this.dispose();
				break;
			default:
				unhandled(message);
		}
	}

	/** Sends the saved settings, or the defaults when nothing is configured yet. */
	private async sendSettings(): Promise<void> {
		const saved = await this.settings.read();
		this.post({
			type: 'settings',
			settings: saved ?? this.settings.defaults(),
			configured: saved !== undefined,
			// Listing them seeds `.bfast/agents` on a fresh workspace, so the first
			// visit to this form is also where the built-in agents appear on disk.
			agents: await this.agents.list(),
			// The same for `.bfast/implement`.
			implementPrompts: await this.implementPrompts.list(),
			// Resolved here because only the host can: the webview has no `os`.
			worktreesDefault: defaultWorktreesHome(),
			version: this.version
		});
		this.post({ type: 'mcpStatus', status: this.mcp.status() });
	}

	/**
	 * Save for the team. The failure is reported on the tab — the file was not
	 * touched, and the reason says which file and why — the `settingsError`
	 * posture the rest of the form takes.
	 */
	private async saveMcpClientConfig(client: unknown): Promise<void> {
		if (!isMcpClientId(client)) {
			return;
		}
		try {
			await this.mcp.saveClientConfig(client);
		} catch (failure) {
			this.post({
				type: 'settingsError',
				message: errorMessage(failure, 'Could not save the connection config.')
			});
		}
	}

	/** Opens one of Implement's templates, restoring the shipped one when it is missing. */
	private async openImplementPrompt(type: TicketType): Promise<void> {
		if (!TICKET_TYPES.includes(type)) {
			return;
		}
		try {
			await this.openFile(await this.implementPrompts.openTemplate(type), IMPLEMENT_TEMPLATE_FILE[type]);
		} catch (failure) {
			this.post({
				type: 'settingsError',
				message: errorMessage(failure, 'Could not open the template.')
			});
		}
	}

	/** Opens the working rules the templates share, restored the same way. */
	private async openImplementRules(): Promise<void> {
		try {
			await this.openFile(await this.implementPrompts.openRules(), IMPLEMENT_RULES_FILE);
		} catch (failure) {
			this.post({
				type: 'settingsError',
				message: errorMessage(failure, 'Could not open the rules.')
			});
		}
	}

	/**
	 * Agents and skills are markdown files, so editing one happens in a real
	 * editor tab — wrapping, spell-check, undo and a readable git diff, none of
	 * which a textarea in a webview gives you.
	 */
	private async openFile(uri: vscode.Uri | undefined, label: string): Promise<void> {
		if (!uri) {
			this.post({ type: 'settingsError', message: 'Open a folder before editing an agent.' });
			return;
		}

		try {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
				preview: false
			});
		} catch {
			this.post({ type: 'settingsError', message: `Could not open “${label}”.` });
		}
	}

	/**
	 * Opens a skill's `SKILL.md`. It goes through the store rather than building
	 * a path, because a skill may be the folder form or the older one-file form
	 * and only the read knows which.
	 */
	private async openSkill(agent: string, slug: string): Promise<void> {
		const skill = (await this.agents.list())
			.find((candidate) => candidate.slug === agent)
			?.skills.find((candidate) => candidate.slug === slug);

		await this.openFile(skill && this.agents.skillUri(skill), slug);
	}

	/** Opens one of a skill's resources — the expected output, usually. */
	private async openSkillResource(agent: string, slug: string, name: string): Promise<void> {
		const skill = (await this.agents.list())
			.find((candidate) => candidate.slug === agent)
			?.skills.find((candidate) => candidate.slug === slug);
		await this.openFile(skill && this.agents.skillResourceUri(skill, name), name);
	}

	/**
	 * A new design style, one dialog per fact: which role draws it, what it is
	 * called, and the prefix its files take. The id is derived from the label
	 * and confirmed rather than typed twice, and the prefix defaults to the
	 * label's initials — both are what a person would have typed anyway.
	 */
	private async newDesignStyle(): Promise<void> {
		const agents = await this.agents.list();
		const agent = await pickAgent('BFAST — new design style', agents, 'Which role draws this style?');
		if (!agent) {
			return;
		}

		const label = await vscode.window.showInputBox({
			title: 'BFAST — new design style',
			prompt: 'What is this style called?',
			placeHolder: 'e.g. C4 Context',
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim().length > 0 ? undefined : 'Enter a name.')
		});
		if (!label) {
			return;
		}

		const styles = await this.agents.designStyles();
		const id = await vscode.window.showInputBox({
			title: 'BFAST — new design style',
			prompt: 'Its id — the tail of the skill folder’s name, and what documents record as their style',
			value: slugifyStyleId(label),
			ignoreFocusOut: true,
			validateInput: (value) =>
				validateStyleId(value.trim()) ??
				(styles.some((style) => style.id === value.trim())
					? `“${value.trim()}” is already a style.`
					: undefined)
		});
		if (!id) {
			return;
		}

		const taken = styles.map((style) => style.prefix);
		const prefix = await vscode.window.showInputBox({
			title: 'BFAST — new design style',
			prompt: 'The prefix its files start with (ERD-1-…, SEQ-2-…)',
			value: prefixFromLabel(label, taken),
			ignoreFocusOut: true,
			validateInput: (value) => validateStylePrefix(value.trim().toUpperCase(), taken)
		});
		if (!prefix) {
			return;
		}

		await this.scaffold('skill', () =>
			this.agents.createDesignStyle(agent, {
				id: id.trim(),
				label: label.trim(),
				prefix: prefix.trim().toUpperCase()
			})
		);
	}

	/** Gives another role an existing style, picked among the roles lacking it. */
	private async addDesignStyle(style: string): Promise<void> {
		const agents = (await this.agents.list()).filter(
			(agent) => resolveDesignSkill(agent, style) === undefined
		);
		if (agents.length === 0) {
			this.post({ type: 'settingsError', message: 'Every role already has this style.' });
			return;
		}
		const agent = await pickAgent('BFAST — add a design style', agents, 'Which role should draw it?');
		if (agent) {
			await this.scaffold('skill', () => this.agents.addDesignStyle(agent, style));
		}
	}

	private async newAgent(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: 'BFAST — new agent',
			prompt: 'What is this agent called?',
			placeHolder: 'e.g. QA Engineer',
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim().length > 0 ? undefined : 'Enter a name.')
		});

		// Escaping either step must not leave a stray file behind.
		if (!name) {
			return;
		}

		const types = await pickTicketTypes('BFAST — new agent', TICKET_TYPES, true);
		if (types.length === 0) {
			return;
		}

		await this.scaffold('agent', () => this.agents.create(name, types));
	}

	private async newSkill(agent: string): Promise<void> {
		const existing = (await this.agents.list()).find((candidate) => candidate.slug === agent);
		// Offering a type the agent already writes would create a second skill for
		// it, and only the first would ever run.
		const available = TICKET_TYPES.filter(
			(type) =>
				!existing?.skills.some(
					(skill) => skillKind(skill) === 'write' && skill.types.includes(type)
				)
		);

		if (available.length === 0) {
			this.post({
				type: 'settingsError',
				message: `“${existing?.name ?? agent}” already has a skill for every ticket type.`
			});
			return;
		}

		const [type] = await pickTicketTypes('BFAST — new skill', available, false);
		if (!type) {
			return;
		}

		await this.scaffold('skill', () => this.agents.createSkill(agent, type));
	}

	/** Writes the file, opens it, and refreshes the list behind the form. */
	private async scaffold(kind: 'agent' | 'skill', write: () => Promise<vscode.Uri>): Promise<void> {
		try {
			const uri = await write();
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
				preview: false
			});
			await this.sendSettings();
		} catch (failure) {
			this.post({
				type: 'settingsError',
				message: errorMessage(failure, `The ${kind} could not be created.`)
			});
		}
	}

	private async pickTrackerFolder(): Promise<void> {
		const workspace = this.settings.workspaceFolder;
		if (!workspace) {
			this.post({ type: 'settingsError', message: 'Open a folder before configuring BFAST.' });
			return;
		}

		const picked = await vscode.window.showOpenDialog({
			title: 'Select the tracker store folder',
			defaultUri: workspace.uri,
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Use this folder'
		});

		const folder = picked?.[0];
		if (!folder) {
			return;
		}

		const relative = toWorkspaceRelative(workspace.uri, folder);
		if (relative === undefined) {
			this.post({
				type: 'settingsError',
				message: 'Pick a folder inside the workspace — the tracker store is stored with the project.'
			});
			return;
		}

		this.post({ type: 'trackerFolderPicked', folder: relative });
	}

	/** `pickTrackerFolder` for a service's folder: inside the workspace, or refused in words. */
	private async pickServiceFolder(index: number): Promise<void> {
		const workspace = this.settings.workspaceFolder;
		if (!workspace) {
			this.post({ type: 'settingsError', message: 'Open a folder before configuring BFAST.' });
			return;
		}
		const picked = await vscode.window.showOpenDialog({
			title: 'Select the service folder',
			defaultUri: workspace.uri,
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Use this folder'
		});
		const folder = picked?.[0];
		if (!folder) {
			return;
		}
		const relative = toWorkspaceRelative(workspace.uri, folder);
		if (relative === undefined) {
			this.post({
				type: 'settingsError',
				message: 'Pick a folder inside the workspace — a service’s commands run in it.'
			});
			return;
		}
		this.post({ type: 'serviceFolderPicked', index, folder: relative });
	}

	/**
	 * The compose chain's service names, for the Services checklist. The form's
	 * unsaved environments block is normalised first — the parse drops a path
	 * that is absolute or leaves the workspace — so no path from the webview
	 * reaches `docker` unchecked. A failure is an answer, not a dialog: the
	 * field falls back to free text and says why.
	 */
	private async listComposeServices(environments: EnvironmentsSettings | undefined): Promise<void> {
		this.post({
			type: 'composeServices',
			...(await readComposeServices(this.settings.workspaceFolder, environments))
		});
	}

	/**
	 * The mirror of `pickTrackerFolder`: that one refuses a folder **outside**
	 * the workspace, this one refuses a folder **inside** it.
	 *
	 * A worktree is disposable and must not sit in the repository, where a
	 * second checkout turns up in every search, every file watcher and every
	 * `git status` — the reason the default lives in the OS temp folder.
	 */
	private async pickWorktreesFolder(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			title: 'Select the folder BFAST keeps worktrees in',
			// The home in force, so Browse opens where the worktrees already are.
			defaultUri: vscode.Uri.file(worktreesHome(this.settings.current?.environments)),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: 'Keep worktrees here'
		});

		const folder = picked?.[0];
		if (!folder) {
			return;
		}

		const message = this.worktreesFolderRefusal(folder);
		if (message) {
			this.post({ type: 'settingsError', message });
			return;
		}

		// Stored the way the parse would store it, so the field shows what the
		// next save writes — and a folder in the home folder as `~/…`, which is
		// the one value a Windows and a macOS teammate can share.
		this.post({
			type: 'worktreesFolderPicked',
			folder: normalizeWorktreesFolder(collapseTilde(folder.fsPath))
		});
	}

	/**
	 * Why this folder cannot be the worktrees home, or `undefined` when it can.
	 * Asked of the picked folder and again of the whole candidate at save: the
	 * inside-the-workspace rule is the one `validateEnvironmentsSettings` cannot
	 * state, since it is pure and the settings webview bundles it — it knows the
	 * path but not where the workspace is.
	 */
	private worktreesFolderRefusal(folder: vscode.Uri): string | undefined {
		return worktreesFolderRefusal(this.settings.workspaceFolder, folder);
	}

	private async save(candidate: BfastSettings): Promise<void> {
		// The form validates as you type; re-check here because the host must not
		// trust a message to write a path.
		// The workspace-relative rule the pure validator cannot reach is in
		// `settingsRefusal` too: a hand-edited absolute path pointing back into
		// the repo is refused here, exactly as the picker refuses one.
		const error = settingsRefusal(this.settings.workspaceFolder, candidate);
		if (error) {
			this.post({ type: 'settingsError', message: error });
			return;
		}

		if (!(await this.confirmMcpReach(candidate))) {
			return;
		}

		try {
			const saved = await this.settings.write(normalizeSettings(candidate));
			this.post({ type: 'settingsSaved' });
			void vscode.window.showInformationMessage(
				`BFAST settings saved to ${SETTINGS_FILE} (tracker store: ${saved.trackerFolder}).`
			);
			// Deliberately not disposed. Saving is what starts, restarts or stops
			// the MCP server, and the tab is where the user reads what happened —
			// whether it is listening, at what address, or that the port is taken
			// and the number they typed is still there to change. Closing the one
			// surface that can say so would make the result unreadable.
		} catch (failure) {
			this.post({
				type: 'settingsError',
				message: `Could not write ${SETTINGS_FILE}: ${errorMessage(failure)}`
			});
		}
	}

	/**
	 * Opening the MCP port to the network is warned **before** it takes effect,
	 * and takes effect only on confirmation.
	 *
	 * A modal, and the host's rather than the form's: it is the one decision here
	 * that changes what other machines can do to this workspace, and a banner in
	 * a webview is something a person clicks past. Asked only when the reach is
	 * actually moving to `network` on a server that will be listening — saving
	 * again with the same setting is not a new decision to take.
	 */
	private async confirmMcpReach(candidate: BfastSettings): Promise<boolean> {
		const wanted = mcpReach(candidate.mcp);
		const saved = this.settings.current;
		if (
			wanted !== 'network' ||
			!mcpEnabled(candidate.mcp) ||
			(mcpReach(saved?.mcp) === 'network' && mcpEnabled(saved?.mcp))
		) {
			return true;
		}

		const choice = await vscode.window.showWarningMessage(
			'Let any machine on the network reach BFAST?',
			{
				modal: true,
				detail:
					`The MCP server will listen on port ${mcpPort(candidate.mcp)} on every network interface. ` +
					'Anyone who can reach this machine on that port can read and change this workspace’s tickets, ' +
					'and trigger whatever else you have switched on. There is no password and no token — BFAST ' +
					'asks connecting clients for nothing at all.'
			},
			'Open to the network'
		);
		if (choice !== 'Open to the network') {
			this.post({
				type: 'settingsError',
				message: 'Nothing was saved. The MCP server is still reachable from this machine only.'
			});
			return false;
		}
		return true;
	}

	private post(message: HostToSettings): void {
		void this.panel.webview.postMessage(message);
	}
}


/**
 * Asks which ticket types a new agent or skill covers.
 *
 * A pick rather than a typed name: a skill *is* "how this role writes a story",
 * so the type is the thing being chosen, and guessing it from free text is what
 * made every new skill an epic. Each entry is labelled with the default skill it
 * would be scaffolded from, so the user can see what they are about to get.
 */
/** One agent by name, or `undefined` when the pick was dismissed. */
async function pickAgent(
	title: string,
	agents: readonly AgentDefinition[],
	placeHolder: string
): Promise<string | undefined> {
	const picked = await vscode.window.showQuickPick(
		agents.map((agent) => ({ label: agent.name, description: agent.description, slug: agent.slug })),
		{ title, placeHolder }
	);
	return picked?.slug;
}

/** `C4 Context` → `c4-context`: the id a style's label suggests. */
function slugifyStyleId(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/^[^a-z]+/, '');
}

/**
 * `C4 Context` → `CC`, then `CC2`… — the initials, made unique. Only a
 * suggestion: the input box shows it and the person can type over it.
 */
function prefixFromLabel(label: string, taken: readonly string[]): string {
	const initials = label
		.split(/\s+/)
		.map((word) => word.replace(/[^A-Za-z0-9]/g, '').charAt(0))
		.join('')
		.toUpperCase()
		.replace(/^[^A-Z]+/, '')
		.slice(0, 4);
	let prefix = initials || 'DOC';
	for (let attempt = 2; taken.includes(prefix); attempt += 1) {
		prefix = `${initials || 'DOC'}${attempt}`.slice(0, 8);
	}
	return prefix;
}

export async function pickTicketTypes(
	title: string,
	available: readonly TicketType[],
	many: boolean
): Promise<TicketType[]> {
	const items = available.map((type) => ({ label: ticketTypeLabel(type), type }));

	if (items.length === 0) {
		return [];
	}

	if (!many) {
		const picked = await vscode.window.showQuickPick(items, {
			title,
			placeHolder: 'What does this skill write?'
		});
		return picked ? [picked.type] : [];
	}

	const picked = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: 'Which ticket types does this agent write?',
		canPickMany: true
	});
	// Ordered by TICKET_TYPES rather than by the order they were ticked, so the
	// skills folder reads the same however it was filled in.
	const wanted = new Set((picked ?? []).map((item) => item.type));
	return TICKET_TYPES.filter((type) => wanted.has(type));
}
