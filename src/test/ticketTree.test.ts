import * as assert from 'assert';
import * as vscode from 'vscode';
import { ticketUri } from '../data/ticketUri';
import {
	buildTree,
	collectTestCases,
	countNodes,
	filterTree,
	findNode,
	TicketNode
} from '../data/ticketTree';
import { TicketTreeProvider, TicketView } from '../data/ticketTreeProvider';
import { MockTicketStore } from './mockTicketStore';

/** Every ticket in the tree, depth first, so a shape is one assertion. */
function keys(nodes: TicketNode[]): string[] {
	return nodes.flatMap((node) => [node.ticket.key, ...keys(node.children)]);
}

const TOTAL = 16;

suite('Ticket tree', () => {
	const store = new MockTicketStore();

	let roots: TicketNode[];

	suiteSetup(async () => {
		roots = buildTree(await store.listSummaries());
	});

	test('nests tickets under their parent', () => {
		assert.deepStrictEqual(
			roots.map((node) => node.ticket.key),
			['EP-1', 'EP-2']
		);
		assert.strictEqual(countNodes(roots), TOTAL);
	});

	test('a test case sits under an AC or directly under its story', () => {
		const [firstEpic] = roots;
		const [firstStory] = firstEpic.children;

		// AC-1, AC-2 and then the standalone TC-1, all children of the story.
		assert.deepStrictEqual(
			firstStory.children.map((node) => `${node.ticket.key} (${node.ticket.type})`),
			['AC-1 (ac)', 'AC-2 (ac)', 'TC-1 (testcase)']
		);
		// The standalone test case and the first AC's test case share a key but
		// not an id — ordinals are per type within a parent.
		assert.deepStrictEqual(
			[firstStory.children[0].children[0].ticket.id, firstStory.children[2].ticket.id],
			['TC-1.1.1.1', 'TC-1.1.1']
		);
	});

	test('a match keeps its ancestors and its descendants', () => {
		// "A successful Stripe payment…" is AC-2 under EP-2 › ST-1.
		const found = keys(filterTree(roots, 'stripe'));

		assert.deepStrictEqual(found, ['EP-2', 'ST-1', 'AC-2']);
	});

	test('a match on an epic keeps its whole subtree', () => {
		const found = keys(filterTree(roots, 'billing'));

		assert.deepStrictEqual(found, ['EP-2', 'ST-1', 'AC-1', 'TC-1', 'AC-2']);
	});

	test('matches on the id as well as the title', () => {
		// The id spells out the path, so it selects exactly one branch even
		// though the key `AC-2` is reused under the other epic.
		assert.deepStrictEqual(keys(filterTree(roots, 'ac-1.1.2')), ['EP-1', 'ST-1', 'AC-2', 'TC-1', 'TC-2']);
	});

	test('matches on the key, which repeats across parents', () => {
		// A bare `AC-2` is deliberately broad: it hits the key of both epics'
		// second AC, and the id of everything under epic 2 whose path starts
		// `AC-2.` — so both branches come back.
		assert.deepStrictEqual(keys(filterTree(roots, 'ac-2')), [
			'EP-1', 'ST-1', 'AC-2', 'TC-1', 'TC-2',
			'EP-2', 'ST-1', 'AC-1', 'TC-1', 'AC-2'
		]);
	});

	test('an empty filter returns the whole tree', () => {
		assert.strictEqual(countNodes(filterTree(roots, '   ')), TOTAL);
	});

	test('findNode walks the tree depth-first by full id', () => {
		assert.strictEqual(findNode(roots, 'TC-1.1.2.2')?.ticket.key, 'TC-2');
		assert.strictEqual(findNode(roots, 'EP-2')?.ticket.title.includes('Billing'), true);
		assert.strictEqual(findNode(roots, 'TC-9.9'), undefined);
	});

	test('collectTestCases spans stories and keeps tree order', () => {
		const epic = findNode(roots, 'EP-1');
		assert.ok(epic);
		assert.deepStrictEqual(
			collectTestCases(epic).map((ticket) => ticket.id),
			['TC-1.1.1.1', 'TC-1.1.2.1', 'TC-1.1.2.2', 'TC-1.1.1', 'TC-1.2.1.1']
		);
	});

	test("collectTestCases on a story takes its ACs' test cases and its direct ones", () => {
		const story = findNode(roots, 'ST-1.1');
		assert.ok(story);
		// The ACs' test cases first, the story's own standalone one after them —
		// exactly the order the sidebar draws.
		assert.deepStrictEqual(
			collectTestCases(story).map((ticket) => ticket.id),
			['TC-1.1.1.1', 'TC-1.1.2.1', 'TC-1.1.2.2', 'TC-1.1.1']
		);
	});

	test('collectTestCases on a test case yields itself, on a childless AC nothing', () => {
		const testCase = findNode(roots, 'TC-1.2.1.1');
		assert.ok(testCase);
		assert.deepStrictEqual(
			collectTestCases(testCase).map((ticket) => ticket.id),
			['TC-1.2.1.1']
		);

		const childless = findNode(roots, 'AC-2.1.2');
		assert.ok(childless);
		assert.deepStrictEqual(collectTestCases(childless), []);
	});

	test('no match returns nothing', () => {
		assert.deepStrictEqual(filterTree(roots, 'zzz'), []);
	});
});

suite('Ticket tree provider', () => {
	const provider = new TicketTreeProvider(new MockTicketStore());

	suiteSetup(() => {
		// The sidebar is gated on settings; these tests are about the tree itself.
		provider.setConfigured(true);
	});

	suiteTeardown(() => {
		provider.dispose();
	});

	test('shows nothing until the workspace is configured', async () => {
		const gated = new TicketTreeProvider(new MockTicketStore());
		try {
			// An empty tree is what lets the "Init settings" welcome view show.
			assert.deepStrictEqual(await gated.getChildren(), []);

			gated.setConfigured(true);
			assert.deepStrictEqual(keys(await gated.getChildren()), ['EP-1', 'EP-2']);
		} finally {
			gated.dispose();
		}
	});

	test('lists the epics at the root, collapsed, and reads a level only when asked', async () => {
		const rootNodes = await provider.getChildren();

		assert.deepStrictEqual(
			rootNodes.map((node) => node.ticket.key),
			['EP-1', 'EP-2']
		);
		// Nothing below the root has been read.
		assert.deepStrictEqual(rootNodes.map((node) => node.children), [[], []]);

		const [epic] = rootNodes;
		const item = provider.getTreeItem(epic);
		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
		// The id is what lets VS Code keep the expansion across a refresh.
		assert.strictEqual(item.id, 'EP-1');

		const stories = await provider.getChildren(epic);
		assert.deepStrictEqual(stories.map((node) => node.ticket.id), ['ST-1.1', 'ST-1.2']);
		assert.strictEqual(epic.children, stories);
	});

	test('a leaf gets no expander', async () => {
		const [epic] = await provider.getChildren();
		const [story] = await provider.getChildren(epic);
		const [ac] = await provider.getChildren(story);
		const [testCase] = await provider.getChildren(ac);

		assert.strictEqual(testCase.ticket.type, 'testcase');
		assert.strictEqual(
			provider.getTreeItem(testCase).collapsibleState,
			vscode.TreeItemCollapsibleState.None
		);
		assert.deepStrictEqual(await provider.getChildren(testCase), []);
	});

	test('hiding test cases drops their rows and an AC’s expander, in both modes', async () => {
		const hidden = new TicketTreeProvider(new MockTicketStore());
		hidden.setConfigured(true);
		try {
			hidden.setTestCasesHidden(true);
			const [epic] = await hidden.getChildren();
			const [story] = await hidden.getChildren(epic);
			const [ac] = await hidden.getChildren(story);
			assert.strictEqual(ac.ticket.type, 'ac');
			assert.strictEqual(
				hidden.getTreeItem(ac).collapsibleState,
				vscode.TreeItemCollapsibleState.None
			);
			assert.deepStrictEqual(await hidden.getChildren(ac), []);
			assert.ok(
				(await hidden.getChildren(story)).every((node) => node.ticket.type !== 'testcase'),
				'a story’s own test cases go too'
			);

			hidden.setFilter('TC-1');
			assert.ok(
				(await hidden.getChildren()).every(function noTestCase(node: TicketNode): boolean {
					return node.ticket.type !== 'testcase' && node.children.every(noTestCase);
				}),
				'a filter does not bring them back'
			);
			hidden.setFilter('');

			hidden.setTestCasesHidden(false);
			const [epicAgain] = await hidden.getChildren();
			const [storyAgain] = await hidden.getChildren(epicAgain);
			const [acAgain] = await hidden.getChildren(storyAgain);
			assert.strictEqual((await hidden.getChildren(acAgain))[0]?.ticket.type, 'testcase');
		} finally {
			hidden.dispose();
		}
	});

	test('a filter reads the whole tree, expanded, and is reported back', async () => {
		provider.setFilter('stripe');
		assert.strictEqual(provider.activeFilter, 'stripe');

		const roots = await provider.getChildren();
		assert.deepStrictEqual(keys(roots), ['EP-2', 'ST-1', 'AC-2']);
		const item = provider.getTreeItem(roots[0]);
		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
		// No id while filtering: a node that comes back has to be new, so that
		// its Expanded state applies and the match is on screen.
		assert.strictEqual(item.id, undefined);

		provider.setFilter('');
		const lazy = await provider.getChildren();
		assert.strictEqual(countNodes(lazy), 2);
		assert.strictEqual(
			provider.getTreeItem(lazy[0]).collapsibleState,
			vscode.TreeItemCollapsibleState.Collapsed
		);
	});

	test('labels a ticket as "key - title"', async () => {
		const [epic] = await provider.getChildren();

		assert.strictEqual(
			provider.getTreeItem(epic).label,
			'EP-1 - Authentication & access control'
		);
	});

	test('the context value carries the type, so menus can gate on it', async () => {
		const [epic] = await provider.getChildren();
		const [story] = await provider.getChildren(epic);

		assert.strictEqual(provider.getTreeItem(epic).contextValue, 'ticket:epic');
		assert.strictEqual(provider.getTreeItem(story).contextValue, 'ticket:story');
	});

	test('an AC with no test case is flagged but still listed', async () => {
		const roots = await provider.getChildren();
		const [story] = await provider.getChildren(roots[1]);
		const childless = (await provider.getChildren(story))[1];

		assert.strictEqual(childless.ticket.key, 'AC-2');
		const item = provider.getTreeItem(childless);
		assert.strictEqual(item.description, '⚠ No test case yet');
		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
	});

	test('opens the ticket it was clicked on', async () => {
		const [epic] = await provider.getChildren();
		const item = provider.getTreeItem(epic);

		// `vscode.open`, so the tree's own open event (preview on a single click,
		// pinned on a double-click) reaches the editor; no other command gets it.
		assert.strictEqual(item.command?.command, 'vscode.open');
		assert.deepStrictEqual(
			item.command?.arguments?.map((argument) => String(argument)),
			[ticketUri('EP-1').toString()]
		);
	});

	test('walks up from a ticket whose ancestors were never expanded', async () => {
		const tree = new TicketTreeProvider(new MockTicketStore());
		tree.setConfigured(true);
		try {
			await tree.getChildren();
			const ac = await new MockTicketStore().getSummary('AC-2.1.2');
			assert.ok(ac);

			const story = await tree.getParent({ ticket: ac, children: [] });
			assert.strictEqual(story?.ticket.id, 'ST-2.1');
			const epic = await tree.getParent(story);
			assert.strictEqual(epic?.ticket.id, 'EP-2');
			assert.strictEqual(await tree.getParent(epic), undefined);
		} finally {
			tree.dispose();
		}
	});
});

/** A stand-in for the view: records reveals, and lets a test show or hide it. */
function fakeView(visible: boolean) {
	const listeners: ((event: vscode.TreeViewVisibilityChangeEvent) => void)[] = [];
	const calls: { id: string; options: unknown }[] = [];
	const view = {
		visible,
		selection: [] as readonly TicketNode[],
		message: undefined as string | undefined,
		description: undefined as string | undefined,
		async reveal(node: TicketNode, options?: unknown): Promise<void> {
			calls.push({ id: node.ticket.id, options });
		},
		onDidChangeVisibility(listener: (event: vscode.TreeViewVisibilityChangeEvent) => void) {
			listeners.push(listener);
			return { dispose(): void {} };
		},
		show(nowVisible: boolean): void {
			view.visible = nowVisible;
			for (const listener of listeners) {
				listener({ visible: nowVisible });
			}
		}
	};
	return { view: view as TicketView & typeof view, calls };
}

/** Long enough for a reveal's own waits (the root, a macrotask, the store). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

suite('Ticket tree reveal', () => {
	let tree: TicketTreeProvider;

	setup(() => {
		tree = new TicketTreeProvider(new MockTicketStore());
	});

	teardown(() => {
		tree.dispose();
	});

	test('selects the board’s ticket without taking focus', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);
		tree.setConfigured(true);
		await tree.getChildren();

		await tree.reveal('AC-2.1.2');

		assert.deepStrictEqual(calls, [
			{ id: 'AC-2.1.2', options: { select: true, focus: false, expand: false } }
		]);
	});

	test('waits for a hidden view to show rather than showing it', async () => {
		const { view, calls } = fakeView(false);
		tree.attach(view);
		tree.setConfigured(true);
		await tree.getChildren();

		await tree.reveal('ST-1.2');
		assert.strictEqual(calls.length, 0);

		view.show(true);
		await settle();
		assert.deepStrictEqual(calls.map((call) => call.id), ['ST-1.2']);
	});

	test('asked before the tree is configured, lands after its first root fetch', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);

		await tree.reveal('EP-2');
		assert.strictEqual(calls.length, 0);

		tree.setConfigured(true);
		await tree.getChildren();
		await settle();
		assert.deepStrictEqual(calls.map((call) => call.id), ['EP-2']);
	});

	test('asked in the same tick as a refresh, waits for the root to be served again', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);
		tree.setConfigured(true);
		await tree.getChildren();

		tree.refresh();
		const revealed = tree.reveal('ST-1.1');
		await settle();
		assert.strictEqual(calls.length, 0, 'must not fire before the tree has reloaded');

		await tree.getChildren();
		await revealed;
		assert.deepStrictEqual(calls.map((call) => call.id), ['ST-1.1']);
	});

	test('the latest ask wins, and an unknown id reveals nothing', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);
		tree.setConfigured(true);
		await tree.getChildren();

		tree.refresh();
		const first = tree.reveal('EP-1');
		const second = tree.reveal('EP-2');
		await tree.getChildren();
		await Promise.all([first, second]);
		assert.deepStrictEqual(calls.map((call) => call.id), ['EP-2']);

		await tree.reveal('EP-9');
		assert.deepStrictEqual(calls.map((call) => call.id), ['EP-2']);
	});

	test('leaves an already selected ticket alone', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);
		tree.setConfigured(true);
		const [epic] = await tree.getChildren();
		view.selection = [epic];

		await tree.reveal(epic.ticket.id);
		assert.strictEqual(calls.length, 0);
	});

	test('clearing a filter lands on the last ticket a board showed', async () => {
		const { view, calls } = fakeView(true);
		tree.attach(view);
		tree.setConfigured(true);
		await tree.getChildren();
		await tree.reveal('ST-1.2');

		tree.setFilter('stripe');
		await tree.getChildren();
		tree.setFilter('');
		await tree.getChildren();
		await settle();

		assert.deepStrictEqual(calls.map((call) => call.id), ['ST-1.2', 'ST-1.2']);
	});
});
