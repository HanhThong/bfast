import * as assert from 'assert';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	collapseTilde,
	defaultWorktreesHome,
	resolveWorktreeHome,
	worktreeHomes,
	worktreesHome
} from '../environments/environmentContext';
import { MARKER_FILE, serializeEnvironmentMarker } from '../environments/environmentMarker';

/**
 * A scratch worktree under the REAL worktrees home — `resolveWorktreeHome`
 * gates on that location, so the test has to live there. The slug carries the
 * pid so parallel runs cannot collide, and teardown removes the whole slug.
 */
const SLUG_ROOT = path.join(os.tmpdir(), 'bfast-worktrees', `test-context-${process.pid}`);
const WORKTREE = path.join(SLUG_ROOT, 'ST-1');
const SOURCE = path.join(os.tmpdir(), `bfast-test-context-source-${process.pid}`);

/**
 * A worktrees home the user configured — deliberately NOT under the default
 * one, so a folder inside it is invisible to a caller that does not know about
 * the setting. Written with forward slashes, the shape the parse stores.
 */
const CUSTOM_HOME = path.join(os.tmpdir(), `bfast-test-custom-home-${process.pid}`);
const CUSTOM_SETTING = CUSTOM_HOME.replace(/\\/g, '/');
const CUSTOM_SLUG_ROOT = path.join(CUSTOM_HOME, 'my-app');
const CUSTOM_WORKTREE = path.join(CUSTOM_SLUG_ROOT, 'ST-2');

suite('BFAST environment context', () => {
	suiteSetup(async () => {
		await mkdir(path.join(WORKTREE, '.bfast'), { recursive: true });
		await writeFile(
			path.join(WORKTREE, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				ticketId: 'ST-1',
				kind: 'docker-compose',
				branch: 'bfast/ST-1',
				ports: { WEB_PORT: 21000 },
				createdAt: '',
				sourceRoot: SOURCE
			})
		);
	});
	suiteSetup(async () => {
		await mkdir(path.join(CUSTOM_WORKTREE, '.bfast'), { recursive: true });
		await writeFile(
			path.join(CUSTOM_WORKTREE, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				ticketId: 'ST-2',
				kind: 'docker-compose',
				branch: 'story/ST-2',
				ports: {},
				createdAt: '',
				sourceRoot: SOURCE
			})
		);
	});
	suiteTeardown(() => rm(SLUG_ROOT, { recursive: true, force: true }));
	suiteTeardown(() => rm(CUSTOM_HOME, { recursive: true, force: true }));

	test('a worktree window resolves the source repo and its siblings’ root', () => {
		const home = resolveWorktreeHome(WORKTREE);
		assert.ok(home, 'the worktree should be recognised');
		// The source repo is what git and the marker filter compare against…
		assert.strictEqual(home.repositoryRoot, SOURCE);
		// …and the parent folder is where every sibling environment lives, which
		// is what lets the worktree window list all of them.
		assert.strictEqual(home.worktreesRoot, SLUG_ROOT);
		assert.strictEqual(home.marker.ticketId, 'ST-1');
	});

	test('an ordinary workspace is not a worktree, marker or no marker', () => {
		// Outside the worktrees home: even a folder with a committed marker must
		// not count — that is the accidental-commit guard.
		assert.strictEqual(resolveWorktreeHome(SOURCE), undefined);
	});

	test('a stray folder under the home without a marker is not a worktree', () => {
		assert.strictEqual(resolveWorktreeHome(path.join(SLUG_ROOT, 'nothing-here')), undefined);
	});

	test('the home is the configured folder, or the OS temp one', () => {
		assert.strictEqual(worktreesHome(undefined), defaultWorktreesHome());
		assert.strictEqual(worktreesHome({ logTail: 5 }), defaultWorktreesHome());
		assert.strictEqual(
			worktreesHome({ worktreesFolder: CUSTOM_SETTING }),
			path.normalize(CUSTOM_HOME)
		);
		// ~ is expanded here and nowhere else: the settings module is bundled by
		// the webview and may not reach for `os.homedir()`.
		assert.strictEqual(worktreesHome({ worktreesFolder: '~' }), path.normalize(os.homedir()));
		assert.strictEqual(
			worktreesHome({ worktreesFolder: '~/wt' }),
			path.join(os.homedir(), 'wt')
		);
	});

	test('the default home stays a candidate beside a configured one', () => {
		// Nothing configured: one home, and it is the default.
		assert.deepStrictEqual(worktreeHomes(undefined), [defaultWorktreesHome()]);
		// Configured: the default is still tested, because changing the setting
		// moves nothing on disk — a window already open on a worktree under the
		// temp folder must go on recognising itself.
		assert.deepStrictEqual(worktreeHomes({ worktreesFolder: CUSTOM_SETTING }), [
			path.normalize(CUSTOM_HOME),
			defaultWorktreesHome()
		]);
		// Configuring the default explicitly is not two homes.
		assert.deepStrictEqual(
			worktreeHomes({ worktreesFolder: defaultWorktreesHome().replace(/\\/g, '/') }),
			[defaultWorktreesHome()]
		);
	});

	test('a picked folder inside the home folder is stored as ~', () => {
		assert.strictEqual(collapseTilde(os.homedir()), '~');
		assert.strictEqual(collapseTilde(path.join(os.homedir(), 'wt')), '~/wt');
		// Forward slashes whatever the platform's separator, the shape the file
		// stores — so what the form shows after a Browse is what the save writes.
		assert.strictEqual(collapseTilde(path.join(os.homedir(), 'dev', 'wt')), '~/dev/wt');

		// Outside the home folder it is left exactly as picked. Not `os.tmpdir()`
		// for the example: on Windows the temp folder is *inside* the home.
		const outside = path.join(path.parse(os.homedir()).root, 'bfast-not-home');
		assert.strictEqual(collapseTilde(outside), outside);

		// The property that matters: collapsing and expanding are one round trip,
		// so the stored value names the folder the user actually picked.
		for (const picked of [os.homedir(), path.join(os.homedir(), 'dev', 'wt'), outside]) {
			assert.strictEqual(
				worktreesHome({ worktreesFolder: collapseTilde(picked) }),
				path.normalize(picked),
				`${picked} should survive the round trip`
			);
		}
	});

	test('a worktree under a configured home is found, and only with that home', () => {
		// A caller with no settings in hand tests the default home alone, so the
		// folder is an ordinary workspace to it — marker or no marker.
		assert.strictEqual(resolveWorktreeHome(CUSTOM_WORKTREE), undefined);

		const homes = worktreeHomes({ worktreesFolder: CUSTOM_SETTING });
		const home = resolveWorktreeHome(CUSTOM_WORKTREE, homes);
		assert.ok(home, 'the worktree under the configured home should be recognised');
		assert.strictEqual(home.repositoryRoot, SOURCE);
		assert.strictEqual(home.worktreesRoot, CUSTOM_SLUG_ROOT);
		assert.strictEqual(home.marker.ticketId, 'ST-2');

		// And the one made before the setting moved is still recognised by the
		// same list — that is what the default staying a candidate buys.
		assert.strictEqual(resolveWorktreeHome(WORKTREE, homes)?.marker.ticketId, 'ST-1');

		// The guard is unchanged: outside every home, a marker still counts for
		// nothing.
		assert.strictEqual(resolveWorktreeHome(SOURCE, homes), undefined);
	});

	test('a worktree folder carrying a master-shaped marker is not a worktree home', async () => {
		// The master environment has no worktree: such a marker names no ticket
		// whose board activation could open, so the folder is a stray, not a home.
		const stray = path.join(SLUG_ROOT, 'XX-1');
		await mkdir(path.join(stray, '.bfast'), { recursive: true });
		await writeFile(
			path.join(stray, ...MARKER_FILE.split('/')),
			serializeEnvironmentMarker({
				version: 1,
				scope: 'master',
				kind: 'docker-compose',
				projectName: 'bfast-master-x',
				ports: {},
				createdAt: '',
				sourceRoot: SOURCE
			})
		);
		assert.strictEqual(resolveWorktreeHome(stray), undefined);
	});
});
