import { TicketSummary } from './types';

export interface TicketNode {
	ticket: TicketSummary;
	children: TicketNode[];
}

/** Turns the flat ticket list into a tree via `parentId`. */
export function buildTree(tickets: TicketSummary[]): TicketNode[] {
	const byId = new Map<string, TicketNode>();
	for (const ticket of tickets) {
		byId.set(ticket.id, { ticket, children: [] });
	}

	const roots: TicketNode[] = [];
	for (const node of byId.values()) {
		const parent = node.ticket.parentId ? byId.get(node.ticket.parentId) : undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

/**
 * Keeps a matching ticket together with the whole tree around it: every ancestor
 * on the way to its epic, and everything hanging below it. Unrelated siblings
 * drop out.
 */
export function filterTree(roots: TicketNode[], filter: string): TicketNode[] {
	const term = filter.trim().toLowerCase();
	if (term.length === 0) {
		return roots;
	}

	// The id is matched as well as the key because ids spell out the whole path
	// (`AC-1.1.2`), so typing a branch's id narrows the tree to that branch.
	const matches = (node: TicketNode): boolean =>
		node.ticket.key.toLowerCase().includes(term) ||
		node.ticket.id.toLowerCase().includes(term) ||
		node.ticket.title.toLowerCase().includes(term);

	const keep = (node: TicketNode, ancestorMatched: boolean): TicketNode | undefined => {
		// Once something on this branch matches, everything below it is related
		// and comes along untouched.
		if (ancestorMatched || matches(node)) {
			return node;
		}

		const children = node.children
			.map((child) => keep(child, false))
			.filter((child): child is TicketNode => child !== undefined);

		return children.length > 0 ? { ticket: node.ticket, children } : undefined;
	};

	return roots
		.map((root) => keep(root, false))
		.filter((root): root is TicketNode => root !== undefined);
}

/** Total number of tickets in a tree, used for the view's filter message. */
export function countNodes(nodes: TicketNode[]): number {
	return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/** The node whose ticket carries `id`, depth-first, or `undefined`. */
export function findNode(roots: TicketNode[], id: string): TicketNode | undefined {
	for (const node of roots) {
		if (node.ticket.id === id) {
			return node;
		}
		const below = findNode(node.children, id);
		if (below) {
			return below;
		}
	}
	return undefined;
}

/**
 * Every test case at or below `node`, in tree order — the node itself included
 * when it is one. Sibling order is the store's scan order (type then ordinal),
 * which `buildTree` preserves, so a story yields its ACs' test cases first and
 * its direct test-case children after them, exactly as the sidebar draws them.
 */
export function collectTestCases(node: TicketNode): TicketSummary[] {
	const collected: TicketSummary[] = [];
	const walk = (current: TicketNode): void => {
		if (current.ticket.type === 'testcase') {
			collected.push(current.ticket);
		}
		for (const child of current.children) {
			walk(child);
		}
	};
	walk(node);
	return collected;
}
