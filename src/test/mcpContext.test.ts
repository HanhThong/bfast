// The MCP tools' *meaning*, against a real tracker.
//
// `mcpTools.test.ts` proves the dispatch with a `FakeMcpContext`; this suite
// drives `bfastMcpContext` — the `vscode` half — against a real
// `FileTicketStore` in a scratch folder, with the batches and the environment
// store faked as literals. What the stories promise about a write from outside
// is about what lands on disk: the history entry, its provenance, and the
// entries that must *not* be written.
//
// The tracker is a scratch folder reached through a `TrackerContext` rather
// than through `SettingsService`, for the reason `fileTicketStore.test.ts`
// gives: writing a real `bfast.json` would flip `bfast.configured`.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileTicketStore } from '../data/fileTicketStore';
import { BUILT_IN_STYLES } from '../design/designDocument';
import { DesignStore } from '../design/designStore';
import type { TrackerContext } from '../data/trackerContext';
import type { EnvironmentHandle } from '../environments/environmentProvider';
import { bfastMcpContext, MCP_PROVENANCE, type McpEnvironments } from '../mcp/mcpContext';
import type { McpToolContext } from '../mcp/mcpTools';
import type { TestBatches, TestBatchStart } from '../testing/testBatches';
import type { McpSettingsAccess } from '../mcp/mcpSettingsContext';
import { normalizeSettings, validateSettings, type BfastSettings } from '../settings/bfastSettings';

const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-mcp');

const tracker: TrackerContext = {
	rootUri: () => ROOT,
	author: () => 'Test Runner'
};

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

/** A batches table that answers what the test scripted and counts the asks. */
function fakeBatches(answer: TestBatchStart): TestBatches & { started: string[] } {
	const started: string[] = [];
	return {
		started,
		start: async (root) => {
			started.push(root);
			return answer;
		},
		cancel: () => undefined,
		batchFor: () => undefined,
		snapshot: () => undefined,
		onDidProgress: () => () => undefined
	};
}

function handle(id: string, overrides: Partial<EnvironmentHandle> = {}): EnvironmentHandle {
	return {
		id,
		scope: 'ticket',
		ticketId: id,
		kind: 'docker-compose',
		branch: `story/${id}`,
		worktreePath: `/tmp/${id}`,
		projectName: `bfast-${id.toLowerCase()}`,
		ports: { WEB_PORT: 21000 },
		createdAt: '2026-01-01T00:00:00.000Z',
		status: 'stopped',
		...overrides
	};
}

/** An environment store that lists what it was given and records what it was asked. */
function fakeEnvironments(
	handles: EnvironmentHandle[],
	availability: { ok: boolean; message?: string } = { ok: true }
): McpEnvironments & { operations: string[] } {
	const operations: string[] = [];
	return {
		operations,
		availability: async () => availability,
		list: async () => handles,
		find: async (id) => handles.find((candidate) => candidate.id === id),
		start: async (id) => {
			operations.push(`start ${id}`);
		},
		stop: async (id) => {
			operations.push(`stop ${id}`);
		}
	};
}

suite('MCP context', () => {
	let store: FileTicketStore;
	let writes: number;
	let batches: ReturnType<typeof fakeBatches>;
	let environments: ReturnType<typeof fakeEnvironments>;
	let context: McpToolContext;

	setup(async () => {
		await reset();
		store = new FileTicketStore(tracker);
		writes = 0;
		batches = fakeBatches({ kind: 'started', completed: Promise.resolve(undefined) });
		environments = fakeEnvironments([]);
		context = bfastMcpContext({
			store,
			designs: new DesignStore(store, {
				styles: async () => BUILT_IN_STYLES,
				author: () => 'Test Runner'
			}),
			batches,
			environments,
			onDidWrite: () => {
				writes++;
			},
			startScan: async () => ({ started: true, message: 'scan' })
		});
	});

	suiteTeardown(reset);

	test('an empty or missing tracker lists nothing, and a bad id is a refusal naming it', async () => {
		assert.deepStrictEqual(await context.listTickets(undefined), []);
		assert.strictEqual(await context.getTicket('ST-9.9'), undefined);
		assert.strictEqual(await context.getTicket('not-an-id'), undefined);
		assert.strictEqual(writes, 0, 'reading never announces a write');
	});

	test('a create lands in the tracker with its provenance, and the window is told', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		const story = await context.createTicket({
			parentId: epic.id,
			type: 'story',
			title: 'Sign in',
			description: '**As a** user'
		});

		const detail = (await store.getDetail(story.id))!;
		assert.strictEqual(detail.status, 'todo');
		assert.strictEqual(detail.description, '**As a** user');
		assert.strictEqual(detail.createdBy, 'Test Runner');
		assert.strictEqual(detail.history.length, 1);
		assert.strictEqual(detail.history[0].action, 'created');
		assert.strictEqual(detail.history[0].author, 'Test Runner');
		assert.match(detail.history[0].comment ?? '', new RegExp(MCP_PROVENANCE));
		assert.strictEqual(writes, 2);

		// The children come back in tree order, ready for the next list.
		const children = await context.listTickets(epic.id);
		assert.deepStrictEqual(
			children.map((ticket) => ticket.id),
			[story.id]
		);
	});

	test('a type the parent cannot contain is refused, and nothing is created elsewhere', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		await assert.rejects(
			() => context.createTicket({ parentId: epic.id, type: 'ac', title: 'Nope' }),
			/epic cannot contain a ac/
		);
		await assert.rejects(
			() => context.createTicket({ type: 'story', title: 'Nope' }),
			/cannot sit at the top level/
		);
		assert.deepStrictEqual(await context.listTickets(epic.id), []);
		assert.strictEqual(writes, 1);
	});

	test('a rename is recorded under the user with its provenance; the same title writes nothing', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		const before = (await store.getDetail(epic.id))!;

		const renamed = await context.renameTicket(epic.id, 'Authentication');
		assert.strictEqual(renamed.id, epic.id);
		assert.strictEqual(renamed.title, 'Authentication');

		const after = (await store.getDetail(epic.id))!;
		assert.strictEqual(after.title, 'Authentication');
		const entry = after.history[after.history.length - 1];
		assert.strictEqual(entry.field, 'title');
		assert.strictEqual(entry.from, 'Auth');
		assert.strictEqual(entry.to, 'Authentication');
		assert.strictEqual(entry.author, 'Test Runner');
		assert.match(entry.comment ?? '', new RegExp(MCP_PROVENANCE));
		assert.notStrictEqual(after.updatedAt, before.updatedAt);
		assert.strictEqual(writes, 2);

		// A rename to the title it already carries is a non-event: no entry, no
		// `updatedAt` bump — but still an announced write, which is harmless.
		const again = await context.renameTicket(epic.id, 'Authentication');
		assert.strictEqual(again.title, 'Authentication');
		const unchanged = (await store.getDetail(epic.id))!;
		assert.strictEqual(unchanged.history.length, after.history.length);
		assert.strictEqual(unchanged.updatedAt, after.updatedAt);
	});

	test('a status move is recorded as the sidebar records it, plus where it came from', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });

		const moved = await context.setStatus(epic.id, 'in-progress');
		assert.strictEqual(moved.status, 'in-progress');

		const detail = (await store.getDetail(epic.id))!;
		assert.strictEqual(detail.status, 'in-progress');
		const entry = detail.history[detail.history.length - 1];
		assert.strictEqual(entry.action, 'changed');
		assert.strictEqual(entry.field, 'status');
		assert.strictEqual(entry.from, 'todo');
		assert.strictEqual(entry.to, 'in-progress');
		assert.strictEqual(entry.author, 'Test Runner');
		assert.match(entry.comment ?? '', new RegExp(MCP_PROVENANCE));
		assert.strictEqual(writes, 2);
	});

	test('the same status again writes nothing — no entry, no updatedAt bump, no refresh', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		await context.setStatus(epic.id, 'done');
		const before = (await store.getDetail(epic.id))!;
		const writesBefore = writes;

		const answer = await context.setStatus(epic.id, 'done');
		assert.strictEqual(answer.status, 'done', 'the tool is still told the state it asked for');

		const after = (await store.getDetail(epic.id))!;
		assert.strictEqual(after.history.length, before.history.length);
		assert.strictEqual(after.updatedAt, before.updatedAt);
		assert.strictEqual(writes, writesBefore);
	});

	test('a status move on a ticket that does not exist names it and writes nothing', async () => {
		await assert.rejects(() => context.setStatus('ST-9.9', 'done'), /ST-9\.9/);
		assert.strictEqual(writes, 0);
	});

	test('run_tests starts the batch and never awaits it; a refusal to start twice is not a failure', async () => {
		const report = await context.runTests('EP-1');
		assert.strictEqual(report.started, true);
		assert.deepStrictEqual(batches.started, ['EP-1']);

		for (const reason of ['running', 'overlap'] as const) {
			const busy = bfastMcpContext({
				store,
				batches: fakeBatches({ kind: 'refused', reason, message: `${reason}!` }),
				environments,
				startScan: async () => ({ started: true, message: 'scan' })
			});
			assert.deepStrictEqual(await busy.runTests('EP-1'), { started: false, message: `${reason}!` });
		}

		// No command, or no such ticket: a settings or tracker problem the tool
		// is told about in words, not a run that quietly finds nothing to do.
		for (const reason of ['unconfigured', 'not-found'] as const) {
			const refused = bfastMcpContext({
				store,
				batches: fakeBatches({ kind: 'refused', reason, message: `${reason}!` }),
				environments,
				startScan: async () => ({ started: true, message: 'scan' })
			});
			await assert.rejects(() => refused.runTests('EP-1'), new RegExp(`${reason}!`));
		}
		assert.strictEqual(writes, 0, 'a run is not a change to a ticket');
	});

	test('list_environments flattens each handle, names its ticket, and carries the error reason', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		environments = fakeEnvironments([
			handle('master', { scope: 'master', ticketId: undefined, branch: 'main', status: 'running' }),
			handle(epic.id, { status: 'error', statusDetail: 'Port 21000 is taken.' }),
			handle('ST-9.9', { branch: '' })
		]);
		context = bfastMcpContext({
			store,
			batches,
			environments,
			startScan: async () => ({ started: true, message: 'scan' })
		});

		const listed = await context.listEnvironments();
		assert.deepStrictEqual(
			listed.map((env) => [env.id, env.ticketId, env.title, env.branch, env.status, env.error]),
			[
				['master', undefined, undefined, 'main', 'running', undefined],
				[epic.id, epic.id, 'Auth', `story/${epic.id}`, 'error', 'Port 21000 is taken.'],
				// A ticket that no longer exists: the id with no title, still listed.
				['ST-9.9', 'ST-9.9', undefined, undefined, 'stopped', undefined]
			]
		);
		assert.deepStrictEqual(listed[1].ports, { WEB_PORT: 21000 });
	});

	test('start and stop are queued and answered at once; an unknown id is refused', async () => {
		environments = fakeEnvironments([handle('ST-1.1')]);
		context = bfastMcpContext({
			store,
			batches,
			environments,
			startScan: async () => ({ started: true, message: 'scan' })
		});

		const started = await context.startEnvironment('ST-1.1');
		assert.strictEqual(started.started, true);
		const stopped = await context.stopEnvironment('ST-1.1');
		assert.strictEqual(stopped.started, true);
		assert.deepStrictEqual(environments.operations, ['start ST-1.1', 'stop ST-1.1']);

		await assert.rejects(() => context.startEnvironment('ST-2.2'), /No environment “ST-2\.2”/);
		assert.strictEqual(environments.operations.length, 2);
		assert.strictEqual(writes, 0, 'an environment operation is not a change to a ticket');
	});

	test('a backend that is not available refuses a start or stop up front, but still lists', async () => {
		environments = fakeEnvironments([handle('ST-1.1', { status: 'unknown' })], {
			ok: false,
			message: 'Docker is not installed.'
		});
		context = bfastMcpContext({
			store,
			batches,
			environments,
			startScan: async () => ({ started: true, message: 'scan' })
		});

		assert.strictEqual((await context.listEnvironments())[0].status, 'unknown');
		await assert.rejects(() => context.startEnvironment('ST-1.1'), /Docker is not installed/);
		await assert.rejects(() => context.stopEnvironment('ST-1.1'), /Docker is not installed/);
		assert.deepStrictEqual(environments.operations, []);
	});
	test('a design document is added, rewritten and read back, each write recorded on the ticket', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		writes = 0;

		const listed = await context.listDesigns(epic.id);
		assert.deepStrictEqual(listed.designs, []);
		assert.deepStrictEqual(
			listed.styles.map((style) => style.prefix),
			['ERD', 'SEQ', 'LLD']
		);

		// By prefix, any case; a bare diagram is fenced so it renders.
		const erd = await context.createDesign({
			ticketId: epic.id,
			style: 'erd',
			title: 'Account model',
			body: 'erDiagram\n  USER ||--o{ SESSION : opens'
		});
		assert.strictEqual(erd.id, 'ERD-1');
		assert.strictEqual(erd.style, 'entity-relationship-diagram');
		assert.strictEqual(erd.body, '```mermaid\nerDiagram\n  USER ||--o{ SESSION : opens\n```');

		const lld = await context.createDesign({
			ticketId: epic.id,
			style: 'low-level-design',
			title: 'Token service'
		});
		assert.strictEqual(lld.id, 'LLD-1');
		assert.strictEqual(lld.body, '');

		const updated = await context.updateDesign({
			ticketId: epic.id,
			designId: 'lld-1',
			body: '## Components\n\nOne service.\n',
			baseUpdatedAt: lld.updatedAt
		});
		assert.strictEqual(updated.body, '## Components\n\nOne service.');
		assert.deepStrictEqual(await context.getDesign(epic.id, 'LLD-1'), updated);
		assert.deepStrictEqual(
			(await context.listDesigns(epic.id)).designs.map((design) => design.id),
			['ERD-1', 'LLD-1']
		);

		const detail = (await store.getDetail(epic.id))!;
		const designed = detail.history.filter((entry) => entry.action === 'designed');
		assert.strictEqual(designed.length, 3);
		for (const entry of designed) {
			assert.strictEqual(entry.author, 'Test Runner');
			assert.match(entry.comment ?? '', new RegExp(MCP_PROVENANCE));
		}
		assert.strictEqual(writes, 3);
	});

	test('the same body again writes nothing, and a stale baseUpdatedAt is refused', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		const erd = await context.createDesign({
			ticketId: epic.id,
			style: 'ERD',
			title: 'Model',
			body: '```mermaid\nerDiagram\n```'
		});
		const before = (await store.getDetail(epic.id))!.history.length;
		writes = 0;

		const same = await context.updateDesign({
			ticketId: epic.id,
			designId: erd.id,
			body: erd.body
		});
		assert.strictEqual(same.updatedAt, erd.updatedAt);
		assert.strictEqual(writes, 0);
		assert.strictEqual((await store.getDetail(epic.id))!.history.length, before);

		await context.updateDesign({ ticketId: epic.id, designId: erd.id, body: 'Edited by a person.' });
		writes = 0;
		await assert.rejects(
			context.updateDesign({
				ticketId: epic.id,
				designId: erd.id,
				body: 'The agent’s version.',
				baseUpdatedAt: erd.updatedAt
			}),
			/changed since it was read/
		);
		assert.strictEqual((await context.getDesign(epic.id, erd.id))!.body, 'Edited by a person.');
		assert.strictEqual(writes, 0);
	});

	test('a design on a ticket that cannot carry one, a missing ticket or an unknown style is refused', async () => {
		const epic = await context.createTicket({ type: 'epic', title: 'Auth' });
		const story = await context.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in' });
		const ac = await context.createTicket({ parentId: story.id, type: 'ac', title: 'Wrong password' });
		writes = 0;

		await assert.rejects(context.listDesigns(ac.id), /belong to an epic or a story/);
		await assert.rejects(context.listDesigns('ST-9.9'), /No ticket “ST-9.9”/);
		await assert.rejects(
			context.createDesign({ ticketId: story.id, style: 'UML', title: 'x' }),
			/No design style “UML”.*ERD \(entity-relationship-diagram\)/
		);
		await assert.rejects(
			context.updateDesign({ ticketId: story.id, designId: 'ERD-1', body: 'x' }),
			/No design document “ERD-1”/
		);
		assert.strictEqual(await context.getDesign(story.id, 'ERD-1'), undefined);
		assert.deepStrictEqual((await context.listDesigns(story.id)).designs, []);
		assert.strictEqual(writes, 0);
	});

	suite('settings', () => {
		/** `bfast.json` in memory, checked by the pure rules the form's Save runs first. */
		function memorySettings(initial: BfastSettings): McpSettingsAccess & {
			file: BfastSettings;
			writesTo: number;
			notices: string[];
		} {
			const access = {
				file: initial,
				writesTo: 0,
				notices: [] as string[],
				current: () => access.file,
				write: async (candidate: BfastSettings) => {
					access.writesTo++;
					access.file = normalizeSettings(candidate);
					return access.file;
				},
				refusal: (candidate: BfastSettings) => validateSettings(candidate),
				composeServices: async () => ({ services: ['orders', 'postgres'], files: ['docker-compose.yml'] }),
				notify: (message: string) => {
					access.notices.push(message);
				}
			};
			return access;
		}

		let file: ReturnType<typeof memorySettings>;

		setup(() => {
			file = memorySettings({ trackerFolder: '.tracker', userName: 'Test Runner' });
			context = bfastMcpContext({
				store,
				batches,
				environments,
				onDidWrite: () => {
					writes++;
				},
				startScan: async () => ({ started: true, message: 'scan' }),
				settings: file
			});
		});

		test('a service is added, replaced and removed through the form’s own rules, and said in the window', async () => {
			const added = (await context.setTestService({
				id: 'orders',
				folder: './services/orders/',
				e2e: { testCommand: 'npm run e2e -- --grep {{id}}', compose: ['orders', 'postgres'] }
			})) as { added: string; service: unknown };
			assert.strictEqual(added.added, 'orders');
			assert.deepStrictEqual(file.file.tests?.services, [
				{
					id: 'orders',
					folder: 'services/orders',
					e2e: { testCommand: 'npm run e2e -- --grep {{id}}', compose: ['orders', 'postgres'] }
				}
			]);
			assert.match(file.notices[0], /tests\.services/);

			const replaced = (await context.setTestService({ id: 'orders', folder: 'apps/orders' })) as { replaced: string };
			assert.strictEqual(replaced.replaced, 'orders');
			assert.deepStrictEqual(file.file.tests?.services, [{ id: 'orders', folder: 'apps/orders' }]);

			await context.removeTestService('orders');
			assert.strictEqual(file.file.tests, undefined, 'the last service gone takes the empty block with it');
			await assert.rejects(context.removeTestService('orders'), /No service “orders”/);
			assert.strictEqual(file.writesTo, 3);
		});

		test('a value the parse would drop refuses the whole change, and nothing is written', async () => {
			await context.updateSettings('tests', { command: 'npx playwright test --grep {{id}}' });
			assert.strictEqual(file.writesTo, 1);

			await assert.rejects(
				context.updateSettings('tests', { command: 'other', concurrency: 99 }),
				/Tests at once.*Nothing was written/
			);
			await assert.rejects(context.setTestService({ id: 'Orders', folder: 'x' }), /needs an "id"/);
			await assert.rejects(
				context.setTestService({ id: 'orders', folder: '../outside' }),
				/Nothing was written/
			);
			await assert.rejects(context.updateSettings('tests', { comand: 'typo' }), /“comand” is not tests settings/);
			await assert.rejects(
				context.updateSettings('environments', { composeOverrides: ['ok.yml', '/abs.yml'] }),
				/Nothing was written/
			);
			assert.strictEqual(file.writesTo, 1);
			assert.strictEqual(file.file.tests?.command, 'npx playwright test --grep {{id}}');
		});

		test('only the fields sent move, and null clears one', async () => {
			await context.updateSettings('environments', {
				composeFile: 'compose.yml',
				composeOverrides: ['compose.e2e.yml'],
				portVariables: ['WEB_PORT', 'API_PORT']
			});
			await context.updateSettings('environments', { composeOverrides: null });
			assert.deepStrictEqual(file.file.environments, {
				composeFile: 'compose.yml',
				portVariables: ['WEB_PORT', 'API_PORT']
			});
			const read = (await context.getSettings()) as {
				writable: boolean;
				effective: { composeFiles: string[]; testsConfigured: boolean };
			};
			assert.strictEqual(read.writable, true);
			assert.deepStrictEqual(read.effective.composeFiles, ['compose.yml']);
			assert.strictEqual(read.effective.testsConfigured, false);
			assert.deepStrictEqual(await context.listComposeServices(), {
				services: ['orders', 'postgres'],
				files: ['docker-compose.yml']
			});
		});

		test('nothing can be changed while the server is open to the network, though it can be read', async () => {
			file.file = { ...file.file, mcp: { enabled: true, reach: 'network' } };
			const read = (await context.getSettings()) as { writable: boolean; readOnlyReason: string };
			assert.strictEqual(read.writable, false);
			assert.match(read.readOnlyReason, /open to the network/);
			await assert.rejects(context.updateSettings('tests', { command: 'rm -rf /' }), /open to the network/);
			await assert.rejects(context.setTestService({ id: 'orders', folder: 'o' }), /open to the network/);
			assert.strictEqual(file.writesTo, 0);
		});

		test('a test case is assigned only to a declared service, recorded with its provenance', async () => {
			await context.setTestService({ id: 'orders', folder: 'services/orders' });
			const epic = await context.createTicket({ type: 'epic', title: 'Shop' });
			const tc = await context.createTicket({ parentId: epic.id, type: 'testcase', title: 'Checkout' });
			writes = 0;

			await assert.rejects(context.setTestCaseService(tc.id, 'billing'), /No service “billing”.*orders/);
			await assert.rejects(context.setTestCaseService(epic.id, 'orders'), /not one/);
			const assigned = await context.setTestCaseService(tc.id, 'orders');
			assert.strictEqual(assigned.service, 'orders');
			const again = await context.setTestCaseService(tc.id, 'orders');
			assert.strictEqual(again.service, 'orders');
			assert.strictEqual(writes, 1, 'the same service again writes nothing');

			const detail = await store.getDetail(tc.id);
			const last = detail!.history[detail!.history.length - 1];
			assert.strictEqual(last.field, 'service');
			assert.strictEqual(last.to, 'orders');
			assert.match(last.comment ?? '', new RegExp(MCP_PROVENANCE));

			const cleared = await context.setTestCaseService(tc.id, undefined);
			assert.strictEqual(cleared.service, undefined);
		});

		test('without a bfast.json the settings tools say so', async () => {
			const bare = bfastMcpContext({
				store,
				batches,
				environments,
				startScan: async () => ({ started: true, message: 'scan' })
			});
			await assert.rejects(bare.getSettings(), /no BFAST settings yet/);
			await assert.rejects(bare.updateSettings('tests', { command: 'x' }), /no BFAST settings yet/);
		});
	});
});
