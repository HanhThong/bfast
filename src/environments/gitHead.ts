// The branch a checkout has out, read from `.git/HEAD` — never by spawning git.
//
// The master environment runs in the workspace itself, so its "branch" is
// whatever the working copy has checked out right now, and that moves under
// it. It is therefore read every time the environment is listed rather than
// recorded in the marker — and read from the file rather than through a
// `ProcessRunner`: `list()` runs every ten seconds while the section is
// visible, and one child process per tick for a label is the wrong trade.
// That is also why this is not in `gitWorktree.ts`, which is "git through a
// runner" and whose tests script argv.
//
// Best-effort by contract: `''` says "unknown" (detached HEAD, no repo, an
// unreadable file), never an exception — the tracker parsers' posture.

import { readFile, stat } from 'fs/promises';
import * as path from 'path';

export async function readCheckedOutBranch(repoRoot: string): Promise<string> {
	try {
		const gitDir = await findGitDir(repoRoot);
		if (!gitDir) {
			return '';
		}
		const head = await readFile(path.join(gitDir, 'HEAD'), 'utf8');
		// A detached HEAD is a bare object id, which does not match — and is
		// deliberately not reported: a hash is not a branch.
		return head.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)?.[1] ?? '';
	} catch {
		return '';
	}
}

/**
 * Walks up from `start` the way git does: the workspace folder need not be
 * the git toplevel (the worktree code already relies on that). `.git` may be
 * a *file* — a linked worktree or a submodule — holding `gitdir: <path>`,
 * relative to the folder that holds it; followed once.
 */
async function findGitDir(start: string): Promise<string | undefined> {
	let current = path.resolve(start);
	for (;;) {
		const candidate = path.join(current, '.git');
		try {
			const info = await stat(candidate);
			if (info.isDirectory()) {
				return candidate;
			}
			const pointer = (await readFile(candidate, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
			return pointer ? path.resolve(current, pointer) : undefined;
		} catch {
			// Nothing here; keep climbing.
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}
