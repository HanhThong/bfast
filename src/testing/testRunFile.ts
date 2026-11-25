// `run.json` — the record a test run leaves in its run folder under the
// results store (`testResultsStore.ts`), beside `output.log` and the files
// copied for it. Pure: the store reads and writes the bytes, this module says
// what they mean.
//
// Reading is forgiving, the tracker's rule: the results folder may be pulled
// from git and a folder may have been made by hand, so a missing or malformed file still
// lists the folder — as outcome `unknown`, with whatever files are actually in
// it. **The directory listing is authoritative**: `run.json` only annotates
// names that exist on disk (their size), and a name it lists that is not there
// is kept only as `missing`, never turned into a url. That is what stops a
// crafted name in a pulled file from reaching a `<video src>`.

import { isSafeEvidenceSegment } from '../shared/evidencePath';
import type { TestRunFile, TestRunOutcome, TestRunRecord } from '../data/types';

export const RUN_FILE = 'run.json';
export const OUTPUT_FILE = 'output.log';

/** The run's folder name: its start time, with `:` (illegal on Windows) as `-`. */
export function runIdFor(startedAt: string): string {
	return startedAt.replace(/:/g, '-');
}

/** The inverse, for a folder whose `run.json` is gone. `undefined` when it is not a time. */
export function startedAtFromRunId(id: string): string | undefined {
	const candidate = id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)/, '$1T$2:$3:$4');
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(candidate) &&
		!Number.isNaN(Date.parse(candidate))
		? candidate
		: undefined;
}

/**
 * One finished run of a test case, as the runner hands it to
 * `TestResultsStore.addRun`. `files` are absolute paths to copy in; one that
 * has vanished since it was found is skipped and named in the record's
 * warnings, never fatal.
 */
export interface NewTestRun {
	startedAt: string;
	finishedAt: string;
	outcome: Exclude<TestRunOutcome, 'unknown'>;
	exitCode?: number | null;
	/** The rendered command line. */
	command: string;
	/** The interleaved stdout+stderr tail; becomes `output.log`. */
	output: string;
	outputTruncated?: boolean;
	/** The rendered pattern, when one was configured. */
	evidencePattern?: string;
	files: string[];
	warnings?: string[];
}

/** One entry of a run folder's listing, as the store reads it. */
export interface RunFolderEntry {
	name: string;
	kind: 'file' | 'directory' | 'symlink' | 'other';
	size?: number;
}

/** What `addTestRun` hands `serializeTestRun`: the record minus what disk decides. */
export type NewTestRunRecord = Omit<TestRunRecord, 'id' | 'hasOutput' | 'files'> & {
	files: TestRunFile[];
};

const OUTCOMES: readonly TestRunOutcome[] = ['passed', 'failed', 'timeout', 'unknown'];

/**
 * The record for one run folder. Never throws: every field of a bad `run.json`
 * falls back on its own, and the listing decides which files exist.
 */
export function parseTestRun(
	text: string | undefined,
	folderName: string,
	entries: readonly RunFolderEntry[]
): TestRunRecord {
	const json = readJson(text);

	const onDisk = new Map<string, RunFolderEntry>();
	for (const entry of entries) {
		// Symlinks are never evidence: following one could leave the ticket folder.
		if (entry.kind === 'file' && entry.name !== RUN_FILE && entry.name !== OUTPUT_FILE) {
			onDisk.set(entry.name, entry);
		}
	}

	const files: TestRunFile[] = [...onDisk.values()]
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
		.map((entry) => ({ name: entry.name, ...(entry.size !== undefined ? { size: entry.size } : {}) }));

	// Named by the record but gone from disk: kept so the board can say so, and
	// only with a name BFAST itself could have written.
	for (const listed of readFiles(json)) {
		if (!onDisk.has(listed.name) && isSafeEvidenceSegment(listed.name)) {
			files.push({ ...listed, missing: true });
		}
	}

	const startedAt = readString(json, 'startedAt') ?? startedAtFromRunId(folderName);
	const outcome = readString(json, 'outcome');

	return {
		id: folderName,
		...(startedAt !== undefined ? { startedAt } : {}),
		...optional('finishedAt', readString(json, 'finishedAt')),
		outcome: json && OUTCOMES.includes(outcome as TestRunOutcome) ? (outcome as TestRunOutcome) : 'unknown',
		...optional('exitCode', readExitCode(json)),
		...optional('command', readString(json, 'command')),
		...optional('author', readString(json, 'author')),
		...optional('evidencePattern', readString(json, 'evidencePattern')),
		files,
		hasOutput: entries.some((entry) => entry.kind === 'file' && entry.name === OUTPUT_FILE),
		...(json?.outputTruncated === true ? { outputTruncated: true } : {}),
		...optional('warnings', readStrings(json, 'warnings'))
	};
}

/** Pretty, with a trailing newline — a file people will read in a diff. */
export function serializeTestRun(record: NewTestRunRecord): string {
	const json = {
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		outcome: record.outcome,
		exitCode: record.exitCode ?? null,
		author: record.author,
		command: record.command,
		evidencePattern: record.evidencePattern,
		files: record.files.map((file) => ({ name: file.name, size: file.size })),
		outputTruncated: record.outputTruncated ?? false,
		warnings: record.warnings ?? []
	};
	return `${JSON.stringify(json, null, 2)}\n`;
}

type Json = Record<string, unknown>;

function readJson(text: string | undefined): Json | undefined {
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Json)
			: undefined;
	} catch {
		return undefined;
	}
}

function readString(json: Json | undefined, key: string): string | undefined {
	const value = json?.[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readStrings(json: Json | undefined, key: string): string[] | undefined {
	const value = json?.[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((item): item is string => typeof item === 'string');
	return strings.length > 0 ? strings : undefined;
}

function readExitCode(json: Json | undefined): number | null | undefined {
	const value = json?.exitCode;
	if (value === null) {
		return null;
	}
	return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readFiles(json: Json | undefined): TestRunFile[] {
	const value = json?.files;
	if (!Array.isArray(value)) {
		return [];
	}
	const files: TestRunFile[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) {
			continue;
		}
		const name = (item as Json).name;
		const size = (item as Json).size;
		if (typeof name === 'string' && name !== '') {
			files.push({ name, ...(typeof size === 'number' && size >= 0 ? { size } : {}) });
		}
	}
	return files;
}

/** `{ key: value }` for a defined value, `{}` otherwise, so it spreads into a literal. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
