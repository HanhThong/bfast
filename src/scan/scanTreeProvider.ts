// The sidebar's third section: the scan server, and what you need to diagnose a
// failure before you have one.
//
// Modeled on `EnvironmentTreeProvider`: `setConfigured` empties the tree so the
// `viewsWelcome` entries can render, `refresh()` drops nothing but fires the
// event (every read is already disk-derived via `ScanServerStore.get()`), and no
// `TreeItem.id` is set — the house rule.
//
// The credential row earns its place: "the scan failed and nobody can tell why"
// is this feature's number-one failure mode, and `Token: not set` in the tree is
// the cheapest possible answer to it.

import * as vscode from 'vscode';
import type { ScanServerHandle, ScanServerStatus } from './scanProvider';
import type { ScanOutcome } from './scanReport';
import type { ScanRunSummary, ScanServerStore } from './scanServerStore';

export type ScanTreeNode =
	| { kind: 'server'; server: ScanServerHandle; toolLabel: string }
	| { kind: 'endpoint'; url: string }
	| { kind: 'credential'; set: boolean }
	| { kind: 'run'; run: ScanRunSummary };

const STATUS_LABEL: Record<ScanServerStatus, string> = {
	absent: 'Not deployed',
	deploying: 'Deploying…',
	stopped: 'Stopped',
	starting: 'Starting…',
	provisioning: 'Provisioning…',
	running: 'Running',
	stopping: 'Stopping…',
	removing: 'Removing…',
	error: 'Error',
	unknown: 'Unknown',
	external: 'External'
};

const OUTCOME_LABEL: Record<ScanOutcome, string> = {
	passed: 'passed',
	warn: 'passed with warnings',
	'no-gate': 'no quality gate',
	failed: 'failed',
	'ce-failed': 'could not be processed',
	'scanner-failed': 'scanner failed',
	timeout: 'timed out',
	unreachable: 'server unreachable',
	unauthorized: 'unauthorized',
	cancelled: 'cancelled'
};

export interface ScanTreeDeps {
	servers: ScanServerStore;
	/** The tool's display name, read at call time so switching tool follows. */
	toolLabel: () => string;
}

export class ScanTreeProvider implements vscode.TreeDataProvider<ScanTreeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	/** Same mechanism as the other two sections: empty while unconfigured. */
	private configured = false;

	constructor(private readonly deps: ScanTreeDeps) {}

	async getChildren(node?: ScanTreeNode): Promise<ScanTreeNode[]> {
		if (node) {
			return node.kind === 'server' ? this.childrenOf(node.server) : [];
		}
		if (!this.configured) {
			return [];
		}
		const server = await this.deps.servers.get();
		return [{ kind: 'server', server, toolLabel: this.deps.toolLabel() }];
	}

	getTreeItem(node: ScanTreeNode): vscode.TreeItem {
		switch (node.kind) {
			case 'server':
				return serverItem(node);
			case 'endpoint':
				return endpointItem(node);
			case 'credential':
				return credentialItem(node);
			case 'run':
				return runItem(node);
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

	private childrenOf(server: ScanServerHandle): ScanTreeNode[] {
		const children: ScanTreeNode[] = [];
		if (server.endpoint) {
			children.push({ kind: 'endpoint', url: server.endpoint.url });
		}
		children.push({ kind: 'credential', set: server.credentialed });
		for (const run of this.deps.servers.runs) {
			children.push({ kind: 'run', run });
		}
		return children;
	}
}

function serverItem(node: { server: ScanServerHandle; toolLabel: string }): vscode.TreeItem {
	const { server, toolLabel } = node;
	const item = new vscode.TreeItem(toolLabel, vscode.TreeItemCollapsibleState.Expanded);

	// The status is part of the context value so the menu entries can gate on it;
	// keep in sync with the `when` clauses in package.json. `external` is a status
	// rather than a flag precisely so Start, Stop and Remove never match it.
	item.contextValue = `scanServer:${server.status}`;
	item.iconPath = statusIcon(server.status);
	item.description = [STATUS_LABEL[server.status], server.port ? `:${server.port}` : undefined]
		.filter((part): part is string => part !== undefined)
		.join(' · ');
	item.tooltip = serverTooltip(server, toolLabel);
	// Deliberately no `item.command`: the actions are all deliberate gestures on
	// the right-click menu, the rule the environment row already follows.
	return item;
}

function endpointItem(node: { url: string }): vscode.TreeItem {
	const item = new vscode.TreeItem(node.url, vscode.TreeItemCollapsibleState.None);
	item.iconPath = new vscode.ThemeIcon('globe');
	item.contextValue = 'scanEndpoint';
	item.tooltip = `Open ${node.url}`;
	// A browser tab is cheap and closable, so this one answers the click — the
	// same call the environments section's port rows make.
	item.command = { command: 'bfast.openScanServer', title: 'Open in Browser', arguments: [node] };
	return item;
}

/**
 * The credential row reads like the server row — a label and a state — rather
 * than "Token: set", which named the mechanism and not the situation. `ready`
 * is the answer to the one question this row exists for: can a scan run.
 */
function credentialItem(node: { set: boolean }): vscode.TreeItem {
	const item = new vscode.TreeItem('Credentials', vscode.TreeItemCollapsibleState.None);
	item.description = node.set ? 'ready' : 'missing — click to add a token';
	item.iconPath = new vscode.ThemeIcon(
		node.set ? 'key' : 'warning',
		node.set ? undefined : new vscode.ThemeColor('charts.yellow')
	);
	item.contextValue = `scanCredential:${node.set ? 'set' : 'missing'}`;
	item.tooltip = node.set
		? 'A SonarQube token is stored for this workspace. Use the copy button to put it on the clipboard, or click to replace it.'
		: 'No SonarQube token is stored. Click to set one, or Deploy to have BFAST generate its own.';
	item.command = {
		command: 'bfast.setSonarQubeToken',
		title: 'Set SonarQube Token',
		arguments: []
	};
	return item;
}

function runItem(node: { run: ScanRunSummary }): vscode.TreeItem {
	const { run } = node;
	const label = run.target.ticketKey ?? run.target.ticketId ?? run.target.projectKey;
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.description = OUTCOME_LABEL[run.outcome];
	item.iconPath = outcomeIcon(run.outcome);
	item.contextValue = `scanRun:${run.outcome}`;
	item.tooltip = new vscode.MarkdownString(
		[`**${label}** — ${OUTCOME_LABEL[run.outcome]}`, '', run.summary, '', `Ran ${run.finishedAt}`].join(
			'\n'
		)
	);
	item.command = { command: 'bfast.openScanResults', title: 'Open Scan Results', arguments: [node] };
	return item;
}

function statusIcon(status: ScanServerStatus): vscode.ThemeIcon {
	switch (status) {
		case 'deploying':
		case 'starting':
		case 'provisioning':
		case 'stopping':
		case 'removing':
			return new vscode.ThemeIcon('sync~spin');
		case 'running':
			return new vscode.ThemeIcon('server-process', new vscode.ThemeColor('charts.green'));
		case 'external':
			return new vscode.ThemeIcon('cloud');
		case 'error':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'unknown':
			return new vscode.ThemeIcon('question');
		default:
			return new vscode.ThemeIcon('server');
	}
}

function outcomeIcon(outcome: ScanOutcome): vscode.ThemeIcon {
	switch (outcome) {
		case 'passed':
			return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
		case 'warn':
		case 'no-gate':
			return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
		case 'failed':
			return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
		case 'cancelled':
			return new vscode.ThemeIcon('circle-slash');
		default:
			return new vscode.ThemeIcon('alert', new vscode.ThemeColor('charts.red'));
	}
}

function serverTooltip(server: ScanServerHandle, toolLabel: string): vscode.MarkdownString {
	return new vscode.MarkdownString(
		[
			`**${toolLabel}** — ${STATUS_LABEL[server.status]}`,
			...(server.statusDetail ? ['', `⚠ ${server.statusDetail}`] : []),
			'',
			`- Project: \`${server.projectName}\``,
			...(server.endpoint ? [`- URL: ${server.endpoint.url}`] : []),
			...(server.port ? [`- Port: ${server.port}`] : []),
			`- Credentials: ${server.credentialed ? 'ready' : 'missing'}`,
			...(server.createdAt ? ['', `Deployed ${server.createdAt}`] : [])
		].join('\n')
	);
}
