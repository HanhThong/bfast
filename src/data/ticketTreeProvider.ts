import * as vscode from 'vscode';
import { ticketUri } from './ticketUri';
import { TicketStore } from './ticketStore';
import { buildTree, countNodes, filterTree, TicketNode } from './ticketTree';
import { allowedChildTypes } from './trackerPaths';
import { TicketStatus, TicketSummary, TicketType } from './types';
import { ticketIcon } from '../ticketIcon';

const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'Epic',
	story: 'Story',
	ac: 'Acceptance criterion',
	testcase: 'Test case'
};

const STATUS_LABEL: Record<TicketStatus, string> = {
	'todo': 'To do',
	'in-progress': 'In progress',
	'in-review': 'In review',
	'done': 'Done',
	'blocked': 'Blocked'
};

/** What the provider needs of its view — a `Pick`, so a test can hand in a fake. */
export type TicketView = Pick<
	vscode.TreeView<TicketNode>,
	'reveal' | 'visible' | 'selection' | 'onDidChangeVisibility' | 'message' | 'description'
>;

/** A promise settled by hand, and readable as settled. */
interface Deferred {
	readonly promise: Promise<void>;
	readonly settled: boolean;
	resolve(): void;
}

function deferred(): Deferred {
	let settle!: () => void;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const value = {
		promise,
		settled: false,
		resolve(): void {
			value.settled = true;
			settle();
		}
	};
	return value;
}

/**
 * The sidebar's ticket tree, read a level at a time: the root call lists the
 * epics, collapsed, and a level is read from the store only when its parent is
 * expanded — so opening a large tracker costs one folder listing, and a write's
 * refresh re-reads only what is open. A filter is the one exception: a search
 * has to see every ticket, so while one is active the whole tracker is read
 * and shown expanded, exactly as before.
 *
 * It also follows the board: `reveal(id)` selects a ticket and expands down to
 * it, which is what makes a lazy tree need `getParent` and a node for a ticket
 * whose ancestors were never expanded.
 */
export class TicketTreeProvider implements vscode.TreeDataProvider<TicketNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
		TicketNode | undefined | void
	>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	/** The whole tracker, held only while a filter is active. */
	private summaries: TicketSummary[] | undefined;
	private filter = '';

	/**
	 * The sidebar's eye button. Test cases are the bulk of a tracker and the
	 * level people least often browse, so hiding them leaves the plan — epics,
	 * stories, criteria — readable. Applied in both modes; the store is
	 * untouched, so a board, Run Tests and the filter's ticket count all still
	 * see them.
	 */
	private testCasesHidden = false;

	/**
	 * False until `.vscode/bfast.json` is found. An unconfigured workspace yields
	 * no nodes on purpose: an empty tree is what lets the `viewsWelcome` "Init
	 * settings" button take over the view.
	 */
	private configured = false;

	/** Set once the view exists: the filter message, and `reveal`. */
	private view: TicketView | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	/**
	 * Every node handed to VS Code since the last refresh, by ticket id — what
	 * `getParent` and `reveal` look up. Rebuilt on every fetch: VS Code hands
	 * back the object from the *latest* fetch of a parent, so identity is never
	 * relied on.
	 */
	private nodes = new Map<string, TicketNode>();

	/**
	 * Settles once the root has been served after the last refresh. A reveal
	 * issued in the same tick as a refresh — a create, then "open it" — would
	 * otherwise race the tree's own reload on the main thread and fail silently.
	 */
	private rootFetched = deferred();

	/** A reveal that arrived while the view was hidden or the tree unconfigured. */
	private pendingReveal: string | undefined;

	/** Bumped by every `reveal`, so a superseded one drops out after each await. */
	private revealRequest = 0;

	/** The last ticket a board showed — where to land when a filter is cleared. */
	private lastShown: string | undefined;

	constructor(private readonly store: TicketStore) {}

	attach(view: TicketView): void {
		this.view = view;
		// A reveal parked while the view was hidden is applied the moment it shows.
		this.disposables.push(
			view.onDidChangeVisibility((event) => {
				if (event.visible) {
					void this.flushReveal();
				}
			})
		);
	}

	get activeFilter(): string {
		return this.filter;
	}

	private get filtering(): boolean {
		return this.filter.trim().length > 0;
	}

	async getChildren(node?: TicketNode): Promise<TicketNode[]> {
		if (!this.configured) {
			if (this.view) {
				this.view.message = undefined;
			}
			if (!node) {
				this.rootFetched.resolve();
			}
			return [];
		}

		if (this.filtering) {
			return this.getFilteredChildren(node);
		}

		const children = (await this.store.listChildren(node?.ticket.id))
			.filter((ticket) => this.shows(ticket))
			.map((ticket) => this.remember({ ticket, children: [] }));
		if (node) {
			node.children = children;
		} else {
			if (this.view) {
				this.view.message = undefined;
			}
			this.rootFetched.resolve();
			void this.flushReveal();
		}
		return children;
	}

	/** The eager tree: every ticket read, matched with `filterTree`, all expanded. */
	private async getFilteredChildren(node?: TicketNode): Promise<TicketNode[]> {
		if (node) {
			return node.children;
		}

		if (!this.summaries) {
			this.summaries = await this.store.listSummaries();
		}

		const roots = filterTree(
			buildTree(this.summaries.filter((ticket) => this.shows(ticket))),
			this.filter
		);
		// Indexed from the filtered tree, not the full one: `filterTree` copies a
		// partially matching node, and the copy is what VS Code is holding.
		this.nodes = new Map();
		const index = (nodes: TicketNode[]): void => {
			for (const candidate of nodes) {
				this.nodes.set(candidate.ticket.id, candidate);
				index(candidate.children);
			}
		};
		index(roots);
		this.updateMessage(roots);
		this.rootFetched.resolve();
		void this.flushReveal();
		return roots;
	}

	getTreeItem(node: TicketNode): vscode.TreeItem {
		const { ticket } = node;
		const lazy = !this.filtering;

		const item = new vscode.TreeItem(
			`${ticket.key} - ${ticket.title}`,
			collapsibleState(node, lazy, this.testCasesHidden)
		);

		if (lazy) {
			// VS Code keys expansion and selection on the id, so both survive the
			// refresh every write fires, and a rename — without one the handle is
			// derived from the label. Never `Expanded` here: VS Code fetches every
			// Expanded subtree at paint, which would be the full scan by another
			// route.
			//
			// Dropped while a filter is active, as it always was: switching modes
			// changes every handle, so entering a filter makes every node new and
			// its `Expanded` applies — which is what puts a match on screen rather
			// than behind a parent the user had collapsed.
			item.id = ticket.id;
		}

		// The type is part of the context value so the "New story" / "New test
		// case" menu entries can gate on it; keep in sync with `allowedChildTypes`.
		item.contextValue = `ticket:${ticket.type}`;
		item.iconPath = ticketIcon(ticket.type, ticket.status);
		// What a `FileDecorationProvider` keys on — the commit feature's
		// uncommitted-change marks. The label and icon are set, so the resource
		// supplies neither.
		item.resourceUri = ticketUri(ticket.id);

		if (ticket.warning) {
			item.description = `⚠ ${ticket.warning}`;
		}

		item.tooltip = new vscode.MarkdownString(
			[
				`**${ticket.key}** — ${ticket.title}`,
				'',
				`- Type: ${TYPE_LABEL[ticket.type]}`,
				`- Status: ${STATUS_LABEL[ticket.status]}`,
				`- Assignee: ${ticket.assignee ?? 'Unassigned'}`,
				...(ticket.warning ? [`- ⚠ ${ticket.warning}`] : [])
			].join('\n')
		);
		// `vscode.open` on the ticket's resource, not `bfast.openTicket`: the tree
		// hands a click's preview/pinned open event to `vscode.open` (and
		// `vscode.diff`) and to no other command, so this is the one way a single
		// click becomes a preview tab and a double-click a pinned one.
		item.command = {
			command: 'vscode.open',
			title: 'Open Ticket',
			arguments: [ticketUri(ticket.id)]
		};

		return item;
	}

	/** Required by `TreeView.reveal`, which walks up from the target to the root. */
	async getParent(node: TicketNode): Promise<TicketNode | undefined> {
		return node.ticket.parentId ? this.nodeFor(node.ticket.parentId) : undefined;
	}

	/**
	 * Selects the ticket in the tree, expanding down to it — what a board asks
	 * for when it opens or becomes the active tab. It never takes focus, and it
	 * never shows a hidden sidebar (`TreeView.reveal` would): while the view is
	 * hidden, or the tree not yet configured, the id is kept and revealed the
	 * moment the view shows or the root loads. The latest ask wins.
	 */
	async reveal(id: string): Promise<void> {
		this.lastShown = id;
		this.pendingReveal = id;
		this.revealRequest++;
		await this.flushReveal();
	}

	private async flushReveal(): Promise<void> {
		const id = this.pendingReveal;
		const view = this.view;
		if (!id || !view || !view.visible || !this.configured) {
			// Kept: the visibility event or the first root fetch calls back here.
			return;
		}
		this.pendingReveal = undefined;
		const request = this.revealRequest;

		// A reveal racing the tree's own reload fails silently on the main thread
		// ("Data tree node not found"): wait for the root to have been served,
		// then one macrotask more so that reply has landed before this is sent.
		// Re-read each time round: a refresh in between re-arms it.
		while (!this.rootFetched.settled) {
			await this.rootFetched.promise;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (request !== this.revealRequest) {
			return;
		}
		if (!view.visible) {
			// Hidden in the meantime; wait for it again rather than show it.
			this.pendingReveal ??= id;
			return;
		}
		if (view.selection[0]?.ticket.id === id) {
			// The click that opened the board already selected it.
			return;
		}

		try {
			const node = await this.nodeFor(id);
			// A hidden test case has no row; its board opening selects nothing.
			if (node && this.shows(node.ticket) && request === this.revealRequest && view.visible) {
				await view.reveal(node, { select: true, focus: false, expand: false });
			}
		} catch {
			// Gone from disk, or filtered out: nothing to reveal.
		}
	}

	/**
	 * The node for an id whether or not its level has been fetched: a ticket
	 * opened from a board may sit under ancestors the tree has never expanded,
	 * and `reveal` matches on the item's `id`, so a freshly built node is as
	 * good as the one VS Code holds. Under a filter only a listed ticket has a
	 * row — one that was filtered out has nowhere to be revealed.
	 */
	private async nodeFor(id: string): Promise<TicketNode | undefined> {
		const cached = this.nodes.get(id);
		if (cached || this.filtering) {
			return cached;
		}
		const ticket = await this.store.getSummary(id);
		return ticket ? this.remember({ ticket, children: [] }) : undefined;
	}

	private remember(node: TicketNode): TicketNode {
		this.nodes.set(node.ticket.id, node);
		return node;
	}

	setFilter(filter: string): void {
		if (filter === this.filter) {
			return;
		}
		const clearing = this.filtering && filter.trim().length === 0;
		const selected = this.view?.selection[0]?.ticket.id;

		this.filter = filter;
		void vscode.commands.executeCommand('setContext', 'bfast.hasFilter', filter.trim().length > 0);
		if (clearing) {
			// Not held across the lazy tree: it is the whole tracker.
			this.summaries = undefined;
		}
		this.repaint();

		// Back to the lazy tree, which comes up as collapsed epics: land the user
		// on the ticket they were looking at rather than on a bare list.
		const target = selected ?? this.lastShown;
		if (clearing && target) {
			void this.reveal(target);
		}
	}

	get hidesTestCases(): boolean {
		return this.testCasesHidden;
	}

	/** The eye button: drop test case rows from the tree, or bring them back. */
	setTestCasesHidden(hidden: boolean): void {
		if (hidden === this.testCasesHidden) {
			return;
		}
		this.testCasesHidden = hidden;
		void vscode.commands.executeCommand('setContext', 'bfast.testCasesHidden', hidden);
		if (this.view) {
			// Said beside the view's title, so an empty criterion never reads as one
			// whose test cases were lost.
			this.view.description = hidden ? 'Test cases hidden' : undefined;
		}
		this.repaint();
	}

	private shows(ticket: TicketSummary): boolean {
		return !(this.testCasesHidden && ticket.type === 'testcase');
	}

	/** Switches between the ticket tree and the "Init settings" welcome view. */
	setConfigured(configured: boolean): void {
		if (configured === this.configured) {
			return;
		}
		this.configured = configured;
		this.refresh();
	}

	/** Drops everything cached, so the next read goes back to the store. */
	refresh(): void {
		this.summaries = undefined;
		this.repaint();
	}

	/** Fires the tree event, with what a reveal needs to know about it. */
	private repaint(): void {
		this.nodes = new Map();
		// Re-armed for the fetch this event causes. The one it replaces is
		// settled rather than orphaned: VS Code coalesces refreshes, so a fetch
		// for it may never come, and `flushReveal` re-reads the field each time
		// round its wait.
		const previous = this.rootFetched;
		this.rootFetched = deferred();
		previous.resolve();
		this.onDidChangeTreeDataEmitter.fire();
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.onDidChangeTreeDataEmitter.dispose();
	}

	private updateMessage(roots: TicketNode[]): void {
		if (!this.view) {
			return;
		}

		const term = this.filter.trim();
		if (term.length === 0) {
			this.view.message = undefined;
			return;
		}

		const count = countNodes(roots);
		this.view.message =
			count === 0
				? `No ticket matches “${term}”.`
				: `Filter: “${term}” — ${count} ticket${count === 1 ? '' : 's'}`;
	}
}

function collapsibleState(
	node: TicketNode,
	lazy: boolean,
	testCasesHidden: boolean
): vscode.TreeItemCollapsibleState {
	if (!lazy) {
		return node.children.length > 0
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None;
	}
	// A store that cannot say gets an expander on every type that may have children.
	// With test cases hidden, a type that can hold nothing else has none to show.
	const visible = allowedChildTypes(node.ticket.type).filter(
		(type) => !(testCasesHidden && type === 'testcase')
	);
	const expandable = visible.length > 0 && (node.ticket.hasChildren ?? true);
	return expandable
		? vscode.TreeItemCollapsibleState.Collapsed
		: vscode.TreeItemCollapsibleState.None;
}
