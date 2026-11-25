import * as assert from 'assert';
import * as vscode from 'vscode';
import type { EnvironmentContext } from '../environments/environmentContext';
import type { EnvironmentContainer, EnvironmentHandle } from '../environments/environmentProvider';
import { EnvironmentStore } from '../environments/environmentStore';
import { ContainerLogPanel } from '../environments/containerLogPanel';
import type { EnvironmentsSettings } from '../settings/environmentSettings';
import { FakeEnvironmentProvider } from './fakeEnvironmentProvider';
import { FakeProcessRunner } from './fakeProcessRunner';

/**
 * A log tab is a live stream, so opening a second container's log must not take
 * the first one's tab away — watching the gateway while the worker crashes is
 * the whole point of the list, and it needs two tabs.
 *
 * Note what this host can and cannot show: `createWebviewPanel` opens a
 * non-preview tab here, so the `isPreview` assertion cannot fail in this suite
 * today. It stays because it is the guarantee the feature owes — a workbench
 * that opens the panel as a preview tab (as a real window was observed to do)
 * must find it pinned by the time the stream starts.
 */
suite('Container log tabs', () => {
	const settings: EnvironmentsSettings = {};
	const context: EnvironmentContext = {
		repositoryRoot: () => '/repo',
		worktreesRoot: () => '/worktrees',
		settings: () => settings
	};

	const environments = new EnvironmentStore({
		context,
		provider: new FakeEnvironmentProvider(),
		runner: new FakeProcessRunner().runner,
		portProbe: async () => true
	});

	const env: EnvironmentHandle = {
		id: 'master',
		scope: 'master',
		kind: 'docker-compose',
		branch: 'master',
		worktreePath: '/repo',
		projectName: 'bfast-master-x',
		ports: {},
		createdAt: '',
		status: 'running'
	};

	const container = (service: string): EnvironmentContainer => ({
		id: service,
		name: `bfast-master-x-${service}-1`,
		service,
		state: 'running',
		status: 'Up 1 minute'
	});

	const opened: ContainerLogPanel[] = [];

	suiteTeardown(() => {
		// Tabs left behind would follow the other suites around.
		for (const panel of opened) {
			panel.dispose();
		}
	});

	const logTabs = () =>
		vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.filter((tab) => tab.label.startsWith('Log — '));

	test('a second container opens its own tab, and neither is left as a preview', async () => {
		const extensionUri = vscode.extensions.all.find((entry) =>
			entry.id.endsWith('.bfast')
		)?.extensionUri;
		assert.ok(extensionUri);

		opened.push(ContainerLogPanel.show(extensionUri, environments, env, container('map-api')));
		await settle();
		opened.push(ContainerLogPanel.show(extensionUri, environments, env, container('redis')));
		await settle();

		const tabs = logTabs();
		assert.deepStrictEqual(
			tabs.map((tab) => tab.label).sort(),
			['Log — Master map-api-1', 'Log — Master redis-1']
		);
		for (const tab of tabs) {
			assert.strictEqual(tab.isPreview, false, `${tab.label} must not be a preview tab`);
		}
	});

	test('the same container reuses its tab rather than doubling it', async () => {
		const extensionUri = vscode.extensions.all.find((entry) =>
			entry.id.endsWith('.bfast')
		)?.extensionUri;
		assert.ok(extensionUri);

		const before = logTabs().length;
		opened.push(ContainerLogPanel.show(extensionUri, environments, env, container('map-api')));
		await settle();

		assert.strictEqual(logTabs().length, before);
	});
});

/** The tab list is updated over an event, so it lags the call that caused it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
