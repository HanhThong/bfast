import * as assert from 'assert';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	classifyChanges,
	CommitError,
	commitPaths,
	parseStatus,
	ticketChanges,
	trackerStatus
} from '../commit/ticketCommit';
import { changedTicketFolders } from '../commit/changeMarks';
import { runProcess } from '../platform/runProcess';
import {
	commitMessageTemplate,
	DEFAULT_COMMIT_MESSAGE,
	normalizeGitSettings,
	parseGitSettings,
	renderCommitMessage,
	unknownCommitMessagePlaceholders
} from '../settings/gitSettings';
import { FakeProcessRunner } from './fakeProcessRunner';

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await runProcess({ executable: 'git', args, cwd }).completed).stdout;
}

async function put(root: string, file: string, text: string): Promise<void> {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), text);
}

suite('BFAST commit ticket', () => {
	test('the git block is omitted when empty and keeps a template', () => {
		assert.strictEqual(parseGitSettings({}), undefined);
		assert.strictEqual(parseGitSettings({ commitMessage: '   ' }), undefined);
		assert.strictEqual(normalizeGitSettings({ commitMessage: '' }), undefined);
		assert.deepStrictEqual(parseGitSettings({ commitMessage: ' {{id}} x ' }), {
			commitMessage: '{{id}} x'
		});
		assert.strictEqual(commitMessageTemplate(undefined), DEFAULT_COMMIT_MESSAGE);
		assert.deepStrictEqual(unknownCommitMessagePlaceholders('{{id}} {{nope}}'), ['nope']);
	});

	test('a message is rendered on one line and an unknown token is left alone', () => {
		assert.strictEqual(
			renderCommitMessage('{{type}} {{id}}: {{title}} {{nope}}', {
				id: 'ST-1.2',
				key: 'ST-2',
				title: 'Sign in\nwith email',
				type: 'story',
				status: 'done'
			}),
			'story ST-1.2: Sign in with email {{nope}}'
		);
	});

	test('the porcelain parser reads renames with their source', () => {
		const entries = parseStatus('R  t/new/a.mdx\0t/old/a.mdx\0?? t/x.mdx\0 D t/y.mdx\0');
		assert.deepStrictEqual(entries, [
			{ index: 'R', worktree: ' ', path: 't/new/a.mdx', origin: 't/old/a.mdx' },
			{ index: '?', worktree: '?', path: 't/x.mdx' },
			{ index: ' ', worktree: 'D', path: 't/y.mdx' }
		]);
	});

	test('changes are split into the ticket, its children and its old location', () => {
		const prefix = '.tracker/EP-1-Auth/ST-1.2-Sign_in/';
		const entries = parseStatus(
			[
				` M ${prefix}Story.mdx`,
				`?? ${prefix}assets/shot.png`,
				`?? ${prefix}ERD-1-Accounts.mdx`,
				`?? ${prefix}AC-1.2.1-Wrong_password/AC.mdx`,
				// The folder before a rename, deleted by the file system.
				` D .tracker/EP-1-Auth/ST-1.2-Old_name/Story.mdx`,
				` D .tracker/EP-1-Auth/ST-1.2-Old_name/AC-1.2.1-Wrong_password/AC.mdx`,
				// A sibling that is not this ticket, and a sibling's deletion.
				` M .tracker/EP-1-Auth/ST-1.3-Other/Story.mdx`,
				` D .tracker/EP-1-Auth/ST-1.3-Other/history.md`,
				// A file of this ticket's id that was not deleted is a duplicate, not an old location.
				` M .tracker/EP-1-Auth/ST-1.2-Duplicate/Story.mdx`
			].join('\0')
		);
		assert.deepStrictEqual(classifyChanges(entries, prefix), {
			own: [
				`.tracker/EP-1-Auth/ST-1.2-Old_name/Story.mdx`,
				`${prefix}ERD-1-Accounts.mdx`,
				`${prefix}Story.mdx`,
				`${prefix}assets/shot.png`
			],
			children: [
				`.tracker/EP-1-Auth/ST-1.2-Old_name/AC-1.2.1-Wrong_password/AC.mdx`,
				`${prefix}AC-1.2.1-Wrong_password/AC.mdx`
			]
		});
	});

	test('a change marks the deepest ticket folder around it, never its ancestors', () => {
		const marks = changedTicketFolders(
			parseStatus(
				[
					' M .tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx',
					'?? .tracker/EP-1-Auth/ST-1.1-Sign_in/assets/EP-9-Not_a_ticket/x.png',
					'?? .tracker/EP-1-Auth/ST-1.2-New/Story.mdx',
					'?? .tracker/EP-1-Auth/ST-1.2-New/metadata.yaml',
					'A  .tracker/EP-1-Auth/ST-1.3-Staged/Story.mdx',
					' D .tracker/EP-1-Auth/ERD-1-Model.mdx',
					'?? .tracker/README.md',
					'?? .tracker/notes/EP-3-Draft/Epic.mdx',
					' M src/app.ts',
					''
				].join('\0')
			),
			'.tracker/'
		);
		assert.deepStrictEqual(Object.fromEntries(marks), {
			'.tracker/EP-1-Auth/ST-1.1-Sign_in': 'modified',
			'.tracker/EP-1-Auth/ST-1.2-New': 'added',
			'.tracker/EP-1-Auth/ST-1.3-Staged': 'added',
			// A deleted design document is a change to the epic.
			'.tracker/EP-1-Auth': 'modified'
		});
	});

	test('a renamed ticket folder is modified, not new', () => {
		const marks = changedTicketFolders(
			parseStatus(
				[
					' D .tracker/EP-1-Auth/Epic.mdx',
					'?? .tracker/EP-1-Authentication/Epic.mdx',
					'R  .tracker/EP-2-Payments/Epic.mdx',
					'.tracker/EP-2-Billing/Epic.mdx',
					''
				].join('\0')
			),
			'.tracker/'
		);
		assert.deepStrictEqual(Object.fromEntries(marks), {
			'.tracker/EP-1-Auth': 'modified',
			'.tracker/EP-1-Authentication': 'modified',
			'.tracker/EP-2-Payments': 'modified',
			'.tracker/EP-2-Billing': 'modified'
		});
	});

	test('the paths reach git on stdin, with literal pathspecs, never on the command line', async () => {
		const fake = new FakeProcessRunner({ results: [{}, {}, { stdout: 'abc1234\n' }] });
		const hash = await commitPaths(fake.runner, '/repo', ['a [1].mdx', 'b.mdx'], 'EP-1: Auth');
		assert.strictEqual(hash, 'abc1234');
		const [add, commit] = fake.requests;
		assert.strictEqual(add.stdin, 'a [1].mdx\0b.mdx');
		assert.strictEqual(commit.stdin, 'a [1].mdx\0b.mdx');
		assert.ok(commit.args.includes('--only'));
		assert.ok(commit.args.includes('EP-1: Auth'));
		assert.ok(!commit.args.includes('b.mdx'));
		assert.strictEqual(commit.env?.GIT_LITERAL_PATHSPECS, '1');
	});

	test('a missing git is said in words', async () => {
		const fake = new FakeProcessRunner({ missingAt: [0] });
		await assert.rejects(
			ticketChanges(fake.runner, '/repo/.tracker/EP-1-A'),
			(error: unknown) => error instanceof CommitError && error.code === 'not-installed'
		);
	});

	suite('against a real repository', () => {
		let root: string;

		setup(async () => {
			root = await mkdtemp(path.join(os.tmpdir(), 'bfast-commit-'));
			await git(root, 'init', '-q');
			await git(root, 'config', 'user.email', 'test@example.com');
			await git(root, 'config', 'user.name', 'Test');
			await git(root, 'config', 'commit.gpgsign', 'false');
			await put(root, '.tracker/EP-1-Auth/Epic.mdx', 'epic');
			await put(root, '.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx', 'story');
			await put(root, '.tracker/EP-2-Billing/Epic.mdx', 'billing');
			await put(root, 'src/app.ts', 'code');
			await git(root, 'add', '-A');
			await git(root, 'commit', '-q', '-m', 'init');
		});

		teardown(async () => {
			await rm(root, { recursive: true, force: true });
		});

		test('commits the ticket alone and leaves what else is staged staged', async () => {
			await put(root, '.tracker/EP-1-Auth/Epic.mdx', 'epic, reviewed');
			await put(root, '.tracker/EP-1-Auth/history.md', 'history');
			await put(root, '.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx', 'story, edited');
			await put(root, '.tracker/EP-2-Billing/Epic.mdx', 'billing, edited');
			await put(root, 'src/app.ts', 'code, staged');
			await git(root, 'add', 'src/app.ts');

			const changes = await ticketChanges(runProcess, path.join(root, '.tracker/EP-1-Auth'));
			assert.deepStrictEqual(changes.own, [
				'.tracker/EP-1-Auth/Epic.mdx',
				'.tracker/EP-1-Auth/history.md'
			]);
			assert.deepStrictEqual(changes.children, ['.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx']);

			await commitPaths(runProcess, changes.top, changes.own, 'EP-1: Auth');

			const committed = await git(root, 'show', '--name-only', '--format=%s', 'HEAD');
			assert.deepStrictEqual(committed.trim().split('\n').filter(Boolean), [
				'EP-1: Auth',
				'.tracker/EP-1-Auth/Epic.mdx',
				'.tracker/EP-1-Auth/history.md'
			]);
			const left = await git(root, 'status', '--porcelain');
			assert.match(left, /^M {2}src\/app\.ts$/m, 'the staged file stays staged');
			assert.match(left, /^ M \.tracker\/EP-1-Auth\/ST-1\.1-Sign_in\/Story\.mdx$/m);
			assert.match(left, /^ M \.tracker\/EP-2-Billing\/Epic\.mdx$/m);
		});

		test('a renamed folder is committed as a rename, never as a second copy', async () => {
			await rename(
				path.join(root, '.tracker/EP-1-Auth'),
				path.join(root, '.tracker/EP-1-Authentication')
			);
			const changes = await ticketChanges(
				runProcess,
				path.join(root, '.tracker/EP-1-Authentication')
			);
			await commitPaths(runProcess, changes.top, [...changes.own, ...changes.children], 'rename');

			const tree = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '.tracker');
			assert.deepStrictEqual(tree.trim().split('\n'), [
				'.tracker/EP-1-Authentication/Epic.mdx',
				'.tracker/EP-1-Authentication/ST-1.1-Sign_in/Story.mdx',
				'.tracker/EP-2-Billing/Epic.mdx'
			]);
			assert.strictEqual((await git(root, 'status', '--porcelain')).trim(), '');
		});

		test('the marks name each ticket folder with changes of its own', async () => {
			await put(root, '.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx', 'story, edited');
			await put(root, '.tracker/EP-1-Auth/ST-1.1-Sign_in/assets/a.png', 'png');
			await put(root, '.tracker/EP-1-Auth/ST-1.2-Sign_out/Story.mdx', 'new');
			await put(root, 'src/app.ts', 'not the tracker');
			await rename(path.join(root, '.tracker/EP-2-Billing'), path.join(root, '.tracker/EP-2-Payments'));

			const { prefix, entries } = await trackerStatus(runProcess, path.join(root, '.tracker'));
			assert.strictEqual(prefix, '.tracker/');
			assert.deepStrictEqual(
				[...changedTicketFolders(entries, prefix)].sort(),
				[
					['.tracker/EP-1-Auth/ST-1.1-Sign_in', 'modified'],
					['.tracker/EP-1-Auth/ST-1.2-Sign_out', 'added'],
					['.tracker/EP-2-Billing', 'modified'],
					['.tracker/EP-2-Payments', 'modified']
				]
			);
		});

		test('a folder outside any repository is refused in words', async () => {
			const outside = await mkdtemp(path.join(os.tmpdir(), 'bfast-norepo-'));
			try {
				await assert.rejects(
					ticketChanges(runProcess, outside),
					(error: unknown) => error instanceof CommitError && error.code === 'not-a-repository'
				);
			} finally {
				await rm(outside, { recursive: true, force: true });
			}
		});
	});
});
