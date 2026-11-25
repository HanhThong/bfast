import * as assert from 'assert';
import * as path from 'path';
import {
	findPlaywrightCli,
	PLAYWRIGHT_CLIS,
	TraceViewerLauncher,
	type TraceViewerDeps
} from '../testing/traceViewerLauncher';
import { FakeProcessRunner } from './fakeProcessRunner';

const ROOT = path.join(path.sep, 'ws');
const CLI = path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js');

function harness(options: {
	files?: string[];
	remote?: boolean;
	roots?: string[];
	runner?: FakeProcessRunner;
	execPath?: string;
}) {
	const files = new Set(options.files ?? [CLI]);
	const runner = options.runner ?? new FakeProcessRunner({ hangFrom: 0 });
	const log: string[] = [];
	const opened: string[] = [];
	const deps: TraceViewerDeps = {
		runner: runner.runner,
		exists: async (file) => files.has(file),
		roots: () => options.roots ?? [ROOT],
		remote: () => options.remote ?? false,
		openExternal: async (url) => {
			opened.push(url);
		},
		log: (line) => log.push(line),
		env: { PATH: '/usr/bin' },
		...(options.execPath ? { execPath: options.execPath } : {})
	};
	return { launcher: new TraceViewerLauncher(deps), runner, log, opened, files };
}

/** The write queue pauses between paths; wait it out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

suite('Trace viewer launcher', () => {
	test('finds the workspace Playwright in order, tests.cwd first', async () => {
		const exists = async (file: string) => file === path.join(ROOT, 'node_modules', 'playwright', 'cli.js');
		assert.deepStrictEqual(await findPlaywrightCli([path.join(ROOT, 'e2e'), ROOT], exists), {
			cli: path.join(ROOT, 'node_modules', 'playwright', 'cli.js'),
			root: ROOT
		});
		const nested = path.join(ROOT, 'e2e', 'node_modules', '@playwright', 'test', 'cli.js');
		assert.deepStrictEqual(await findPlaywrightCli([path.join(ROOT, 'e2e'), ROOT], async (file) => file === nested), {
			cli: nested,
			root: path.join(ROOT, 'e2e')
		});
		assert.strictEqual(await findPlaywrightCli([ROOT], async () => false), undefined);
		assert.deepStrictEqual(PLAYWRIGHT_CLIS, ['playwright-core/cli.js', 'playwright/cli.js', '@playwright/test/cli.js']);
	});

	test('the first trace starts the viewer over stdin; later ones reuse it, one path per write', async () => {
		const { launcher, runner, log } = harness({});
		assert.deepStrictEqual(await launcher.open('/results/TC-1/run-1/TC-1.zip'), { kind: 'opened' });
		assert.strictEqual(runner.requests.length, 1);
		const request = runner.requests[0];
		assert.strictEqual(request.executable, 'node');
		assert.deepStrictEqual(request.args, [CLI, 'show-trace', '--stdin']);
		assert.strictEqual(request.cwd, ROOT);
		assert.strictEqual(request.interactive, true);
		assert.strictEqual(request.killTree, true);
		assert.strictEqual(request.env?.PATH, '/usr/bin');

		assert.deepStrictEqual(await launcher.open('/results/TC-1/run-2/TC-1.zip'), { kind: 'reused' });
		assert.strictEqual(runner.requests.length, 1, 'one viewer per window');
		await settle();
		await settle();
		assert.deepStrictEqual(runner.hanging[0].written, ['/results/TC-1/run-1/TC-1.zip\n', '/results/TC-1/run-2/TC-1.zip\n']);
		assert.ok(log.some((line) => /Opening TC-1.zip in Playwright Trace Viewer: node/.test(line)));
		assert.ok(log.some((line) => /running Playwright Trace Viewer/.test(line)));
	});

	test('when the viewer exits, the next open starts a new one', async () => {
		const { launcher, runner, log } = harness({});
		await launcher.open('/a.zip');
		runner.hanging[0].resolveNow({ code: 0, stdout: '', stderr: '' });
		await settle();
		assert.ok(log.includes('— Trace viewer closed.'));
		assert.deepStrictEqual(await launcher.open('/b.zip'), { kind: 'opened' });
		assert.strictEqual(runner.requests.length, 2);
	});

	test('on a remote it serves on 127.0.0.1, waits for the url and opens it externally', async () => {
		const { launcher, runner, opened, log } = harness({ remote: true });
		const opening = launcher.open('/a.zip');
		// The url arrives after the spawn settles.
		await new Promise((resolve) => setTimeout(resolve, 500));
		runner.hanging[0].emit({ stdout: '\nListening on http://127.0.0.1:41234\n', stderr: '' });
		assert.deepStrictEqual(await opening, { kind: 'opened' });
		assert.deepStrictEqual(runner.requests[0].args, [CLI, 'show-trace', '--stdin', '--host', '127.0.0.1', '--port', '0']);
		assert.deepStrictEqual(opened, ['http://127.0.0.1:41234']);
		assert.ok(log.includes('— Trace viewer: http://127.0.0.1:41234'));
		await settle();
		assert.deepStrictEqual(runner.hanging[0].written, ['/a.zip\n']);
	});

	test('no Playwright in the workspace is not-found; no node falls back to the editor runtime', async () => {
		const none = harness({ files: [] });
		assert.deepStrictEqual(await none.launcher.open('/a.zip'), { kind: 'not-found' });
		assert.strictEqual(none.runner.requests.length, 0);

		const runner = new FakeProcessRunner({ missingAt: [0], hangFrom: 1 });
		const fallback = harness({ runner, execPath: '/apps/code/code' });
		assert.deepStrictEqual(await fallback.launcher.open('/a.zip'), { kind: 'opened' });
		assert.strictEqual(runner.requests.length, 2);
		assert.strictEqual(runner.requests[1].executable, '/apps/code/code');
		assert.strictEqual(runner.requests[1].env?.ELECTRON_RUN_AS_NODE, '1');
		assert.ok(fallback.log.some((line) => /not on the PATH/.test(line)));

		const neither = harness({ runner: new FakeProcessRunner({ missingAt: [0] }) });
		const outcome = await neither.launcher.open('/a.zip');
		assert.strictEqual(outcome.kind, 'failed');
	});

	test('a viewer that dies at once reports the failure and hints at the browser install', async () => {
		const runner = new FakeProcessRunner({
			failAt: [0],
			stderr: "browserType.launch: Executable doesn't exist at /home/x/.cache/ms-playwright/chromium"
		});
		const { launcher, log } = harness({ runner });
		const outcome = await launcher.open('/a.zip');
		assert.strictEqual(outcome.kind, 'failed');
		await settle();
		assert.ok(log.some((line) => /npx playwright install chromium/.test(line)), log.join('\n'));
	});

	test('dispose ends the viewer’s stdin, and nothing opens afterwards', async () => {
		const { launcher, runner } = harness({});
		await launcher.open('/a.zip');
		launcher.dispose();
		assert.strictEqual(runner.hanging[0].stdinEnded, true);
		const outcome = await launcher.open('/b.zip');
		assert.strictEqual(outcome.kind, 'failed');
		runner.hanging[0].resolveNow({ code: 0, stdout: '', stderr: '' });
	});
});
