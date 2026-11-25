import * as assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { EnvironmentContext } from '../environments/environmentContext';
import {
	MARKER_FILE,
	MASTER_MARKER_FILE,
	serializeEnvironmentMarker
} from '../environments/environmentMarker';
import {
	EnvironmentCancelledError,
	EnvironmentError
} from '../environments/environmentProvider';
import { EnvironmentStore } from '../environments/environmentStore';
import {
	gitArgs,
	worktreeAddArgs,
	worktreePruneArgs,
	worktreeRemoveArgs
} from '../environments/gitWorktree';
import type { PortProbe } from '../environments/portAllocator';
import {
	DEFAULT_LOG_TAIL,
	type EnvironmentsSettings
} from '../settings/environmentSettings';
import { FakeEnvironmentProvider, type FakeEnvironmentOptions } from './fakeEnvironmentProvider';
import { FakeProcessRunner, type FakeProcessOptions } from './fakeProcessRunner';

/**
 * A scratch worktrees root under the OS temp folder — never the fixture
 * workspace, so nothing here can flip `bfast.configured` or dirty the tree.
 */
const SCRATCH = path.join(os.tmpdir(), `bfast-test-envstore-${process.pid}`);
const ROOT = path.join(SCRATCH, 'worktrees');
const REPO = path.join(SCRATCH, 'repo');

const SETTINGS: EnvironmentsSettings = {
	portVariables: ['WEB_PORT', 'DB_PORT'],
	portRangeStart: 21000,
	portRangeEnd: 21010
};

const context: EnvironmentContext = {
	repositoryRoot: () => REPO,
	worktreesRoot: () => ROOT,
	settings: () => SETTINGS
};

function makeStore(
	providerOptions?: FakeEnvironmentOptions,
	gitOptions?: FakeProcessOptions,
	portProbe?: PortProbe
): { store: EnvironmentStore; provider: FakeEnvironmentProvider; git: FakeProcessRunner } {
	const provider = new FakeEnvironmentProvider(providerOptions);
	const git = new FakeProcessRunner(gitOptions);
	const store = new EnvironmentStore({
		context,
		provider,
		runner: git.runner,
		// No real socket binds in a test.
		portProbe: portProbe ?? (async () => true),
		// The same git sequence on every machine; Windows' extra step has its own tests.
		platform: 'linux'
	});
	return { store, provider, git };
}

/**
 * A probe held until released — the one await a master create has that a
 * test can park it on, since it spawns no git. It is asked once per port, so
 * releasing answers every call held so far *and* every later one.
 */
function heldProbe(): { probe: PortProbe; release: () => void } {
	let released = false;
	const waiting: (() => void)[] = [];
	const probe: PortProbe = () =>
		released
			? Promise.resolve(true)
			: new Promise((resolve) => {
					waiting.push(() => resolve(true));
				});
	return {
		probe,
		release: () => {
			released = true;
			for (const answer of waiting.splice(0)) {
				answer();
			}
		}
	};
}

const MASTER_PROJECT = 'bfast-master-worktrees';

const settleTick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function reset(): Promise<void> {
	await rm(SCRATCH, { recursive: true, force: true });
	await mkdir(REPO, { recursive: true });
}

suite('BFAST environment store', () => {
	setup(reset);
	suiteTeardown(() => rm(SCRATCH, { recursive: true, force: true }));

	test('create allocates ports, adds the worktree and writes the marker — nothing starts', async () => {
		const { store, provider, git } = makeStore();

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		assert.strictEqual(handle.branch, 'story/ST-1');
		assert.deepStrictEqual(handle.ports, { WEB_PORT: 21000, DB_PORT: 21001 });
		// The first variable is the main port unless settings name another.
		assert.strictEqual(handle.mainPort, 'WEB_PORT');

		// prune heals leftovers first, then the add mints the branch from HEAD —
		// and nothing else: the long-path check is Windows' alone.
		assert.deepStrictEqual(git.requests[0].args, gitArgs(worktreePruneArgs()));
		assert.deepStrictEqual(
			git.requests[1].args,
			gitArgs(worktreeAddArgs(path.join(ROOT, 'ST-1'), 'story/ST-1', true))
		);
		assert.strictEqual(git.requests[1].cwd, REPO);
		assert.strictEqual(git.requests.length, 2);

		const marker = JSON.parse(
			await readFile(path.join(ROOT, 'ST-1', ...MARKER_FILE.split('/')), 'utf8')
		);
		assert.strictEqual(marker.ticketId, 'ST-1');
		assert.strictEqual(marker.sourceRoot, REPO);

		// Create is not start.
		assert.deepStrictEqual(provider.operations, []);
		assert.strictEqual((await store.list())[0]?.status, 'stopped');
	});

	/** A Windows store whose phase lines are kept, for the long-path check. */
	function windowsStore(gitOptions: FakeProcessOptions): {
		store: EnvironmentStore;
		git: FakeProcessRunner;
		phases: string[];
	} {
		const git = new FakeProcessRunner(gitOptions);
		const phases: string[] = [];
		const store = new EnvironmentStore({
			context,
			provider: new FakeEnvironmentProvider(),
			runner: git.runner,
			portProbe: async () => true,
			platform: 'win32',
			onProgress: (progress) => {
				if (progress.kind === 'phase') {
					phases.push(progress.label);
				}
			}
		});
		return { store, git, phases };
	}

	test('on Windows, a worktree with paths too long for git turns core.longpaths on', async () => {
		// prune, add, then the listing (one path far past 260), the read (unset:
		// exit 1) and the write.
		const { store, git, phases } = windowsStore({
			results: [{}, {}, { stdout: `README.md\0deep/${'x'.repeat(300)}\0` }, {}],
			failAt: [3],
			stderr: ''
		});

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		assert.deepStrictEqual(git.requests[2].args, gitArgs(['ls-files', '-z']));
		assert.strictEqual(git.requests[2].cwd, path.join(ROOT, 'ST-1'));
		assert.deepStrictEqual(git.requests[4].args, gitArgs(['config', 'core.longpaths', 'true']));
		assert.strictEqual(git.requests[4].cwd, REPO);
		assert.strictEqual(git.requests.length, 5);
		assert.ok(
			phases.some((label) =>
				label.startsWith('Enabled core.longpaths for this repository: 1 path in the new worktree is')
			),
			phases.join('\n')
		);
	});

	test('on Windows, a failed long-path check is said, and the create still succeeds', async () => {
		const { store, git, phases } = windowsStore({ failAt: [2], stderr: 'fatal: boom' });

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		// Nothing was written into the repository's config.
		assert.strictEqual(git.requests.length, 3);
		await stat(path.join(ROOT, 'ST-1', ...MARKER_FILE.split('/')));
		assert.ok(
			phases.some((label) => label.startsWith("Could not check the new worktree's path lengths")),
			phases.join('\n')
		);
	});

	/** What a checkout of a repository whose settings switch the MCP server on carries. */
	const CHECKOUT_SETTINGS = {
		trackerFolder: '.tracker',
		userName: 'Someone',
		mcp: { enabled: true, port: 17711, functions: ['read', 'write'] },
		// A key this version does not know survives the rewrite.
		later: { kept: true }
	};
	const CHECKOUT_CLAUDE = {
		mcpServers: { bfast: { type: 'http', url: 'http://127.0.0.1:17711/mcp' } }
	};
	const json = (value: unknown) => `${JSON.stringify(value, undefined, 2)}\n`;

	/**
	 * A store whose fake `git worktree add` fills the folder the way a real
	 * checkout would — the settings and Claude Code's connection file — and
	 * whose `ls-files` reports every path it was asked about as tracked.
	 */
	function mcpStore(options: {
		settingsText?: string;
		probe?: PortProbe;
		failAt?: number[];
	} = {}): { store: EnvironmentStore; git: FakeProcessRunner; phases: string[] } {
		const git = new FakeProcessRunner({
			failAt: options.failAt,
			respond: (request) => {
				const args = request.args;
				if (args.includes('worktree') && args.includes('add')) {
					const folder = args.find((arg) => arg.startsWith(ROOT))!;
					mkdirSync(path.join(folder, '.vscode'), { recursive: true });
					writeFileSync(
						path.join(folder, '.vscode', 'bfast.json'),
						options.settingsText ?? json(CHECKOUT_SETTINGS)
					);
					writeFileSync(path.join(folder, '.mcp.json'), json(CHECKOUT_CLAUDE));
				}
				if (args.includes('ls-files')) {
					return { stdout: `${args.slice(args.indexOf('--') + 1).join('\0')}\0` };
				}
				return undefined;
			}
		});
		const phases: string[] = [];
		const store = new EnvironmentStore({
			context,
			provider: new FakeEnvironmentProvider(),
			runner: git.runner,
			portProbe: options.probe ?? (async () => true),
			platform: 'linux',
			onProgress: (progress) => {
				if (progress.kind === 'phase') {
					phases.push(progress.label);
				}
			}
		});
		return { store, git, phases };
	}

	const readJson = async (...segments: string[]) =>
		JSON.parse(await readFile(path.join(...segments), 'utf8'));
	const readMarkerOf = (ticketId: string) => readJson(ROOT, ticketId, ...MARKER_FILE.split('/'));

	test('create moves the worktree’s MCP server to a port of its own, hidden from git there', async () => {
		// The workspace's own files, which must come out byte-identical.
		await mkdir(path.join(REPO, '.vscode'), { recursive: true });
		await writeFile(path.join(REPO, '.vscode', 'bfast.json'), json(CHECKOUT_SETTINGS));
		await writeFile(path.join(REPO, '.mcp.json'), json(CHECKOUT_CLAUDE));
		const { store, git, phases } = mcpStore();

		await store.create('ST-1');

		const worktree = path.join(ROOT, 'ST-1');
		const settings = await readJson(worktree, '.vscode', 'bfast.json');
		assert.deepStrictEqual(settings, {
			...CHECKOUT_SETTINGS,
			mcp: { ...CHECKOUT_SETTINGS.mcp, port: 17712 }
		});
		// Every key where it was — a diff of the file shows the port and nothing else.
		assert.deepStrictEqual(Object.keys(settings), Object.keys(CHECKOUT_SETTINGS));
		assert.deepStrictEqual(Object.keys(settings.mcp), Object.keys(CHECKOUT_SETTINGS.mcp));
		assert.deepStrictEqual(await readJson(worktree, '.mcp.json'), {
			mcpServers: { bfast: { type: 'http', url: 'http://127.0.0.1:17712/mcp' } }
		});
		assert.strictEqual((await readMarkerOf('ST-1')).mcpPort, 17712);

		const rewritten = ['.vscode/bfast.json', '.mcp.json'];
		assert.deepStrictEqual(git.requests[2].args, gitArgs(['ls-files', '-z', '--', ...rewritten]));
		assert.deepStrictEqual(
			git.requests[3].args,
			gitArgs(['update-index', '--skip-worktree', '--', ...rewritten])
		);
		// The worktree's own index — never the workspace's.
		assert.strictEqual(git.requests[2].cwd, worktree);
		assert.strictEqual(git.requests[3].cwd, worktree);
		assert.strictEqual(git.requests.length, 4);
		assert.ok(
			phases.includes(
				'MCP server port for ST-1: 17711 → 17712 (.vscode/bfast.json, .mcp.json — hidden from git in the worktree)'
			),
			phases.join('\n')
		);

		assert.strictEqual(await readFile(path.join(REPO, '.vscode', 'bfast.json'), 'utf8'), json(CHECKOUT_SETTINGS));
		assert.strictEqual(await readFile(path.join(REPO, '.mcp.json'), 'utf8'), json(CHECKOUT_CLAUDE));
	});

	test('a second environment keeps clear of the first one’s MCP port, though nothing listens on it', async () => {
		const { store } = mcpStore();
		await store.create('ST-1');
		await store.create('ST-2');

		assert.strictEqual((await readJson(ROOT, 'ST-2', '.vscode', 'bfast.json')).mcp.port, 17713);
		assert.strictEqual((await readMarkerOf('ST-2')).mcpPort, 17713);
	});

	test('a port something else is listening on is skipped', async () => {
		const { store } = mcpStore({ probe: async (port) => port !== 17712 });
		await store.create('ST-1');
		assert.strictEqual((await readMarkerOf('ST-1')).mcpPort, 17713);
	});

	test('a server that is switched off leaves the checkout alone and asks git nothing more', async () => {
		const off = json({ trackerFolder: '.tracker', mcp: { port: 17711 } });
		const { store, git } = mcpStore({ settingsText: off });

		await store.create('ST-1');

		assert.strictEqual(await readFile(path.join(ROOT, 'ST-1', '.vscode', 'bfast.json'), 'utf8'), off);
		assert.strictEqual(await readFile(path.join(ROOT, 'ST-1', '.mcp.json'), 'utf8'), json(CHECKOUT_CLAUDE));
		assert.strictEqual('mcpPort' in (await readMarkerOf('ST-1')), false);
		assert.strictEqual(git.requests.length, 2);
	});

	test('settings that are not JSON are said, and the create still succeeds with nothing moved', async () => {
		const broken = '{ "mcp": { "enabled": true, ';
		const { store, phases } = mcpStore({ settingsText: broken });

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		assert.strictEqual(await readFile(path.join(ROOT, 'ST-1', '.vscode', 'bfast.json'), 'utf8'), broken);
		assert.strictEqual('mcpPort' in (await readMarkerOf('ST-1')), false);
		assert.ok(
			phases.some((label) => label.startsWith('Could not give ST-1 its own MCP server port')),
			phases.join('\n')
		);
	});

	test('git refusing the mark is said, and the moved port is still recorded', async () => {
		// prune, add, ls-files, then the update-index fails.
		const { store, phases } = mcpStore({ failAt: [3] });

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		assert.strictEqual((await readMarkerOf('ST-1')).mcpPort, 17712);
		assert.ok(
			phases.some((label) =>
				label.startsWith('Not everything followed the MCP port: git could not hide .vscode/bfast.json, .mcp.json')
			),
			phases.join('\n')
		);
	});

	test('a second environment never reuses the first one’s ports', async () => {
		const { store } = makeStore();
		await store.create('ST-1');
		const second = await store.create('ST-2');
		assert.deepStrictEqual(second.ports, { WEB_PORT: 21002, DB_PORT: 21003 });
	});

	test('concurrent creates serialize, so they cannot allocate the same ports', async () => {
		// Without the store-wide create chain, neither create would see the
		// other's marker and both would get 21000/21001.
		const { store } = makeStore();
		const [first, second] = await Promise.all([store.create('ST-1'), store.create('ST-2')]);
		const taken = [
			...Object.values(first.ports),
			...Object.values(second.ports)
		];
		assert.strictEqual(new Set(taken).size, taken.length, `ports overlap: ${taken.join(', ')}`);
	});

	test('another workspace’s environment in the way is refused, never deleted', async () => {
		const { store } = makeStore();
		const squatter = path.join(ROOT, 'ST-1');
		await mkdir(path.join(squatter, '.bfast'), { recursive: true });
		await writeFile(
			path.join(squatter, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				ticketId: 'ST-1',
				kind: 'docker-compose',
				branch: 'story/ST-1',
				ports: {},
				createdAt: '',
				sourceRoot: path.join(SCRATCH, 'other-repo')
			})
		);

		await assert.rejects(store.create('ST-1'), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'exists');
			return true;
		});
		// Hands off: the other workspace's marker survives.
		await stat(path.join(squatter, ...MARKER_FILE.split('/')));
	});

	test('a markerless leftover folder is cleared and the create proceeds', async () => {
		// The interrupted-delete shape: the marker went with the partial removal
		// but the folder stayed — without this, every future create dead-ends.
		const { store, provider } = makeStore();
		const leftover = path.join(ROOT, 'ST-1');
		await mkdir(leftover, { recursive: true });
		await writeFile(path.join(leftover, 'debris.txt'), 'from an interrupted delete');

		const handle = await store.create('ST-1');

		assert.strictEqual(handle.status, 'stopped');
		await assert.rejects(stat(path.join(leftover, 'debris.txt')));
		await stat(path.join(ROOT, 'ST-1', ...MARKER_FILE.split('/')));
		// The clearing also asked the provider to destroy (the leftover's stack
		// may still exist) and to reclaim (its files may be root-owned) — the
		// reclaim deliberately needs no compose file, which a half-deleted
		// leftover may have lost.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['destroy', 'reclaim']
		);
	});

	test('create refuses a ticket that already has an environment', async () => {
		const { store } = makeStore();
		await store.create('ST-1');
		await assert.rejects(store.create('ST-1'), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'exists');
			return true;
		});
	});

	test('list scans markers, skips junk, and keeps another repo’s environments out', async () => {
		const { store } = makeStore();
		await store.create('ST-1');

		// A folder with no marker is not an environment.
		await mkdir(path.join(ROOT, 'junk'), { recursive: true });
		// A marker from a different repo (same-named workspace elsewhere).
		const foreign = path.join(ROOT, 'XX-1');
		await mkdir(path.join(foreign, '.bfast'), { recursive: true });
		await writeFile(
			path.join(foreign, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				ticketId: 'XX-1',
				kind: 'docker-compose',
				branch: 'bfast/XX-1',
				ports: {},
				createdAt: '',
				sourceRoot: path.join(SCRATCH, 'other-repo')
			})
		);

		const listed = await store.list();
		assert.deepStrictEqual(
			listed.map((handle) => handle.id),
			['ST-1']
		);
	});

	test('the per-environment queue keeps start strictly after a hanging stop', async () => {
		const { store, provider } = makeStore({ hangFrom: 0 });
		await store.create('ST-1');

		const stopped = store.stop('ST-1');
		const started = store.start('ST-1');
		await settleTick();

		// Only the stop has reached the provider; the start is queued, not racing.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['stop']
		);
		assert.strictEqual((await store.find('ST-1'))?.status, 'stopping');

		provider.hanging[0].resolveNow();
		await stopped;
		await settleTick();
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['stop', 'start']
		);

		provider.hanging[1].resolveNow();
		await started;
	});

	test('a failed start shows as error until a later operation succeeds', async () => {
		const { store } = makeStore({ failAt: [0] });
		await store.create('ST-1');

		await assert.rejects(store.start('ST-1'));
		const failed = await store.find('ST-1');
		assert.strictEqual(failed?.status, 'error');
		assert.strictEqual(failed?.statusDetail, 'start failed');

		await store.start('ST-1');
		assert.strictEqual((await store.find('ST-1'))?.status, 'stopped');
	});

	test('a partial stack reads as error with a detail, an unreachable backend as unknown', async () => {
		const { store } = makeStore({ statuses: { 'ST-1': 'partial', 'ST-2': 'unknown' } });
		await store.create('ST-1');
		await store.create('ST-2');

		const listed = await store.list();
		assert.strictEqual(listed[0]?.status, 'error');
		assert.strictEqual(listed[0]?.statusDetail, 'Some services are not running.');
		assert.strictEqual(listed[1]?.status, 'unknown');
	});

	test('remove destroys the stack first, then the worktree — and survives a locked folder', async () => {
		// Git refuses the remove (the Windows file-lock shape); the fallback
		// deletes the folder directly and prunes.
		const { store, provider, git } = makeStore(undefined, {
			failAt: [2],
			stderr: 'fatal: locked'
		});
		await store.create('ST-1');

		await store.remove('ST-1');

		// Destroy tears the stack down; reclaim makes the folder deletable
		// (root-owned bind-mount files) before the worktree removal.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['destroy', 'reclaim']
		);
		assert.deepStrictEqual(
			git.requests[2].args,
			gitArgs(worktreeRemoveArgs(path.join(ROOT, 'ST-1')))
		);
		assert.deepStrictEqual(git.requests[3].args, gitArgs(worktreePruneArgs()));
		await assert.rejects(stat(path.join(ROOT, 'ST-1')));
		assert.deepStrictEqual(await store.list(), []);
	});

	test('cancel mid-create leaves no half environment behind', async () => {
		const { store, git } = makeStore(undefined, { hangFrom: 0 });

		const creating = store.create('ST-9');
		await settleTick();
		// The prune is hanging; the sidebar already shows the create.
		assert.strictEqual((await store.find('ST-9'))?.status, 'creating');

		store.cancel('ST-9');
		await assert.rejects(creating, (error: unknown) => {
			assert.ok(error instanceof EnvironmentCancelledError);
			return true;
		});

		assert.ok(git.cancelled >= 1);
		await assert.rejects(stat(path.join(ROOT, 'ST-9')));
		// No marker means no environment: the sidebar shows nothing for it.
		assert.strictEqual(await store.find('ST-9'), undefined);
	});

	test('cancel reaches an operation that is still queued, not only the running one', async () => {
		const { store, provider } = makeStore({ hangFrom: 0 });
		await store.create('ST-1');

		const started = store.start('ST-1');
		const stopped = store.stop('ST-1');
		await settleTick();

		// One cancel covers the running start AND the queued stop — otherwise
		// the stop would run to completion the moment the start dies and the
		// cancel would look ignored.
		store.cancel('ST-1');
		await assert.rejects(started, (error: unknown) => error instanceof EnvironmentCancelledError);
		await assert.rejects(stopped, (error: unknown) => error instanceof EnvironmentCancelledError);
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['start']
		);
	});

	test('dispose drains queued work without spawning anything new', async () => {
		const { store, provider } = makeStore({ hangFrom: 0 });
		await store.create('ST-1');

		const started = store.start('ST-1');
		const stopped = store.stop('ST-1');
		await settleTick();

		store.dispose();
		await assert.rejects(started);
		await assert.rejects(stopped);
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['start']
		);
	});

	test('create refuses to double-book an environment that is mid-operation', async () => {
		const { store, git } = makeStore(undefined, { hangFrom: 0 });
		const creating = store.create('ST-1');
		await settleTick();

		assert.throws(
			() => store.create('ST-1'),
			(error: unknown) => error instanceof EnvironmentError && error.code === 'busy'
		);

		store.cancel('ST-1');
		await creating.catch(() => undefined);
		assert.ok(git.requests.length >= 1);
	});

	test('changes fire for every repaint-worthy moment', async () => {
		const { store } = makeStore();
		let fired = 0;
		const unsubscribe = store.onDidChange(() => fired++);
		await store.create('ST-1');
		assert.ok(fired >= 2, `expected at least start+finish events, got ${fired}`);

		const seen = fired;
		unsubscribe();
		await store.start('ST-1');
		assert.strictEqual(fired, seen);
	});

	// ------------------------------------------------------ the master environment

	test('createMaster allocates ports and writes master.json beside the worktrees — no git, nothing in the repo', async () => {
		const { store, provider, git } = makeStore();

		const handle = await store.createMaster();

		assert.strictEqual(handle.id, 'master');
		assert.strictEqual(handle.scope, 'master');
		assert.strictEqual(handle.ticketId, undefined);
		assert.strictEqual(handle.status, 'stopped');
		// The stack runs in the workspace folder itself, under a project that
		// carries the workspace slug — the worktrees root's own name.
		assert.strictEqual(handle.worktreePath, REPO);
		assert.strictEqual(handle.projectName, MASTER_PROJECT);
		assert.deepStrictEqual(handle.ports, { WEB_PORT: 21000, DB_PORT: 21001 });
		assert.strictEqual(handle.mainPort, 'WEB_PORT');

		// No checkout to make: git is never spawned, and nothing lands in the repo.
		assert.deepStrictEqual(git.requests, []);
		assert.deepStrictEqual(await readdir(REPO), []);

		const marker = JSON.parse(await readFile(path.join(ROOT, MASTER_MARKER_FILE), 'utf8'));
		assert.strictEqual(marker.scope, 'master');
		assert.strictEqual(marker.ticketId, undefined);
		assert.strictEqual(marker.projectName, MASTER_PROJECT);
		assert.strictEqual(marker.sourceRoot, REPO);

		// Create is not start.
		assert.deepStrictEqual(provider.operations, []);
		assert.strictEqual((await store.find('master'))?.status, 'stopped');
	});

	test('the master environment reports the branch the workspace has checked out — read, not recorded', async () => {
		const { store } = makeStore();
		await mkdir(path.join(REPO, '.git'), { recursive: true });
		await writeFile(path.join(REPO, '.git', 'HEAD'), 'ref: refs/heads/main\n');

		const handle = await store.createMaster();
		assert.strictEqual(handle.branch, 'main');

		// A checkout switch shows on the next list; the marker holds no branch.
		await writeFile(path.join(REPO, '.git', 'HEAD'), 'ref: refs/heads/release/2\n');
		assert.strictEqual((await store.find('master'))?.branch, 'release/2');
		const marker = JSON.parse(await readFile(path.join(ROOT, MASTER_MARKER_FILE), 'utf8'));
		assert.strictEqual(marker.branch, undefined);
	});

	test('master and ticket environments never share a port, whichever comes first', async () => {
		const { store } = makeStore();
		const first = await store.create('ST-1');
		const master = await store.createMaster();
		const second = await store.create('ST-2');

		assert.deepStrictEqual(master.ports, { WEB_PORT: 21002, DB_PORT: 21003 });
		const taken = [first, master, second].flatMap((handle) => Object.values(handle.ports));
		assert.strictEqual(new Set(taken).size, taken.length, `ports overlap: ${taken.join(', ')}`);
	});

	test('a second master environment is refused', async () => {
		const { store } = makeStore();
		await store.createMaster();
		await assert.rejects(store.createMaster(), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'exists');
			return true;
		});
	});

	test('another workspace’s master marker in the way is refused, never overwritten', async () => {
		// Same-named workspaces share a worktrees folder — and so one master.json.
		// The sidebar filters that marker out; the create must not, or it would
		// replace the file whose project name the other stack runs under.
		const { store } = makeStore();
		await mkdir(ROOT, { recursive: true });
		const foreign = serializeEnvironmentMarker({
			version: 1,
			scope: 'master',
			kind: 'docker-compose',
			projectName: MASTER_PROJECT,
			ports: { WEB_PORT: 21000 },
			createdAt: '',
			sourceRoot: path.join(SCRATCH, 'other-repo')
		});
		await writeFile(path.join(ROOT, MASTER_MARKER_FILE), foreign);

		await assert.rejects(store.createMaster(), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'exists');
			return true;
		});
		assert.strictEqual(await readFile(path.join(ROOT, MASTER_MARKER_FILE), 'utf8'), foreign);
		// And it is not this workspace's environment either.
		assert.deepStrictEqual(await store.list(), []);
	});

	test('a junk master.json is debris and the create proceeds over it', async () => {
		const { store } = makeStore();
		await mkdir(ROOT, { recursive: true });
		await writeFile(path.join(ROOT, MASTER_MARKER_FILE), '{ not json');

		const handle = await store.createMaster();
		assert.strictEqual(handle.status, 'stopped');
		assert.strictEqual((await store.find('master'))?.projectName, MASTER_PROJECT);
	});

	test('a master-shaped marker inside a worktree folder is a stray, not an environment', async () => {
		const { store } = makeStore();
		await store.create('ST-1');
		const stray = path.join(ROOT, 'XX-1');
		await mkdir(path.join(stray, '.bfast'), { recursive: true });
		await writeFile(
			path.join(stray, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				scope: 'master',
				kind: 'docker-compose',
				projectName: 'bfast-master-x',
				ports: {},
				createdAt: '',
				sourceRoot: REPO
			})
		);
		assert.deepStrictEqual((await store.list()).map((handle) => handle.id), ['ST-1']);
	});

	test('the master environment heads the list; tickets follow in id order', async () => {
		const { store } = makeStore();
		await store.create('ST-2');
		await store.create('ST-10');
		await store.createMaster();
		assert.deepStrictEqual(
			(await store.list()).map((handle) => handle.id),
			['master', 'ST-2', 'ST-10']
		);
	});

	test('start hands the provider the workspace folder and the master project name', async () => {
		const { store, provider } = makeStore();
		await store.createMaster();

		await store.start('master');

		const [operation] = provider.operations;
		assert.strictEqual(operation?.kind, 'start');
		assert.strictEqual(operation?.env.worktreePath, REPO);
		assert.strictEqual(operation?.env.projectName, MASTER_PROJECT);
		assert.strictEqual(operation?.env.ticketId, undefined);
	});

	test('start on a missing master environment says so', async () => {
		const { store } = makeStore();
		await assert.rejects(store.start('master'), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'not-configured');
			assert.ok(error.message.includes('no master environment'), error.message);
			return true;
		});
	});

	test('remove of the master environment destroys the stack and its marker, and nothing else', async () => {
		const { store, provider, git } = makeStore();
		await store.createMaster();
		await writeFile(path.join(REPO, 'keep.txt'), 'the user’s own file');

		await store.remove('master');

		// Destroy only: no ownership reclaim, no worktree removal, no git at all
		// — the folder is the workspace, and none of that is this feature's to
		// run on it.
		assert.deepStrictEqual(
			provider.operations.map((operation) => operation.kind),
			['destroy']
		);
		assert.deepStrictEqual(git.requests, []);
		await assert.rejects(stat(path.join(ROOT, MASTER_MARKER_FILE)));
		assert.strictEqual(await readFile(path.join(REPO, 'keep.txt'), 'utf8'), 'the user’s own file');
		assert.deepStrictEqual(await store.list(), []);
	});

	test('cancel mid-createMaster leaves no marker behind', async () => {
		const held = heldProbe();
		const { store } = makeStore(undefined, undefined, held.probe);

		const creating = store.createMaster();
		await settleTick();
		// Parked at allocation; the sidebar already shows the create.
		assert.strictEqual((await store.find('master'))?.status, 'creating');

		store.cancel('master');
		held.release();
		await assert.rejects(creating, (error: unknown) => error instanceof EnvironmentCancelledError);
		await assert.rejects(stat(path.join(ROOT, MASTER_MARKER_FILE)));
		assert.strictEqual(await store.find('master'), undefined);
	});

	test('createMaster refuses to double-book while its create is in flight', async () => {
		const held = heldProbe();
		const { store } = makeStore(undefined, undefined, held.probe);
		const creating = store.createMaster();
		await settleTick();

		assert.throws(
			() => store.createMaster(),
			(error: unknown) => error instanceof EnvironmentError && error.code === 'busy'
		);

		held.release();
		await creating;
	});
});

/**
 * Listing containers and following a log are **reads**, and the store forwards
 * them without the per-environment queue: listing what is running must not wait
 * behind a fifteen-minute build, and neither changes anything there is a race
 * to lose. docs/environments/provider-interface.md says so; this holds it.
 */
suite('BFAST environment container reads', () => {
	suiteTeardown(() => rm(SCRATCH, { recursive: true, force: true }));

	const web = {
		id: 'aaa',
		name: 'bfast-st-1-web-1',
		service: 'web',
		state: 'running' as const,
		status: 'Up 3 minutes'
	};

	test('a listing does not queue behind a running operation', async () => {
		// `hangFrom: 0` parks the start for ever. A queued read would never
		// answer, and the sidebar would sit blank for the whole build.
		const { store, provider } = makeStore({ hangFrom: 0, containers: { 'ST-1': [web] } });
		const environment = await store.create('ST-1');

		const started = store.start('ST-1');
		started.catch(() => undefined);
		await settleTick();

		assert.deepStrictEqual(await store.containers(environment), [web]);

		provider.hanging[0].resolveNow();
		await started;
	});

	test('a failed listing rejects rather than answering an empty list', async () => {
		const { store } = makeStore({ containersFail: { 'ST-2': 'Docker is not running.' } });
		const environment = await store.create('ST-2');

		// "Could not ask" and "nothing there" are different facts that the
		// sidebar shows differently, so they may not arrive the same way.
		await assert.rejects(
			() => store.containers(environment),
			(error: unknown) =>
				error instanceof EnvironmentError && error.message === 'Docker is not running.'
		);
	});

	test('the follow carries the configured tail, read at call time', async () => {
		const { store, provider } = makeStore();
		const environment = await store.create('ST-3');

		store.logs(environment, web);
		// This workspace sets no `logTail`, so the default reaches the provider
		// — and the panel never learns there is a setting at all.
		assert.strictEqual(provider.logRuns[0].tail, DEFAULT_LOG_TAIL);
		assert.strictEqual(provider.logRuns[0].container.id, 'aaa');
	});

	test('a follow does not queue either, and its output reaches the listener', async () => {
		const { store, provider } = makeStore({ hangFrom: 0 });
		const environment = await store.create('ST-4');

		const started = store.start('ST-4');
		started.catch(() => undefined);
		await settleTick();

		const chunks: string[] = [];
		const follow = store.logs(environment, web, (progress) => {
			if (progress.kind === 'output') {
				chunks.push(progress.text);
			}
		});
		provider.logRuns[0].emit('listening on 3000\n');
		assert.deepStrictEqual(chunks, ['listening on 3000\n']);

		// Closing the tab cancels it; nothing keeps following behind a tab that
		// is gone.
		follow.cancel();
		await assert.rejects(() => follow.completed);

		provider.hanging[0].resolveNow();
		await started;
	});
});
