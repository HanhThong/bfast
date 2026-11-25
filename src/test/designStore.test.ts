import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import { TicketConflictError, type WritableTicketStore } from '../data/ticketStore';
import { TrackerContext } from '../data/trackerContext';
import { DesignNotAllowedError, DesignStore } from '../design/designStore';
import { BUILT_IN_STYLES, type DesignStyle } from '../design/designDocument';

/** A scratch tracker of this suite's own — see `fileTicketStore.test.ts`. */
const ROOT = vscode.Uri.joinPath(
	vscode.workspace.workspaceFolders![0].uri,
	'.tracker-design'
);

const tracker: TrackerContext = { rootUri: () => ROOT, author: () => 'Test Runner' };

const C4: DesignStyle = { id: 'c4-context', label: 'C4 Context', prefix: 'C4' };
let styles: DesignStyle[] = [...BUILT_IN_STYLES];

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

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

suite('Design store', () => {
	let tickets: FileTicketStore;
	let designs: DesignStore;
	let story: string;
	let epic: string;

	setup(async () => {
		await reset();
		styles = [...BUILT_IN_STYLES];
		tickets = new FileTicketStore(tracker);
		designs = new DesignStore(tickets, {
			styles: async () => styles,
			author: () => 'Test Runner'
		});

		epic = (await tickets.createTicket({ type: 'epic', title: 'Authentication' })).id;
		story = (
			await tickets.createTicket({ parentId: epic, type: 'story', title: 'Sign in with email' })
		).id;
	});

	suiteTeardown(reset);

	test('a ticket with no design documents lists none', async () => {
		assert.deepStrictEqual(await designs.list(story), []);
	});

	test('creating one writes a file beside the ticket’s own', async () => {
		const document = await designs.create(story, 'entity-relationship-diagram', 'Account model');

		assert.strictEqual(document.id, 'ERD-1');
		assert.strictEqual(document.prefix, 'ERD');
		assert.strictEqual(document.fileName, 'ERD-1-Account_model.mdx');
		assert.strictEqual(document.createdBy, 'Test Runner');

		const folder = `EP-1-Authentication/ST-1.1-Sign_in_with_email`;
		assert.deepStrictEqual(await names(folder), [
			'ERD-1-Account_model.mdx',
			'Story.mdx',
			'history.md',
			'metadata.yaml'
		]);

		const text = await read(folder, 'ERD-1-Account_model.mdx');
		assert.ok(text?.startsWith('---\n'));
		assert.ok(text?.includes('style: entity-relationship-diagram'));
	});

	// The two histories are independent: `history.md` is what changed about the
	// ticket, and a design document's own history is git's.
	test('a write files one history entry and never touches updatedAt', async () => {
		const before = await tickets.getDetail(story);
		const document = await designs.create(story, 'sequence-diagram', 'Login flow');
		await designs.update(story, document.id, '```mermaid\nsequenceDiagram\n```');
		const after = await tickets.getDetail(story);

		assert.strictEqual(after?.updatedAt, before?.updatedAt);
		assert.strictEqual(after?.status, before?.status);

		const entries = after!.history.filter((entry) => entry.action === 'designed');
		assert.strictEqual(entries.length, 2);
		assert.ok(entries[0].comment?.includes('Login flow'));
		assert.ok(entries.every((entry) => entry.field === undefined));
	});

	// Empty on purpose: the assistant writes it from what the user says it should
	// show, or the user does by hand. A stock diagram would be one more thing to
	// delete before either.
	test('a new document starts empty', async () => {
		const sequence = await designs.create(story, 'sequence-diagram', 'Login flow');
		assert.strictEqual(sequence.body, '');
		assert.strictEqual((await designs.get(story, 'SEQ-1'))?.body, '');
	});

	test('ordinals are counted per style', async () => {
		await designs.create(story, 'entity-relationship-diagram', 'Accounts');
		await designs.create(story, 'sequence-diagram', 'Login');
		await designs.create(story, 'sequence-diagram', 'Reset');

		assert.deepStrictEqual(
			(await designs.list(story)).map((design) => design.id),
			['ERD-1', 'SEQ-1', 'SEQ-2']
		);
	});

	test('a stale updatedAt is refused', async () => {
		const document = await designs.create(story, 'sequence-diagram', 'Login flow');
		await designs.update(story, document.id, 'first', document.updatedAt);

		await assert.rejects(
			() => designs.update(story, document.id, 'second', document.updatedAt),
			TicketConflictError
		);
		// And the first write is still what is on disk.
		assert.strictEqual((await designs.get(story, document.id))?.body.trim(), 'first');
	});

	test('renaming moves the slug and keeps the id', async () => {
		const document = await designs.create(story, 'sequence-diagram', 'Login flow');
		const renamed = await designs.rename(story, document.id, 'Sign in flow');

		assert.strictEqual(renamed.id, 'SEQ-1');
		assert.strictEqual(renamed.fileName, 'SEQ-1-Sign_in_flow.mdx');

		const listed = await designs.list(story);
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].title, 'Sign in flow');
	});

	test('deleting removes the file and leaves the ticket', async () => {
		const document = await designs.create(story, 'sequence-diagram', 'Login flow');
		await designs.remove(story, document.id);

		assert.deepStrictEqual(await designs.list(story), []);
		assert.ok(await tickets.getSummary(story));
	});

	test('an epic may carry designs; an acceptance criterion may not', async () => {
		assert.ok(await designs.create(epic, 'sequence-diagram', 'Overview'));

		const ac = await tickets.createTicket({ parentId: story, type: 'ac', title: 'Wrong password' });
		await assert.rejects(
			() => designs.create(ac.id, 'sequence-diagram', 'Nope'),
			DesignNotAllowedError
		);
	});

	test('a style nobody configured cannot be created, but its documents survive', async () => {
		styles = [...BUILT_IN_STYLES, C4];
		const document = await designs.create(story, 'c4-context', 'Context');
		assert.strictEqual(document.fileName, 'C4-1-Context.mdx');

		// The style is removed from settings; the document keeps working.
		styles = [...BUILT_IN_STYLES];
		const listed = await designs.list(story);
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0].style, 'c4');
		assert.ok(await designs.update(story, 'C4-1', 'still editable'));

		await assert.rejects(
			() => designs.create(story, 'c4-context', 'Another'),
			DesignNotAllowedError
		);
	});

	// `TicketStore.folderUri` is optional, so the feature has to say so rather
	// than assume every backend is folder-backed.
	test('a tracker with no folders refuses rather than throwing something opaque', async () => {
		const folderless: WritableTicketStore = Object.create(tickets);
		folderless.folderUri = undefined;
		const store = new DesignStore(folderless, {
			styles: async () => styles,
			author: () => 'Test Runner'
		});

		assert.deepStrictEqual(await store.list(story), []);
		await assert.rejects(
			() => store.create(story, 'sequence-diagram', 'Nope'),
			DesignNotAllowedError
		);
	});
});
