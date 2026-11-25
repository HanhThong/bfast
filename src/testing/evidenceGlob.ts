// Finds the files a `tests.evidence` pattern names for one test case.
//
// Hand-rolled rather than a dependency or `fs.promises.glob`, for the reason
// `yaml.ts` is: the grammar is three characters (`**` spans folders, `*` and
// `?` match within a name — everything else is literal, so `TC-1.1.*` cannot
// match `TC-1.10.webm`), and a walker of its own can refuse what a general one
// would not: it never follows a symbolic link, never enters `node_modules` or a
// dot-folder unless the pattern names it, starts at the pattern's literal
// prefix rather than the working directory, and stops at a depth, a count and
// a cancel. `workspace.findFiles` was the alternative, and its treatment of
// `.gitignore` is undocumented — the reference workspace gitignores exactly
// the folder the evidence is in.
//
// No `vscode` import: injected into the runner as `TestRunDeps.findEvidence`
// and driven by a test against a scratch tree.

import * as fs from 'fs/promises';
import * as path from 'path';
import { MAX_EVIDENCE_DEPTH, MAX_EVIDENCE_FILES } from './testReport';

export interface EvidenceMatch {
	/** Absolute. */
	path: string;
	size: number;
	mtimeMs: number;
}

export interface EvidenceSearch {
	/** Sorted: fewer path segments first, then names with numbers compared as numbers. */
	matches: EvidenceMatch[];
	/** The walk stopped at `maxFiles`; there were more. */
	truncated: boolean;
}

export interface FindEvidenceOptions {
	/** Checked between directory reads; a cancelled walk returns what it has. */
	isCancelled?: () => boolean;
	maxFiles?: number;
	maxDepth?: number;
}

/** The seam the runner takes; production is `findEvidence`, a test scripts one. */
export type EvidenceFinder = (
	root: string,
	pattern: string,
	options?: FindEvidenceOptions
) => Promise<EvidenceSearch>;

/** Folders the `**` walk never enters on its own. A pattern may still name them. */
const IMPLICIT_SKIP = (name: string): boolean => name === 'node_modules' || name.startsWith('.');

/**
 * Throws only for a pattern that must never be walked: absolute, or escaping
 * with `..`. The settings block refuses those on the way out and drops them on
 * the way in, so reaching here means a hand-edited file — and the runner turns
 * the throw into a warning on the run, never a rejection.
 */
export function normalizeEvidencePattern(pattern: string): string[] {
	let normalized = pattern.trim().replace(/\\/g, '/');
	while (normalized.startsWith('./')) {
		normalized = normalized.slice(2);
	}
	if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
		throw new Error(`The evidence pattern \`${pattern}\` is absolute; it must be relative to the working directory.`);
	}
	const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
	if (segments.includes('..')) {
		throw new Error(`The evidence pattern \`${pattern}\` leaves the working directory.`);
	}
	if (segments.length === 0) {
		throw new Error('The evidence pattern is empty.');
	}
	return segments;
}

const isGlob = (segment: string): boolean => /[*?]/.test(segment);

/** One segment to a matcher: `*` and `?` are the only special characters. */
function segmentMatcher(segment: string): (name: string) => boolean {
	if (!isGlob(segment)) {
		return (name) => name === segment;
	}
	const source = segment
		.split('')
		.map((char) => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
		.join('');
	const regex = new RegExp(`^${source}$`);
	return (name) => regex.test(name);
}

export const findEvidence: EvidenceFinder = async (root, pattern, options = {}) => {
	const segments = normalizeEvidencePattern(pattern);
	const maxFiles = options.maxFiles ?? MAX_EVIDENCE_FILES;
	const maxDepth = options.maxDepth ?? MAX_EVIDENCE_DEPTH;
	const cancelled = (): boolean => options.isCancelled?.() === true;

	// Anchor at the literal prefix, so `e2e/evidence/**/x.*` reads `e2e/evidence`
	// and nothing else — a `**` at the top would otherwise walk the whole tree.
	let anchorSegments = 0;
	while (anchorSegments < segments.length - 1 && !isGlob(segments[anchorSegments])) {
		anchorSegments++;
	}
	const anchor = path.join(root, ...segments.slice(0, anchorSegments));
	const rest = segments.slice(anchorSegments);

	const found: EvidenceMatch[] = [];
	let truncated = false;

	// The literal prefix is walked by name, so it gets the check the walk gives
	// every entry: a committed `e2e/evidence -> /elsewhere` must find nothing.
	for (let depth = 1; depth <= anchorSegments; depth++) {
		try {
			if ((await fs.lstat(path.join(root, ...segments.slice(0, depth)))).isSymbolicLink()) {
				return { matches: [], truncated: false };
			}
		} catch {
			return { matches: [], truncated: false };
		}
	}

	const readDir = async (dir: string) => {
		try {
			return await fs.readdir(dir, { withFileTypes: true });
		} catch {
			// Missing or unreadable: nothing here, which is a legal answer.
			return [];
		}
	};

	const collect = async (file: string): Promise<void> => {
		if (found.length >= maxFiles) {
			truncated = true;
			return;
		}
		try {
			const stat = await fs.lstat(file);
			if (stat.isFile()) {
				found.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
			}
		} catch {
			// Vanished between listing and stat — the reporter is still writing.
		}
	};

	const walk = async (dir: string, index: number, depth: number): Promise<void> => {
		if (cancelled() || truncated || depth > maxDepth) {
			return;
		}
		const segment = rest[index];
		const last = index === rest.length - 1;
		const entries = await readDir(dir);

		if (segment === '**') {
			// Zero folders: the rest of the pattern applies right here — and a
			// trailing `**` means every file below.
			if (!last) {
				await walk(dir, index + 1, depth);
			} else {
				for (const entry of entries) {
					if (!entry.isSymbolicLink() && entry.isFile()) {
						await collect(path.join(dir, entry.name));
					}
				}
			}
			for (const entry of entries) {
				if (entry.isSymbolicLink() || !entry.isDirectory() || IMPLICIT_SKIP(entry.name)) {
					continue;
				}
				await walk(path.join(dir, entry.name), index, depth + 1);
			}
			return;
		}

		const matches = segmentMatcher(segment);
		for (const entry of entries) {
			if (entry.isSymbolicLink() || !matches(entry.name)) {
				continue;
			}
			if (last) {
				if (entry.isFile()) {
					await collect(path.join(dir, entry.name));
				}
			} else if (entry.isDirectory()) {
				await walk(path.join(dir, entry.name), index + 1, depth + 1);
			}
		}
	};

	await walk(anchor, 0, 0);

	// Shallower first, then the plain name before its dotted variants (`TC-1.webm`
	// before `TC-1.page-2.webm`), then numbers as numbers — the order the board
	// lists them in too.
	found.sort((a, b) => {
		const ra = path.relative(anchor, a.path);
		const rb = path.relative(anchor, b.path);
		const bySegments = ra.split(path.sep).length - rb.split(path.sep).length;
		if (bySegments !== 0) {
			return bySegments;
		}
		const byParts = path.basename(ra).split('.').length - path.basename(rb).split('.').length;
		return byParts !== 0 ? byParts : ra.localeCompare(rb, undefined, { numeric: true });
	});

	return { matches: found, truncated };
};
