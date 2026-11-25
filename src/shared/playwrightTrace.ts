// What a Playwright trace says, in the shape the board's Tests tab shows —
// read from the NDJSON files inside `trace.zip` and reduced to the actions, the
// screencast frames, the console, the network and the errors. Node-free and
// DOM-free, so the webview bundles it for the types and the pure helpers
// (`windowFor`, `frameBefore`…) and the host runs the parser; imports nothing.
//
// The format is Playwright's own and versioned (`context-options.version`, 9 at
// the time of writing; `frameLocation` says what moved in 9). This reader is
// **forgiving** the way `historyFile.ts` is: an unknown event type is skipped,
// a line that is not JSON is counted, an
// `after` with no `before` is a warning, a version newer than it knows is read
// anyway and said so — the tab must degrade on a Playwright upgrade, never
// break. It throws nothing on input.
//
// A merged trace (the `@playwright/test` reporter's) holds two contexts: the
// browser library's (`0-trace.trace`) and the test runner's (`test.trace`), on
// two clocks, and the runner's steps name the library calls under them by
// `stepId`. `buildTraceReport` joins them the way Playwright's own viewer does
// (`mergeActionsAndUpdateTimingSameTrace`): a runner step whose id a library
// call carries folds into that call, the two clocks are aligned on the first
// such pair, and what is left of the runner's steps — the hooks, `test.step`,
// `expect` — is appended. So a step and the click inside it appear once each,
// nested, rather than twice.

export interface TraceReport {
	version?: number;
	browserName?: string;
	playwrightVersion?: string;
	sdkLanguage?: string;
	/** The test's title, when the runner wrote one. */
	title?: string;
	/** Wall-clock start (epoch ms), when the trace carries one. */
	wallTime?: number;
	/** Monotonic ms; every other time here is on this clock. */
	startTime: number;
	endTime: number;
	viewport?: { width: number; height: number };
	/** Screencast frames per page, sorted by timestamp. */
	pages: TracePage[];
	/** Sorted by start, a parent before its children. */
	actions: TraceAction[];
	/** Console messages, page errors, dialogs…, sorted by time. */
	events: TraceEvent[];
	/** The runner's errors plus every action's, deduplicated by message. */
	errors: TraceError[];
	/** Sorted by start. */
	network: TraceRequest[];
	stdio: TraceStdio[];
	/** Every distinct source file the stacks name. */
	sources: string[];
	frameCount: number;
	/** What the reader could not use, in order; empty for a clean trace. */
	warnings: string[];
}

export interface TracePage {
	id: string;
	frames: TraceFrame[];
}

export interface TraceFrame {
	/** What the board asks for it by: its entry's last segment, never a path. */
	name: string;
	/** Where its image sits in the archive — see `frameLocation`. */
	entry: string;
	pageId: string;
	timestamp: number;
	width: number;
	height: number;
}

export interface TraceAction {
	callId: string;
	parentId?: string;
	depth: number;
	origin: 'library' | 'testRunner';
	stepId?: string;
	/** What the row reads: the trace's own title, or `class.method` made readable. */
	title: string;
	class: string;
	method: string;
	/** Each value a short preview — a selector, a url — never the whole object. */
	params: Record<string, string>;
	startTime: number;
	/** Absent when the trace ended before the call did. */
	endTime?: number;
	unfinished: boolean;
	pageId?: string;
	error?: { message: string; stack?: string };
	log: { time: number; message: string }[];
	stack?: TraceStackFrame[];
	attachments?: { name: string; contentType: string }[];
	/** Where a click landed, when the trace recorded it. */
	point?: { x: number; y: number };
}

export interface TraceStackFrame {
	file: string;
	line: number;
	column: number;
	function?: string;
}

export type TraceEvent =
	| {
			kind: 'console';
			time: number;
			pageId?: string;
			/** `log`, `warning`, `error`, `info`, `debug`… — the browser's word. */
			level: string;
			text: string;
			location?: { url: string; line: number; column: number };
	  }
	| { kind: 'pageerror'; time: number; pageId?: string; message: string; stack?: string }
	| { kind: 'dialog' | 'download' | 'page' | 'pageClosed'; time: number; pageId?: string; text: string };

export interface TraceError {
	message: string;
	stack?: TraceStackFrame[];
	/** The action it belongs to, when it was an action's. */
	callId?: string;
}

export interface TraceRequest {
	id: string;
	pageId?: string;
	method: string;
	url: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	/** Body size, when the trace knows it. */
	size?: number;
	transferSize?: number;
	startTime: number;
	/** Absent when the request never finished. */
	duration?: number;
}

export interface TraceStdio {
	channel: 'stdout' | 'stderr';
	time: number;
	text: string;
}

/** Past this the rest are dropped with a warning; a trace that size is the official viewer's. */
export const MAX_TRACE_ACTIONS = 5000;
/** Most thumbnails the filmstrip shows. */
export const MAX_FILMSTRIP_FRAMES = 40;
/** A param value longer than this is cut; the tab shows a row, not a document. */
export const PARAM_PREVIEW_CHARS = 200;
/** The newest format this reader was written against. */
export const KNOWN_TRACE_VERSION = 9;
/** The first format that names a frame's image by its path (`file`) rather than by `sha1`. */
export const FIRST_SCREENCAST_TRACE_VERSION = 9;

/**
 * Where the board takes a trace's screenshots from — `tests.traceFrames`.
 * `auto` follows each context's own format, `resources` and `screencast` hold
 * to one layout whatever the trace says it is.
 */
export const TRACE_FRAME_SOURCES = ['auto', 'resources', 'screencast'] as const;
export type TraceFrameSource = (typeof TRACE_FRAME_SOURCES)[number];
export const DEFAULT_TRACE_FRAME_SOURCE: TraceFrameSource = 'auto';

/** One `<prefix>.trace` file, read; the input to `buildTraceReport`. */
export interface TraceContext {
	prefix: string;
	origin: 'library' | 'testRunner';
	version?: number;
	frameSource: TraceFrameSource;
	browserName?: string;
	playwrightVersion?: string;
	sdkLanguage?: string;
	title?: string;
	wallTime?: number;
	viewport?: { width: number; height: number };
	actions: Map<string, TraceAction>;
	events: TraceEvent[];
	frames: TraceFrame[];
	network: TraceRequest[];
	errors: TraceError[];
	stdio: TraceStdio[];
	/** From `<prefix>.stacks`, keyed by callId. */
	stacks: Map<string, TraceStackFrame[]>;
	warnings: string[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// The runner colours its error messages for the terminal; a board is not one.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Terminal colour codes removed — the runner writes its expect messages with them. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/** A value as a person would want to see it in a row: strings bare, the rest as JSON, capped. */
export function previewValue(value: unknown): string {
	let text: string;
	if (typeof value === 'string') {
		text = stripAnsi(value);
	} else if (value === undefined) {
		text = '';
	} else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	return text.length > PARAM_PREVIEW_CHARS ? `${text.slice(0, PARAM_PREVIEW_CHARS - 1)}…` : text;
}

function previewParams(value: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	if (!isRecord(value)) {
		return result;
	}
	let count = 0;
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined || key === 'info' || key === 'metadata') {
			continue;
		}
		result[key] = previewValue(item);
		if (++count >= 20) {
			break;
		}
	}
	return result;
}

/**
 * Reads one context: its `.trace` file — newline-delimited JSON, one event per
 * line — plus, when the archive has them, the matching `.stacks` file and the
 * `.network` file (the same grammar, holding only `resource-snapshot` events,
 * and on this context's clock, which is why it is read here and not as a
 * context of its own). `frameSource` is `tests.traceFrames`. Never throws.
 */
export function parseTraceContext(
	text: string,
	prefix: string,
	sidecars: { stacks?: string; network?: string } = {},
	frameSource: TraceFrameSource = DEFAULT_TRACE_FRAME_SOURCE
): TraceContext {
	const context: TraceContext = {
		prefix,
		origin: 'library',
		frameSource,
		actions: new Map(),
		events: [],
		frames: [],
		network: [],
		errors: [],
		stdio: [],
		stacks: sidecars.stacks === undefined ? new Map() : parseStacks(sidecars.stacks),
		warnings: []
	};
	readLines(context, text, `${prefix}.trace`);
	if (sidecars.network !== undefined) {
		readLines(context, sidecars.network, `${prefix}.network`);
	}
	return context;
}

function readLines(context: TraceContext, text: string, fileName: string): void {
	let broken = 0;
	let orphans = 0;
	let dropped = 0;
	let synthetic = 0;
	let position = 0;
	while (position < text.length) {
		let end = text.indexOf('\n', position);
		if (end === -1) {
			end = text.length;
		}
		const line = text.slice(position, end);
		position = end + 1;
		if (line.trim().length === 0) {
			continue;
		}
		// Snapshots are the bulk of a trace and nothing here reads them; the
		// recorder writes `type` first, so they are dropped without a parse.
		if (line.startsWith('{"type":"frame-snapshot"')) {
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			broken++;
			continue;
		}
		if (!isRecord(event)) {
			broken++;
			continue;
		}
		switch (event.type) {
			case 'context-options':
				readContextOptions(context, event);
				break;
			case 'before': {
				if (context.actions.size >= MAX_TRACE_ACTIONS) {
					dropped++;
					break;
				}
				const callId = asString(event.callId) ?? `synthetic@${fileName}#${++synthetic}`;
				context.actions.set(callId, readBefore(event, callId, context));
				break;
			}
			case 'input': {
				const action = context.actions.get(asString(event.callId) ?? '');
				const point = readPoint(event.point);
				if (action && point) {
					action.point = point;
				}
				break;
			}
			case 'log': {
				const action = context.actions.get(asString(event.callId) ?? '');
				if (action) {
					action.log.push({ time: asNumber(event.time) ?? action.startTime, message: previewValue(event.message) });
				}
				break;
			}
			case 'after': {
				const action = context.actions.get(asString(event.callId) ?? '');
				if (!action) {
					orphans++;
					break;
				}
				readAfter(action, event);
				break;
			}
			case 'action': {
				// The single-event shape of format 5 and older.
				if (context.actions.size >= MAX_TRACE_ACTIONS) {
					dropped++;
					break;
				}
				const callId = asString(event.callId) ?? `synthetic@${fileName}#${++synthetic}`;
				const action = readBefore(event, callId, context);
				readAfter(action, event);
				if (Array.isArray(event.log)) {
					for (const message of event.log) {
						action.log.push({ time: action.startTime, message: previewValue(message) });
					}
				}
				context.actions.set(callId, action);
				break;
			}
			case 'console':
				context.events.push(readConsole(event, asString(event.messageType) ?? 'log', event));
				break;
			case 'event':
				readBrowserEvent(context, event);
				break;
			case 'screencast-frame': {
				const frame = readFrame(event, context);
				if (frame) {
					context.frames.push(frame);
				}
				break;
			}
			case 'resource-snapshot': {
				const request = readResource(event, context.network.length);
				if (request) {
					context.network.push(request);
				}
				break;
			}
			case 'error': {
				const message = asString(event.message);
				if (message !== undefined) {
					const error: TraceError = { message: stripAnsi(message) };
					const stack = readStackFrames(event.stack);
					if (stack) {
						error.stack = stack;
					}
					context.errors.push(error);
				}
				break;
			}
			case 'stdout':
			case 'stderr': {
				const decoded = readStdio(event);
				if (decoded !== undefined) {
					context.stdio.push({
						channel: event.type,
						time: asNumber(event.timestamp) ?? 0,
						text: decoded
					});
				}
				break;
			}
			default:
				// `frame-snapshot` that did not start the line, `input`s for calls
				// we never saw, and whatever a newer format adds.
				break;
		}
	}
	if (broken > 0) {
		context.warnings.push(`${broken} ${broken === 1 ? 'line' : 'lines'} of ${fileName} could not be read.`);
	}
	if (orphans > 0) {
		context.warnings.push(`${orphans} ${orphans === 1 ? 'call' : 'calls'} ended without a recorded start.`);
	}
	if (dropped > 0) {
		context.warnings.push(
			`The trace has more than ${MAX_TRACE_ACTIONS} actions; ${dropped} were not read. Open it in Playwright's viewer for all of them.`
		);
	}
}

function readContextOptions(context: TraceContext, event: Json): void {
	context.origin = event.origin === 'testRunner' ? 'testRunner' : 'library';
	context.version = asNumber(event.version);
	if (context.version !== undefined && context.version > KNOWN_TRACE_VERSION) {
		context.warnings.push(
			`This trace is format ${context.version}, newer than BFAST knows (${KNOWN_TRACE_VERSION}); what it shows may be incomplete.`
		);
	}
	context.browserName = asString(event.browserName) ?? context.browserName;
	context.playwrightVersion = asString(event.playwrightVersion) ?? context.playwrightVersion;
	context.sdkLanguage = asString(event.sdkLanguage) ?? context.sdkLanguage;
	context.title = asString(event.title) ?? context.title;
	context.wallTime = asNumber(event.wallTime) ?? context.wallTime;
	const options = isRecord(event.options) ? event.options : undefined;
	const viewport = options && isRecord(options.viewport) ? options.viewport : undefined;
	const width = viewport ? asNumber(viewport.width) : undefined;
	const height = viewport ? asNumber(viewport.height) : undefined;
	if (width !== undefined && height !== undefined) {
		context.viewport = { width, height };
	}
}

function readBefore(event: Json, callId: string, context: TraceContext): TraceAction {
	const className = asString(event.class) ?? '';
	const method = asString(event.method) ?? '';
	const params = previewParams(event.params);
	const stack = readStackFrames(event.stack) ?? context.stacks.get(callId);
	const action: TraceAction = {
		callId,
		depth: 0,
		origin: context.origin,
		title: asString(event.title) ?? asString(event.apiName) ?? readableCall(className, method),
		class: className,
		method,
		params,
		startTime: asNumber(event.startTime) ?? 0,
		unfinished: true,
		log: []
	};
	const parentId = asString(event.parentId);
	if (parentId !== undefined) {
		action.parentId = parentId;
	}
	const stepId = asString(event.stepId);
	if (stepId !== undefined) {
		action.stepId = stepId;
	}
	const pageId = asString(event.pageId);
	if (pageId !== undefined) {
		action.pageId = pageId;
	}
	if (stack && stack.length > 0) {
		action.stack = stack;
	}
	return action;
}

function readAfter(action: TraceAction, event: Json): void {
	const endTime = asNumber(event.endTime);
	if (endTime !== undefined) {
		action.endTime = endTime;
		action.unfinished = false;
	}
	if (isRecord(event.error)) {
		const message = stripAnsi(asString(event.error.message) ?? asString(event.error.name) ?? 'Error');
		const stack = asString(event.error.stack);
		action.error = stack !== undefined ? { message, stack: stripAnsi(stack) } : { message };
	} else if (typeof event.error === 'string') {
		action.error = { message: stripAnsi(event.error) };
	}
	const point = readPoint(event.point);
	if (point) {
		action.point = point;
	}
	if (Array.isArray(event.attachments)) {
		const attachments: { name: string; contentType: string }[] = [];
		for (const item of event.attachments) {
			if (isRecord(item)) {
				attachments.push({
					name: asString(item.name) ?? 'attachment',
					contentType: asString(item.contentType) ?? 'application/octet-stream'
				});
			}
		}
		if (attachments.length > 0) {
			action.attachments = attachments;
		}
	}
}

function readPoint(value: unknown): { x: number; y: number } | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const x = asNumber(value.x);
	const y = asNumber(value.y);
	return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function readConsole(event: Json, level: string, source: Json): TraceEvent {
	const text = stripAnsi(asString(source.text) ?? previewArgs(source.args));
	const location = isRecord(source.location) ? source.location : undefined;
	const url = location ? asString(location.url) : undefined;
	const result: TraceEvent = {
		kind: 'console',
		time: asNumber(event.time) ?? 0,
		level,
		text
	};
	const pageId = asString(event.pageId);
	if (pageId !== undefined) {
		result.pageId = pageId;
	}
	if (url !== undefined && location) {
		result.location = {
			url,
			line: asNumber(location.lineNumber) ?? 0,
			column: asNumber(location.columnNumber) ?? 0
		};
	}
	return result;
}

function previewArgs(value: unknown): string {
	if (!Array.isArray(value)) {
		return '';
	}
	return value
		.map((item) => (isRecord(item) ? asString(item.preview) ?? previewValue(item.value) : previewValue(item)))
		.join(' ');
}

function readBrowserEvent(context: TraceContext, event: Json): void {
	const method = asString(event.method) ?? '';
	const params = isRecord(event.params) ? event.params : {};
	const time = asNumber(event.time) ?? 0;
	const pageId = asString(event.pageId) ?? asString(params.pageId);
	const withPage = <T extends TraceEvent>(item: T): T => (pageId !== undefined ? { ...item, pageId } : item);
	switch (method) {
		case 'console':
			// Formats before 7 wrote console messages as browser events.
			context.events.push(withPage(readConsole(event, asString(params.type) ?? 'log', params)));
			break;
		case 'pageError': {
			const error = isRecord(params.error) ? params.error : params;
			const message = asString(error.message) ?? asString(error.name) ?? 'Page error';
			const stack = asString(error.stack);
			context.events.push(withPage(stack !== undefined ? { kind: 'pageerror', time, message, stack } : { kind: 'pageerror', time, message }));
			break;
		}
		case 'dialog': {
			const type = asString(params.type) ?? 'dialog';
			const message = asString(params.message);
			context.events.push(withPage({ kind: 'dialog', time, text: message !== undefined ? `${type}: ${message}` : type }));
			break;
		}
		case 'download':
			context.events.push(
				withPage({
					kind: 'download',
					time,
					text: asString(params.suggestedFilename) ?? asString(params.url) ?? 'download'
				})
			);
			break;
		case 'page':
			context.events.push(withPage({ kind: 'page', time, text: 'Page opened' }));
			break;
		case 'pageClosed':
			context.events.push(withPage({ kind: 'pageClosed', time, text: 'Page closed' }));
			break;
		default:
			break;
	}
}

function readFrame(event: Json, context: TraceContext): TraceFrame | undefined {
	const location = frameLocation(event, context.version, context.frameSource);
	const pageId = asString(event.pageId);
	const timestamp = asNumber(event.timestamp);
	if (location === undefined || pageId === undefined || timestamp === undefined) {
		return undefined;
	}
	return {
		...location,
		pageId,
		timestamp,
		width: asNumber(event.width) ?? 0,
		height: asNumber(event.height) ?? 0
	};
}

/**
 * Where a `screencast-frame`'s image is in the archive. Up to format 8 the
 * event names it by `sha1` and the image is `resources/<sha1>`; from format 9
 * it gives the image's own path as `file` (`screencast/page@…-<time>.jpeg`)
 * and there is no `sha1`. `auto` goes by the context's format, and takes the
 * other field when the expected one is missing — a format the reader does not
 * know yet, or a trace from a build in between. `resources` and `screencast`
 * read only their own field, for a trace whose format number cannot be
 * trusted. `undefined` when the event names no image this way.
 */
export function frameLocation(
	event: Record<string, unknown>,
	version: number | undefined,
	source: TraceFrameSource
): { name: string; entry: string } | undefined {
	const sha1 = asString(event.sha1);
	const file = asString(event.file);
	const inResources = sha1 === undefined ? undefined : { name: sha1, entry: `resources/${sha1}` };
	const inScreencast = file === undefined ? undefined : { name: file.slice(file.lastIndexOf('/') + 1), entry: file };
	switch (source) {
		case 'resources':
			return inResources;
		case 'screencast':
			return inScreencast;
		case 'auto':
			return version !== undefined && version >= FIRST_SCREENCAST_TRACE_VERSION
				? (inScreencast ?? inResources)
				: (inResources ?? inScreencast);
	}
}

function readResource(event: Json, index: number): TraceRequest | undefined {
	const snapshot = isRecord(event.snapshot) ? event.snapshot : undefined;
	if (!snapshot) {
		return undefined;
	}
	const request = isRecord(snapshot.request) ? snapshot.request : {};
	const response = isRecord(snapshot.response) ? snapshot.response : {};
	const content = isRecord(response.content) ? response.content : {};
	const url = asString(request.url);
	if (url === undefined) {
		return undefined;
	}
	const result: TraceRequest = {
		id: `request@${index}`,
		method: asString(request.method) ?? 'GET',
		url,
		startTime: asNumber(snapshot._monotonicTime) ?? 0
	};
	const pageId = asString(snapshot.pageref);
	if (pageId !== undefined) {
		result.pageId = pageId;
	}
	const status = asNumber(response.status);
	if (status !== undefined && status > 0) {
		result.status = status;
	}
	const statusText = asString(response.statusText);
	if (statusText) {
		result.statusText = statusText;
	}
	const mimeType = asString(content.mimeType);
	if (mimeType) {
		result.mimeType = mimeType;
	}
	const size = asNumber(content.size);
	if (size !== undefined && size >= 0) {
		result.size = size;
	}
	const transferSize = asNumber(response._transferSize);
	if (transferSize !== undefined && transferSize >= 0) {
		result.transferSize = transferSize;
	}
	const duration = asNumber(snapshot.time);
	if (duration !== undefined && duration >= 0) {
		result.duration = duration;
	}
	return result;
}

function readStdio(event: Json): string | undefined {
	const text = asString(event.text);
	if (text !== undefined) {
		return stripAnsi(text);
	}
	const base64 = asString(event.base64);
	if (base64 !== undefined && typeof atob === 'function') {
		try {
			return stripAnsi(atob(base64));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function readStackFrames(value: unknown): TraceStackFrame[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const frames: TraceStackFrame[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			continue;
		}
		const file = asString(item.file);
		if (file === undefined) {
			continue;
		}
		const frame: TraceStackFrame = { file, line: asNumber(item.line) ?? 0, column: asNumber(item.column) ?? 0 };
		const fn = asString(item.function);
		if (fn) {
			frame.function = fn;
		}
		frames.push(frame);
	}
	return frames.length > 0 ? frames : undefined;
}

/**
 * `<prefix>.stacks`: `{ files: string[], stacks: [id, [[fileIndex, line, column, function?]…]][] }`,
 * keyed here as `call@<id>` — the callId the matching `before` carries.
 */
export function parseStacks(text: string): Map<string, TraceStackFrame[]> {
	const result = new Map<string, TraceStackFrame[]>();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return result;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.files) || !Array.isArray(parsed.stacks)) {
		return result;
	}
	const files = parsed.files.map((file) => (typeof file === 'string' ? file : ''));
	for (const entry of parsed.stacks) {
		if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
			continue;
		}
		const frames: TraceStackFrame[] = [];
		for (const raw of entry[1]) {
			if (!Array.isArray(raw)) {
				continue;
			}
			const file = files[asNumber(raw[0]) ?? -1];
			if (!file) {
				continue;
			}
			const frame: TraceStackFrame = { file, line: asNumber(raw[1]) ?? 0, column: asNumber(raw[2]) ?? 0 };
			const fn = asString(raw[3]);
			if (fn) {
				frame.function = fn;
			}
			frames.push(frame);
		}
		if (frames.length > 0) {
			result.set(`call@${String(entry[0])}`, frames);
		}
	}
	return result;
}

/** `Frame.click` → `click`; `BrowserContext.newPage` → `BrowserContext.newPage`. */
function readableCall(className: string, method: string): string {
	if (method === '') {
		return className || 'call';
	}
	if (['Frame', 'Page', 'ElementHandle', 'Locator', 'FrameLocator'].includes(className) || className === '') {
		return method;
	}
	return `${className}.${method}`;
}

/**
 * Joins the contexts of one archive into the report. The library's clock is
 * shifted onto the runner's by the first step that names a library call
 * (`delta`), that call takes the step's error, attachments, parent and times,
 * and the step itself is dropped; unmatched runner steps stay, on their own
 * clock, which is now the shared one.
 */
export function buildTraceReport(contexts: TraceContext[]): TraceReport {
	const warnings: string[] = [];
	const libraries = contexts.filter((context) => context.origin === 'library');
	const runners = contexts.filter((context) => context.origin === 'testRunner');
	for (const context of contexts) {
		warnings.push(...context.warnings);
	}

	// Library calls by the step that made them.
	const byStep = new Map<string, TraceAction>();
	for (const library of libraries) {
		for (const action of library.actions.values()) {
			if (action.stepId !== undefined && !byStep.has(action.stepId)) {
				byStep.set(action.stepId, action);
			}
		}
	}

	// Align the clocks on the first matched pair, per library context.
	const deltas = new Map<TraceContext, number>();
	for (const library of libraries) {
		let delta = 0;
		outer: for (const runner of runners) {
			for (const step of runner.actions.values()) {
				const call = byStep.get(step.callId);
				if (call && library.actions.get(call.callId) === call) {
					delta = step.startTime - call.startTime;
					break outer;
				}
			}
		}
		deltas.set(library, delta);
	}

	const actions: TraceAction[] = [];
	const events: TraceEvent[] = [];
	const frames: TraceFrame[] = [];
	const network: TraceRequest[] = [];
	const errors: TraceError[] = [];
	const stdio: TraceStdio[] = [];
	for (const library of libraries) {
		const delta = deltas.get(library) ?? 0;
		for (const action of library.actions.values()) {
			actions.push(shiftAction(action, delta));
		}
		events.push(...library.events.map((event) => ({ ...event, time: event.time + delta })));
		frames.push(...library.frames.map((frame) => ({ ...frame, timestamp: frame.timestamp + delta })));
		network.push(...library.network.map((request) => ({ ...request, startTime: request.startTime + delta })));
		errors.push(...library.errors);
		stdio.push(...library.stdio.map((line) => ({ ...line, time: line.time + delta })));
	}
	const merged = new Map(actions.map((action) => [action.callId, action] as const));
	const folded = new Map<string, string>();
	for (const runner of runners) {
		for (const step of runner.actions.values()) {
			const call = merged.get(byStep.get(step.callId)?.callId ?? '');
			if (call) {
				call.error = call.error ?? step.error;
				call.attachments = call.attachments ?? step.attachments;
				call.stack = call.stack ?? step.stack;
				if (step.parentId !== undefined) {
					call.parentId = step.parentId;
				}
				// A step opens before its call and closes after it.
				call.startTime = step.startTime;
				if (step.endTime !== undefined) {
					call.endTime = step.endTime;
					call.unfinished = false;
				}
				if (step.title && call.title === readableCall(call.class, call.method)) {
					call.title = step.title;
				}
				folded.set(step.callId, call.callId);
				continue;
			}
			merged.set(step.callId, step);
			actions.push(step);
		}
		events.push(...runner.events);
		frames.push(...runner.frames);
		network.push(...runner.network);
		errors.push(...runner.errors);
		stdio.push(...runner.stdio);
	}
	// A child of a folded step now hangs under the call it folded into.
	for (const action of actions) {
		if (action.parentId !== undefined) {
			const target = folded.get(action.parentId);
			if (target !== undefined) {
				action.parentId = target;
			}
			if (!merged.has(action.parentId)) {
				delete action.parentId;
			}
		}
	}

	// A call the trace ended inside takes its children's end, where it has any.
	const children = new Map<string, TraceAction[]>();
	for (const action of actions) {
		if (action.parentId !== undefined) {
			const list = children.get(action.parentId) ?? [];
			list.push(action);
			children.set(action.parentId, list);
		}
	}
	for (const action of actions) {
		if (action.endTime === undefined) {
			let end: number | undefined;
			for (const child of children.get(action.callId) ?? []) {
				if (child.endTime !== undefined && (end === undefined || child.endTime > end)) {
					end = child.endTime;
				}
			}
			if (end !== undefined) {
				action.endTime = end;
			}
		}
	}

	// Depth-first in start order, a parent before its children; a cycle in
	// `parentId` (a damaged trace) is broken rather than followed.
	const byStart = (a: TraceAction, b: TraceAction): number => a.startTime - b.startTime;
	const ordered: TraceAction[] = [];
	const visited = new Set<string>();
	const visit = (action: TraceAction, depth: number): void => {
		if (visited.has(action.callId)) {
			return;
		}
		visited.add(action.callId);
		action.depth = depth;
		ordered.push(action);
		for (const child of (children.get(action.callId) ?? []).sort(byStart)) {
			visit(child, depth + 1);
		}
	};
	for (const root of actions.filter((action) => action.parentId === undefined).sort(byStart)) {
		visit(root, 0);
	}
	for (const action of actions.sort(byStart)) {
		// Whatever a cycle kept out.
		visit(action, 0);
	}

	// An action's error joins the list unless the runner already reported it —
	// by the same message, or from the same line: the runner's `error` event
	// carries the full expect message where the call carries "Expect failed".
	const location = (stack: TraceStackFrame[] | undefined): string | undefined =>
		stack && stack.length > 0 ? `${stack[0].file}:${stack[0].line}:${stack[0].column}` : undefined;
	for (const action of ordered) {
		if (!action.error) {
			continue;
		}
		const at = location(action.stack);
		const known = errors.some(
			(error) => error.message === action.error?.message || (at !== undefined && location(error.stack) === at)
		);
		if (!known) {
			const error: TraceError = { message: action.error.message, callId: action.callId };
			if (action.stack) {
				error.stack = action.stack;
			}
			errors.push(error);
		}
	}

	events.sort((a, b) => a.time - b.time);
	frames.sort((a, b) => a.timestamp - b.timestamp);
	network.sort((a, b) => a.startTime - b.startTime);
	stdio.sort((a, b) => a.time - b.time);

	const pagesById = new Map<string, TracePage>();
	for (const frame of frames) {
		const page = pagesById.get(frame.pageId) ?? { id: frame.pageId, frames: [] };
		page.frames.push(frame);
		pagesById.set(frame.pageId, page);
	}

	// Real files only: the runner also names pseudo-locations (`project#`)
	// for fixtures declared in the config, which no editor can open.
	const sources = new Set<string>();
	const isPath = (file: string): boolean => /[\\/]/.test(file);
	for (const action of ordered) {
		for (const frame of action.stack ?? []) {
			if (isPath(frame.file)) {
				sources.add(frame.file);
			}
		}
	}
	for (const error of errors) {
		for (const frame of error.stack ?? []) {
			if (isPath(frame.file)) {
				sources.add(frame.file);
			}
		}
	}

	let startTime = Number.POSITIVE_INFINITY;
	let endTime = Number.NEGATIVE_INFINITY;
	const span = (time: number | undefined): void => {
		if (time !== undefined) {
			startTime = Math.min(startTime, time);
			endTime = Math.max(endTime, time);
		}
	};
	for (const action of ordered) {
		span(action.startTime);
		span(action.endTime);
	}
	for (const frame of frames) {
		span(frame.timestamp);
	}
	for (const event of events) {
		span(event.time);
	}
	if (!Number.isFinite(startTime)) {
		startTime = 0;
		endTime = 0;
	}

	const primary = runners[0] ?? libraries[0];
	const library = libraries[0];
	const report: TraceReport = {
		startTime,
		endTime,
		pages: [...pagesById.values()],
		actions: ordered,
		events,
		errors,
		network,
		stdio,
		sources: [...sources].sort(),
		frameCount: frames.length,
		warnings
	};
	const version = primary?.version ?? library?.version;
	if (version !== undefined) {
		report.version = version;
	}
	const browserName = library?.browserName ?? primary?.browserName;
	if (browserName !== undefined) {
		report.browserName = browserName;
	}
	const playwrightVersion = primary?.playwrightVersion ?? library?.playwrightVersion;
	if (playwrightVersion !== undefined) {
		report.playwrightVersion = playwrightVersion;
	}
	const sdkLanguage = primary?.sdkLanguage ?? library?.sdkLanguage;
	if (sdkLanguage !== undefined) {
		report.sdkLanguage = sdkLanguage;
	}
	const title = runners.map((runner) => runner.title).find((value) => value !== undefined) ?? library?.title;
	if (title !== undefined) {
		report.title = title;
	}
	const wallTime = primary?.wallTime ?? library?.wallTime;
	if (wallTime !== undefined) {
		report.wallTime = wallTime;
	}
	const viewport = library?.viewport ?? primary?.viewport;
	if (viewport !== undefined) {
		report.viewport = viewport;
	}
	return report;
}

function shiftAction(action: TraceAction, delta: number): TraceAction {
	if (delta === 0) {
		return action;
	}
	const shifted: TraceAction = {
		...action,
		startTime: action.startTime + delta,
		log: action.log.map((line) => ({ ...line, time: line.time + delta }))
	};
	if (action.endTime !== undefined) {
		shifted.endTime = action.endTime + delta;
	}
	return shifted;
}

/** Whether `candidate` sits under `ancestor` in the report's tree. */
function isDescendant(report: TraceReport, candidate: TraceAction, ancestor: TraceAction): boolean {
	const byId = new Map(report.actions.map((action) => [action.callId, action] as const));
	let current: TraceAction | undefined = candidate;
	const seen = new Set<string>();
	while (current?.parentId !== undefined && !seen.has(current.callId)) {
		seen.add(current.callId);
		if (current.parentId === ancestor.callId) {
			return true;
		}
		current = byId.get(current.parentId);
	}
	return false;
}

/**
 * The span an action owns for the console, the network and the frames: from
 * its start to the start of the next action that is not inside it and not a
 * route handler (Playwright's `eventsForAction` rule, with the nesting taken
 * into account so a step's window is not ended by its own first child). The
 * last action's window runs to its end, or on for ever if it has none.
 */
export function windowFor(report: TraceReport, action: TraceAction): { start: number; end: number } {
	const index = report.actions.indexOf(action);
	for (let next = index + 1; next < report.actions.length; next++) {
		const candidate = report.actions[next];
		if (candidate.class === 'Route' || isDescendant(report, candidate, action)) {
			continue;
		}
		return { start: action.startTime, end: candidate.startTime };
	}
	return { start: action.startTime, end: action.endTime ?? Number.POSITIVE_INFINITY };
}

/** The events in an action's window; every event when there is no action. */
export function eventsFor(report: TraceReport, action?: TraceAction): TraceEvent[] {
	if (!action) {
		return report.events;
	}
	const { start, end } = windowFor(report, action);
	return report.events.filter((event) => event.time >= start && event.time < end);
}

/** The requests started in an action's window; every request when there is no action. */
export function requestsFor(report: TraceReport, action?: TraceAction): TraceRequest[] {
	if (!action) {
		return report.network;
	}
	const { start, end } = windowFor(report, action);
	return report.network.filter((request) => request.startTime >= start && request.startTime < end);
}

/**
 * The page an action's screenshots come from: its own when it has frames,
 * else the page most recently drawn before it started, else the first.
 */
export function pageFor(report: TraceReport, action: TraceAction): TracePage | undefined {
	const own = action.pageId !== undefined ? report.pages.find((page) => page.id === action.pageId) : undefined;
	if (own && own.frames.length > 0) {
		return own;
	}
	let best: TracePage | undefined;
	let bestTime = Number.NEGATIVE_INFINITY;
	for (const page of report.pages) {
		const frame = lastFrameAtOrBefore(page.frames, action.startTime);
		if (frame && frame.timestamp > bestTime) {
			best = page;
			bestTime = frame.timestamp;
		}
	}
	return best ?? report.pages.find((page) => page.frames.length > 0);
}

function lastFrameAtOrBefore(frames: TraceFrame[], time: number): TraceFrame | undefined {
	let low = 0;
	let high = frames.length - 1;
	let found: TraceFrame | undefined;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (frames[middle].timestamp <= time) {
			found = frames[middle];
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return found;
}

/** The last frame drawn at or before the action started; the first frame when none was, marked so. */
export function frameBefore(
	report: TraceReport,
	action: TraceAction
): { frame: TraceFrame; closest: boolean } | undefined {
	const page = pageFor(report, action);
	if (!page || page.frames.length === 0) {
		return undefined;
	}
	const frame = lastFrameAtOrBefore(page.frames, action.startTime);
	return frame ? { frame, closest: false } : { frame: page.frames[0], closest: true };
}

/** The last frame drawn at or before the action ended — or, for an unfinished one, before the next began. */
export function frameAfter(
	report: TraceReport,
	action: TraceAction
): { frame: TraceFrame; closest: boolean } | undefined {
	const page = pageFor(report, action);
	if (!page || page.frames.length === 0) {
		return undefined;
	}
	const end = action.endTime ?? windowFor(report, action).end;
	const frame = lastFrameAtOrBefore(page.frames, Number.isFinite(end) ? end : Number.POSITIVE_INFINITY);
	return frame ? { frame, closest: false } : { frame: page.frames[0], closest: true };
}

/** The filmstrip: the busiest page's frames, thinned evenly to at most `max`, the last one always kept. */
export function filmstripFrames(report: TraceReport, max = MAX_FILMSTRIP_FRAMES): TraceFrame[] {
	let page: TracePage | undefined;
	for (const candidate of report.pages) {
		if (!page || candidate.frames.length > page.frames.length) {
			page = candidate;
		}
	}
	if (!page || page.frames.length === 0 || max <= 0) {
		return [];
	}
	const frames = page.frames;
	if (frames.length <= max) {
		return frames;
	}
	const result: TraceFrame[] = [];
	for (let index = 0; index < max; index++) {
		result.push(frames[Math.floor((index * (frames.length - 1)) / (max - 1))]);
	}
	return result;
}

/** The action whose window holds `time` — the deepest one, so a click on the filmstrip lands on a step's child, not the step. */
export function actionAt(report: TraceReport, time: number): TraceAction | undefined {
	let best: TraceAction | undefined;
	for (const action of report.actions) {
		const { start, end } = windowFor(report, action);
		if (time >= start && time < end && (!best || action.depth >= best.depth)) {
			best = action;
		}
	}
	return best;
}

/** `+1.234s` from the trace's start; `0.000s` at it. */
export function formatTraceTime(time: number, startTime: number): string {
	const seconds = Math.max(0, time - startTime) / 1000;
	return `${seconds.toFixed(seconds >= 100 ? 0 : seconds >= 10 ? 1 : 3)}s`;
}

/** `312ms`, `1.4s`, `2m 05s`. */
export function formatTraceDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** The one param worth a row's width: the selector, the url, the key… */
export function actionDetail(action: TraceAction): string | undefined {
	for (const key of ['selector', 'url', 'key', 'text', 'value', 'expression', 'name', 'expected', 'path']) {
		const value = action.params[key];
		if (value !== undefined && value !== '') {
			return value;
		}
	}
	return undefined;
}
