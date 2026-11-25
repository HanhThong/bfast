// The host's half of trace viewing: opens a `trace.zip` from the results
// store, reads every `<prefix>.trace` context in it (with its `.network` and
// `.stacks` sidecars) into one `TraceReport` for the board, and serves one
// screencast frame at a time as base64 — the `readEvidenceVideo` route, since
// the webview may only be posted json-serializable values and the CSP already
// takes `img-src data:`.
//
// Parsed archives are kept in a small LRU keyed on the file's identity
// (real path, size, mtime), so the frames a person clicks through cost one
// inflate each rather than a re-read of the zip; a `git pull` that replaces
// the file changes the key. Frames are served **only by a name the report
// listed** — the webview echoes names back, and this is the allow-list that
// keeps it from naming an arbitrary entry.

import * as fs from 'fs/promises';
import {
	buildTraceReport,
	DEFAULT_TRACE_FRAME_SOURCE,
	parseTraceContext,
	type TraceContext,
	type TraceFrameSource,
	type TraceReport
} from '../shared/playwrightTrace';
import { MAX_EVIDENCE_FILE_BYTES } from './testReport';
import { readZip, ZipError, type ZipArchive } from './zipFile';
import { errorMessage } from '../platform/errors';

/** The largest archive read; the runner never copies more than this anyway. */
export const MAX_TRACE_ZIP_BYTES = MAX_EVIDENCE_FILE_BYTES;
/** Most one entry may inflate to — a `trace.trace` with snapshots runs to tens of MB. */
export const MAX_INFLATED_ENTRY_BYTES = 256 * 1024 * 1024;
/** Parsed archives kept in memory. */
export const TRACE_CACHE_SIZE = 3;

export type TraceReadResult = { trace: TraceReport } | { error: string; notATrace?: boolean };
export type TraceFrameResult = { data: string; mime: string } | { error: string };

export interface TraceReader {
	/** The report for the archive at `path`, or why not. */
	readReport(path: string): Promise<TraceReadResult>;
	/** One screencast frame the report listed, as base64, or why not. */
	readFrame(path: string, name: string): Promise<TraceFrameResult>;
}

interface CachedTrace {
	key: string;
	archive: ZipArchive;
	report: TraceReport;
	/** Each frame the report listed, by name, and the entry its image is in. */
	frames: Map<string, string>;
}

export interface TraceReaderOptions {
	maxZipBytes?: number;
	maxEntryBytes?: number;
	cacheSize?: number;
	/** `tests.traceFrames`, read at every open so a saved setting applies to the next trace shown. */
	frameSource?: () => TraceFrameSource;
}

const TRACE_ENTRY = /^(.*)\.trace$/;

/** Whether an archive is a Playwright trace: at least one `<prefix>.trace` entry. */
export function tracePrefixes(archive: ZipArchive): string[] {
	const prefixes: string[] = [];
	for (const entry of archive.entries) {
		const match = TRACE_ENTRY.exec(entry.name);
		if (match && !entry.name.includes('/')) {
			prefixes.push(match[1]);
		}
	}
	return prefixes.sort();
}

export function createTraceReader(options: TraceReaderOptions = {}): TraceReader {
	const maxZipBytes = options.maxZipBytes ?? MAX_TRACE_ZIP_BYTES;
	const maxEntryBytes = options.maxEntryBytes ?? MAX_INFLATED_ENTRY_BYTES;
	const cacheSize = options.cacheSize ?? TRACE_CACHE_SIZE;
	const frameSource = options.frameSource ?? (() => DEFAULT_TRACE_FRAME_SOURCE);
	// Insertion order is recency: a hit is deleted and re-set.
	const cache = new Map<string, CachedTrace>();

	const load = async (path: string): Promise<CachedTrace | { error: string; notATrace?: boolean }> => {
		let real: string;
		let size: number;
		let mtimeMs: number;
		try {
			real = await fs.realpath(path);
			const stat = await fs.stat(real);
			size = stat.size;
			mtimeMs = stat.mtimeMs;
		} catch {
			return { error: 'The trace file could not be found.' };
		}
		const source = frameSource();
		// The source is part of the key: the same file read another way lists other frames.
		const key = `${real}|${size}|${mtimeMs}|${source}`;
		const hit = cache.get(real);
		if (hit && hit.key === key) {
			cache.delete(real);
			cache.set(real, hit);
			return hit;
		}
		if (size > maxZipBytes) {
			return {
				error: `The trace is ${(size / 1024 / 1024).toFixed(1)} MB, over what the board reads. Open it in Playwright's viewer.`
			};
		}
		let archive: ZipArchive;
		try {
			archive = readZip(await fs.readFile(real), { maxEntryBytes });
		} catch (error) {
			return {
				error: error instanceof ZipError ? error.message : errorMessage(error),
				notATrace: error instanceof ZipError
			};
		}
		const prefixes = tracePrefixes(archive);
		if (prefixes.length === 0) {
			return { error: 'This zip is not a Playwright trace: it has no `.trace` file.', notATrace: true };
		}
		const contexts: TraceContext[] = [];
		const warnings: string[] = [];
		for (const prefix of prefixes) {
			const text = readText(archive, `${prefix}.trace`, warnings);
			if (text === undefined) {
				continue;
			}
			const sidecars: { stacks?: string; network?: string } = {};
			const stacks = archive.has(`${prefix}.stacks`) ? readText(archive, `${prefix}.stacks`, warnings) : undefined;
			if (stacks !== undefined) {
				sidecars.stacks = stacks;
			}
			const network = archive.has(`${prefix}.network`) ? readText(archive, `${prefix}.network`, warnings) : undefined;
			if (network !== undefined) {
				sidecars.network = network;
			}
			contexts.push(parseTraceContext(text, prefix, sidecars, source));
		}
		if (contexts.length === 0) {
			return { error: warnings[0] ?? 'The trace could not be read.' };
		}
		const report = buildTraceReport(contexts);
		report.warnings.push(...warnings, ...archive.warnings);
		const frames = new Map<string, string>();
		for (const page of report.pages) {
			for (const frame of page.frames) {
				frames.set(frame.name, frame.entry);
			}
		}
		const entry: CachedTrace = { key, archive, report, frames };
		cache.set(real, entry);
		while (cache.size > cacheSize) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			cache.delete(oldest);
		}
		return entry;
	};

	return {
		async readReport(path) {
			const loaded = await load(path);
			return 'error' in loaded ? loaded : { trace: loaded.report };
		},
		async readFrame(path, name) {
			const loaded = await load(path);
			if ('error' in loaded) {
				return { error: loaded.error };
			}
			const entry = loaded.frames.get(name);
			if (entry === undefined) {
				return { error: `The trace has no frame named \`${name}\`.` };
			}
			try {
				const bytes = loaded.archive.read(entry);
				return { data: bytes.toString('base64'), mime: frameMime(name) };
			} catch (error) {
				return { error: errorMessage(error) };
			}
		}
	};
}

function readText(archive: ZipArchive, name: string, warnings: string[]): string | undefined {
	try {
		return archive.read(name).toString('utf8');
	} catch (error) {
		warnings.push(errorMessage(error));
		return undefined;
	}
}

/** Playwright writes screencast frames as JPEG; anything else is named by its extension. */
export function frameMime(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith('.png')) {
		return 'image/png';
	}
	if (lower.endsWith('.webp')) {
		return 'image/webp';
	}
	return 'image/jpeg';
}
