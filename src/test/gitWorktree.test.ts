import * as assert from 'assert';
import { mkdir, rm, stat } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EnvironmentError } from '../environments/environmentProvider';
import {
	addWorktree,
	enableLongPathsIfNeeded,
	environmentBranchName,
	gitArgs,
	removeWorktree,
	windowsPathOverflow,
	worktreeAddArgs,
	worktreePruneArgs,
	worktreeRemoveArgs
} from '../environments/gitWorktree';
import { ProcessError, type ProcessRunner } from '../platform/runProcess';
import { FakeProcessRunner } from './fakeProcessRunner';

suite('BFAST git worktree', () => {
	test('branch names carry the ticket type and keep the id readable and path-safe', () => {
		assert.strictEqual(environmentBranchName('ST-1.2'), 'story/ST-1.2');
		assert.strictEqual(environmentBranchName('EP-1'), 'epic/EP-1');
		assert.strictEqual(environmentBranchName('st-3'), 'story/st-3');
		// An unknown prefix falls back to bfast/, never to a wrong type.
		assert.strictEqual(environmentBranchName('XX-1'), 'bfast/XX-1');
		assert.strictEqual(environmentBranchName('ST 1/2'), 'story/ST-1-2');
	});

	test('the argv arrays cover both branch modes', () => {
		assert.deepStrictEqual(worktreeAddArgs('/wt', 'bfast/ST-1', true), [
			'worktree',
			'add',
			'-b',
			'bfast/ST-1',
			'/wt',
			'HEAD'
		]);
		assert.deepStrictEqual(worktreeAddArgs('/wt', 'bfast/ST-1', false), [
			'worktree',
			'add',
			'/wt',
			'bfast/ST-1'
		]);
		assert.deepStrictEqual(worktreeRemoveArgs('/wt'), ['worktree', 'remove', '--force', '/wt']);
	});

	test('every git command runs with core.longpaths on, whatever the platform', () => {
		// Git for Windows refuses a long path without it — the checkout of a deep
		// tracker in a worktree — and every other git ignores the key.
		assert.deepStrictEqual(gitArgs(worktreePruneArgs()), [
			'-c',
			'core.longpaths=true',
			'worktree',
			'prune'
		]);
	});

	test('an existing branch is reused rather than surfacing as an error', async () => {
		const fake = new FakeProcessRunner({
			failAt: [0],
			stderr: "fatal: a branch named 'story/ST-1' already exists"
		});

		await addWorktree(fake.runner, '/repo', '/wt', 'story/ST-1');

		assert.strictEqual(fake.requests.length, 2);
		// Both shapes carry the flag: the retry is the one that checked out the
		// long path in the case this exists for.
		assert.deepStrictEqual(fake.requests[0].args, gitArgs(worktreeAddArgs('/wt', 'story/ST-1', true)));
		assert.deepStrictEqual(fake.requests[1].args, gitArgs(worktreeAddArgs('/wt', 'story/ST-1', false)));
		assert.strictEqual(fake.requests[1].cwd, '/repo');
	});

	test('a missing git maps to not-installed, anything else to git-error', async () => {
		const missing = new FakeProcessRunner({ missingAt: [0] });
		await assert.rejects(addWorktree(missing.runner, '/repo', '/wt', 'b'), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'not-installed');
			return true;
		});

		const failing = new FakeProcessRunner({ failAt: [0], stderr: 'fatal: something else' });
		await assert.rejects(addWorktree(failing.runner, '/repo', '/wt', 'b'), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'git-error');
			assert.strictEqual(error.message, 'fatal: something else');
			return true;
		});
	});

	test('a cancelled remove stops — it must not escalate to a force delete', async () => {
		const scratch = path.join(os.tmpdir(), `bfast-test-worktree-cancel-${process.pid}`);
		await mkdir(scratch, { recursive: true });

		// The runner reports the kill the user asked for; the fallback rm must
		// not run, or the cancel would delete the very folder it protected.
		const cancelled: ProcessRunner = () => {
			const completed = Promise.reject(new ProcessError('cancelled', 'stopped'));
			completed.catch(() => undefined);
			return { completed, cancel: () => undefined };
		};

		await assert.rejects(removeWorktree(cancelled, '/repo', scratch), (error: unknown) => {
			assert.ok(error instanceof EnvironmentError);
			assert.strictEqual(error.code, 'cancelled');
			return true;
		});
		// Still there.
		await stat(scratch);

		await rm(scratch, { recursive: true, force: true });
	});

	test('a git remove that "succeeded" but left the folder behind is not believed', async () => {
		const scratch = path.join(os.tmpdir(), `bfast-test-worktree-lied-${process.pid}`);
		await mkdir(scratch, { recursive: true });

		// The fake git reports success without touching the disk — the shape of
		// a remove that left container-created files behind. The folder actually
		// being gone is the contract, so the fallback still clears it.
		const fake = new FakeProcessRunner();
		await removeWorktree(fake.runner, '/repo', scratch);

		await assert.rejects(stat(scratch));
		assert.deepStrictEqual(fake.requests[1].args, gitArgs(worktreePruneArgs()));
	});

	test('a refused remove falls back to deleting the folder and pruning', async () => {
		const scratch = path.join(os.tmpdir(), `bfast-test-worktree-${process.pid}`);
		await mkdir(scratch, { recursive: true });

		// Git says no — the Windows-file-lock shape — so the folder goes by hand
		// and the dangling registration is pruned.
		const fake = new FakeProcessRunner({ failAt: [0], stderr: 'fatal: locked' });
		await removeWorktree(fake.runner, '/repo', scratch);

		await assert.rejects(stat(scratch));
		assert.deepStrictEqual(fake.requests[1].args, gitArgs(worktreePruneArgs()));

		await rm(scratch, { recursive: true, force: true });
	});
});

suite('BFAST long paths on Windows', () => {
	// The file that failed a real worktree's checkout: 245 characters from the
	// repository root, folder 231.
	const DEEP =
		'.tracker/EP-1-Authentication/' +
		'ST-1.1-Tạo_tài_khoản_người_chơi_bằng_email_và_mật_khẩu_ngay_trong/' +
		'AC-1.1.1-Tạo_tài_khoản_mới_bằng_email,_tên_hiển_thị_và_mật_khẩu_rồi/' +
		'TC-1.1.1.1-Registers_with_email,_display_name_and_password_and_lands/' +
		'metadata.yaml';

	test('a path that fits the repository can be too long for its worktree', () => {
		assert.strictEqual(DEEP.length, 245);
		// In the repository it fits: 255 for the file, 241 for its folder.
		assert.strictEqual(windowsPathOverflow('D:\\aurora', [DEEP]), undefined);
		// Sixteen characters deeper, its folder is past 248 and git refused it.
		assert.deepStrictEqual(windowsPathOverflow('D:\\workspaces\\aurora\\EP-1', [DEEP, 'README.md']), {
			count: 1,
			length: 271
		});
	});

	test('the limits are 260 for a file and 248 for its folder, in UTF-16 units', () => {
		const root = 'C:\\r'; // four characters, five with the separator
		assert.strictEqual(windowsPathOverflow(root, ['x'.repeat(254)]), undefined);
		assert.deepStrictEqual(windowsPathOverflow(root, ['x'.repeat(255)]), { count: 1, length: 260 });
		assert.strictEqual(windowsPathOverflow(root, [`${'d'.repeat(242)}/f`]), undefined);
		assert.deepStrictEqual(windowsPathOverflow(`${root}\\`, [`${'d'.repeat(243)}/f`]), {
			count: 1,
			length: 250
		});
		// The empty entry `ls-files -z` ends with is not a file.
		assert.strictEqual(windowsPathOverflow(root, ['', 'a/b.ts', '']), undefined);
	});

	test('turns core.longpaths on for the repository when a checked-out path needs it', async () => {
		// ls-files, then the read (unset: exit 1), then the write.
		const fake = new FakeProcessRunner({
			results: [{ stdout: `README.md\0${DEEP}\0` }, {}],
			failAt: [1],
			stderr: ''
		});

		const overflow = await enableLongPathsIfNeeded(
			fake.runner,
			'D:\\aurora',
			'D:\\workspaces\\aurora\\EP-1',
			() => undefined
		);

		assert.deepStrictEqual(overflow, { count: 1, length: 271 });
		assert.strictEqual(fake.requests.length, 3);
		assert.deepStrictEqual(fake.requests[0].args, gitArgs(['ls-files', '-z']));
		assert.strictEqual(fake.requests[0].cwd, 'D:\\workspaces\\aurora\\EP-1');
		// The listing is data: it never reaches the output channel.
		assert.strictEqual(fake.requests[0].onOutput, undefined);
		// Without BFAST's own `-c`, which `--get` would only read back.
		assert.deepStrictEqual(fake.requests[1].args, ['config', '--type=bool', '--get', 'core.longpaths']);
		assert.strictEqual(fake.requests[1].cwd, 'D:\\aurora');
		assert.deepStrictEqual(fake.requests[2].args, gitArgs(['config', 'core.longpaths', 'true']));
		assert.strictEqual(fake.requests[2].cwd, 'D:\\aurora');
	});

	test('leaves the config alone when it is already on, or when every path fits', async () => {
		const alreadyOn = new FakeProcessRunner({
			results: [{ stdout: `${DEEP}\0` }, { stdout: 'true\n' }]
		});
		assert.strictEqual(
			await enableLongPathsIfNeeded(alreadyOn.runner, 'D:\\aurora', 'D:\\workspaces\\aurora\\EP-1'),
			undefined
		);
		assert.strictEqual(alreadyOn.requests.length, 2);

		const fits = new FakeProcessRunner({ results: [{ stdout: 'README.md\0src/index.ts\0' }] });
		assert.strictEqual(
			await enableLongPathsIfNeeded(fits.runner, 'D:\\aurora', 'D:\\workspaces\\aurora\\EP-1'),
			undefined
		);
		assert.strictEqual(fits.requests.length, 1);
	});
});
