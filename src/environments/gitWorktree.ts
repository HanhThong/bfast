// Git worktree operations for environments.
//
// The pure argv builders are exported for tests; `addWorktree` and
// `removeWorktree` are the thin calls through a `ProcessRunner`, so no test
// ever spawns a real git. Everything runs with `cwd: repoRoot` — worktree
// commands work from any directory inside the repo, so the workspace folder
// not being the git toplevel still works — except the file listing
// `enableLongPathsIfNeeded` takes inside the new worktree, and `skipWorktree`,
// whose mark lives in the new worktree's own index.

import { access, rm } from 'fs/promises';
import { EnvironmentCancelledError, EnvironmentError } from './environmentProvider';
import { ProcessError, type ProcessRunner, type RunProcessResult } from '../platform/runProcess';

/**
 * Every git command BFAST runs starts with this. Git for Windows refuses a
 * path of 260 characters or more — 248 for a folder — unless `core.longpaths`
 * is on, whatever Windows' own `LongPathsEnabled` policy says, and a worktree
 * sits a folder or two deeper than the repo it came from: a tracker that fits
 * in the repo can fail the worktree's checkout. Every other git ignores the
 * key, so the argv is the same on every platform.
 */
const GIT_OPTIONS = ['-c', 'core.longpaths=true'];

/** The argv `git()` actually runs for `args`. Exported for tests. */
export function gitArgs(args: readonly string[]): string[] {
	return [...GIT_OPTIONS, ...args];
}

/**
 * `'ST-1.2'` → `'story/ST-1.2'`, `'EP-1'` → `'epic/EP-1'` — the branch an
 * environment's work lives on, prefixed by the ticket type the id encodes so
 * the branch list reads like the tracker. An id with an unknown prefix falls
 * back to `bfast/`, never to a wrong type.
 */
export function environmentBranchName(ticketId: string): string {
	return `${branchPrefix(ticketId)}/${ticketId.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

function branchPrefix(ticketId: string): string {
	// The leading letters, whatever separator follows — the id format is
	// `<PREFIX>-…`, but a hand-typed id must still land on the right side.
	switch (ticketId.match(/^[A-Za-z]+/)?.[0]?.toUpperCase()) {
		case 'ST':
			return 'story';
		case 'EP':
			return 'epic';
		default:
			return 'bfast';
	}
}

/**
 * `createBranch` chooses between minting the branch (`-b`, from the current
 * `HEAD`) and reusing one that already exists.
 */
export function worktreeAddArgs(path: string, branch: string, createBranch: boolean): string[] {
	return createBranch
		? ['worktree', 'add', '-b', branch, path, 'HEAD']
		: ['worktree', 'add', path, branch];
}

/** `--force`: the worktree may hold untracked files (the marker, build output). */
export function worktreeRemoveArgs(path: string): string[] {
	return ['worktree', 'remove', '--force', path];
}

export function worktreePruneArgs(): string[] {
	return ['worktree', 'prune'];
}

export type GitOutput = (text: string, channel: 'stdout' | 'stderr') => void;

/**
 * Adds the worktree on `branch`, minting the branch when it does not exist
 * yet and reusing it when it does — a re-created environment lands back on
 * the story's branch, commits and all.
 */
export async function addWorktree(
	runner: ProcessRunner,
	repoRoot: string,
	path: string,
	branch: string,
	onOutput?: GitOutput
): Promise<void> {
	try {
		await git(runner, repoRoot, worktreeAddArgs(path, branch, true), onOutput);
	} catch (error) {
		// `-b` refuses an existing branch with "a branch named '…' already
		// exists"; retry reusing it. The match is deliberately narrower than
		// "already exists" alone — a *path* collision says "'<path>' already
		// exists" and must surface, not be retried as a branch collision. Any
		// other failure — including the retry's own — surfaces as git-error.
		if (error instanceof EnvironmentError && /branch.*already exists/i.test(error.message)) {
			await git(runner, repoRoot, worktreeAddArgs(path, branch, false), onOutput);
			return;
		}
		throw error;
	}
}

/**
 * Removes the worktree folder — and does not take git's word for it. When git
 * refuses (a Windows file lock is the usual reason), *or reports success while
 * something survived* (files a container created with permissions git cannot
 * touch), the fallback deletes the folder directly, with retries for
 * transient locks, and prunes the now-dangling registration. Only if the
 * folder still cannot be removed does the error surface, saying what likely
 * holds it.
 */
export async function removeWorktree(
	runner: ProcessRunner,
	repoRoot: string,
	path: string,
	onOutput?: GitOutput
): Promise<void> {
	try {
		await git(runner, repoRoot, worktreeRemoveArgs(path), onOutput);
	} catch (error) {
		// A cancel must stop the delete, not escalate it: swallowing the
		// cancellation here would make the fallback force-delete the very folder
		// the user just asked to keep their hands off.
		if (
			error instanceof EnvironmentError &&
			(error.code === 'not-installed' || error.code === 'cancelled')
		) {
			throw error;
		}
	}

	// The folder actually being gone is the contract; a git success that left
	// leftovers behind is what turned Delete-then-Create into a dead end.
	if (!(await stillExists(path))) {
		return;
	}

	try {
		await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch (error) {
		// The registration must not dangle even when the folder wins.
		await pruneWorktrees(runner, repoRoot, onOutput);
		throw new EnvironmentError(
			'git-error',
			'The worktree folder could not be fully removed. Close any window or ' +
				'process holding it open — files created by containers may need ' +
				'elevated permissions to delete — and delete the environment again.',
			error
		);
	}
	await pruneWorktrees(runner, repoRoot, onOutput);
}

async function stillExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort: heals registrations whose folders the OS cleaned away. */
export async function pruneWorktrees(
	runner: ProcessRunner,
	repoRoot: string,
	onOutput?: GitOutput
): Promise<void> {
	try {
		await git(runner, repoRoot, worktreePruneArgs(), onOutput);
	} catch {
		// A failed prune never blocks the operation that asked for it.
	}
}

/**
 * Windows' limits for a program that is not long-path aware — git without
 * `core.longpaths` among them: a file's full path under MAX_PATH (260, its
 * terminating NUL included), and a folder's under 248, MAX_PATH less room for
 * an 8.3 name, which is where git's own `mkdir` stops.
 */
const WINDOWS_FILE_PATH_LIMIT = 260;
const WINDOWS_FOLDER_PATH_LIMIT = 248;

export interface PathOverflow {
	/** How many files cannot be used, by their own path's length or their folder's. */
	count: number;
	/** The longest of those files' full paths, in characters. */
	length: number;
}

/**
 * Which of `files` — relative to `root`, `/`-separated, as `git ls-files`
 * prints them — a program bound by MAX_PATH could not use once checked out
 * under `root`. Lengths are `string.length`, UTF-16 units, which is what
 * Windows counts. `undefined` when every one fits.
 */
export function windowsPathOverflow(
	root: string,
	files: readonly string[]
): PathOverflow | undefined {
	const base = root.replace(/[\\/]+$/, '').length + 1;
	let count = 0;
	let length = 0;
	for (const file of files) {
		if (file === '') {
			continue;
		}
		const fileLength = base + file.length;
		const slash = file.lastIndexOf('/');
		const folderLength = slash < 0 ? 0 : base + slash;
		if (fileLength >= WINDOWS_FILE_PATH_LIMIT || folderLength >= WINDOWS_FOLDER_PATH_LIMIT) {
			count++;
			length = Math.max(length, fileLength);
		}
	}
	return count > 0 ? { count, length } : undefined;
}

/**
 * Makes a new worktree usable by git *outside* BFAST — the environment
 * window's Source Control, a terminal, a merge — which reads `core.longpaths`
 * from config, never from BFAST's command line. Turns it on for the repository
 * (`.git/config`, which the main working tree and every worktree share) only
 * when a file the worktree checked out is past Windows' limits and it is not
 * already on at any level. Answers what it found when it turned it on, and
 * `undefined` when there was nothing to do. The caller decides that this is
 * Windows.
 */
export async function enableLongPathsIfNeeded(
	runner: ProcessRunner,
	repoRoot: string,
	worktreePath: string,
	onOutput?: GitOutput
): Promise<PathOverflow | undefined> {
	// No `onOutput`: the listing is data, and a large repository's would bury
	// the log. Run inside the worktree, so its paths are relative to its root.
	const { stdout } = await git(runner, worktreePath, ['ls-files', '-z']);
	const overflow = windowsPathOverflow(worktreePath, stdout.split('\0'));
	if (!overflow || (await longPathsEnabled(runner, repoRoot))) {
		return undefined;
	}
	await git(runner, repoRoot, ['config', 'core.longpaths', 'true'], onOutput);
	return overflow;
}

/**
 * Hides local edits to `files` from git in one worktree: `git status`,
 * `git add -A` and `git commit -a` there pass over them. For files BFAST
 * rewrote on purpose and that must never travel back with the branch — a new
 * environment's own MCP port (docs/environments/README.md §The MCP server in
 * an environment).
 *
 * `--skip-worktree` is a bit in the index, and a linked worktree has an index
 * of its own, so the mark reaches no other checkout. `files` are relative to
 * `worktreePath`, `/`-separated. Only the ones git tracks are marked —
 * `update-index` refuses the whole call over a path with no index entry —
 * and those are what it answers.
 */
export async function skipWorktree(
	runner: ProcessRunner,
	worktreePath: string,
	files: readonly string[],
	onOutput?: GitOutput
): Promise<string[]> {
	if (files.length === 0) {
		return [];
	}
	const { stdout } = await git(runner, worktreePath, ['ls-files', '-z', '--', ...files]);
	const tracked = stdout.split('\0').filter((file) => file.length > 0);
	if (tracked.length === 0) {
		return [];
	}
	await git(runner, worktreePath, ['update-index', '--skip-worktree', '--', ...tracked], onOutput);
	return tracked;
}

/**
 * Whether `core.longpaths` is already on — in the repository, or the user's
 * global or system config. Deliberately run *without* `GIT_OPTIONS`: `--get`
 * reads the command line's `-c` too, so it would only ever find BFAST's own
 * flag. An unset key exits 1, which reads as off.
 */
async function longPathsEnabled(runner: ProcessRunner, repoRoot: string): Promise<boolean> {
	try {
		const { stdout } = await run(runner, repoRoot, [
			'config',
			'--type=bool',
			'--get',
			'core.longpaths'
		]);
		return stdout.trim() === 'true';
	} catch (error) {
		if (error instanceof EnvironmentCancelledError) {
			throw error;
		}
		return false;
	}
}

function git(
	runner: ProcessRunner,
	cwd: string,
	args: string[],
	onOutput?: GitOutput
): Promise<RunProcessResult> {
	return run(runner, cwd, gitArgs(args), onOutput);
}

/** Runs `argv` exactly as given; `git()` is the caller that adds `GIT_OPTIONS`. */
async function run(
	runner: ProcessRunner,
	cwd: string,
	argv: string[],
	onOutput?: GitOutput
): Promise<RunProcessResult> {
	try {
		return await runner({
			executable: 'git',
			args: argv,
			cwd,
			// Stable English messages: `addWorktree` sniffs stderr for the
			// branch-exists case, and a localized git would never match.
			env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
			onOutput
		}).completed;
	} catch (error) {
		if (error instanceof ProcessError && error.code === 'not-installed') {
			throw new EnvironmentError(
				'not-installed',
				'Could not run `git`. Install git and make sure it is on your PATH.',
				error
			);
		}
		if (error instanceof ProcessError && error.code === 'cancelled') {
			throw new EnvironmentCancelledError(error.message);
		}
		throw new EnvironmentError(
			'git-error',
			error instanceof ProcessError ? error.message : 'git failed.',
			error
		);
	}
}
