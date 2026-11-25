import * as assert from 'assert';
import {
	actionAt,
	buildTraceReport,
	eventsFor,
	filmstripFrames,
	formatTraceDuration,
	formatTraceTime,
	frameAfter,
	frameBefore,
	frameLocation,
	KNOWN_TRACE_VERSION,
	parseStacks,
	parseTraceContext,
	requestsFor,
	windowFor
} from '../shared/playwrightTrace';
import { LIBRARY_EVENTS, ndjson, NETWORK_EVENTS, sampleReport, STACKS } from './traceFixture';

suite('Playwright trace reader', () => {
	test('reads a library context: actions, frames, console, page errors, and counts what it cannot read', () => {
		const context = parseTraceContext(ndjson(LIBRARY_EVENTS), '0-trace', { stacks: STACKS });
		assert.strictEqual(context.origin, 'library');
		assert.strictEqual(context.version, 8);
		assert.deepStrictEqual(context.viewport, { width: 1280, height: 720 });
		assert.strictEqual(context.actions.size, 5);
		const click = context.actions.get('call@2')!;
		assert.strictEqual(click.title, 'click');
		assert.strictEqual(click.params.selector, 'internal:role=button[name="Sign in"i]');
		assert.deepStrictEqual(click.point, { x: 640, y: 400 });
		assert.strictEqual(click.endTime, 1060);
		// The stack for call@2 came from the .stacks file (`call@` + id 2).
		assert.deepStrictEqual(click.stack, [{ file: '/ci/e2e/login.spec.ts', line: 7, column: 5, function: 'signIn' }]);
		const goto = context.actions.get('call@1')!;
		assert.deepStrictEqual(goto.log, [{ time: 1012, message: 'navigating to "http://localhost:3000/login"' }]);
		assert.strictEqual(context.actions.get('call@5')!.unfinished, true);
		assert.strictEqual(context.actions.get('call@4')!.error?.message, 'Timed out 5000ms waiting for expect(locator).toBeVisible()');
		assert.strictEqual(context.frames.length, 5);
		assert.deepStrictEqual(
			context.events.map((event) => event.kind),
			['console', 'pageerror']
		);
		assert.deepStrictEqual(context.warnings, ['1 line of 0-trace.trace could not be read.']);
	});

	test('reads the network file into requests, with a failed one left open', () => {
		const context = parseTraceContext(ndjson(NETWORK_EVENTS), '0-trace');
		assert.strictEqual(context.network.length, 2);
		assert.deepStrictEqual(context.network[0], {
			id: 'request@0',
			pageId: 'page@1',
			method: 'GET',
			url: 'http://localhost:3000/login',
			startTime: 1011,
			status: 200,
			statusText: 'OK',
			mimeType: 'text/html',
			size: 5120,
			transferSize: 5400,
			duration: 42
		});
		assert.strictEqual(context.network[1].duration, undefined);
		assert.strictEqual(context.network[1].size, undefined);
		assert.strictEqual(context.network[1].status, 500);
	});

	test('the merged report folds runner steps into the calls they made and aligns the clocks', () => {
		const report = sampleReport();
		assert.strictEqual(report.title, 'TC-1.1 signs in');
		assert.strictEqual(report.browserName, 'chromium');
		assert.strictEqual(report.version, 8);
		// hook, step, goto (folded), click (folded), Route, expect (folded), waitForTimeout
		assert.deepStrictEqual(
			report.actions.map((action) => `${'  '.repeat(action.depth)}${action.callId}`),
			['hook@1', 'step@1', '  call@1', '  call@2', 'call@3', 'call@4', 'call@5']
		);
		const goto = report.actions.find((action) => action.callId === 'call@1')!;
		// The step's title and times win; the library's params stay.
		assert.strictEqual(goto.title, 'Navigate to login');
		assert.strictEqual(goto.params.url, 'http://localhost:3000/login');
		assert.strictEqual(goto.startTime, 5010);
		assert.strictEqual(goto.endTime, 5031);
		assert.strictEqual(goto.parentId, 'step@1');
		// Frames, events and requests moved onto the runner's clock (+4000).
		assert.strictEqual(report.pages[0].frames[0].timestamp, 5005);
		assert.strictEqual(report.events[0].time, 5050);
		assert.strictEqual(report.network[0].startTime, 5011);
		assert.strictEqual(report.startTime, 5000);
		// The expect's error is reported once, though the runner and the call both carry it.
		assert.strictEqual(report.errors.length, 1);
		assert.deepStrictEqual(report.errors[0].stack, [{ file: '/ci/e2e/login.spec.ts', line: 9, column: 3 }]);
		assert.deepStrictEqual(report.sources, ['/ci/e2e/login.spec.ts']);
		assert.strictEqual(report.frameCount, 5);
		assert.deepStrictEqual(report.stdio, [{ channel: 'stdout', time: 5010, text: 'signing in…\n' }]);
		assert.deepStrictEqual(report.warnings, ['1 line of 0-trace.trace could not be read.']);
	});

	test('a step is not ended by its own children; a route handler ends nobody', () => {
		const report = sampleReport();
		const step = report.actions.find((action) => action.callId === 'step@1')!;
		const click = report.actions.find((action) => action.callId === 'call@2')!;
		const last = report.actions.find((action) => action.callId === 'call@5')!;
		// The step runs to the expect's start, over both of its children.
		assert.deepStrictEqual(windowFor(report, step), { start: 5008, end: 5069 });
		// The click's window skips the Route call and ends at the expect.
		assert.deepStrictEqual(windowFor(report, click), { start: 5039, end: 5069 });
		assert.deepStrictEqual(windowFor(report, last), { start: 5100, end: Number.POSITIVE_INFINITY });
		assert.deepStrictEqual(eventsFor(report, click).map((event) => event.kind), ['console']);
		assert.deepStrictEqual(requestsFor(report, click).map((request) => request.method), ['POST']);
		assert.strictEqual(eventsFor(report).length, 2);
		assert.strictEqual(requestsFor(report).length, 2);
		// The deepest action owning a time, so the filmstrip lands on a child.
		assert.strictEqual(actionAt(report, 5045)?.callId, 'call@2');
	});

	test('screenshots are the last frame at or before each end of an action', () => {
		const report = sampleReport();
		const click = report.actions.find((action) => action.callId === 'call@2')!;
		assert.deepStrictEqual(frameBefore(report, click), {
			frame: {
				name: 'page@1-2.jpeg',
				entry: 'resources/page@1-2.jpeg',
				pageId: 'page@1',
				timestamp: 5020,
				width: 1280,
				height: 720
			},
			closest: false
		});
		assert.strictEqual(frameAfter(report, click)?.frame.name, 'page@1-3.jpeg');
		// Before anything was drawn: the first frame, said to be the nearest.
		const hook = report.actions.find((action) => action.callId === 'hook@1')!;
		assert.deepStrictEqual(frameBefore(report, hook), {
			frame: {
				name: 'page@1-1.jpeg',
				entry: 'resources/page@1-1.jpeg',
				pageId: 'page@1',
				timestamp: 5005,
				width: 1280,
				height: 720
			},
			closest: true
		});
		// An unfinished action's "after" is the last frame before the next action — here, the end.
		const last = report.actions.find((action) => action.callId === 'call@5')!;
		assert.strictEqual(frameAfter(report, last)?.frame.name, 'page@1-4.jpeg');
	});

	test('the filmstrip is the busiest page, thinned evenly with the last frame kept', () => {
		const report = sampleReport();
		assert.deepStrictEqual(
			filmstripFrames(report).map((frame) => frame.name),
			['page@1-1.jpeg', 'page@1-2.jpeg', 'page@1-3.jpeg', 'page@1-4.jpeg']
		);
		assert.deepStrictEqual(
			filmstripFrames(report, 2).map((frame) => frame.name),
			['page@1-1.jpeg', 'page@1-4.jpeg']
		);
		assert.deepStrictEqual(
			filmstripFrames(report, 3).map((frame) => frame.name),
			['page@1-1.jpeg', 'page@1-2.jpeg', 'page@1-4.jpeg']
		);
	});

	test('the single-event shape of old traces, an unknown type and a newer version all still read', () => {
		const context = parseTraceContext(
			ndjson([
				{ type: 'context-options', version: KNOWN_TRACE_VERSION + 1, browserName: 'firefox' },
				{
					type: 'action',
					callId: 'call@9',
					startTime: 10,
					endTime: 20,
					apiName: 'page.click',
					class: 'Frame',
					method: 'click',
					params: { selector: 'text=Go' },
					log: ['waiting', 'done'],
					error: { message: 'nope' }
				},
				{ type: 'something-new', payload: 1 },
				{ type: 'after', callId: 'call@nobody', endTime: 30 },
				{ type: 'event', time: 15, class: 'BrowserContext', method: 'console', params: { type: 'warning', text: 'old style', args: [] } },
				{ type: 'event', time: 16, class: 'BrowserContext', method: 'dialog', params: { type: 'alert', message: 'hi' } }
			]),
			'trace'
		);
		const action = context.actions.get('call@9')!;
		assert.strictEqual(action.title, 'page.click');
		assert.strictEqual(action.endTime, 20);
		assert.strictEqual(action.error?.message, 'nope');
		assert.strictEqual(action.log.length, 2);
		assert.deepStrictEqual(
			context.events.map((event) => (event.kind === 'console' ? `${event.level}:${event.text}` : 'text' in event ? `${event.kind}:${event.text}` : event.kind)),
			['warning:old style', 'dialog:alert: hi']
		);
		assert.match(context.warnings[0], new RegExp(`format ${KNOWN_TRACE_VERSION + 1}, newer than BFAST knows`));
		assert.match(context.warnings[1], /1 call ended without a recorded start/);
		// Nothing thrown on junk.
		assert.strictEqual(parseTraceContext('not json\n{"type":', 'x').warnings[0], '2 lines of x.trace could not be read.');
		assert.strictEqual(parseStacks('garbage').size, 0);
		assert.strictEqual(buildTraceReport([]).actions.length, 0);
	});

	test('a frame is found by its format: resources/<sha1> up to 8, the file it names from 9', () => {
		const old = { sha1: 'page@1-1.jpeg' };
		const moved = { file: 'screencast/page@1-1000.jpeg' };
		const inResources = { name: 'page@1-1.jpeg', entry: 'resources/page@1-1.jpeg' };
		const inScreencast = { name: 'page@1-1000.jpeg', entry: 'screencast/page@1-1000.jpeg' };

		assert.deepStrictEqual(frameLocation(old, 8, 'auto'), inResources);
		assert.deepStrictEqual(frameLocation(moved, 9, 'auto'), inScreencast);
		// Auto takes the other field when the expected one is missing, whatever the number says.
		assert.deepStrictEqual(frameLocation(moved, 8, 'auto'), inScreencast);
		assert.deepStrictEqual(frameLocation(old, 9, 'auto'), inResources);
		assert.deepStrictEqual(frameLocation(old, undefined, 'auto'), inResources);
		// A forced source reads its own field only.
		assert.strictEqual(frameLocation(moved, 9, 'resources'), undefined);
		assert.strictEqual(frameLocation(old, 8, 'screencast'), undefined);
		assert.deepStrictEqual(frameLocation({ ...old, ...moved }, 9, 'resources'), inResources);
		assert.strictEqual(frameLocation({}, 9, 'auto'), undefined);

		const context = parseTraceContext(
			ndjson([
				{ type: 'context-options', version: 9 },
				{ type: 'screencast-frame', pageId: 'page@1', file: 'screencast/page@1-1000.jpeg', width: 400, height: 300, timestamp: 5 }
			]),
			'1-trace'
		);
		assert.deepStrictEqual(context.frames, [{ ...inScreencast, pageId: 'page@1', timestamp: 5, width: 400, height: 300 }]);
		assert.deepStrictEqual(context.warnings, []);
	});

	test('a cycle in parentId is broken rather than followed', () => {
		const report = buildTraceReport([
			parseTraceContext(
				ndjson([
					{ type: 'before', callId: 'a', startTime: 1, class: 'Frame', method: 'x', parentId: 'b' },
					{ type: 'after', callId: 'a', endTime: 2 },
					{ type: 'before', callId: 'b', startTime: 3, class: 'Frame', method: 'y', parentId: 'a' },
					{ type: 'after', callId: 'b', endTime: 4 }
				]),
				'trace'
			)
		]);
		assert.deepStrictEqual(report.actions.map((action) => action.callId).sort(), ['a', 'b']);
	});

	test('times format for a row', () => {
		assert.strictEqual(formatTraceTime(5045, 5000), '0.045s');
		assert.strictEqual(formatTraceTime(17_500, 5000), '12.5s');
		assert.strictEqual(formatTraceDuration(312), '312ms');
		assert.strictEqual(formatTraceDuration(1400), '1.4s');
		assert.strictEqual(formatTraceDuration(125_000), '2m 05s');
	});
});
