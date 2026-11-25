// The trace the reader tests share: a merged `trace.zip`'s worth of events —
// a library context and a test-runner context on two clocks, a network file
// and a stacks file — small enough to read, shaped like the real thing.

import { buildTraceReport, parseTraceContext, type TraceReport } from '../shared/playwrightTrace';

/** Newline-delimited JSON, the way the recorder writes it. */
export function ndjson(events: unknown[]): string {
	return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

// A library context on its own clock (1000-based), as `0-trace.trace` holds it:
// two pages' worth of frames, a click inside a `goto`, a failing expect, a
// console message and a route handler that must not end anyone's window.
export const LIBRARY_EVENTS: unknown[] = [
	{
		type: 'context-options',
		origin: 'library',
		version: 8,
		browserName: 'chromium',
		playwrightVersion: '1.59.1',
		options: { viewport: { width: 1280, height: 720 } },
		platform: 'linux',
		wallTime: 1_757_000_000_000,
		monotonicTime: 1000,
		sdkLanguage: 'javascript'
	},
	{ type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-1.jpeg', width: 1280, height: 720, timestamp: 1005 },
	{
		type: 'before',
		callId: 'call@1',
		startTime: 1010,
		class: 'Frame',
		method: 'goto',
		params: { url: 'http://localhost:3000/login', waitUntil: 'load' },
		stepId: 'pw:api@1',
		pageId: 'page@1'
	},
	{ type: 'log', callId: 'call@1', time: 1012, message: 'navigating to "http://localhost:3000/login"' },
	{ type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-2.jpeg', width: 1280, height: 720, timestamp: 1020 },
	{ type: 'after', callId: 'call@1', endTime: 1030, result: {} },
	{
		type: 'before',
		callId: 'call@2',
		startTime: 1040,
		class: 'Frame',
		method: 'click',
		params: { selector: 'internal:role=button[name="Sign in"i]', strict: true },
		stepId: 'pw:api@2',
		pageId: 'page@1'
	},
	{ type: 'input', callId: 'call@2', point: { x: 640, y: 400 } },
	{ type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-3.jpeg', width: 1280, height: 720, timestamp: 1045 },
	{
		type: 'console',
		messageType: 'error',
		text: 'Failed to load resource',
		args: [],
		location: { url: 'http://localhost:3000/app.js', lineNumber: 12, columnNumber: 4 },
		time: 1050,
		pageId: 'page@1'
	},
	{ type: 'before', callId: 'call@3', startTime: 1052, class: 'Route', method: 'fulfill', params: {}, pageId: 'page@1' },
	{ type: 'after', callId: 'call@3', endTime: 1053 },
	{ type: 'after', callId: 'call@2', endTime: 1060 },
	{
		type: 'before',
		callId: 'call@4',
		startTime: 1070,
		class: 'Frame',
		method: 'expect',
		params: { selector: 'internal:text="Welcome"', expression: 'to.be.visible', isNot: false },
		stepId: 'pw:api@3',
		pageId: 'page@1'
	},
	{ type: 'screencast-frame', pageId: 'page@1', sha1: 'page@1-4.jpeg', width: 1280, height: 720, timestamp: 1080 },
	{
		type: 'event',
		time: 1085,
		class: 'BrowserContext',
		method: 'pageError',
		params: { error: { message: 'Uncaught TypeError: boom', stack: 'TypeError: boom\n    at app.js:1' } },
		pageId: 'page@1'
	},
	{
		type: 'after',
		callId: 'call@4',
		endTime: 1090,
		error: { name: 'Error', message: 'Timed out 5000ms waiting for expect(locator).toBeVisible()', stack: 'Error: Timed out\n    at test.spec.ts:9' }
	},
	// A page opened later, with one frame: not the busiest, never the filmstrip.
	{ type: 'screencast-frame', pageId: 'page@2', sha1: 'page@2-1.jpeg', width: 800, height: 600, timestamp: 1095 },
	// The trace ended inside this one.
	{ type: 'before', callId: 'call@5', startTime: 1100, class: 'Frame', method: 'waitForTimeout', params: { timeout: 60000 }, pageId: 'page@1' },
	{ type: 'frame-snapshot', snapshot: { html: ['div', {}, 'never parsed'] } },
	'this line is not json'
];

/** The runner's context on its own clock: 4000 ahead of the library's, aligned on pw:api@1 ↔ call@1. */
export const RUNNER_EVENTS: unknown[] = [
	{ type: 'context-options', origin: 'testRunner', version: 8, title: 'TC-1.1 signs in', wallTime: 1_757_000_000_000, monotonicTime: 5000, sdkLanguage: 'javascript' },
	{ type: 'before', callId: 'hook@1', startTime: 5000, class: 'Test', method: 'hook', title: 'Before Hooks', stack: [] },
	{ type: 'after', callId: 'hook@1', endTime: 5005 },
	{
		type: 'before',
		callId: 'step@1',
		startTime: 5008,
		class: 'Test',
		method: 'test.step',
		title: 'Sign in',
		stack: [{ file: '/ci/e2e/login.spec.ts', line: 5, column: 3, function: 'signIn' }]
	},
	// pw:api@1 is call@1's stepId: this step folds into the goto.
	{ type: 'before', callId: 'pw:api@1', startTime: 5010, class: 'Test', method: 'pw:api', title: 'Navigate to login', parentId: 'step@1', stack: [{ file: '/ci/e2e/login.spec.ts', line: 6, column: 5 }] },
	{ type: 'after', callId: 'pw:api@1', endTime: 5031 },
	{ type: 'before', callId: 'pw:api@2', startTime: 5039, class: 'Test', method: 'pw:api', title: 'Click Sign in', parentId: 'step@1', stack: [{ file: '/ci/e2e/login.spec.ts', line: 7, column: 5 }] },
	{ type: 'after', callId: 'pw:api@2', endTime: 5061 },
	{ type: 'after', callId: 'step@1', endTime: 5062 },
	{ type: 'before', callId: 'pw:api@3', startTime: 5069, class: 'Test', method: 'expect', title: 'Expect welcome', stack: [{ file: '/ci/e2e/login.spec.ts', line: 9, column: 3 }] },
	{ type: 'after', callId: 'pw:api@3', endTime: 5091, error: { message: 'Timed out 5000ms waiting for expect(locator).toBeVisible()' } },
	{ type: 'error', message: 'Timed out 5000ms waiting for expect(locator).toBeVisible()', stack: [{ file: '/ci/e2e/login.spec.ts', line: 9, column: 3 }] },
	{ type: 'stdout', timestamp: 5010, text: 'signing in…\n' }
];

export const NETWORK_EVENTS: unknown[] = [
	{
		type: 'resource-snapshot',
		snapshot: {
			pageref: 'page@1',
			_monotonicTime: 1011,
			startedDateTime: '2026-09-05T10:00:00.000Z',
			time: 42,
			request: { method: 'GET', url: 'http://localhost:3000/login', headers: [] },
			response: { status: 200, statusText: 'OK', headers: [], content: { size: 5120, mimeType: 'text/html' }, _transferSize: 5400 }
		}
	},
	{
		type: 'resource-snapshot',
		snapshot: {
			pageref: 'page@1',
			_monotonicTime: 1041,
			time: -1,
			request: { method: 'POST', url: 'http://localhost:3000/api/session', headers: [] },
			response: { status: 500, statusText: 'Internal Server Error', headers: [], content: { size: -1, mimeType: 'application/json' } }
		}
	}
];

export const STACKS = JSON.stringify({
	files: ['/ci/e2e/login.spec.ts'],
	stacks: [[2, [[0, 7, 5, 'signIn']]]]
});

export function sampleReport(): TraceReport {
	return buildTraceReport([
		parseTraceContext(ndjson(LIBRARY_EVENTS), '0-trace', { stacks: STACKS, network: ndjson(NETWORK_EVENTS) }),
		parseTraceContext(ndjson(RUNNER_EVENTS), 'test')
	]);
}
