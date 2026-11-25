// The sidebar's second section: one row per environment, a child row per
// allocated port, and below those a row per container of its stack.
//
// Modeled on `TicketTreeProvider`: `setConfigured` empties the tree so the
// `viewsWelcome` entries can render, `refresh()` drops nothing but fires the
// event (every read is already disk-derived via `EnvironmentStore.list()`),
// and no `TreeItem.id` is set — as the ticket tree does while a filter is
// active, so a row that comes back is new and takes its own collapsible state.

import * as vscode from 'vscode';
import type { TicketStore } from '../data/ticketStore';
import {
	EnvironmentError,
	containerDisplayName,
	type EnvironmentContainer,
	type EnvironmentHandle,
	type EnvironmentStatus
} from './environmentProvider';
import type { EnvironmentStore } from './environmentStore';
import { errorMessage } from '../platform/errors';

export type EnvironmentTreeNode =
	| { kind: 'environment'; environment: EnvironmentHandle; title?: string }
	| { kind: 'port'; name: string; port: number; main: boolean }
	| { kind: 'container'; environment: EnvironmentHandle; container: EnvironmentContainer }
	/** Why there is no container row to show — see `containerNodes`. */
	| { kind: 'note'; text: string; warning: boolean };

const STATUS_LABEL: Record<EnvironmentStatus, string> = {
	creating: 'Creating…',
	stopped: 'Stopped',
	starting: 'Starting…',
	running: 'Running',
	stopping: 'Stopping…',
	deleting: 'Deleting…',
	error: 'Error',
	unknown: 'Unknown'
};

export interface EnvironmentTreeDeps {
	environments: EnvironmentStore;
	/** Resolves ticket titles; an environment whose ticket vanished still renders. */
	tickets: TicketStore;
}

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvironmentTreeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	/** Same mechanism as the ticket tree: empty while unconfigured, so the welcome view shows. */
	private configured = false;

	constructor(private readonly deps: EnvironmentTreeDeps) {}

	async getChildren(node?: EnvironmentTreeNode): Promise<EnvironmentTreeNode[]> {
		if (node) {
			// A level at a time, the ticket tree's doctrine: the container
			// listing costs a backend call, and only an **expanded** environment
			// pays it — on this call and on every refresh while it stays open.
			return node.kind === 'environment'
				? [
						...portNodes(node.environment),
						...(await containerNodes(this.deps.environments, node.environment))
					]
				: [];
		}

		if (!this.configured) {
			return [];
		}

		const environments = await this.deps.environments.list();
		const titles = await this.ticketTitles(
			environments.flatMap((environment) => (environment.ticketId ? [environment.ticketId] : []))
		);

		return environments.map((environment) => ({
			kind: 'environment' as const,
			environment,
			// The master environment has no ticket, so no title to look up — and
			// no "ticket not found" to warn about.
			title: environment.ticketId === undefined ? undefined : titles.get(environment.ticketId)
		}));
	}

	getTreeItem(node: EnvironmentTreeNode): vscode.TreeItem {
		switch (node.kind) {
			case 'environment':
				return environmentItem(node);
			case 'port':
				return portItem(node);
			case 'container':
				return containerItem(node);
			case 'note':
				return noteItem(node);
		}
	}

	setConfigured(configured: boolean): void {
		if (configured === this.configured) {
			return;
		}
		this.configured = configured;
		this.onDidChangeTreeDataEmitter.fire();
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	dispose(): void {
		this.onDidChangeTreeDataEmitter.dispose();
	}

	/**
	 * One lookup per environment, never a read of the whole tracker: this runs
	 * on every poll while the section is visible, which is whenever the ticket
	 * tree is — and that tree reads a level at a time for a reason.
	 */
	private async ticketTitles(ids: readonly string[]): Promise<Map<string, string>> {
		const titles = new Map<string, string>();
		await Promise.all(
			[...new Set(ids)].map(async (id) => {
				try {
					const ticket = await this.deps.tickets.getSummary(id);
					if (ticket) {
						titles.set(id, ticket.title);
					}
				} catch {
					// A broken tracker read must not take the environments section down.
				}
			})
		);
		return titles;
	}
}

function environmentItem(node: {
	environment: EnvironmentHandle;
	title?: string;
}): vscode.TreeItem {
	const { environment, title } = node;
	const master = environment.scope === 'master';

	const item = new vscode.TreeItem(
		master
			? 'Master'
			: title === undefined
				? environment.id
				: `${environment.id} ${title}`,
		// Always expandable, whether or not there are ports: the containers are
		// the other half of what is under an environment, and a row that hid
		// them would be the worse mistake — the ticket tree's `hasChildren` is
		// over-inclusive for the same reason. It never opens to nothing, since
		// an empty container list is itself a row that says so.
		vscode.TreeItemCollapsibleState.Collapsed
	);

	// The status is part of the context value so Start/Stop/Delete menu entries
	// can gate on it, and the master environment carries a `:master` suffix so
	// entries that make no sense for it (Open in New Window — the workspace is
	// already open) can opt out with a `$` anchor while every prefix-matching
	// clause keeps applying. Keep in sync with the `when` clauses in
	// package.json.
	item.contextValue = `environment:${environment.status}${master ? ':master' : ''}`;
	item.iconPath = statusIcon(environment.status);

	// The master row says which branch the workspace has out — that is what
	// its stack was built from, and it moves; a ticket row's branch is fixed
	// and lives in the tooltip.
	const notFound = !master && title === undefined ? '⚠ ticket not found' : undefined;
	item.description = [
		STATUS_LABEL[environment.status],
		master && environment.branch ? environment.branch : undefined,
		mainPortSummary(environment),
		notFound
	]
		.filter((part): part is string => part !== undefined)
		.join(' · ');

	item.tooltip = tooltip(environment, title);
	// Deliberately no `item.command`: opening a window is a deliberate gesture,
	// reached by right-click → "Open in New Window" — a plain click only
	// selects/expands, so browsing the list cannot spawn windows by accident.

	return item;
}

function portNodes(environment: EnvironmentHandle): EnvironmentTreeNode[] {
	const main = environment.mainPort;
	const entries = Object.entries(environment.ports).map(([name, port]) => ({
		kind: 'port' as const,
		name,
		port,
		main: name === main
	}));
	// The main port is the environment's front door; it goes first.
	return entries.sort((a, b) => Number(b.main) - Number(a.main));
}

function portItem(node: { name: string; port: number; main: boolean }): vscode.TreeItem {
	const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
	item.description = node.main ? `${node.port} · main` : String(node.port);
	item.iconPath = new vscode.ThemeIcon('plug');
	item.contextValue = 'environmentPort';
	// The row opens in VS Code, and the tooltip says so — there are two routes
	// now, and a name that does not say which one this is leaves the user to
	// find out by clicking.
	item.tooltip = `Open http://localhost:${node.port} in VS Code — right-click to open it in your browser`;
	// Unlike the environment row (where a click spawning a window was an
	// accident waiting to happen), an editor tab is cheap and closable — so a
	// port answers the click directly.
	item.command = {
		command: 'bfast.openEnvironmentPort',
		title: 'Open Port in VS Code',
		arguments: [node]
	};
	return item;
}

/**
 * The stack's containers, or one row saying why there are none.
 *
 * Three things that must never look alike, each getting its own row: a stack
 * with no containers (Stop removed them, or it was never started), a backend
 * that could not be asked at all, and a provider that does not implement this.
 * An empty list where Docker is simply not running would read as "your
 * environment has nothing in it", which is the one wrong thing to say — hence
 * `containers` rejecting rather than answering `[]`.
 */
async function containerNodes(
	store: EnvironmentStore,
	environment: EnvironmentHandle
): Promise<EnvironmentTreeNode[]> {
	let containers: EnvironmentContainer[];
	try {
		containers = await store.containers(environment);
	} catch (error) {
		// A provider that has nothing to say for itself already says it in full
		// ("Kubernetes environments are not implemented yet."); anything else is
		// a backend's own complaint and needs naming what BFAST was doing.
		const reason =
			errorMessage(error, 'the backend could not be queried');
		return [
			{
				kind: 'note',
				text:
					error instanceof EnvironmentError && error.code === 'not-implemented'
						? reason
						: `Could not list containers: ${reason}`,
				warning: true
			}
		];
	}

	return containers.length > 0
		? containers.map((container) => ({ kind: 'container', environment, container }))
		: [{ kind: 'note', text: 'No containers — the environment is not running', warning: false }];
}

function containerItem(node: {
	environment: EnvironmentHandle;
	container: EnvironmentContainer;
}): vscode.TreeItem {
	const { environment, container } = node;
	const item = new vscode.TreeItem(container.service, vscode.TreeItemCollapsibleState.None);

	// The backend's own sentence — 'Up 3 minutes (healthy)', 'Exited (1) 12
	// seconds ago' — so the row reads the way `docker compose ps` does rather
	// than the way BFAST would paraphrase it.
	item.description = container.status;
	item.iconPath = containerIcon(container);
	item.contextValue = 'environmentContainer';
	item.tooltip = containerTooltip(environment, container);
	// A log tab is cheap and closable, so the row answers the click — the port
	// row's rule, and the opposite of the environment row's.
	item.command = {
		command: 'bfast.openContainerLog',
		title: 'Open Container Log',
		arguments: [node]
	};
	return item;
}

/**
 * The verdict at a glance: red is a container that died, which is what makes
 * finding the culprit behind an `error` environment one expand and no reading.
 */
function containerIcon(container: EnvironmentContainer): vscode.ThemeIcon {
	switch (container.state) {
		case 'running':
			return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
		case 'restarting':
			return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
		case 'dead':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'exited':
			return container.exitCode === undefined || container.exitCode === 0
				? new vscode.ThemeIcon('circle-outline')
				: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'unknown':
			return new vscode.ThemeIcon('question');
		default:
			return new vscode.ThemeIcon('circle-outline');
	}
}

function containerTooltip(
	environment: EnvironmentHandle,
	container: EnvironmentContainer
): vscode.MarkdownString {
	return new vscode.MarkdownString(
		[
			`**${container.service}** — ${containerDisplayName(environment, container)}`,
			'',
			`- State: ${container.state}`,
			...(container.status ? [`- Status: ${container.status}`] : []),
			...(container.exitCode === undefined ? [] : [`- Exit code: ${container.exitCode}`]),
			`- Container: \`${container.name}\``,
			'',
			'Click to open its log.'
		].join('\n')
	);
}

function noteItem(node: { text: string; warning: boolean }): vscode.TreeItem {
	const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon(node.warning ? 'warning' : 'info');
	item.tooltip = node.text;
	// Its own context value, so no container or port menu entry can land on it.
	item.contextValue = 'environmentNote';
	return item;
}

function statusIcon(status: EnvironmentStatus): vscode.ThemeIcon {
	switch (status) {
		case 'creating':
		case 'starting':
		case 'stopping':
		case 'deleting':
			return new vscode.ThemeIcon('sync~spin');
		case 'running':
			return new vscode.ThemeIcon('vm-running', new vscode.ThemeColor('charts.green'));
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'unknown':
			return new vscode.ThemeIcon('question');
		default:
			return new vscode.ThemeIcon('vm');
	}
}

function mainPortSummary(environment: EnvironmentHandle): string | undefined {
	const main = environment.mainPort ?? Object.keys(environment.ports)[0];
	const port = main === undefined ? undefined : environment.ports[main];
	return port === undefined ? undefined : `:${port}`;
}

function tooltip(environment: EnvironmentHandle, title: string | undefined): vscode.MarkdownString {
	const ports = Object.entries(environment.ports);
	const master = environment.scope === 'master';
	return new vscode.MarkdownString(
		[
			master
				? '**Master** — the workspace folder itself, whatever it has checked out'
				: `**${environment.id}**${title ? ` — ${title}` : ''}`,
			'',
			`- Status: ${STATUS_LABEL[environment.status]}`,
			...(environment.statusDetail ? [`- ⚠ ${environment.statusDetail}`] : []),
			...(environment.branch ? [`- Branch: \`${environment.branch}\``] : []),
			`- ${master ? 'Folder' : 'Worktree'}: \`${environment.worktreePath}\``,
			`- Project: \`${environment.projectName}\``,
			...(ports.length > 0
				? [
						'',
						'| Variable | Port |',
						'| --- | --- |',
						...ports.map(
							([name, port]) =>
								`| ${name}${name === environment.mainPort ? ' (main)' : ''} | ${port} |`
						)
					]
				: []),
			...(environment.createdAt ? ['', `Created ${environment.createdAt}`] : [])
		].join('\n')
	);
}
