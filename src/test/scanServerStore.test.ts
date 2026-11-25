// The scan server's lifecycle — see docs/scan/README.md for the contract.
//
// Drives `ScanServerStore` against a `FakeScanProvider` and a scratch folder
// under the OS temp dir, the `environmentStore.test.ts` shape: never the fixture
// workspace, so nothing here can flip `bfast.configured` or dirty the tree, and
// never a real docker or a real network.

import * as assert from 'assert';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ScanContext } from '../scan/scanContext';
import { ScanError, type ScanCredentials } from '../scan/scanProvider';
import { SCAN_STATE_FILE } from '../scan/scanServerState';
import { ScanServerStore } from '../scan/scanServerStore';
import type { ScanSettings } from '../settings/scanSettings';
import { FakeScanProvider, type FakeScanOptions } from './fakeScanProvider';

const SCRATCH = path.join(os.tmpdir(), `bfast-test-scan-${process.pid}`);
const HOME = path.join(SCRATCH, 'scan-home');
const REPO = path.join(SCRATCH, 'repo');

const settled = (ticks = 200): Promise<void> =>
	new Promise((resolve) => {
		let attempt = 0;
		const tick = (): void => {
			attempt += 1;
			if (attempt >= ticks) {
				resolve();
			} else {
				setTimeout(tick, 1);
			}
		};
		setTimeout(tick, 1);
	});

/** Waits for a condition the flow reaches on its own microtasks. */
async function until(condition: () => boolean, ticks = 200): Promise<void> {
	for (let attempt = 0; attempt < ticks && !condition(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeStore(options: FakeScanOptions = {}, settings: ScanSettings = {}) {
	const provider = new FakeScanProvider(options);
	const stored: ScanCredentials[] = [];
	let credentials: ScanCredentials = {};
	let cleared = 0;

	const context: ScanContext = {
		workspaceRoot: () => REPO,
		workspaceName: () => 'my-app',
		workspaceSlug: () => 'my-app',
		scanHome: () => HOME,
		settings: () => settings,
		credentials: async () => credentials,
		storeCredentials: async (patch) => {
			stored.push(patch);
			credentials = { ...credentials, ...patch };
		},
		clearCredentials: async () => {
			cleared += 1;
			credentials = {};
		}
	};

	const store = new ScanServerStore({
		context,
		provider,
		// No real socket binds in a test.
		portProbe: async () => true,
		now: () => new Date('2026-09-05T00:00:00.000Z')
	});

	return { store, provider, stored, cleared: () => cleared, credentials: () => credentials };
}

async function reset(): Promise<void> {
	await rm(SCRATCH, { recursive: true, force: true });
	await mkdir(REPO, { recursive: true });
}

suite('BFAST scan server store', () => {
	setup(reset);
	suiteTeardown(() => rm(SCRATCH, { recursive: true, force: true }));

	test('nothing deployed reads as absent, not as an error', async () => {
		const { store } = makeStore();
		const handle = await store.get();
		assert.strictEqual(handle.status, 'absent');
		assert.strictEqual(handle.credentialed, false);
		assert.strictEqual(handle.projectName, 'bfast-sonar-my-app');
	});

	test('deploy allocates a port and writes the state file — and starts nothing', async () => {
		const { store, provider } = makeStore();
		await store.deploy();

		const handle = await store.get();
		assert.strictEqual(handle.port, 9000);
		// Deployed but not started: create and start are separate gestures.
		assert.strictEqual(handle.status, 'stopped');
		// Create is not Start: the only lifecycle call a deploy makes is `create`.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create']
		);

		const raw = JSON.parse(await readFile(path.join(HOME, SCAN_STATE_FILE), 'utf8'));
		assert.deepStrictEqual(raw, {
			version: 1,
			tool: 'sonarqube',
			mode: 'auto',
			projectName: 'bfast-sonar-my-app',
			port: 9000,
			createdAt: '2026-09-05T00:00:00.000Z',
			sourceRoot: REPO
		});
	});

	test('deploying twice is refused rather than allocating a second port', async () => {
		const { store } = makeStore();
		await store.deploy();
		await assert.rejects(
			() => store.deploy(),
			(error: unknown) => error instanceof ScanError && error.code === 'exists'
		);
	});

	test('a failed create leaves no state file behind', async () => {
		// The state file lands after create succeeds, so a half-made server reads
		// as absent — recoverable — rather than as one the sidebar shows and
		// cannot start.
		const { store } = makeStore({ failAt: [0] });
		await assert.rejects(() => store.deploy());
		await assert.rejects(() => readFile(path.join(HOME, SCAN_STATE_FILE), 'utf8'));
		assert.strictEqual((await store.get()).status, 'error');
	});

	test('another workspace state file is ignored, never adopted', async () => {
		await mkdir(HOME, { recursive: true });
		await writeFile(
			path.join(HOME, SCAN_STATE_FILE),
			JSON.stringify({
				version: 1,
				tool: 'sonarqube',
				mode: 'auto',
				projectName: 'bfast-sonar-someone-else',
				port: 9001,
				createdAt: '2020-01-01T00:00:00.000Z',
				sourceRoot: path.join(SCRATCH, 'other-repo')
			}),
			'utf8'
		);

		const { store } = makeStore();
		assert.strictEqual((await store.get()).status, 'absent');
	});

	test('junk in the state file reads as absent rather than throwing', async () => {
		await mkdir(HOME, { recursive: true });
		await writeFile(path.join(HOME, SCAN_STATE_FILE), '{ not json', 'utf8');
		const { store } = makeStore();
		assert.strictEqual((await store.get()).status, 'absent');
	});

	test('provision persists what the provider returns, and nothing else does', async () => {
		const { store, provider, stored, credentials } = makeStore({
			credentials: { analysisToken: 'sqa_x', resultsToken: 'squ_y', adminPassword: 'Pw' }
		});
		await store.deploy();
		assert.deepStrictEqual(stored, [], 'a deploy must not write a credential');

		await store.provision();
		assert.deepStrictEqual(stored, [
			{ analysisToken: 'sqa_x', resultsToken: 'squ_y', adminPassword: 'Pw' }
		]);
		assert.strictEqual(credentials().analysisToken, 'sqa_x');
		assert.ok(provider.operations.some((operation) => operation.kind === 'provision'));
		assert.strictEqual((await store.get()).credentialed, true);
	});

	test('the queue keeps start strictly after a hanging stop', async () => {
		const { store, provider } = makeStore({ hangFrom: 1 });
		await store.deploy();

		const stopping = store.stop();
		const starting = store.start();
		await settled(20);

		// Only the stop reached the provider; the start is queued behind it.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'stop']
		);
		assert.strictEqual((await store.get()).status, 'stopping');

		provider.hanging[0].resolveNow(undefined);
		await stopping;
		await until(() => provider.hanging.length > 1);
		provider.hanging[1].resolveNow(undefined);
		await starting;

		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'stop', 'start']
		);
	});

	test('a cancel reaches an operation still waiting its turn', async () => {
		const { store, provider } = makeStore({ hangFrom: 1 });
		await store.deploy();

		const stopping = store.stop();
		const starting = store.start();
		await settled(20);

		store.cancel();
		await assert.rejects(() => stopping);
		await assert.rejects(() => starting);

		// The queued start never reached the provider at all — the whole point of
		// creating the LiveOperation at enqueue time rather than at run time.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'stop']
		);
	});

	test('a failed operation leaves error with its reason until a later one succeeds', async () => {
		const { store } = makeStore({ failAt: [1] });
		await store.deploy();
		await assert.rejects(() => store.start());

		const failed = await store.get();
		assert.strictEqual(failed.status, 'error');
		assert.strictEqual(failed.statusDetail, 'start failed');

		await store.stop();
		assert.notStrictEqual((await store.get()).status, 'error');
	});

	test('one failure does not block every later operation', async () => {
		// The chain survives a rejection: `queue.set(run.catch(...))`.
		const { store, provider } = makeStore({ failAt: [1] });
		await store.deploy();
		await assert.rejects(() => store.start());
		await store.stop();
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'start', 'stop']
		);
	});

	test('remove destroys the stack, clears the folder and clears the credentials', async () => {
		const { store, provider, cleared } = makeStore();
		await store.deploy();
		await store.provision();

		await store.remove();

		assert.ok(provider.operations.some((operation) => operation.kind === 'destroy'));
		await assert.rejects(() => readFile(path.join(HOME, SCAN_STATE_FILE), 'utf8'));
		assert.strictEqual(cleared(), 1, 'a leftover token pointing at nothing is worse than none');
		assert.strictEqual((await store.get()).status, 'absent');
	});

	test('an external server offers no lifecycle and refuses a deploy', async () => {
		const { store, provider } = makeStore({}, { mode: 'external', hostUrl: 'https://x.com' });
		assert.strictEqual((await store.get()).status, 'external');
		await assert.rejects(
			() => store.deploy(),
			(error: unknown) => error instanceof ScanError && error.code === 'external'
		);
		assert.deepStrictEqual(provider.operations, []);
	});

	test('setup is the one gesture: deploy, start and provision, each skipped when done', async () => {
		const { store, provider } = makeStore({
			credentials: { analysisToken: 'sqa_x', resultsToken: 'squ_y' }
		});

		// From nothing: all three, in order — the Deploy button's whole job.
		await store.setup();
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'start', 'provision']
		);
		const running = await store.get();
		assert.strictEqual(running.status, 'running');
		assert.strictEqual(running.credentialed, true);

		// Stopped: start and provision only — the Start button's job.
		await store.stop();
		const before = provider.operations.length;
		await store.setup();
		assert.deepStrictEqual(
			provider.operations.slice(before).map((operation) => operation.kind),
			['start', 'provision']
		);

		// Healthy: the one idempotent call, and nothing else.
		const healthy = provider.operations.length;
		await store.setup();
		assert.deepStrictEqual(
			provider.operations.slice(healthy).map((operation) => operation.kind),
			['provision']
		);
	});

	test('setup against an external server only verifies the credentials', async () => {
		const { store, provider } = makeStore(
			{ credentials: {} },
			{ mode: 'external', hostUrl: 'https://x.com' }
		);
		await store.setup();
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['provision']
		);
	});

	test('ready deploys, starts and provisions in that order, then hands back the endpoint', async () => {
		const { store, provider } = makeStore({
			credentials: { analysisToken: 'sqa_x', resultsToken: 'squ_y' }
		});
		const ready = await store.ready();

		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'start', 'provision']
		);
		assert.strictEqual(ready.endpoint.url, 'http://localhost:9000');
		assert.strictEqual(ready.endpoint.containerUrl, 'http://sonarqube:9000');
		assert.strictEqual(ready.credentials.analysisToken, 'sqa_x');
	});

	test('ready on a running, credentialed server only re-checks the credentials', async () => {
		const { store, provider } = makeStore({
			credentials: { analysisToken: 'sqa_x', resultsToken: 'squ_y' }
		});
		await store.ready();
		const before = provider.operations.length;

		await store.ready();
		// Deploy and start are skipped; provision runs every time because it is
		// idempotent and cheapest-first, and it is what catches a revoked token.
		assert.deepStrictEqual(
			provider.operations.slice(before).map((operation) => operation.kind),
			['provision']
		);
	});

	test('ready refuses when provisioning produced no analysis token', async () => {
		const { store } = makeStore({ credentials: {} });
		await assert.rejects(
			() => store.ready(),
			(error: unknown) => error instanceof ScanError && error.code === 'unauthorized'
		);
	});

	test('recent runs are newest first and capped', async () => {
		const { store } = makeStore();
		for (let index = 0; index < 12; index += 1) {
			store.recordRun({
				target: { projectKey: 'my-app', directory: REPO },
				outcome: 'passed',
				summary: `run ${index}`,
				finishedAt: '2026-09-05T00:00:00.000Z'
			});
		}
		assert.strictEqual(store.runs.length, 10);
		assert.strictEqual(store.runs[0].summary, 'run 11');
	});

	test('changes fire for every repaint-worthy moment, and unsubscribe works', async () => {
		const { store } = makeStore();
		let fired = 0;
		const unsubscribe = store.onDidChange(() => {
			fired += 1;
		});

		await store.deploy();
		// At least the enter and the leave of the one operation.
		assert.ok(fired >= 2, `expected at least 2 changes, saw ${fired}`);

		unsubscribe();
		const after = fired;
		await store.stop();
		assert.strictEqual(fired, after);
	});

	test('dispose drains queued work without spawning any of it', async () => {
		const { store, provider } = makeStore({ hangFrom: 1 });
		await store.deploy();

		const stopping = store.stop();
		const starting = store.start();
		await settled(20);

		store.dispose();
		await assert.rejects(() => stopping);
		await assert.rejects(() => starting);
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['create', 'stop']
		);
	});
});
