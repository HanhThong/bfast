// Commit Ticket's pure half: which changed files belong to a ticket, and the
// git calls that commit exactly those. docs/commit/README.md is the spec.
//
// No `vscode` import — every git call goes through an injected
// `ProcessRunner`, so the suite drives it against a scratch repository or a
// scripted fake.
//
// Three decisions are load-bearing:
// - **Only the ticket's paths are committed** (`git commit --only`), so
//   whatever else the user has staged stays staged and out of this commit.
// - **Paths travel on stdin** (`--pathspec-from-file=- --pathspec-file-nul`)
//   with `GIT_LITERAL_PATHSPECS=1`: a subtree can be hundreds of files, past
//   Windows' command-line limit, and a slug may carry `[` or `*`, which a
//   pathspec would otherwise read as a glob.
// - **A renamed folder takes its old location along.** BFAST renames a slug
//   with a plain file-system rename, so git sees the old folder deleted and
//   the new one untracked. Committing only the new folder would put both in
//   the commit's tree — a duplicate ticket for everyone who pulls it.

import { gitArgs } from '../environments/gitWorktree';
import { parseFolderName } from '../data/trackerPaths';
import { ProcessError, type ProcessRunner, type RunProcessResult } from '../platform/runProcess';

export type CommitErrorCode = 'not-installed' | 'not-a-repository' | 'failed';

export class CommitError extends Error {
	constructor(
		readonly code: CommitErrorCode,
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'CommitError';
	}
}

/** One entry of `git status --porcelain=v1 -z`. */
export interface StatusEntry {
	/** Repository-relative, forward slashes. */
	path: string;
	/** A rename's or copy's source. */
	origin?: string;
	/** The `X` column: the index against `HEAD`. */
	index: string;
	/** The `Y` column: the working tree against the index. */
	worktree: string;
}

/** What changed for one ticket, as repository-relative paths. */
export interface TicketChanges {
	/** The repository's top level, the cwd every later call runs in. */
	top: string;
	/** The ticket's own files: its description, metadata, history, design documents, `assets/`. */
	own: string[];
	/** Files inside the folders of tickets below it. */
	children: string[];
}

/**
 * Parses `git status --porcelain=v1 -z`. A rename or copy is followed by its
 * source as the next NUL-separated field; nothing is quoted under `-z`.
 */
export function parseStatus(stdout: string): StatusEntry[] {
	const fields = stdout.split('\0');
	const entries: StatusEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) {
			continue;
		}
		const entry: StatusEntry = { index: field[0], worktree: field[1], path: field.slice(3) };
		if (entry.index === 'R' || entry.index === 'C') {
			entry.origin = fields[++i];
		}
		entries.push(entry);
	}
	return entries;
}

/**
 * Sorts changed paths into the ticket's own and its children's.
 *
 * `prefix` is the ticket folder relative to the repository, ending in `/`.
 * Inside it, a path whose first segment is a ticket folder (`ST-1.2-…`)
 * belongs to a child; anything else — `assets/`, a design document — is the
 * ticket's own. Outside it, a deleted path under a sibling folder claiming the
 * same id is where this folder used to be before a rename, and is classified
 * the same way relative to that old folder.
 */
export function classifyChanges(
	entries: readonly StatusEntry[],
	prefix: string
): { own: string[]; children: string[] } {
	const folder = prefix.replace(/\/$/, '');
	const slash = folder.lastIndexOf('/');
	const parent = slash < 0 ? '' : folder.slice(0, slash + 1);
	const folderName = folder.slice(slash + 1);
	const id = parseFolderName(folderName).id;

	const own = new Set<string>();
	const children = new Set<string>();

	const place = (path: string, base: string): void => {
		const rest = path.slice(base.length);
		const cut = rest.indexOf('/');
		const isChild = cut > 0 && parseFolderName(rest.slice(0, cut)).id !== undefined;
		(isChild ? children : own).add(path);
	};

	/** The folder `path` sits in under `parent`, when it is this ticket's old location. */
	const oldLocation = (path: string): string | undefined => {
		if (id === undefined || !path.startsWith(parent)) {
			return undefined;
		}
		const rest = path.slice(parent.length);
		const cut = rest.indexOf('/');
		if (cut <= 0) {
			return undefined;
		}
		const name = rest.slice(0, cut);
		return name !== folderName && parseFolderName(name).id === id
			? `${parent}${name}/`
			: undefined;
	};

	for (const entry of entries) {
		if (entry.path.startsWith(prefix)) {
			place(entry.path, prefix);
			if (entry.origin !== undefined) {
				// A staged rename into this folder: the source goes with it, or
				// the commit would hold the file twice.
				(children.has(entry.path) ? children : own).add(entry.origin);
			}
			continue;
		}
		const deleted = entry.index === 'D' || entry.worktree === 'D';
		const old = deleted ? oldLocation(entry.path) : undefined;
		if (old !== undefined) {
			place(entry.path, old);
		}
	}

	return { own: [...own].sort(), children: [...children].sort() };
}

/** What every git call here runs with: literal pathspecs, and never a credential prompt. */
const GIT_ENV = { GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' };

async function git(
	runner: ProcessRunner,
	cwd: string,
	args: string[],
	stdin?: string
): Promise<RunProcessResult> {
	try {
		return await runner({
			executable: 'git',
			args: gitArgs(args),
			cwd,
			env: { ...process.env, ...GIT_ENV },
			stdin
		}).completed;
	} catch (error) {
		if (error instanceof ProcessError && error.code === 'not-installed') {
			throw new CommitError('not-installed', 'Git is not installed, or not on the PATH.', error);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new CommitError('failed', message, error);
	}
}

/**
 * The repository holding `folder` and the folder's path inside it. A folder
 * outside any repository is `not-a-repository`, said in words — the raw
 * `fatal:` line is git's, not the user's.
 */
export async function locateFolder(
	runner: ProcessRunner,
	folder: string
): Promise<{ top: string; prefix: string }> {
	let result: RunProcessResult;
	try {
		result = await git(runner, folder, ['rev-parse', '--show-toplevel', '--show-prefix']);
	} catch (error) {
		// `not a git repository`, `Stopping at filesystem boundary`, a
		// `safe.directory` refusal: each means git found no repository it
		// will use, so each is this row — with git's own line for the detail.
		if (error instanceof CommitError && error.code === 'failed') {
			throw new CommitError(
				'not-a-repository',
				`The tracker is not inside a git repository git can use (${error.message}).`,
				error
			);
		}
		throw error;
	}
	const [top = '', prefix = ''] = result.stdout.split(/\r?\n/);
	if (top.trim().length === 0 || prefix.trim().length === 0) {
		throw new CommitError('not-a-repository', 'The tracker is not inside a git repository.');
	}
	return { top: top.trim(), prefix: prefix.trim() };
}

/** The changed files of the ticket whose folder is `folder`, sorted into own and children. */
export async function ticketChanges(
	runner: ProcessRunner,
	folder: string
): Promise<TicketChanges> {
	const { top, prefix } = await locateFolder(runner, folder);
	const trimmed = prefix.replace(/\/$/, '');
	const parent = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/') + 1) : '';

	// The parent folder rather than the ticket's own, so a rename's old
	// location is in the listing too.
	const status = await git(runner, top, [
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
		'--',
		...(parent ? [parent] : [])
	]);
	return { top, ...classifyChanges(parseStatus(status.stdout), prefix) };
}

/**
 * Stages and commits exactly `paths`, leaving everything else the index holds
 * untouched. Answers the new commit's short hash.
 */
export async function commitPaths(
	runner: ProcessRunner,
	top: string,
	paths: readonly string[],
	message: string
): Promise<string> {
	if (paths.length === 0) {
		throw new CommitError('failed', 'Nothing to commit.');
	}
	const list = paths.join('\0');
	const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul'];

	// `-A` so a deleted file is staged as a deletion and an untracked one as an
	// addition; a path already staged as deleted is skipped by git, not refused.
	await git(runner, top, ['add', '-A', ...fromStdin], list);
	await git(runner, top, ['commit', '--only', '--message', message, ...fromStdin], list);
	const head = await git(runner, top, ['rev-parse', '--short', 'HEAD']);
	return head.stdout.trim();
}

/**
 * Every uncommitted change under the tracker, for the sidebar's marks.
 * `--no-optional-locks` because this runs whenever the git extension reports
 * a change: a plain `status` may refresh the index, and that write would be
 * the next change the extension reports — a loop.
 */
export async function trackerStatus(
	runner: ProcessRunner,
	trackerFolder: string
): Promise<{ top: string; prefix: string; entries: StatusEntry[] }> {
	const { top, prefix } = await locateFolder(runner, trackerFolder);
	const status = await git(runner, top, [
		'--no-optional-locks',
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
		'--',
		prefix
	]);
	return { top, prefix, entries: parseStatus(status.stdout) };
}
