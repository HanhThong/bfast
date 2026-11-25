// What the environments feature needs from the outside world.
//
// The same shape as `TrackerContext` and `AiContext`, for the same two
// payoffs: everything is read at call time rather than captured, so the store
// and providers can be built before settings have been read from disk — and a
// test can point them at a scratch folder without writing a real `bfast.json`.
//
// One twist beyond those two: a window opened **on a worktree** must see the
// original workspace's environments, not an empty list of its own. The marker
// makes the worktree self-describing (`sourceRoot` names the repo it came
// from) and worktrees sit directly under their workspace's worktrees root, so
// the current folder's parent *is* that root — `resolveWorktreeHome` reads
// both off disk, and the context prefers them over the derive-from-this-
// workspace defaults.
//
// Where that home is, is `environments.worktreesFolder` — and the *default*
// home stays a candidate alongside it (`worktreeHomes`), so pointing the
// setting somewhere new does not stop a window already open on a worktree
// under the temp folder from recognising itself.

import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	environmentWorktreesFolder,
	type EnvironmentsSettings
} from '../settings/environmentSettings';
import type { SettingsService } from '../settings/settingsService';
import {
	MARKER_FILE,
	parseEnvironmentMarker,
	type TicketEnvironmentMarker
} from './environmentMarker';
import { workspaceSlug } from '../platform/workspaceSlug';

export interface EnvironmentContext {
	/** Absolute path of the repo worktrees are made from, or `undefined` while no folder is open. */
	repositoryRoot(): string | undefined;
	/**
	 * Where this workspace's worktrees live: `<worktrees home>/<workspace-slug>`,
	 * the home being `environments.worktreesFolder` or, by default,
	 * `<os temp>/bfast-worktrees`. Outside the workspace either way — a worktree
	 * is disposable, and putting it inside the workspace would put a second
	 * checkout in the first one's search results.
	 *
	 * The `<workspace-slug>` segment is never optional, whatever the home: two
	 * repos on one machine must not share a folder, and `masterProjectName`
	 * reads the slug back off this path's last segment.
	 */
	worktreesRoot(): string | undefined;
	settings(): EnvironmentsSettings | undefined;
}

/**
 * What a workspace folder that IS a worktree knows about where it came from.
 * Always a ticket's marker: the master environment has no worktree, so a
 * master-shaped marker inside one is a stray file, not a home.
 */
export interface WorktreeHome {
	marker: TicketEnvironmentMarker;
	/** The source repo — `marker.sourceRoot`. */
	repositoryRoot: string;
	/** The folder's parent: the source workspace's worktrees root. */
	worktreesRoot: string;
}

/** The folder holding BFAST's worktrees, one subfolder per workspace. */
export const WORKTREES_HOME_FOLDER = 'bfast-worktrees';

/** `<os temp>/bfast-worktrees` — where worktrees go when nothing is configured. */
export function defaultWorktreesHome(): string {
	return path.join(os.tmpdir(), WORKTREES_HOME_FOLDER);
}

/**
 * The home in force: the configured folder, or the default. The one address
 * for that precedence — `environmentSettings.ts` deliberately does not default
 * it, since naming the temp folder would drag `os` into a module the settings
 * webview bundles.
 */
export function worktreesHome(environments: EnvironmentsSettings | undefined): string {
	const configured = environmentWorktreesFolder(environments);
	return configured === undefined
		? defaultWorktreesHome()
		: path.normalize(expandTilde(configured));
}

/**
 * Every folder a worktree of this workspace may legitimately sit under — the
 * configured home first, then the default.
 *
 * The default stays a candidate on purpose: changing the setting moves nothing
 * on disk, and a window already open on a worktree under the temp folder must
 * go on recognising itself rather than silently becoming an ordinary workspace
 * with an empty Environments section. It costs nothing — the list is only ever
 * a prefix test — and it widens no guard: the point of the test is that the
 * folder is under *a* BFAST worktrees home, so that a marker accidentally
 * committed to a repo can never count.
 */
export function worktreeHomes(environments: EnvironmentsSettings | undefined): string[] {
	const configured = worktreesHome(environments);
	const fallback = defaultWorktreesHome();
	return samePath(configured, fallback) ? [configured] : [configured, fallback];
}

/**
 * `~` and `~/…` start at the user's home folder. Accepted because
 * `bfast.json` is committed to git, so a `~`-relative value is the one shape
 * a Windows and a macOS teammate can share. `~user` is not a thing here:
 * `ABSOLUTE_PATH` refuses it on the way in, so anything reaching this has
 * either a `/` after the tilde or nothing at all.
 */
function expandTilde(value: string): string {
	if (value === '~') {
		return os.homedir();
	}
	return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * The inverse of `expandTilde`, for a folder the user just picked in a dialog.
 * A path under the home folder is stored as `~/…`: `bfast.json` is committed,
 * so a picker that wrote `C:/Users/me/worktrees` verbatim would hand every
 * teammate a path that is not theirs, and `~` is the one shape they can share.
 *
 * It is a default and not a rewrite behind the user's back — the field shows
 * what was stored, so an absolute path is one edit away.
 */
export function collapseTilde(absolute: string): string {
	const target = path.normalize(absolute);
	const home = path.normalize(os.homedir());
	if (samePath(target, home)) {
		return '~';
	}
	if (!isInside(target, home)) {
		return absolute;
	}
	return `~/${target.slice(home.length + 1).split(path.sep).join('/')}`;
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * `undefined` for an ordinary workspace. Synchronous on purpose — the context
 * accessors are synchronous — and cheap: it only ever reads inside a worktrees
 * home, and callers cache per folder.
 *
 * `homes` is what `worktreeHomes` answers. It defaults to the default home
 * alone, which is the honest answer for a caller with no settings in hand.
 */
export function resolveWorktreeHome(
	folderPath: string,
	homes: readonly string[] = [defaultWorktreesHome()]
): WorktreeHome | undefined {
	if (!homes.some((home) => isInside(folderPath, home))) {
		return undefined;
	}

	try {
		const raw = readFileSync(path.join(folderPath, ...MARKER_FILE.split('/')), 'utf8');
		const marker = parseEnvironmentMarker(JSON.parse(raw));
		return marker && marker.scope !== 'master' && marker.sourceRoot
			? {
					marker,
					repositoryRoot: marker.sourceRoot,
					worktreesRoot: path.dirname(folderPath)
				}
			: undefined;
	} catch {
		// No readable marker — a stray folder under the home, not a worktree.
		return undefined;
	}
}

function isInside(folderPath: string, home: string): boolean {
	const prefix = path.normalize(home) + path.sep;
	return process.platform === 'win32'
		? folderPath.toLowerCase().startsWith(prefix.toLowerCase())
		: folderPath.startsWith(prefix);
}

export function bfastEnvironmentContext(settings: SettingsService): EnvironmentContext {
	// The marker never changes after create and the folder identity is fixed
	// for the window's lifetime, so one read per folder is the honest cache.
	// The homes are part of the key rather than the folder alone: they come
	// from settings, so the first call may land before `settings.read()` has
	// resolved — a folder-keyed cache would pin that answer and a worktree
	// window would never find itself.
	let cached: { key: string; home: WorktreeHome | undefined } | undefined;
	const homeOf = (folder: string): WorktreeHome | undefined => {
		const homes = worktreeHomes(settings.current?.environments);
		const key = [folder, ...homes].join('|');
		if (cached?.key !== key) {
			cached = { key, home: resolveWorktreeHome(folder, homes) };
		}
		return cached.home;
	};

	return {
		repositoryRoot: () => {
			const folder = settings.workspaceFolder?.uri.fsPath;
			return folder === undefined ? undefined : (homeOf(folder)?.repositoryRoot ?? folder);
		},
		worktreesRoot: () => {
			const folder = settings.workspaceFolder;
			if (!folder) {
				return undefined;
			}
			return (
				homeOf(folder.uri.fsPath)?.worktreesRoot ??
				path.join(worktreesHome(settings.current?.environments), workspaceSlug(folder.name))
			);
		},
		settings: () => settings.current?.environments
	};
}
