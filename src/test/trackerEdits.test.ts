import * as assert from 'assert';
import * as path from 'node:path';
import {
	contentFileUnder,
	DENIED_TOOLS,
	EDIT_RUN_TOOLS,
	editRulesFor,
	previousText,
	runSettingsJson,
	TrackerEditLog,
	type EditableFile
} from '../ai/trackerEdits';

const FILES: EditableFile[] = [
	{ id: 'EP-1', type: 'epic', path: '.tracker/EP-1-Auth/Epic.mdx' },
	{ id: 'ST-1.1', type: 'story', path: '.tracker/EP-1-Auth/ST-1.1-Sign_in,_now_(beta)/Story.mdx' },
	{ id: 'EP-2', type: 'epic', path: '.tracker/EP-2-Billing/Epic.mdx' }
];

suite('Tracker edit rules', () => {
	// One rule per existing file, never a glob: the spike showed `Edit` creating
	// a file that did not exist, and an `Edit(...)` rule admitting it.
	test('allows exactly the existing content files, and denies the ticket being written', () => {
		const rules = editRulesFor(FILES, 'ST-1.1');
		assert.deepStrictEqual([...rules.tools], ['Read', 'Glob', 'Grep', 'Edit']);
		assert.deepStrictEqual(rules.allow, [
			'Edit(.tracker/EP-1-Auth/Epic.mdx)',
			'Edit(.tracker/EP-2-Billing/Epic.mdx)'
		]);
		assert.deepStrictEqual(rules.deny, [
			'Write',
			'NotebookEdit',
			'MultiEdit',
			'Edit(.tracker/EP-1-Auth/ST-1.1-Sign_in,_now_(beta)/Story.mdx)'
		]);
	});

	test('a run with no ticket of its own denies only the writing tools', () => {
		const rules = editRulesFor(FILES);
		assert.strictEqual(rules.allow.length, 3);
		assert.deepStrictEqual(rules.deny, [...DENIED_TOOLS]);
	});

	// The posture the read-only allow-list already has: a test, not a comment.
	test('no rule ever names a tool that writes freely or runs anything', () => {
		const rules = editRulesFor(FILES, 'EP-1');
		for (const rule of [...rules.allow, ...rules.tools]) {
			assert.ok(!/^(Write|Bash|NotebookEdit|MultiEdit|WebFetch)/.test(rule), rule);
		}
		assert.ok(rules.allow.every((rule) => rule.startsWith('Edit(') && rule.endsWith(')')));
		assert.ok(!EDIT_RUN_TOOLS.includes('Write' as never));
	});

	test('refuses a path that is not a workspace-relative content file', () => {
		for (const file of [
			{ id: 'EP-1', type: 'epic', path: '/abs/.tracker/EP-1/Epic.mdx' },
			{ id: 'EP-1', type: 'epic', path: '.tracker/../EP-1/Epic.mdx' },
			{ id: 'EP-1', type: 'epic', path: '.tracker\\EP-1\\Epic.mdx' },
			{ id: 'EP-1', type: 'epic', path: '.tracker/EP-1/metadata.yaml' },
			{ id: 'EP-1', type: 'epic', path: '.tracker/EP-1/Story.mdx' }
		] as EditableFile[]) {
			assert.throws(() => editRulesFor([file]), new RegExp(file.type));
		}
	});

	test('the settings file carries the rules verbatim', () => {
		const parsed = JSON.parse(runSettingsJson(editRulesFor(FILES, 'EP-2')));
		assert.deepStrictEqual(Object.keys(parsed), ['permissions']);
		assert.ok(parsed.permissions.allow.includes('Edit(.tracker/EP-1-Auth/ST-1.1-Sign_in,_now_(beta)/Story.mdx)'));
		assert.ok(parsed.permissions.deny.includes('Edit(.tracker/EP-2-Billing/Epic.mdx)'));
	});
});

suite('Tracker edit log', () => {
	const cwd = path.resolve('/ws');
	const tracker = '.tracker';
	const epic = path.join(cwd, '.tracker', 'EP-1-Auth', 'Epic.mdx');

	test('recognises a content file under the tracker, relative or absolute', () => {
		assert.strictEqual(contentFileUnder(cwd, tracker, '.tracker/EP-1-Auth/Epic.mdx'), epic);
		assert.strictEqual(contentFileUnder(cwd, tracker, epic), epic);
		assert.strictEqual(contentFileUnder(cwd, tracker, '.tracker/EP-1-Auth/metadata.yaml'), undefined);
		assert.strictEqual(contentFileUnder(cwd, tracker, '.tracker/EP-1-Auth/ERD-1-x.mdx'), undefined);
		assert.strictEqual(contentFileUnder(cwd, tracker, 'notes/Epic.mdx'), undefined);
		assert.strictEqual(contentFileUnder(cwd, tracker, '.tracker-other/EP-1/Epic.mdx'), undefined);
		assert.strictEqual(contentFileUnder(cwd, tracker, path.join(cwd, 'Epic.mdx')), undefined);
	});

	function log(disk: Record<string, string>, updatedAt = '2026-01-01T00:00:00.000Z') {
		return new TrackerEditLog({
			cwd,
			trackerRoot: tracker,
			read: async (file) => disk[file],
			updatedAt: async () => updatedAt
		});
	}

	// The agent reads, edits, then reads again to check its work. The snapshot
	// has to be the first read: taken again after the edit, the file would look
	// unchanged, nothing would be adopted, and a board open on it mid-edit would
	// clobber the agent's text without a warning.
	test('the first event naming a file takes the snapshot, and a later read never replaces it', async () => {
		const disk = { [epic]: 'before' };
		const edits = log(disk);
		edits.observe({ kind: 'use', id: 'r1', name: 'Read', filePath: epic });
		edits.observe({ kind: 'result', id: 'r1', error: false });
		disk[epic] = 'after';
		edits.observe({
			kind: 'use',
			id: 'e1',
			name: 'Edit',
			filePath: '.tracker/EP-1-Auth/Epic.mdx',
			edit: { oldString: 'before', newString: 'after', replaceAll: false }
		});
		edits.observe({ kind: 'result', id: 'e1', error: false });
		edits.observe({ kind: 'use', id: 'r2', name: 'Read', filePath: epic });
		edits.observe({ kind: 'result', id: 'r2', error: false });

		const [edit] = await edits.settle();
		assert.strictEqual(edit.path, epic);
		assert.deepStrictEqual(edit.snapshot, {
			text: 'before',
			updatedAt: '2026-01-01T00:00:00.000Z',
			unsafe: false
		});
		assert.strictEqual(edit.edits.length, 1);
	});

	test('a snapshot taken on an edit is marked unsafe', async () => {
		const edits = log({ [epic]: 'maybe already edited' });
		edits.observe({
			kind: 'use',
			id: 'e1',
			name: 'Edit',
			filePath: epic,
			edit: { oldString: 'a', newString: 'b', replaceAll: false }
		});
		edits.observe({ kind: 'result', id: 'e1', error: false });
		const [edit] = await edits.settle();
		assert.strictEqual(edit.snapshot?.unsafe, true);
	});

	// A rule denial and a mismatched `old_string` both look like an Edit in the
	// request stream; only the result says whether anything happened.
	test('a file counts as edited only when an edit of it succeeded', async () => {
		const edits = log({ [epic]: 'x' });
		edits.observe({ kind: 'use', id: 'r1', name: 'Read', filePath: epic });
		edits.observe({
			kind: 'use',
			id: 'e1',
			name: 'Edit',
			filePath: epic,
			edit: { oldString: 'x', newString: 'y', replaceAll: false }
		});
		edits.observe({ kind: 'result', id: 'e1', error: true });
		assert.deepStrictEqual(await edits.settle(), []);

		// Files that are not content files, or not under the tracker, never appear.
		edits.observe({
			kind: 'use',
			id: 'e2',
			name: 'Edit',
			filePath: '.tracker/EP-1-Auth/metadata.yaml',
			edit: { oldString: 'a', newString: 'b', replaceAll: false }
		});
		edits.observe({ kind: 'result', id: 'e2', error: false });
		assert.deepStrictEqual(await edits.settle(), []);
	});

	test('reconstructs the previous text by reversing the edits, and gives up when ambiguous', () => {
		assert.strictEqual(previousText('a b c', [{ oldString: 'B', newString: 'b', replaceAll: false }]), 'a B c');
		assert.strictEqual(
			previousText('one two three', [
				{ oldString: '1', newString: 'one', replaceAll: false },
				{ oldString: '3', newString: 'three', replaceAll: false }
			]),
			'1 two 3'
		);
		assert.strictEqual(previousText('x x', [{ oldString: 'y', newString: 'x', replaceAll: true }]), 'y y');
		// `x` occurs twice and the edit replaced one of them: which one is unknowable.
		assert.strictEqual(previousText('x x', [{ oldString: 'y', newString: 'x', replaceAll: false }]), undefined);
		assert.strictEqual(previousText('gone', [{ oldString: 'a', newString: 'zzz', replaceAll: false }]), undefined);
		assert.strictEqual(previousText('text', [{ oldString: 'a', newString: '', replaceAll: false }]), undefined);
	});
});
