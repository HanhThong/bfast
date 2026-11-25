// The "Run Scan" flow, end to end — see docs/scan/ for the contract.
//
// Drives `runScan` against a real `FileTicketStore` and a scripted
// `FakeScanProvider`, the `testRunner.test.ts` shape: the tracker is a scratch
// folder reached through a `TrackerContext` rather than through
// `SettingsService`, so nothing here can flip `bfast.configured` or make the
// other suites depend on run order. The `.gitignore` glob
// `src/test/fixtures/workspace/.tracker*/` covers the scratch on a crashed run.

import * as assert from 'assert';
import { mkdir, readFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import type { ScanContext } from '../scan/scanContext';
import { ScanError, type ScanCredentials } from '../scan/scanProvider';
import type { ScanReport } from '../scan/scanReport';
import {
	outcomeForError,
	runScan,
	SCAN_HISTORY_ACTION,
	type ScanRunDeps
} from '../scan/scanRunner';
import { ScanServerStore } from '../scan/scanServerStore';
import type { ScanSettings } from '../settings/scanSettings';
import { FakeScanProvider, type FakeScanOptions } from './fakeScanProvider';

const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-scan');
const WORKSPACE_ROOT = vscode.workspace.workspaceFolders![0].uri.fsPath;
const SCRATCH = path.join(os.tmpdir(), `bfast-test-scanrun-${process.pid}`);

const context: TrackerContext = {
	rootUri: () => ROOT,
	author: () => 'Scan Runner'
};

const PASSING: ScanReport = {
	gate: 'ok',
	conditions: [],
	measures: [
		{ metric: 'bugs', label: 'bugs', value: '0' },
		{ metric: 'coverage', label: 'coverage', value: '78.2', unit: '%' }
	],
	issues: [],
	truncated: false,
	dashboardUrl: 'http://localhost:9000/dashboard?id=my-app'
};

const FAILING: ScanReport = {
	gate: 'error',
	conditions: [
		{
			metric: 'new_coverage',
			label: 'new_coverage',
			actual: '82.5',
			threshold: '85',
			comparator: 'LT',
			ok: false
		}
	],
	measures: [],
	issues: [],
	truncated: false,
	dashboardUrl: 'http://localhost:9000/dashboard?id=my-app'
};

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Never existed.
	}
	await rm(SCRATCH, { recursive: true, force: true });
	await mkdir(SCRATCH, { recursive: true });
}

suite('BFAST scan runner', () => {
	let store: FileTicketStore;
	let storyId: string;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({
			parentId: epic.id,
			type: 'story',
			title: 'Sign in'
		});
		storyId = story.id;
	});

	suiteTeardown(async () => {
		try {
			await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
		} catch {
			// Never existed.
		}
		await rm(SCRATCH, { recursive: true, force: true });
	});

	function makeDeps(
		options: FakeScanOptions = {},
		settings: ScanSettings = {},
		extra: Partial<ScanRunDeps> = {}
	) {
		const provider = new FakeScanProvider(options);
		let credentials: ScanCredentials = {};
		const scanContext: ScanContext = {
			workspaceRoot: () => WORKSPACE_ROOT,
			workspaceName: () => 'my-app',
			workspaceSlug: () => 'my-app',
			scanHome: () => SCRATCH,
			settings: () => settings,
			credentials: async () => credentials,
			storeCredentials: async (patch) => {
				credentials = { ...credentials, ...patch };
			},
			clearCredentials: async () => {
				credentials = {};
			}
		};
		const server = new ScanServerStore({
			context: scanContext,
			provider,
			portProbe: async () => true,
			now: () => new Date('2026-09-05T00:00:00.000Z')
		});

		const deps: ScanRunDeps = {
			provider,
			server,
			store,
			settings: () => settings,
			workspaceRoot: () => WORKSPACE_ROOT,
			workspaceName: () => 'my-app',
			// Every ticket has an environment at the workspace root unless a test
			// says otherwise: a ticket scan is its environment, and nothing else.
			resolveDirectory: async () => WORKSPACE_ROOT,
			now: () => new Date('2026-09-05T01:00:00.000Z'),
			...extra
		};
		return { deps, provider, server };
	}

	async function historyOf(id: string): Promise<string> {
		const folder = await store.folderUri(id);
		assert.ok(folder);
		return readFile(path.join(folder.fsPath, 'history.md'), 'utf8');
	}

	async function updatedAtOf(id: string): Promise<string | undefined> {
		return (await store.getDetail(id))?.updatedAt;
	}

	test('a passing gate is recorded on the ticket and never changes its status', async () => {
		const { deps } = makeDeps({
			reports: [PASSING],
			credentials: { analysisToken: 'sqa_x', resultsToken: 'squ_y' }
		});
		const before = await store.getDetail(storyId);

		const result = await runScan(deps, storyId);

		assert.strictEqual(result.outcome, 'passed');
		assert.strictEqual(result.summary, 'quality gate **OK** — 0 bugs, 78.2% coverage.');
		assert.strictEqual(result.recordError, undefined);

		const after = await store.getDetail(storyId);
		// Run Tests owns `done` and `blocked`; a scan writes evidence, not a verdict
		// on the ticket.
		assert.strictEqual(after?.status, before?.status);

		const history = await historyOf(storyId);
		assert.ok(history.includes(SCAN_HISTORY_ACTION), history);
		assert.ok(history.includes('quality gate **OK**'), history);
		assert.ok(history.includes('http://localhost:9000/dashboard?id=my-app'), history);
	});

	test('recordNote leaves updatedAt untouched', async () => {
		// The trap this keeps closed: a board sitting open mid-edit is holding the
		// `updatedAt` it read when Edit was pressed. Bumping it here would fail the
		// user's own next save over a scan they never asked to be an edit.
		const { deps } = makeDeps({ reports: [PASSING] });
		const before = await updatedAtOf(storyId);

		await runScan(deps, storyId);

		assert.strictEqual(await updatedAtOf(storyId), before);
	});

	test('a failing gate still records, and still does not change the status', async () => {
		const { deps } = makeDeps({ reports: [FAILING] });
		const before = await store.getDetail(storyId);

		const result = await runScan(deps, storyId);

		assert.strictEqual(result.outcome, 'failed');
		assert.strictEqual(
			result.summary,
			'quality gate **ERROR** — new_coverage 82.5 LT 85.'
		);
		assert.strictEqual((await store.getDetail(storyId))?.status, before?.status);
		assert.ok((await historyOf(storyId)).includes('quality gate **ERROR**'));
	});

	test('a scanner failure writes nothing on the ticket', async () => {
		// The analysis produced no verdict, so there is nothing true to record.
		const { deps } = makeDeps({ failAt: [3] }); // create, start, provision, then scan
		const result = await runScan(deps, storyId);

		assert.strictEqual(result.outcome, 'ce-failed');
		assert.ok(result.message);
		assert.strictEqual(result.report, undefined);
		assert.ok(!(await historyOf(storyId)).includes(SCAN_HISTORY_ACTION));
	});

	test('a run never rejects, whatever went wrong', async () => {
		// The `runTests` contract: every failure is a tagged outcome, so the caller
		// renders one thing rather than branching between a result and a throw.
		for (const options of [{ failAt: [0] }, { failAt: [1] }, { failAt: [3] }]) {
			const { deps } = makeDeps(options);
			await assert.doesNotReject(() => runScan(deps, storyId));
		}
	});

	test('the phases arrive in order', async () => {
		const phases: string[] = [];
		const { deps } = makeDeps({ reports: [PASSING] }, {}, {
			onProgress: (event) => {
				if (event.kind === 'phase') {
					phases.push(event.phase);
				}
			}
		});

		await runScan(deps, storyId);

		assert.deepStrictEqual(phases, ['preparing', 'scanning', 'report']);
	});

	test('cancelling before anything starts stops the run and writes nothing', async () => {
		const { deps } = makeDeps({ reports: [PASSING] });
		const result = await runScan(deps, storyId, {
			// The Stop button can be pressed before the first spawn, so the hook is
			// handed out before anything starts.
			onCancel: (cancel) => cancel()
		});

		assert.strictEqual(result.outcome, 'cancelled');
		assert.ok(!(await historyOf(storyId)).includes(SCAN_HISTORY_ACTION));
	});

	test('a workspace scan produces a result with no ticket to record on', async () => {
		const { deps } = makeDeps({ reports: [PASSING] });
		const result = await runScan(deps);

		assert.strictEqual(result.outcome, 'passed');
		assert.strictEqual(result.target.ticketId, undefined);
		assert.strictEqual(result.target.directory, WORKSPACE_ROOT);
		assert.strictEqual(result.recordError, undefined);
	});

	test('the project key is one per workspace, defaulted from its name', async () => {
		const { deps, provider } = makeDeps({ reports: [PASSING] });
		const folder = (await runScan(deps, storyId)).target;
		assert.strictEqual(folder.projectKey, 'my-app');
		assert.strictEqual(folder.projectKeySource, 'folder');
		// The folder name is the display name too, so the dashboard is not
		// titled after a slug.
		assert.strictEqual(provider.operations.at(-1)?.request?.projectName, 'my-app');

		const configured = makeDeps({ reports: [PASSING] }, { projectKey: 'acme_my-app' });
		const fromSettings = (await runScan(configured.deps, storyId)).target;
		assert.strictEqual(fromSettings.projectKey, 'acme_my-app');
		assert.strictEqual(fromSettings.projectKeySource, 'settings');
	});

	test('a checkout with its own sonar-project.properties names the project', async () => {
		// The file wins over settings: `-D` beats it inside the scanner, so a key
		// BFAST chose would silently rename the project a team set up in CI.
		const { deps, provider } = makeDeps(
			{
				reports: [PASSING],
				identity: (directory) =>
					directory === WORKSPACE_ROOT ? { projectKey: 'ice-hrm', projectName: 'ICE HRM' } : undefined
			},
			{ projectKey: 'acme_my-app' }
		);
		const target = (await runScan(deps, storyId)).target;
		assert.strictEqual(target.projectKey, 'ice-hrm');
		assert.strictEqual(target.projectName, 'ICE HRM');
		assert.strictEqual(target.projectKeySource, 'properties');

		const request = provider.operations.at(-1)?.request;
		assert.strictEqual(request?.projectKey, 'ice-hrm');
		assert.strictEqual(request?.projectName, 'ICE HRM');
	});

	test('a file that names only the display name still falls through for the key', async () => {
		const { deps } = makeDeps({
			reports: [PASSING],
			identity: () => ({ projectName: 'ICE HRM' })
		});
		const target = (await runScan(deps, storyId)).target;
		assert.strictEqual(target.projectKey, 'my-app');
		assert.strictEqual(target.projectName, 'ICE HRM');
		assert.strictEqual(target.projectKeySource, 'folder');
	});

	test('a key the file names but SonarQube would refuse is ignored, not sent', async () => {
		// All digits is refused by the server; the fallbacks give one that works
		// rather than a 400 four minutes in.
		const { deps } = makeDeps({ reports: [PASSING], identity: () => ({ projectKey: '12345' }) });
		const target = (await runScan(deps, storyId)).target;
		assert.strictEqual(target.projectKey, 'my-app');
		assert.strictEqual(target.projectKeySource, 'folder');
	});

	test('the properties file is read from the directory actually scanned', async () => {
		// A worktree carries its own copy of the file, and that is the one that
		// describes what is analysed.
		const worktree = path.join(SCRATCH, 'worktree-props');
		await mkdir(worktree, { recursive: true });
		const seen: string[] = [];
		const { deps } = makeDeps(
			{
				reports: [PASSING],
				identity: (directory) => {
					seen.push(directory);
					return undefined;
				}
			},
			{},
			{ resolveDirectory: async () => worktree }
		);
		await runScan(deps, storyId);
		assert.deepStrictEqual(seen, [worktree]);
	});

	test('scan.cwd narrows a workspace scan; a ticket scan is its environment worktree', async () => {
		const withCwd = makeDeps({ reports: [PASSING] }, { cwd: 'src' });
		const plain = await runScan(withCwd.deps);
		assert.strictEqual(plain.target.directory, path.join(WORKSPACE_ROOT, 'src'));
		assert.strictEqual(plain.target.worktree, undefined);

		// `cwd` is about the workspace; an environment is a whole checkout of its own.
		const worktree = path.join(SCRATCH, 'worktree');
		await mkdir(worktree, { recursive: true });
		const withEnvironment = makeDeps({ reports: [PASSING] }, { cwd: 'src' }, {
			resolveDirectory: async () => worktree
		});
		const scanned = await runScan(withEnvironment.deps, storyId);
		assert.strictEqual(scanned.target.directory, worktree);
		assert.strictEqual(scanned.target.worktree, true);
	});

	test('a ticket with no environment is refused, never scanned at the workspace', async () => {
		// Analysing the repo's main checkout under the ticket's name would file a
		// verdict about code the ticket never touched.
		const { deps, provider } = makeDeps({ reports: [PASSING] }, {}, {
			resolveDirectory: async () => undefined
		});
		const result = await runScan(deps, storyId);
		assert.strictEqual(result.outcome, 'unreachable');
		assert.ok(/no environment/.test(result.message ?? ''), result.message);
		assert.strictEqual(result.target.directory, '');
		assert.ok(!provider.operations.some((operation) => operation.kind === 'scan'));
		assert.ok(!/scanned/.test(await historyOf(storyId)), 'nothing was recorded');

		// The same when the runner is handed no lookup at all.
		const bare = makeDeps({ reports: [PASSING] }, {}, { resolveDirectory: undefined });
		assert.strictEqual((await runScan(bare.deps, storyId)).outcome, 'unreachable');
	});

	test('a broken environments lookup fails the scan rather than scanning the wrong tree', async () => {
		const { deps } = makeDeps({ reports: [PASSING] }, {}, {
			resolveDirectory: async () => {
				throw new Error('environments are broken');
			}
		});
		const result = await runScan(deps, storyId);
		assert.strictEqual(result.outcome, 'unreachable');
		assert.ok(/environments are broken/.test(result.message ?? ''), result.message);
	});

	test('a run without SCM data says so in the history entry', async () => {
		const { deps } = makeDeps({ reports: [{ ...PASSING, scmDisabled: true }] });
		await runScan(deps, storyId);
		const history = await historyOf(storyId);
		assert.ok(/without SCM data/.test(history), history);
	});

	test('the run lands in the sidebar list, newest first', async () => {
		const { deps, server } = makeDeps({ reports: [PASSING] });
		await runScan(deps, storyId);

		assert.strictEqual(server.runs.length, 1);
		assert.strictEqual(server.runs[0].outcome, 'passed');
		assert.strictEqual(server.runs[0].target.ticketId, storyId);
		assert.strictEqual(server.runs[0].dashboardUrl, 'http://localhost:9000/dashboard?id=my-app');
	});

	test('a ticket deleted mid-run is reported, not thrown', async () => {
		// The analysis really happened and its result is on screen; losing the run
		// over a tracker that moved underneath it would be the wrong trade.
		const { deps } = makeDeps({ reports: [PASSING] });
		const result = await runScan(deps, 'ST-9.9');

		assert.strictEqual(result.outcome, 'passed');
		assert.ok(result.recordError, 'the failed write is reported');
	});

	test('unauthorized maps to its own outcome, not to a generic failure', async () => {
		const provider = new FakeScanProvider();
		const scanContext: ScanContext = {
			workspaceRoot: () => WORKSPACE_ROOT,
			workspaceName: () => 'my-app',
			workspaceSlug: () => 'my-app',
			scanHome: () => SCRATCH,
			settings: () => ({}),
			// Provisioning yields nothing, so `ready` refuses with `unauthorized`.
			credentials: async () => ({}),
			storeCredentials: async () => undefined,
			clearCredentials: async () => undefined
		};
		const server = new ScanServerStore({
			context: scanContext,
			provider: new FakeScanProvider({ credentials: {} }),
			portProbe: async () => true
		});
		const result = await runScan({
			provider,
			server,
			store,
			settings: () => ({}),
			workspaceRoot: () => WORKSPACE_ROOT,
			workspaceName: () => 'my-app'
		});

		assert.strictEqual(result.outcome, 'unauthorized');
		assert.ok(result.message);
	});

	test('an error carrying no ScanError code is still a tagged outcome', () => {
		// Defensive: a provider that throws something unexpected must not escape
		// the runner's contract.
		const codes: [ScanError, string][] = [
			[new ScanError('timeout', 'x'), 'timeout'],
			[new ScanError('not-installed', 'x'), 'unreachable'],
			[new ScanError('scanner-error', 'x'), 'scanner-failed']
		];
		for (const [error, expected] of codes) {
			assert.strictEqual(outcomeForError(error, false), expected, error.code);
		}
		// And a cancel wins over whatever the error says.
		assert.strictEqual(outcomeForError(new ScanError('timeout', 'x'), true), 'cancelled');
		assert.strictEqual(outcomeForError(new Error('surprise'), false), 'scanner-failed');
	});
});
