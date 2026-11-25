import * as assert from 'assert';
import * as vscode from 'vscode';
import { deleteFolder, FileTicketStore } from '../data/fileTicketStore';
import { buildTree, TicketNode } from '../data/ticketTree';
import { TicketConflictError, TicketTypeChangeError, type FolderRename } from '../data/ticketStore';
import { TrackerContext } from '../data/trackerContext';

/**
 * A scratch tracker inside the fixture workspace. Deliberately NOT reached
 * through `SettingsService`: writing a real `.vscode/bfast.json` would flip the
 * `bfast.configured` context key and make the other suites depend on which one
 * happened to run first.
 */
const ROOT = vscode.Uri.joinPath(
	vscode.workspace.workspaceFolders![0].uri,
	'.tracker-it'
);

const context: TrackerContext = {
	rootUri: () => ROOT,
	author: () => 'Test Runner'
};

async function read(...parts: string[]): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ROOT, ...parts));
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

async function names(...parts: string[]): Promise<string[]> {
	const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(ROOT, ...parts));
	return entries.map(([name]) => name).sort();
}

async function write(content: string, ...parts: string[]): Promise<void> {
	await vscode.workspace.fs.writeFile(
		vscode.Uri.joinPath(ROOT, ...parts),
		new TextEncoder().encode(content)
	);
}

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

function keys(nodes: TicketNode[]): string[] {
	return nodes.flatMap((node) => [node.ticket.id, ...keys(node.children)]);
}

/** A ticket folder written by hand, named the way the old, longer rule named one. */
async function oldTicket(folder: string[], contentFile: string, id: string, title: string): Promise<void> {
	await write(
		`id: ${id}\ntitle: ${title}\nstatus: todo\nupdatedAt: 2026-09-01T00:00:00.000Z\n`,
		...folder,
		'metadata.yaml'
	);
	await write('Its description.', ...folder, contentFile);
	await write('## 2026-09-01T00:00:00.000Z — Someone — created\n', ...folder, 'history.md');
}

function byId(renames: FolderRename[]): FolderRename[] {
	return [...renames].sort((a, b) => a.id.localeCompare(b.id));
}

suite('File ticket store', () => {
	let store: FileTicketStore;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
	});

	suiteTeardown(reset);

	test('an empty or missing tracker folder yields no tickets', async () => {
		assert.deepStrictEqual(await store.listSummaries(), []);
	});

	test('creating a ticket writes the three files', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Authentication & access' });

		assert.strictEqual(epic.id, 'EP-1');
		assert.strictEqual(epic.key, 'EP-1');
		assert.strictEqual(epic.status, 'todo');

		// `&` is legal in a folder name, so the slug keeps it.
		const folder = 'EP-1-Authentication_&_access';
		assert.deepStrictEqual(await names(), [folder]);
		assert.deepStrictEqual(await names(folder), ['Epic.mdx', 'history.md', 'metadata.yaml']);

		const metadata = await read(folder, 'metadata.yaml');
		assert.ok(metadata?.includes('id: EP-1'), metadata);
		assert.ok(metadata?.includes('status: todo'), metadata);
		assert.ok(metadata?.includes('createdBy: Test Runner'), metadata);

		const history = await read(folder, 'history.md');
		assert.ok(history?.includes('Test Runner'), history);
		assert.ok(history?.includes('created'), history);
	});

	test('ids follow the nesting, and per-type ordinals keep siblings apart', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({
			parentId: epic.id,
			type: 'story',
			title: 'Sign in'
		});
		const ac = await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		const standalone = await store.createTicket({
			parentId: story.id,
			type: 'testcase',
			title: 'Smoke'
		});

		assert.deepStrictEqual(
			[epic.id, story.id, ac.id, standalone.id],
			['EP-1', 'ST-1.1', 'AC-1.1.1', 'TC-1.1.1']
		);

		// The AC's test case and the story's standalone one share an ordinal but
		// not an id, because ordinals are counted per type within a parent.
		const summaries = await store.listSummaries();
		const underAc = summaries.find((ticket) => ticket.parentId === ac.id);
		assert.strictEqual(underAc?.id, 'TC-1.1.1.1');

		assert.deepStrictEqual(keys(buildTree(summaries)), [
			'EP-1',
			'ST-1.1',
			'AC-1.1.1',
			'TC-1.1.1.1',
			'TC-1.1.1'
		]);
	});

	test('an epic can hold sub-epics beside its stories, and every id stays unique', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		const sub = await store.createTicket({ parentId: epic.id, type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Audit' });
		const deepStory = await store.createTicket({ parentId: sub.id, type: 'story', title: 'Sign in' });
		const ac = await store.createAcceptanceCriterion(story.id, 'Logged', 'Entry written');
		const deepAc = await store.createAcceptanceCriterion(deepStory.id, 'Wrong password', 'Same error');

		// The story takes ordinal 2, not 1: sub-epics and stories share a
		// sequence, so `ST-1.1` and `EP-1.1` cannot both exist.
		assert.deepStrictEqual(
			[epic.id, sub.id, story.id, deepStory.id, ac.id, deepAc.id],
			['EP-1', 'EP-1.1', 'ST-1.2', 'ST-1.1.1', 'AC-1.2.1', 'AC-1.1.1.1']
		);

		store.invalidate();
		const summaries = await store.listSummaries();
		const ids = summaries.map((ticket) => ticket.id);
		assert.strictEqual(new Set(ids).size, ids.length, ids.join(', '));
		assert.strictEqual(summaries.find((t) => t.id === 'ST-1.1.1')?.parentId, 'EP-1.1');
		assert.deepStrictEqual(
			(await store.listChildren(epic.id)).map((ticket) => ticket.id),
			['EP-1.1', 'ST-1.2']
		);

		// A fresh store walks down through the sub-epic by ordinal alone.
		const fresh = new FileTicketStore(context);
		assert.strictEqual((await fresh.getSummary('TC-1.1.1.1.1'))?.parentId, 'AC-1.1.1.1');
		assert.strictEqual((await fresh.getSummary('TC-1.2.1.1'))?.parentId, 'AC-1.2.1');
	});

	test('a stray epic folder beside an existing story never renames the story', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same error');
		const epicFolder = (await names())[0];

		// The shape an older tracker could already hold — an epic folder copied
		// into another by hand, which BFAST used to skip — claiming the
		// story's ordinal.
		await write('id: EP-1.1\ntitle: Stray\nstatus: todo\n', epicFolder, 'EP-1.1-Stray', 'metadata.yaml');
		await write('', epicFolder, 'EP-1.1-Stray', 'Epic.mdx');

		store.invalidate();
		const children = await store.listChildren(epic.id);
		assert.deepStrictEqual(children.map((ticket) => ticket.id), ['EP-1.1#2', 'ST-1.1']);
		assert.strictEqual(children[0].warning, 'Duplicate id');
		assert.strictEqual(children[1].warning, undefined);

		// The story's whole subtree keeps the ids it had.
		const ids = (await store.listSummaries()).map((ticket) => ticket.id).sort();
		assert.deepStrictEqual(ids, ['AC-1.1.1', 'EP-1', 'EP-1.1#2', 'ST-1.1', 'TC-1.1.1.1']);
		assert.strictEqual((await new FileTicketStore(context).getSummary('TC-1.1.1.1'))?.parentId, 'AC-1.1.1');
	});

	test('a sub-epic becomes a story and back, keeping its ordinal and everything it holds', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		const sub = await store.createTicket({ parentId: epic.id, type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Audit' });
		await store.updateDescription(sub.id, 'The body.');
		const epicFolder = (await names())[0];
		await write('![x](assets/x.png)', epicFolder, 'EP-1.1-Auth', 'ERD-1-Model.mdx');
		const before = await store.getDetail(sub.id);

		assert.deepStrictEqual(await store.planTypeChange(sub.id, 'story'), { id: 'EP-1.1', newId: 'ST-1.1' });
		const story = await store.changeType(sub.id, 'story');

		assert.strictEqual(story.id, 'ST-1.1');
		assert.strictEqual(story.type, 'story');
		assert.strictEqual(story.parentId, epic.id);
		assert.deepStrictEqual(await names(epicFolder), [
			'Epic.mdx',
			'ST-1.1-Auth',
			'ST-1.2-Audit',
			'history.md',
			'metadata.yaml'
		]);
		assert.deepStrictEqual(await names(epicFolder, 'ST-1.1-Auth'), [
			'ERD-1-Model.mdx',
			'Story.mdx',
			'history.md',
			'metadata.yaml'
		]);

		const after = await store.getDetail('ST-1.1');
		assert.strictEqual(after?.description, 'The body.');
		assert.strictEqual(after?.title, before?.title);
		assert.strictEqual(after?.status, before?.status);
		assert.strictEqual(after?.createdAt, before?.createdAt);
		assert.notStrictEqual(after?.updatedAt, before?.updatedAt);
		assert.strictEqual(after?.warning, undefined);
		const last = after?.history[after.history.length - 1];
		assert.deepStrictEqual(
			[last?.action, last?.field, last?.from, last?.to],
			['changed', 'type', 'epic', 'story']
		);
		assert.ok((await read(epicFolder, 'ST-1.1-Auth', 'metadata.yaml'))?.includes('id: ST-1.1'));

		// And back again; a fresh store reads it the same.
		const back = await store.changeType('ST-1.1', 'epic');
		assert.strictEqual(back.id, 'EP-1.1');
		assert.strictEqual((await new FileTicketStore(context).getSummary('EP-1.1'))?.type, 'epic');
		assert.deepStrictEqual(
			(await store.listChildren(epic.id)).map((ticket) => ticket.id),
			['EP-1.1', 'ST-1.2']
		);
	});

	test('the same type again is a non-event', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Audit' });
		const before = await store.getDetail(story.id);

		await store.changeType(story.id, 'story');

		const after = await store.getDetail(story.id);
		assert.strictEqual(after?.updatedAt, before?.updatedAt);
		assert.strictEqual(after?.history.length, before?.history.length);
	});

	test('a type change that would break the hierarchy is refused and writes nothing', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same error');
		const sub = await store.createTicket({ parentId: epic.id, type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: sub.id, type: 'story', title: 'Reset' });
		const snapshot = async () => JSON.stringify(await store.listSummaries());
		const before = await snapshot();

		// A top-level epic has nowhere to be a story.
		await assert.rejects(() => store.changeType(epic.id, 'story'), TicketTypeChangeError);
		await assert.rejects(() => store.planTypeChange(epic.id, 'story'), /top level/);
		// A story with criteria, an epic with stories.
		await assert.rejects(() => store.changeType(story.id, 'epic'), /a child/);
		await assert.rejects(() => store.changeType(sub.id, 'story'), /a child/);
		// Nothing but an epic or a story converts.
		await assert.rejects(() => store.changeType('AC-1.1.1', 'testcase'), TicketTypeChangeError);

		store.invalidate();
		assert.strictEqual(await snapshot(), before);
	});

	test('a type change out of a hand-made clash takes the next free ordinal', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		const epicFolder = (await names())[0];
		await write('id: EP-1.1\ntitle: Stray\nstatus: todo\n', epicFolder, 'EP-1.1-Stray', 'metadata.yaml');
		await write('', epicFolder, 'EP-1.1-Stray', 'Epic.mdx');
		store.invalidate();

		const story = await store.changeType('EP-1.1#2', 'story');

		assert.strictEqual(story.id, 'ST-1.2');
		assert.deepStrictEqual(
			(await store.listChildren(epic.id)).map((ticket) => [ticket.id, ticket.warning]),
			[['ST-1.1', undefined], ['ST-1.2', undefined]]
		);
	});

	test('an acceptance criterion arrives with its test case in one step', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');

		const acFolder = ['EP-1-Auth', 'ST-1.1-Sign_in', 'AC-1.1.1-Wrong_password'];
		assert.deepStrictEqual(await names(...acFolder), [
			'AC.mdx',
			'TC-1.1.1.1-Same_message',
			'history.md',
			'metadata.yaml'
		]);

		// Created together, so it is never flagged as childless.
		const ac = (await store.listSummaries()).find((ticket) => ticket.type === 'ac');
		assert.strictEqual(ac?.warning, undefined);
	});

	test('a gap left by a delete is not filled in', async () => {
		await store.createTicket({ type: 'epic', title: 'Auth' });
		const second = await store.createTicket({ type: 'epic', title: 'Billing' });
		await store.createTicket({ type: 'epic', title: 'Reporting' });

		await store.deleteTicket(second.id);
		const fresh = await store.createTicket({ type: 'epic', title: 'Search' });

		// EP-2 is free again but stays free: the next id is one past the highest
		// that still exists, so a live ticket's id is never handed out twice.
		assert.strictEqual(fresh.id, 'EP-4');
	});

	test('deleting the last ticket does free its ordinal again', async () => {
		const only = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.deleteTicket(only.id);

		// Nothing on disk remembers EP-1 existed, so it comes back. Ordinals are
		// derived from what is there, not from a counter.
		assert.strictEqual((await store.createTicket({ type: 'epic', title: 'Billing' })).id, 'EP-1');
	});

	test('a file system with no trash still deletes the folder', async () => {
		// What a remote workspace (SSH, WSL, a container) answers: the provider
		// has no trash at all, and a confirmed Delete must not fail on that.
		const asked: boolean[] = [];
		await deleteFolder(ROOT, async (_uri, options) => {
			asked.push(options.useTrash);
			if (options.useTrash) {
				throw new Error('Unable to delete file via trash because provider does not support it.');
			}
		});

		assert.deepStrictEqual(asked, [true, false]);
	});

	test('a test case can sit directly under an epic, beside its sub-epics and stories', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		const journey = await store.createTicket({ parentId: epic.id, type: 'testcase', title: 'Sign up then sign in' });
		const sub = await store.createTicket({ parentId: epic.id, type: 'epic', title: 'SSO' });

		// Its own sequence: containers share one, a test case is not a container.
		assert.deepStrictEqual([story.id, journey.id, sub.id], ['ST-1.1', 'TC-1.1', 'EP-1.2']);
		assert.strictEqual((await store.getSummary(journey.id))?.parentId, epic.id);
		assert.deepStrictEqual(
			(await store.listChildren(epic.id)).map((ticket) => ticket.id).sort(),
			['EP-1.2', 'ST-1.1', 'TC-1.1']
		);
	});

	test('a test case is assigned to a service with one history entry, and cleared the same way', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Shop' });
		const tc = await store.createTicket({ parentId: epic.id, type: 'testcase', title: 'Checkout journey' });

		const assigned = await store.setService(tc.id, 'orders');
		assert.strictEqual(assigned.service, 'orders');
		assert.strictEqual((await store.getSummary(tc.id))?.service, 'orders');
		const entry = assigned.history.at(-1)!;
		assert.deepStrictEqual([entry.action, entry.field, entry.from, entry.to], ['changed', 'service', undefined, 'orders']);
		assert.ok(assigned.updatedAt, 'a service change stamps updatedAt');

		// The same service again is a non-event.
		const again = await store.setService(tc.id, 'orders');
		assert.strictEqual(again.history.length, assigned.history.length);
		assert.strictEqual(again.updatedAt, assigned.updatedAt);

		const cleared = await store.setService(tc.id, undefined);
		assert.strictEqual(cleared.service, undefined);
		assert.deepStrictEqual([cleared.history.at(-1)!.from, cleared.history.at(-1)!.to], ['orders', undefined]);

		await assert.rejects(() => store.setService(epic.id, 'orders'), /Only a test case/);
		await assert.rejects(() => store.setService(tc.id, 'Not An Id'), /not a service id/);
	});

	test('the hierarchy is enforced, whoever asks', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });

		await assert.rejects(
			() => store.createTicket({ parentId: epic.id, type: 'ac', title: 'Nope' }),
			/cannot contain/
		);
		await assert.rejects(
			() => store.createTicket({ type: 'story', title: 'Nope' }),
			/top level/
		);
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await assert.rejects(
			() => store.createTicket({ parentId: story.id, type: 'epic', title: 'Nope' }),
			/cannot contain/
		);
	});

	test('saving a description rewrites the mdx and records one change', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const before = await store.getDetail(epic.id);

		const saved = await store.updateDescription(epic.id, 'Now with a body.', before?.updatedAt);

		assert.strictEqual(saved.description, 'Now with a body.');
		assert.strictEqual(await read('EP-1-Auth', 'Epic.mdx'), 'Now with a body.');
		assert.notStrictEqual(saved.updatedAt, before?.updatedAt);

		assert.deepStrictEqual(
			saved.history.map((entry) => `${entry.action} ${entry.field ?? ''}`.trim()),
			['created', 'changed description']
		);

		// The entry says what the text was, not only that it moved.
		const change = saved.history[1];
		assert.strictEqual(change.from, '');
		assert.strictEqual(change.to, 'Now with a body.');
	});

	test('a description edit records the text on both sides of it', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const first = await store.updateDescription(epic.id, '## Goal\n\nSign in with **email**.');
		const second = await store.updateDescription(
			epic.id,
			'## Goal\n\nSign in with email or SSO.',
			first.updatedAt
		);

		const change = second.history[2];
		assert.strictEqual(change.field, 'description');
		assert.strictEqual(change.from, '## Goal\n\nSign in with **email**.');
		assert.strictEqual(change.to, '## Goal\n\nSign in with email or SSO.');

		// A description full of markdown must not split its own history entry.
		assert.strictEqual(second.history.length, 3);
	});

	test('a description change can record where the text came from', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const note = 'Generated with the BFAST AI assistant (Claude Code CLI, claude-opus-5).';
		const saved = await store.updateDescription(epic.id, '## Goal\n\nSign in.', undefined, {
			comment: note
		});

		const change = saved.history[1];
		assert.strictEqual(change.action, 'changed');
		assert.strictEqual(change.field, 'description');
		// The author stays the person who pressed Save; the comment is what says a
		// model was involved. Recording "claude" as the author would hide who ran it.
		assert.strictEqual(change.author, 'Test Runner');
		assert.strictEqual(change.comment, note);

		// It survives the round trip through the file, not just the return value.
		const reloaded = await store.getDetail(epic.id);
		assert.strictEqual(reloaded?.history[1].comment, note);
		assert.ok((await read('EP-1-Auth', 'history.md'))?.includes(note));
	});

	test('an ordinary description change still writes no comment', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const saved = await store.updateDescription(epic.id, 'By hand.');

		assert.strictEqual(saved.history[1].comment, undefined);

		// No blockquote line at all, so an ordinary edit still serialises exactly
		// as it always has and existing history files read back unchanged.
		const history = (await read('EP-1-Auth', 'history.md')) ?? '';
		assert.ok(!history.split('\n').some((line) => line.startsWith('>')));
	});

	test('a stale save is refused rather than clobbering the file', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const opened = await store.getDetail(epic.id);

		// Something else writes in the meantime.
		await store.updateDescription(epic.id, 'From an editor tab.');

		await assert.rejects(
			() => store.updateDescription(epic.id, 'From the board.', opened?.updatedAt),
			TicketConflictError
		);
		assert.strictEqual(await read('EP-1-Auth', 'Epic.mdx'), 'From an editor tab.');
	});

	test('changing status records where it came from', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const updated = await store.updateStatus(epic.id, 'in-progress');

		assert.strictEqual(updated.status, 'in-progress');
		assert.ok((await read('EP-1-Auth', 'metadata.yaml'))?.includes('status: in-progress'));

		const last = updated.history[updated.history.length - 1];
		assert.deepStrictEqual(
			{ field: last.field, from: last.from, to: last.to },
			{ field: 'status', from: 'todo', to: 'in-progress' }
		);
	});

	test('a status change can carry provenance, read back as the comment', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const updated = await store.updateStatus(epic.id, 'done', {
			comment: 'Test run: `npm test -- --grep EP-1` exited 0 (passed).'
		});

		const last = updated.history[updated.history.length - 1];
		assert.deepStrictEqual(
			{ field: last.field, to: last.to, comment: last.comment },
			{
				field: 'status',
				to: 'done',
				comment: 'Test run: `npm test -- --grep EP-1` exited 0 (passed).'
			}
		);
		// The blockquote survives a disk round-trip through parseHistory.
		const detail = await store.getDetail(epic.id);
		assert.strictEqual(
			detail?.history[detail.history.length - 1].comment,
			'Test run: `npm test -- --grep EP-1` exited 0 (passed).'
		);
	});

	test('an ordinary status change still writes no comment', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.updateStatus(epic.id, 'in-progress');

		const history = (await read('EP-1-Auth', 'history.md')) ?? '';
		assert.ok(!history.split('\n').some((line) => line.startsWith('>')));
	});

	test('renaming moves the folder but not the id', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });

		const renamed = await store.renameTicket(epic.id, 'Authentication');

		assert.strictEqual(renamed.id, 'EP-1');
		assert.deepStrictEqual(await names(), ['EP-1-Authentication']);
		// The child rode along and kept its id, because only the slug moved.
		const story = (await store.listSummaries()).find((ticket) => ticket.type === 'story');
		assert.strictEqual(story?.id, 'ST-1.1');
	});

	test('a rename carries its note, and the same title again writes nothing', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });

		await store.renameTicket(epic.id, 'Authentication', { comment: 'From outside.' });
		const renamed = (await store.getDetail(epic.id))!;
		const entry = renamed.history[renamed.history.length - 1];
		assert.strictEqual(entry.field, 'title');
		assert.strictEqual(entry.comment, 'From outside.');

		// A non-event: no entry, no `updatedAt` bump, the folder untouched.
		const again = await store.renameTicket(epic.id, 'Authentication');
		assert.strictEqual(again.title, 'Authentication');
		const unchanged = (await store.getDetail(epic.id))!;
		assert.strictEqual(unchanged.history.length, renamed.history.length);
		assert.strictEqual(unchanged.updatedAt, renamed.updatedAt);
		assert.deepStrictEqual(await names(), ['EP-1-Authentication']);
	});

	test('an acceptance criterion left without a test case is flagged, not dropped', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');

		// Somebody deletes the last test case by hand.
		await vscode.workspace.fs.delete(
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'ST-1.1-Sign_in', 'AC-1.1.1-Wrong_password', 'TC-1.1.1.1-Same_message'),
			{ recursive: true, useTrash: false }
		);
		store.invalidate();

		const ac = (await store.listSummaries()).find((ticket) => ticket.type === 'ac');
		assert.strictEqual(ac?.id, 'AC-1.1.1');
		assert.strictEqual(ac?.warning, 'No test case yet');
	});

	test('survives a tracker folder mangled by hand', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createTicket({ type: 'epic', title: 'Billing' });
		await store.createTicket({ type: 'epic', title: 'Reporting' });

		// A metadata file goes missing, another turns to nonsense, a stray file
		// and a plain folder show up, and a folder is renamed by hand.
		await vscode.workspace.fs.delete(
			vscode.Uri.joinPath(ROOT, 'EP-2-Billing', 'metadata.yaml'),
			{ useTrash: false }
		);
		await write('}{ not yaml', 'EP-3-Reporting', 'metadata.yaml');
		await write('a bug report', 'EP-1-Auth', 'Bug.mdx');
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(ROOT, 'assets'));
		await write('x', 'assets', 'diagram.png');
		await vscode.workspace.fs.rename(
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'ST-1.1-Sign_in'),
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'ST-1.1-Renamed_by_hand'),
			{ overwrite: false }
		);

		store.invalidate();
		const summaries = await store.listSummaries();

		// Every ticket still loads, in the same shape, and `assets` is not one.
		assert.deepStrictEqual(keys(buildTree(summaries)), [
			'EP-1',
			'ST-1.1',
			'EP-2',
			'EP-3'
		]);

		const billing = summaries.find((ticket) => ticket.id === 'EP-2');
		assert.strictEqual(billing?.warning, 'No metadata.yaml');
		// The title falls back to the folder name once metadata is gone.
		assert.strictEqual(billing?.title, 'Billing');

		// Nonsense metadata still leaves a usable ticket.
		const reporting = summaries.find((ticket) => ticket.id === 'EP-3');
		assert.strictEqual(reporting?.status, 'todo');

		// The hand-renamed folder keeps its id, because nesting decides that.
		const story = summaries.find((ticket) => ticket.type === 'story');
		assert.strictEqual(story?.title, 'Sign in');
	});

	test('a folder moved by hand is reparented, not orphaned', async () => {
		const first = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: first.id, type: 'story', title: 'Sign in' });
		await store.createTicket({ type: 'epic', title: 'Billing' });

		// Drag ST-1.1 under the second epic without renaming it, which is exactly
		// what full-id folder names invite.
		await vscode.workspace.fs.rename(
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'ST-1.1-Sign_in'),
			vscode.Uri.joinPath(ROOT, 'EP-2-Billing', 'ST-1.1-Sign_in'),
			{ overwrite: false }
		);
		store.invalidate();

		const story = (await store.listSummaries()).find((ticket) => ticket.type === 'story');

		// Nesting decides the ancestry, so it is now the first story of EP-2 and
		// its stale folder name is reported rather than obeyed.
		assert.strictEqual(story?.id, 'ST-2.1');
		assert.strictEqual(story?.parentId, 'EP-2');
		assert.strictEqual(story?.warning, 'Id does not match its folder');
	});

	test('two folders resolving to the same id both survive', async () => {
		await store.createTicket({ type: 'epic', title: 'Auth' });

		// The shape a bad merge leaves behind: a second EP-1.
		await write(
			'id: EP-1\ntitle: From another branch\nstatus: todo\n',
			'EP-1-From_another_branch',
			'metadata.yaml'
		);
		await write('', 'EP-1-From_another_branch', 'Epic.mdx');

		store.invalidate();
		const summaries = await store.listSummaries();

		// Neither is silently swallowed by the other in `buildTree`.
		assert.deepStrictEqual(summaries.map((ticket) => ticket.id).sort(), ['EP-1', 'EP-1#2']);
		assert.ok(summaries.some((ticket) => ticket.warning === 'Duplicate id'));
	});

	test('concurrent saves both land, one after the other', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });

		await Promise.all([
			store.updateStatus(epic.id, 'in-progress'),
			store.updateDescription(epic.id, 'Body text.')
		]);

		const detail = await store.getDetail(epic.id);

		// Serialised rather than interleaved: neither write lost the other's
		// history entry.
		assert.strictEqual(detail?.status, 'in-progress');
		assert.strictEqual(detail?.description, 'Body text.');
		assert.strictEqual(detail?.history.length, 3);
	});

	test('an attachment lands in the ticket assets folder, bytes intact', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

		const path = await store.addAttachment(epic.id, 'My Diagram.PNG', bytes);

		assert.strictEqual(path, 'assets/My_Diagram.png');
		assert.deepStrictEqual(await names('EP-1-Auth'), [
			'Epic.mdx',
			'assets',
			'history.md',
			'metadata.yaml'
		]);

		const written = await vscode.workspace.fs.readFile(
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'assets', 'My_Diagram.png')
		);
		assert.deepStrictEqual([...written], [...bytes]);
	});

	test('a second attachment of the same name sits beside the first', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });

		const first = await store.addAttachment(epic.id, 'shot.png', new Uint8Array([1]));
		const second = await store.addAttachment(epic.id, 'shot.png', new Uint8Array([2]));

		assert.strictEqual(first, 'assets/shot.png');
		assert.strictEqual(second, 'assets/shot-1.png');
		assert.deepStrictEqual(await names('EP-1-Auth', 'assets'), ['shot-1.png', 'shot.png']);

		// Both kept their own bytes: nothing was overwritten.
		const one = await vscode.workspace.fs.readFile(
			vscode.Uri.joinPath(ROOT, 'EP-1-Auth', 'assets', 'shot.png')
		);
		assert.deepStrictEqual([...one], [1]);
	});

	test('attaching an image is not a change to the ticket', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const before = await store.getDetail(epic.id);

		await store.addAttachment(epic.id, 'shot.png', new Uint8Array([1]));
		const after = await store.getDetail(epic.id);

		// The board is holding `before.updatedAt` as its save token while the user
		// is still typing; moving it here would fail their own next save.
		assert.strictEqual(after?.updatedAt, before?.updatedAt);
		assert.strictEqual(after?.history.length, before?.history.length);

		// And the assets folder is not a ticket.
		assert.deepStrictEqual((await store.listSummaries()).map((ticket) => ticket.id), [epic.id]);
	});

	test('attaching to a ticket that is not there is refused', async () => {
		await assert.rejects(() => store.addAttachment('EP-9', 'shot.png', new Uint8Array([1])));
	});

	// ------------------------------------------------ shortening folder names

	test('a new or renamed ticket gets a folder name of at most 40 characters', async () => {
		const epic = await store.createTicket({
			type: 'epic',
			title: 'Billing and invoices for every kind of customer'
		});
		assert.deepStrictEqual(await names(), ['EP-1-Billing_and_invoices_for_every_kind']);

		await store.renameTicket(epic.id, 'Authentication and account management for players');
		assert.deepStrictEqual(await names(), ['EP-1-Authentication_and_account']);
	});

	test('shortening renames only folders past 40 characters, and nothing inside them', async () => {
		const epic = ['EP-1-Authentication'];
		const story = [...epic, 'ST-1.1-Create_a_player_account_with_email_and'];
		const ac = [...story, 'AC-1.1.1-Creating_an_account_with_email,_display'];
		const tc = [...ac, 'TC-1.1.1.1-Registers_with_email,_display_name_and'];
		await oldTicket(epic, 'Epic.mdx', 'EP-1', 'Authentication');
		await oldTicket(
			story,
			'Story.mdx',
			'ST-1.1',
			'Create a player account with email and password right inside the game'
		);
		await oldTicket(
			ac,
			'AC.mdx',
			'AC-1.1.1',
			'Creating an account with email, display name and password lands on the map'
		);
		await oldTicket(
			tc,
			'TestCase.mdx',
			'TC-1.1.1.1',
			'Registers with email, display name and password and lands straight on the map'
		);
		store.invalidate();
		const before = await store.listSummaries();
		const metadata = await read(...tc, 'metadata.yaml');
		const history = await read(...tc, 'history.md');

		const planned = await store.longFolderNames();
		const outcome = await store.shortenFolderNames();

		// The epic's name already fits and is left alone.
		assert.deepStrictEqual(
			planned.map((rename) => rename.id),
			['ST-1.1', 'AC-1.1.1', 'TC-1.1.1.1']
		);
		// Deepest first, which is what lets every rename land: each parent's
		// carries its already-renamed child along.
		assert.deepStrictEqual(
			outcome.renamed.map((rename) => rename.id),
			['TC-1.1.1.1', 'AC-1.1.1', 'ST-1.1']
		);
		assert.deepStrictEqual(outcome.skipped, []);
		assert.deepStrictEqual(byId(outcome.renamed), byId(planned));

		const renamed = [
			'EP-1-Authentication',
			'ST-1.1-Create_a_player_account_with',
			'AC-1.1.1-Creating_an_account_with_email',
			'TC-1.1.1.1-Registers_with_email,_display'
		];
		assert.deepStrictEqual(await names(...renamed), ['TestCase.mdx', 'history.md', 'metadata.yaml']);

		// Only names moved: every id and title, and the files themselves, are as
		// they were — `updatedAt` and the history included.
		assert.deepStrictEqual(await store.listSummaries(), before);
		assert.strictEqual(await read(...renamed, 'metadata.yaml'), metadata);
		assert.strictEqual(await read(...renamed, 'history.md'), history);

		// And there is nothing left to shorten.
		assert.deepStrictEqual(await store.longFolderNames(), []);
	});

	test('a folder whose new name is taken is skipped and reported, and the rest still go', async () => {
		// A bad merge left two EP-1s with one title, which shorten to one name.
		const title = 'Authentication and account management for players';
		await oldTicket(['EP-1-Authentication_and_account_management_for'], 'Epic.mdx', 'EP-1', title);
		await oldTicket(
			['EP-1-Authentication_and_account_management_for_players'],
			'Epic.mdx',
			'EP-1',
			title
		);
		await oldTicket(
			['EP-2-Billing_and_invoices_for_every_kind_of_customer'],
			'Epic.mdx',
			'EP-2',
			'Billing and invoices for every kind of customer'
		);
		store.invalidate();

		const outcome = await store.shortenFolderNames();

		assert.deepStrictEqual(outcome.renamed.map((rename) => rename.to).sort(), [
			'EP-1-Authentication_and_account',
			'EP-2-Billing_and_invoices_for_every_kind'
		]);
		assert.strictEqual(outcome.skipped.length, 1);
		assert.strictEqual(outcome.skipped[0].to, 'EP-1-Authentication_and_account');
		assert.match(outcome.skipped[0].reason, /already exists/);
		// Nothing was overwritten: all three tickets are still there.
		assert.strictEqual((await names()).length, 3);
		assert.strictEqual((await store.listSummaries()).length, 3);
	});
	// ----------------------------------------------------- reading by level

	test('lists one level at a time, saying whether each ticket has children', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		const empty = await store.createTicket({ type: 'epic', title: 'Billing' });

		assert.deepStrictEqual(
			(await store.listChildren()).map((ticket) => [ticket.id, ticket.hasChildren]),
			[['EP-1', true], ['EP-2', false]]
		);
		assert.deepStrictEqual((await store.listChildren(epic.id)).map((ticket) => ticket.id), ['ST-1.1']);
		assert.deepStrictEqual((await store.listChildren(story.id)).map((ticket) => ticket.id), ['AC-1.1.1']);
		assert.deepStrictEqual((await store.listChildren('AC-1.1.1')).map((ticket) => ticket.id), ['TC-1.1.1.1']);
		// A leaf, an empty epic, an unknown parent and nonsense all list nothing.
		assert.deepStrictEqual(await store.listChildren('TC-1.1.1.1'), []);
		assert.deepStrictEqual(await store.listChildren(empty.id), []);
		assert.deepStrictEqual(await store.listChildren('EP-9'), []);
		assert.deepStrictEqual(await store.listChildren('garbage'), []);
	});

	test('a ticket is found by walking down to it, never by reading everything', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		await store.createAcceptanceCriterion(story.id, 'Wrong password', 'Same message');
		await store.createTicket({ type: 'epic', title: 'Billing' });

		// A store that has read nothing yet, and is not allowed to read everything.
		const cold = new FileTicketStore(context);
		cold.listSummaries = () => {
			throw new Error('read the whole tracker');
		};

		assert.strictEqual((await cold.getSummary('TC-1.1.1.1'))?.parentId, 'AC-1.1.1');
		assert.strictEqual((await cold.getDetail('AC-1.1.1'))?.title, 'Wrong password');
		assert.ok((await cold.folderUri('ST-1.1'))?.path.endsWith('ST-1.1-Sign_in'));
		assert.strictEqual(await cold.getSummary('EP-9'), undefined);
		// The story has no standalone test case; only the AC's TC-1.1.1.1 exists.
		assert.strictEqual(await cold.getSummary('TC-1.1.1'), undefined);
		assert.strictEqual(await cold.getSummary('garbage'), undefined);
	});

	test('the flag on an acceptance criterion follows its folder listing', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		const ac = await store.createTicket({ parentId: story.id, type: 'ac', title: 'Wrong password' });

		const [flagged] = await store.listChildren(story.id);
		assert.strictEqual(flagged.warning, 'No test case yet');
		assert.strictEqual(flagged.hasChildren, false);

		await store.createTicket({ parentId: ac.id, type: 'testcase', title: 'Same message' });
		const [cleared] = await store.listChildren(story.id);
		assert.strictEqual(cleared.warning, undefined);
		assert.strictEqual(cleared.hasChildren, true);
	});

	test('a duplicate parent’s children carry its rank, read by level or all at once', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		// A bad merge: a second EP-1, with a story of its own.
		const other = 'EP-1-From_another_branch';
		await write('id: EP-1\ntitle: From another branch\nstatus: todo\n', other, 'metadata.yaml');
		await write('', other, 'Epic.mdx');
		await write('id: ST-1.1\ntitle: Their story\nstatus: todo\n', other, 'ST-1.1-Their_story', 'metadata.yaml');
		await write('', other, 'ST-1.1-Their_story', 'Story.mdx');
		store.invalidate();

		// Whichever folder the file system listed second took the rank.
		const epics = await store.listChildren();
		assert.deepStrictEqual(epics.map((ticket) => ticket.id).sort(), ['EP-1', 'EP-1#2']);
		const ranked = epics.find((ticket) => ticket.id === 'EP-1#2');
		const plain = epics.find((ticket) => ticket.id === 'EP-1');
		assert.ok(ranked && plain);
		assert.strictEqual(ranked.warning, 'Duplicate id');
		assert.strictEqual(ranked.key, 'EP-1#2');

		// The rank sits on the epic's segment of the story's id, and the story's
		// own key stays plain; its folder and metadata never carried one.
		const [theirs] = await store.listChildren('EP-1#2');
		assert.deepStrictEqual(
			[theirs.id, theirs.key, theirs.parentId, theirs.warning],
			['ST-1#2.1', 'ST-1', 'EP-1#2', undefined]
		);
		assert.deepStrictEqual((await store.listChildren('EP-1')).map((ticket) => ticket.id), ['ST-1.1']);
		const rankedStory = ranked.title === 'From another branch' ? 'Their story' : 'Sign in';
		assert.strictEqual((await store.getDetail('ST-1#2.1'))?.title, rankedStory);

		// Read all at once instead, the same ids come out.
		store.invalidate();
		assert.deepStrictEqual(
			(await store.listSummaries()).map((ticket) => ticket.id).sort(),
			['EP-1', 'EP-1#2', 'ST-1#2.1', 'ST-1.1']
		);
	});

	test('a load in flight when a write lands cannot poison what comes after', async () => {
		await store.createTicket({ type: 'epic', title: 'Auth' });

		// Started before the write, so it answers for the disk as it was asked.
		const inFlight = store.listChildren();
		await store.createTicket({ type: 'epic', title: 'Billing' });

		assert.deepStrictEqual((await inFlight).map((ticket) => ticket.id), ['EP-1']);
		assert.deepStrictEqual((await store.listChildren()).map((ticket) => ticket.id), ['EP-1', 'EP-2']);
	});

	test('a create counts its siblings from disk, not from a tree that was never read', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Auth' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'One' });
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Two' });

		const cold = new FileTicketStore(context);
		const third = await cold.createTicket({ parentId: 'EP-1', type: 'story', title: 'Three' });

		assert.strictEqual(third.id, 'ST-1.3');
		assert.strictEqual(third.hasChildren, false);
	});


	// An AI run may edit another ticket's description file directly. The store
	// did not write it, so nothing bumped `updatedAt` or wrote history — this is
	// the call that does, after the fact, and only when it can be honest.
	suite('adopting a description written outside the store', () => {
		test('records the change with both sides and bumps updatedAt', async () => {
			const epic = await store.createTicket({ type: 'epic', title: 'Authentication', description: 'old' });
			const before = (await store.getDetail(epic.id))!;
			await write('new text', 'EP-1-Authentication', 'Epic.mdx');

			const adopted = await store.adoptDescription(
				epic.id,
				{ text: 'old', updatedAt: before.updatedAt },
				{ comment: 'Edited by an agent.' }
			);
			assert.strictEqual(adopted.outcome, 'recorded');
			assert.notStrictEqual(adopted.ticket.updatedAt, before.updatedAt);

			const entry = adopted.ticket.history.at(-1)!;
			assert.strictEqual(entry.action, 'changed');
			assert.strictEqual(entry.field, 'description');
			assert.strictEqual(entry.from, 'old');
			assert.strictEqual(entry.to, 'new text');
			assert.strictEqual(entry.comment, 'Edited by an agent.');
		});

		test('leaves out a previous text it was not given, rather than guessing one', async () => {
			const epic = await store.createTicket({ type: 'epic', title: 'Authentication', description: 'old' });
			await write('new text', 'EP-1-Authentication', 'Epic.mdx');
			const adopted = await store.adoptDescription(epic.id, undefined, {});
			assert.strictEqual(adopted.outcome, 'recorded');
			const entry = adopted.ticket.history.at(-1)!;
			assert.strictEqual(entry.from, undefined);
			assert.strictEqual(entry.to, 'new text');
		});

		test('writes nothing when the file still holds the previous text', async () => {
			const epic = await store.createTicket({ type: 'epic', title: 'Authentication', description: 'same' });
			const before = (await store.getDetail(epic.id))!;
			const adopted = await store.adoptDescription(epic.id, { text: 'same' }, {});
			assert.strictEqual(adopted.outcome, 'unchanged');
			assert.strictEqual(adopted.ticket.updatedAt, before.updatedAt);
			assert.strictEqual(adopted.ticket.history.length, before.history.length);
		});

		// The user saved from a board between the agent's edit and this call. The
		// store recorded that save under their name; recording it again under the
		// agent's would be a lie.
		test('stands down when the store has written the ticket since', async () => {
			const epic = await store.createTicket({ type: 'epic', title: 'Authentication', description: 'old' });
			const before = (await store.getDetail(epic.id))!;
			await store.updateDescription(epic.id, 'saved by a person', before.updatedAt);

			const adopted = await store.adoptDescription(epic.id, { text: 'old', updatedAt: before.updatedAt }, {});
			assert.strictEqual(adopted.outcome, 'superseded');
			assert.strictEqual(adopted.ticket.history.at(-1)?.to, 'saved by a person');
		});
	});

	// The inverse of `folderUri`, for a file path a tool reported.
	test('finds the ticket a content file belongs to by walking the nesting', async () => {
		const epic = await store.createTicket({ type: 'epic', title: 'Authentication' });
		const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		const storyFile = vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'ST-1.1-Sign_in', 'Story.mdx');

		assert.strictEqual((await store.ticketAt(storyFile))?.id, story.id);
		assert.strictEqual(
			(await store.ticketAt(vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'Epic.mdx')))?.id,
			epic.id
		);
		// A file that is not inside a ticket folder is nobody's.
		assert.strictEqual(await store.ticketAt(vscode.Uri.joinPath(ROOT, 'notes.md')), undefined);
		assert.strictEqual(
			await store.ticketAt(vscode.Uri.joinPath(ROOT, 'EP-1-Authentication', 'stray', 'Story.mdx')),
			undefined
		);
	});

	// docs/tracker/ §Links is the specification.
	suite('links', () => {
		async function three() {
			const epic = await store.createTicket({ type: 'epic', title: 'Authentication' });
			const a = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
			const b = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign out' });
			return { epic, a, b };
		}

		test('a link is written on both tickets, each in its own words', async () => {
			const { a, b } = await three();
			const beforeB = (await store.getDetail(b.id))!;

			const detail = await store.linkTickets(a.id, 'blocks', b.id);

			assert.deepStrictEqual(
				detail.links?.map((link) => [link.relation, link.id, link.target?.title]),
				[['blocks', 'ST-1.2', 'Sign out']]
			);
			const other = (await store.getDetail(b.id))!;
			assert.deepStrictEqual(
				other.links?.map((link) => [link.relation, link.id]),
				[['is-blocked-by', 'ST-1.1']]
			);
			assert.ok((await read('EP-1-Authentication', 'ST-1.1-Sign_in', 'metadata.yaml'))?.includes('blocks: ST-1.2'));
			assert.ok((await read('EP-1-Authentication', 'ST-1.2-Sign_out', 'metadata.yaml'))?.includes('blockedBy: ST-1.1'));

			// One entry each, and no `updatedAt` bump: a board mid-edit must still save.
			const last = other.history.at(-1)!;
			assert.deepStrictEqual([last.action, last.field, last.to], ['linked', 'is blocked by', 'ST-1.1']);
			assert.strictEqual(other.updatedAt, beforeB.updatedAt);
			await store.updateDescription(b.id, 'Still saves.', beforeB.updatedAt);
			// …and the save keeps the link.
			assert.strictEqual((await store.getDetail(b.id))?.links?.length, 1);
		});

		test('the same link again writes nothing; itself and a missing ticket are refused', async () => {
			const { a, b } = await three();
			await store.linkTickets(a.id, 'relates-to', b.id);
			const history = (await store.getDetail(b.id))!.history.length;

			// From the other side, `relates to` is its own inverse: already there.
			await store.linkTickets(b.id, 'relates-to', a.id);
			assert.strictEqual((await store.getDetail(b.id))!.history.length, history);

			await assert.rejects(() => store.linkTickets(a.id, 'blocks', a.id), /itself/);
			await assert.rejects(() => store.linkTickets(a.id, 'blocks', 'ST-9.9'), /ST-9\.9/);
		});

		test('unlinking removes both sides; a link to a ticket that is gone still comes off', async () => {
			const { a, b } = await three();
			await store.linkTickets(a.id, 'duplicates', b.id);

			const detail = await store.unlinkTickets(b.id, 'is-duplicated-by', a.id);
			assert.deepStrictEqual(detail.links, []);
			assert.deepStrictEqual((await store.getDetail(a.id))?.links, []);
			assert.ok(!(await read('EP-1-Authentication', 'ST-1.1-Sign_in', 'metadata.yaml'))?.includes('duplicates'));
			assert.strictEqual((await store.getDetail(a.id))?.history.at(-1)?.action, 'unlinked');

			// A dangling id, typed by hand: shown without a target, and removable.
			const metadata = (await read('EP-1-Authentication', 'ST-1.1-Sign_in', 'metadata.yaml'))!;
			await write(`${metadata}clonedBy: ST-1.7\n`, 'EP-1-Authentication', 'ST-1.1-Sign_in', 'metadata.yaml');
			store.invalidate();
			const dangling = (await store.getDetail(a.id))!.links!;
			assert.deepStrictEqual(dangling, [{ relation: 'is-cloned-by', id: 'ST-1.7' }]);
			assert.deepStrictEqual((await store.unlinkTickets(a.id, 'is-cloned-by', 'ST-1.7')).links, []);
		});

		test('a type change re-points the other side of every link', async () => {
			const epic = await store.createTicket({ type: 'epic', title: 'Platform' });
			const sub = await store.createTicket({ parentId: epic.id, type: 'epic', title: 'Auth' });
			const story = await store.createTicket({ parentId: epic.id, type: 'story', title: 'Audit' });
			await store.linkTickets(story.id, 'clones', sub.id);

			await store.changeType(sub.id, 'story');

			assert.deepStrictEqual(
				(await store.getDetail(story.id))?.links?.map((link) => [link.relation, link.id, link.target?.type]),
				[['clones', 'ST-1.1', 'story']]
			);
		});

		test('deleting a ticket takes its links off the tickets that remain', async () => {
			const { epic, a, b } = await three();
			const ac = await store.createTicket({ parentId: b.id, type: 'ac', title: 'Session ends' });
			await store.linkTickets(a.id, 'is-blocked-by', b.id);
			await store.linkTickets(ac.id, 'relates-to', a.id);
			await store.linkTickets(ac.id, 'relates-to', b.id);

			await store.deleteTicket(b.id);

			const left = (await store.getDetail(a.id))!;
			assert.deepStrictEqual(left.links, []);
			// The story and the criterion inside it both linked to `a`, and both
			// went with the delete: one `unlinked` entry each, in subtree order.
			assert.deepStrictEqual(
				left.history.slice(-2).map((entry) => [entry.action, entry.from, entry.comment]),
				[
					['unlinked', 'ST-1.2', 'ST-1.2 was deleted.'],
					['unlinked', 'AC-1.2.1', 'AC-1.2.1 was deleted.']
				]
			);
			// The link inside the deleted subtree needed nothing; the epic is untouched.
			assert.deepStrictEqual((await store.getDetail(epic.id))?.links, []);
		});
	});
});
