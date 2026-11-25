import * as assert from 'assert';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readCheckedOutBranch } from '../environments/gitHead';

const SCRATCH = path.join(os.tmpdir(), `bfast-test-githead-${process.pid}`);

async function repoWithHead(name: string, head: string): Promise<string> {
	const repo = path.join(SCRATCH, name);
	await mkdir(path.join(repo, '.git'), { recursive: true });
	await writeFile(path.join(repo, '.git', 'HEAD'), head);
	return repo;
}

suite('BFAST git HEAD reader', () => {
	setup(async () => {
		await rm(SCRATCH, { recursive: true, force: true });
		await mkdir(SCRATCH, { recursive: true });
	});
	suiteTeardown(() => rm(SCRATCH, { recursive: true, force: true }));

	test('reads the branch a .git directory has checked out, slashes included', async () => {
		assert.strictEqual(
			await readCheckedOutBranch(await repoWithHead('main', 'ref: refs/heads/main\n')),
			'main'
		);
		assert.strictEqual(
			await readCheckedOutBranch(await repoWithHead('nested', 'ref: refs/heads/feature/x\n')),
			'feature/x'
		);
	});

	test('walks up, so a workspace folder below the git toplevel still reports the branch', async () => {
		const repo = await repoWithHead('mono', 'ref: refs/heads/develop\n');
		const inner = path.join(repo, 'packages', 'web');
		await mkdir(inner, { recursive: true });
		assert.strictEqual(await readCheckedOutBranch(inner), 'develop');
	});

	test('follows a .git file to a linked worktree’s own HEAD', async () => {
		// The shape `git worktree add` leaves: `.git` is a file pointing into
		// the main repo's `.git/worktrees/<name>`, relative to the folder.
		const main = await repoWithHead('main-repo', 'ref: refs/heads/main\n');
		const linked = path.join(main, '.git', 'worktrees', 'st-1');
		await mkdir(linked, { recursive: true });
		await writeFile(path.join(linked, 'HEAD'), 'ref: refs/heads/story/ST-1\n');
		const worktree = path.join(SCRATCH, 'wt');
		await mkdir(worktree, { recursive: true });
		await writeFile(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, linked)}\n`);

		assert.strictEqual(await readCheckedOutBranch(worktree), 'story/ST-1');
	});

	test('a detached HEAD, a junk pointer and a missing repo all read as unknown', async () => {
		assert.strictEqual(
			await readCheckedOutBranch(
				await repoWithHead('detached', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n')
			),
			''
		);
		const junk = path.join(SCRATCH, 'junk');
		await mkdir(junk, { recursive: true });
		await writeFile(path.join(junk, '.git'), 'not a pointer');
		assert.strictEqual(await readCheckedOutBranch(junk), '');
		assert.strictEqual(await readCheckedOutBranch(path.join(SCRATCH, 'nowhere')), '');
	});
});
