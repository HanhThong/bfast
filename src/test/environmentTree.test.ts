import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EnvironmentContext } from '../environments/environmentContext';
import type {
	EnvironmentContainer,
	EnvironmentHandle,
	EnvironmentProvider
} from '../environments/environmentProvider';
import { EnvironmentStore } from '../environments/environmentStore';
import { K8sProvider } from '../environments/k8sProvider';
import type { EnvironmentsSettings } from '../settings/environmentSettings';
import { EnvironmentTreeProvider } from '../environments/environmentTreeProvider';
import { FakeEnvironmentProvider } from './fakeEnvironmentProvider';
import { FakeProcessRunner } from './fakeProcessRunner';
import { MockTicketStore } from './mockTicketStore';

/**
 * A port row has two ways to open now — an editor tab and the operating
 * system's browser — so what a row and its menu are *called* is the feature,
 * not decoration: a name that does not say where the page lands leaves the
 * user to find out by clicking.
 */
suite('Environment port rows', () => {
	const settings: EnvironmentsSettings = { portVariables: ['WEB_PORT'] };
	const context: EnvironmentContext = {
		repositoryRoot: () => '/repo',
		worktreesRoot: () => '/worktrees',
		settings: () => settings
	};

	/** A port row renders from the node alone; neither dep is read for one. */
	const provider = new EnvironmentTreeProvider({
		environments: new EnvironmentStore({
			context,
			provider: new FakeEnvironmentProvider(),
			runner: new FakeProcessRunner().runner,
			portProbe: async () => true
		}),
		tickets: new MockTicketStore()
	});

	test('a click opens the port in VS Code, and the row says so', () => {
		const item = provider.getTreeItem({ kind: 'port', name: 'WEB_PORT', port: 5173, main: true });

		// The click is the route the user already had; it must not have moved
		// to the browser under them.
		assert.strictEqual(item.command?.command, 'bfast.openEnvironmentPort');
		assert.strictEqual(item.command?.title, 'Open Port in VS Code');

		const tooltip = String(item.tooltip);
		assert.ok(tooltip.includes('http://localhost:5173'), tooltip);
		assert.ok(tooltip.includes('VS Code'), tooltip);
		assert.ok(tooltip.includes('browser'), tooltip);
	});

	test('the right-click menu offers both ways, each named after where it opens', () => {
		const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith('.bfast'));
		assert.ok(extension);

		const { commands, menus } = extension.packageJSON.contributes as {
			commands: { command: string; title: string }[];
			menus: Record<string, { command: string; when?: string; group?: string }[]>;
		};
		const titleOf = (id: string) => commands.find((entry) => entry.command === id)?.title;

		assert.strictEqual(titleOf('bfast.openEnvironmentPort'), 'Open Port in VS Code');
		assert.strictEqual(titleOf('bfast.openEnvironmentPortInBrowser'), 'Open Port in Browser');

		// Both sit on the port row's context menu — the one surface the browser
		// route has, since the row keeps its single inline button.
		const onPortRow = menus['view/item/context']
			.filter((entry) => entry.when?.includes('viewItem == environmentPort'))
			.filter((entry) => entry.group !== 'inline@1')
			.map((entry) => entry.command);
		assert.ok(onPortRow.includes('bfast.openEnvironmentPort'), onPortRow.join(', '));
		assert.ok(onPortRow.includes('bfast.openEnvironmentPortInBrowser'), onPortRow.join(', '));
	});
});

/**
 * The container rows and the three ways there can be none.
 *
 * docs/environments/container-logs.md is the spec: an empty list is a fact
 * about the stack and a failed query is a fact about the machine, and the
 * second rendered as the first would tell someone whose Docker is not running
 * that their environment has nothing in it.
 */
suite('Environment container rows', () => {
	const settings: EnvironmentsSettings = { portVariables: ['WEB_PORT'] };
	const context: EnvironmentContext = {
		repositoryRoot: () => '/repo',
		worktreesRoot: () => '/worktrees',
		settings: () => settings
	};

	const handle: EnvironmentHandle = {
		id: 'ST-1.2',
		scope: 'ticket',
		ticketId: 'ST-1.2',
		kind: 'docker-compose',
		branch: 'story/ST-1.2',
		worktreePath: '/worktrees/ST-1.2',
		projectName: 'bfast-st-1-2',
		ports: { WEB_PORT: 20000 },
		mainPort: 'WEB_PORT',
		createdAt: '2026-09-20T00:00:00.000Z',
		status: 'error'
	};

	const container = (patch: Partial<EnvironmentContainer>): EnvironmentContainer => ({
		id: 'aaa',
		name: 'bfast-st-1-2-web-1',
		service: 'web',
		state: 'running',
		status: 'Up 3 minutes (healthy)',
		...patch
	});

	const treeFor = (provider: EnvironmentProvider) =>
		new EnvironmentTreeProvider({
			environments: new EnvironmentStore({
				context,
				provider,
				runner: new FakeProcessRunner().runner,
				portProbe: async () => true
			}),
			tickets: new MockTicketStore()
		});

	test('the ports come first, then a row per container that answers the click', async () => {
		const provider = treeFor(
			new FakeEnvironmentProvider({
				containers: {
					'ST-1.2': [
						container({}),
						container({
							id: 'bbb',
							name: 'bfast-st-1-2-api-1',
							service: 'api',
							state: 'exited',
							status: 'Exited (1) 12 seconds ago',
							exitCode: 1
						})
					]
				}
			})
		);

		const children = await provider.getChildren({ kind: 'environment', environment: handle });
		assert.deepStrictEqual(
			children.map((node) => node.kind),
			['port', 'container', 'container']
		);

		const web = provider.getTreeItem(children[1]);
		assert.strictEqual(web.label, 'web');
		// The backend's own sentence, not a BFAST paraphrase of it.
		assert.strictEqual(web.description, 'Up 3 minutes (healthy)');
		assert.strictEqual(web.contextValue, 'environmentContainer');
		// A log tab is cheap and closable, so the row answers the click — unlike
		// the environment row, where a click spawning a window was an accident
		// waiting to happen.
		assert.strictEqual(web.command?.command, 'bfast.openContainerLog');
		assert.strictEqual((web.iconPath as vscode.ThemeIcon).id, 'circle-filled');
	});

	test('a container that died wears the error icon — that is the culprit, at a glance', async () => {
		const provider = treeFor(
			new FakeEnvironmentProvider({
				containers: {
					'ST-1.2': [
						container({ service: 'api', state: 'exited', status: 'Exited (1)', exitCode: 1 }),
						container({
							id: 'ccc',
							name: 'bfast-st-1-2-seed-1',
							service: 'seed',
							state: 'exited',
							status: 'Exited (0)',
							exitCode: 0
						})
					]
				}
			})
		);

		const children = await provider.getChildren({ kind: 'environment', environment: handle });
		const [failed, cleanly] = children
			.filter((node) => node.kind === 'container')
			.map((node) => provider.getTreeItem(node));

		assert.strictEqual((failed.iconPath as vscode.ThemeIcon).id, 'error');
		// A job that ran and exited 0 did its job; only a non-zero exit is red.
		assert.strictEqual((cleanly.iconPath as vscode.ThemeIcon).id, 'circle-outline');
	});

	test('an empty listing says the environment is not running, and is not a warning', async () => {
		const provider = treeFor(new FakeEnvironmentProvider());

		const children = await provider.getChildren({ kind: 'environment', environment: handle });
		const note = children.find((node) => node.kind === 'note');
		assert.ok(note && note.kind === 'note');
		assert.strictEqual(note.warning, false);
		assert.match(note.text, /not running/);

		const item = provider.getTreeItem(note);
		assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'info');
		// Its own context value, so no container or port menu entry lands on it.
		assert.strictEqual(item.contextValue, 'environmentNote');
	});

	test('a backend that could not be asked says so, rather than showing nothing', async () => {
		const provider = treeFor(
			new FakeEnvironmentProvider({
				containersFail: { 'ST-1.2': 'Cannot connect to the Docker daemon.' }
			})
		);

		const children = await provider.getChildren({ kind: 'environment', environment: handle });
		const note = children.find((node) => node.kind === 'note');
		assert.ok(note && note.kind === 'note');
		assert.strictEqual(note.warning, true);
		assert.match(note.text, /^Could not list containers: Cannot connect to the Docker daemon\.$/);
		assert.strictEqual(
			(provider.getTreeItem(note).iconPath as vscode.ThemeIcon).id,
			'warning'
		);
	});

	test('a provider that does not implement this says exactly that, unprefixed', async () => {
		// The k8s stub's answer is already a whole sentence; wrapping it in
		// "Could not list containers:" would read as a failure rather than as a
		// feature that has not shipped.
		const provider = treeFor(new K8sProvider());

		const children = await provider.getChildren({ kind: 'environment', environment: handle });
		const note = children.find((node) => node.kind === 'note');
		assert.ok(note && note.kind === 'note');
		assert.strictEqual(note.text, 'Kubernetes environments are not implemented yet.');
		assert.strictEqual(note.warning, true);
	});

	test('an environment with no ports is still expandable — its containers are under it too', () => {
		const provider = treeFor(new FakeEnvironmentProvider());
		const item = provider.getTreeItem({
			kind: 'environment',
			environment: { ...handle, ports: {}, mainPort: undefined }
		});

		assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
	});
});
