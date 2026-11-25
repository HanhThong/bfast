import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { frameAfter, frameBefore } from '../shared/playwrightTrace';
import { createTraceReader, frameMime } from '../testing/traceReader';
import { LIBRARY_EVENTS, ndjson, NETWORK_EVENTS, RUNNER_EVENTS, STACKS } from './traceFixture';
import { buildZip, type ZipFixtureEntry } from './zipFixture';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

/** A merged trace the way `@playwright/test` writes one: prefixed library files, the runner's `test.trace`. */
function traceZip(extra: ZipFixtureEntry[] = []): Buffer {
	return buildZip([
		{ name: '0-trace.trace', data: ndjson(LIBRARY_EVENTS) },
		{ name: '0-trace.network', data: ndjson(NETWORK_EVENTS) },
		{ name: '0-trace.stacks', data: STACKS, streamed: false },
		{ name: 'test.trace', data: ndjson(RUNNER_EVENTS), streamed: false },
		{ name: 'resources/page@1-1.jpeg', data: JPEG, method: 'store' },
		{ name: 'resources/page@1-2.jpeg', data: JPEG },
		{ name: 'resources/page@1-3.jpeg', data: JPEG },
		{ name: 'resources/page@1-4.jpeg', data: JPEG },
		{ name: 'resources/page@2-1.jpeg', data: JPEG },
		{ name: 'resources/secret.txt', data: 'not for the board' },
		...extra
	]);
}

suite('Trace reader', () => {
	let folder: string;

	suiteSetup(async () => {
		folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bfast-trace-'));
	});

	suiteTeardown(async () => {
		await fs.rm(folder, { recursive: true, force: true });
	});

	test('reads a merged archive into one report and serves the frames it listed', async () => {
		const file = path.join(folder, 'TC-1.zip');
		await fs.writeFile(file, traceZip());
		const reader = createTraceReader();
		const result = await reader.readReport(file);
		assert.ok('trace' in result, JSON.stringify(result));
		assert.strictEqual(result.trace.title, 'TC-1.1 signs in');
		assert.strictEqual(result.trace.actions.length, 7);
		assert.strictEqual(result.trace.network.length, 2);
		// The network file rode the library's clock onto the runner's.
		assert.strictEqual(result.trace.network[0].startTime, 5011);
		assert.strictEqual(result.trace.frameCount, 5);
		assert.deepStrictEqual(result.trace.warnings, ['1 line of 0-trace.trace could not be read.']);

		const frame = await reader.readFrame(file, 'page@1-2.jpeg');
		assert.ok('data' in frame);
		assert.strictEqual(frame.mime, 'image/jpeg');
		assert.ok(Buffer.from(frame.data, 'base64').equals(JPEG));
	});

	test('serves only names the report listed, never an arbitrary entry', async () => {
		const file = path.join(folder, 'TC-2.zip');
		await fs.writeFile(file, traceZip());
		const reader = createTraceReader();
		for (const name of ['secret.txt', '../0-trace.trace', 'page@9-9.jpeg', '']) {
			const result = await reader.readFrame(file, name);
			assert.ok('error' in result, name);
			assert.match(result.error, /no frame named/);
		}
	});

	test('a zip that is not a trace, a file that is not a zip, and a missing file each say so', async () => {
		const reader = createTraceReader();
		const plain = path.join(folder, 'plain.zip');
		await fs.writeFile(plain, buildZip([{ name: 'readme.txt', data: 'hi' }]));
		const notTrace = await reader.readReport(plain);
		assert.ok('error' in notTrace && notTrace.notATrace === true);
		assert.match(notTrace.error, /not a Playwright trace/);

		const junk = path.join(folder, 'junk.zip');
		await fs.writeFile(junk, Buffer.alloc(300, 1));
		const notZip = await reader.readReport(junk);
		assert.ok('error' in notZip && notZip.notATrace === true);

		const missing = await reader.readReport(path.join(folder, 'nope.zip'));
		assert.ok('error' in missing && !missing.notATrace);
		assert.match(missing.error, /could not be found/);
	});

	test('the size cap refuses before reading; the cache follows the file', async () => {
		const file = path.join(folder, 'TC-3.zip');
		const bytes = traceZip();
		await fs.writeFile(file, bytes);
		const small = createTraceReader({ maxZipBytes: 100 });
		const capped = await small.readReport(file);
		assert.ok('error' in capped);
		assert.match(capped.error, /over what the board reads/);

		const reader = createTraceReader({ cacheSize: 1 });
		const first = await reader.readReport(file);
		assert.ok('trace' in first);
		// Replace the file: a different runner title, a later mtime.
		const replaced = RUNNER_EVENTS.map((event) =>
			typeof event === 'object' && event !== null && (event as { type?: string }).type === 'context-options'
				? { ...(event as object), title: 'replaced' }
				: event
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await fs.writeFile(
			file,
			buildZip([
				{ name: '0-trace.trace', data: ndjson(LIBRARY_EVENTS) },
				{ name: 'test.trace', data: ndjson(replaced) }
			])
		);
		const second = await reader.readReport(file);
		assert.ok('trace' in second);
		assert.strictEqual(second.trace.title, 'replaced');
	});

	test('a single-context trace keeps the plain names', async () => {
		const file = path.join(folder, 'TC-4.zip');
		await fs.writeFile(
			file,
			buildZip([
				{ name: 'trace.trace', data: ndjson(LIBRARY_EVENTS) },
				{ name: 'trace.network', data: ndjson(NETWORK_EVENTS) },
				{ name: 'resources/page@1-1.jpeg', data: JPEG }
			])
		);
		const result = await createTraceReader().readReport(file);
		assert.ok('trace' in result);
		assert.strictEqual(result.trace.actions.length, 5);
		assert.strictEqual(result.trace.network[0].startTime, 1011);
		assert.strictEqual(result.trace.title, undefined);
	});

	// Recorded with @playwright/test 1.59.1 (`trace: 'on'`, a 400×300 viewport) on
	// a test that opens a data: page, clicks, passes one expect and fails another —
	// the merged archive the reporter writes, so a format change fails here rather
	// than on the first click in a board.
	test('reads a trace Playwright actually wrote', async () => {
		const fixture = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tiny-trace.zip');
		const reader = createTraceReader();
		const result = await reader.readReport(fixture);
		assert.ok('trace' in result, JSON.stringify(result));
		const trace = result.trace;
		assert.strictEqual(trace.version, 8);
		assert.strictEqual(trace.browserName, 'chromium');
		assert.strictEqual(trace.playwrightVersion, '1.59.1');
		assert.strictEqual(trace.title, 'tiny.spec.js:3 › TC-1.1 signs in');
		assert.deepStrictEqual(trace.viewport, { width: 400, height: 300 });
		assert.deepStrictEqual(trace.warnings, []);
		assert.strictEqual(trace.frameCount, 3);

		// The runner's step and the library's calls, folded: one row per call.
		const titles = trace.actions.map((action) => `${'  '.repeat(action.depth)}${action.title}`);
		assert.ok(titles.includes('Open the form'), titles.join('\n'));
		assert.ok(titles.includes('  Navigate to "data:"'), titles.join('\n'));
		assert.ok(titles.includes('Click locator(\'#go\')'), titles.join('\n'));
		const goto = trace.actions.find((action) => action.method === 'goto')!;
		assert.strictEqual(goto.origin, 'library');
		assert.strictEqual(goto.depth, 1);
		assert.strictEqual(trace.actions.find((action) => action.callId === goto.parentId)?.title, 'Open the form');
		assert.ok(goto.stack?.[0].file.endsWith('tiny.spec.js'));
		assert.strictEqual(goto.stack?.[0].line, 5);
		assert.strictEqual(trace.actions.filter((action) => action.title === 'Navigate to "data:"').length, 1);

		// The failing expect: red on its row, once in the error list, without the terminal colours.
		const failed = trace.actions.filter((action) => action.error !== undefined);
		assert.strictEqual(failed.length, 1);
		assert.strictEqual(failed[0].title, 'Expect "toBeVisible"');
		assert.strictEqual(trace.errors.length, 1);
		assert.match(trace.errors[0].message, /^Error: expect\(locator\)\.toBeVisible\(\) failed/);
		assert.ok(!trace.errors[0].message.includes('\u001b'));
		assert.strictEqual(trace.errors[0].stack?.[0].line, 9);

		// The page's console line, and the click's before/after frames.
		assert.deepStrictEqual(
			trace.events.map((event) => (event.kind === 'console' ? `console:${event.text}` : event.kind)),
			['page', 'console:clicked']
		);
		const click = trace.actions.find((action) => action.method === 'click')!;
		const before = frameBefore(trace, click);
		const after = frameAfter(trace, click);
		assert.ok(before && after);
		assert.notStrictEqual(before.frame.name, after.frame.name);
		const frame = await reader.readFrame(fixture, after.frame.name);
		assert.ok('data' in frame && frame.mime === 'image/jpeg');
		assert.deepStrictEqual([...Buffer.from(frame.data, 'base64').subarray(0, 3)], [0xff, 0xd8, 0xff]);

		// Only real files are sources: the runner's `project#` pseudo-location is not.
		assert.strictEqual(trace.sources.length, 1);
		assert.ok(trace.sources[0].endsWith('tiny.spec.js'));
	});

	// Recorded with @playwright/test 1.63.0 on the same kind of test: format 9,
	// whose frames are `screencast/<page>-<time>.jpeg` files the events name by
	// `file`, with no `sha1` and nothing under `resources/` for them.
	test('reads a format 9 trace, whose frames moved to screencast/', async () => {
		const fixture = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tiny-trace-v9.zip');
		const reader = createTraceReader();
		const result = await reader.readReport(fixture);
		assert.ok('trace' in result, JSON.stringify(result));
		const trace = result.trace;
		assert.strictEqual(trace.version, 9);
		assert.strictEqual(trace.playwrightVersion, '1.63.0');
		assert.deepStrictEqual(trace.warnings, []);
		assert.strictEqual(trace.frameCount, 2);
		assert.ok(trace.pages[0].frames.every((frame) => frame.entry.startsWith('screencast/') && !frame.name.includes('/')));

		const click = trace.actions.find((action) => action.method === 'click')!;
		const after = frameAfter(trace, click);
		assert.ok(after);
		const frame = await reader.readFrame(fixture, after.frame.name);
		assert.ok('data' in frame && frame.mime === 'image/jpeg');
		assert.deepStrictEqual([...Buffer.from(frame.data, 'base64').subarray(0, 3)], [0xff, 0xd8, 0xff]);
	});

	test('a forced frame source reads one layout only, and a change of source is not served from the cache', async () => {
		const v9 = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tiny-trace-v9.zip');
		const v8 = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tiny-trace.zip');
		let source: 'auto' | 'resources' | 'screencast' = 'resources';
		const reader = createTraceReader({ frameSource: () => source });

		const forcedOld = await reader.readReport(v9);
		assert.ok('trace' in forcedOld);
		assert.strictEqual(forcedOld.trace.frameCount, 0);

		source = 'auto';
		const auto = await reader.readReport(v9);
		assert.ok('trace' in auto);
		assert.strictEqual(auto.trace.frameCount, 2);

		source = 'screencast';
		const forcedNew = await reader.readReport(v8);
		assert.ok('trace' in forcedNew);
		assert.strictEqual(forcedNew.trace.frameCount, 0);
	});

	test('frame mimes', () => {
		assert.strictEqual(frameMime('page@1-1.jpeg'), 'image/jpeg');
		assert.strictEqual(frameMime('x.PNG'), 'image/png');
		assert.strictEqual(frameMime('x'), 'image/jpeg');
	});
});
