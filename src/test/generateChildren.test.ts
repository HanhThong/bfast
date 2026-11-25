// The sidebar's "Generate stories" / "Generate acceptance criteria" /
// "Generate test cases", end to end.
//
// Drives `generateChildren` against a real `FileTicketStore` and a scripted
// `FakeAiProvider`, with the surface injected. That is what the
// `GeneratePrompts` seam exists for: everything between the two AI runs — the
// parsing, the ordering, the writes and the failure rules — is testable without
// opening the generate tab, and a test that had to click through a webview
// would test none of it.
//
// The tracker is a scratch folder reached through a `TrackerContext` rather than
// through `SettingsService`, for the reason `fileTicketStore.test.ts` gives:
// writing a real `bfast.json` would flip `bfast.configured` and make the other
// suites depend on run order.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseAgent, parseSkill, type AgentDefinition } from '../ai/agent';
import { AiError } from '../ai/aiProvider';
import { hasGivenWhenThen } from '../ai/generateChildren';
import { FileTicketStore } from '../data/fileTicketStore';
import type { TrackerContext } from '../data/trackerContext';
import type { TicketSummary, TicketType } from '../data/types';
import {
	generateChildren,
	type GenerateChildrenDeps,
	type GeneratePrompts,
	type GenerateReport,
	type GenerateStep
} from '../ai/generateChildrenCommand';
import type { ChildrenChoice } from '../ai/generateChildrenCommand';
import {
	mementoSessionStore,
	type GenerateSession,
	type GenerateSessionStore
} from '../ai/generateSessions';
import type { GenerateLaneStatus } from '../shared/protocol';
import { sharedLimiter } from '../platform/semaphore';
import { FakeAiProvider } from './fakeAiProvider';

const ROOT = vscode.Uri.joinPath(
	vscode.workspace.workspaceFolders![0].uri,
	'.tracker-generate'
);

const context: TrackerContext = {
	rootUri: () => ROOT,
	author: () => 'Test Runner'
};

const ANALYST: AgentDefinition = parseAgent(
	'---\nname: Analyst\ntypes: epic, story\n---\n\nWrite like an analyst.',
	'analyst',
	[
		parseSkill('---\nname: write-story\ntypes: story\n---\n\nShape a story.', 'write-story'),
		parseSkill(
			'---\nname: break-down-epic\nkind: plan\ntypes: epic\n---\n\nList the stories.',
			'break-down-epic'
		)
	]
);

/** A second agent, so the picker has something to choose between. */
const OWNER: AgentDefinition = parseAgent(
	'---\nname: Owner\ntypes: story\n---\n\nWrite like an owner.',
	'owner',
	[parseSkill('---\nname: write-story\ntypes: story\n---\n\nShape a story.', 'write-story')]
);

/** Writes test cases, and breaks a criterion into them. */
const TESTER: AgentDefinition = parseAgent(
	'---\nname: Tester\ntypes: testcase\n---\n\nWrite like a tester.',
	'tester',
	[
		parseSkill(
			'---\nname: write-test-case\ntypes: testcase\n---\n\nOne runnable test.',
			'write-test-case'
		),
		parseSkill(
			'---\nname: break-down-acceptance-criterion\nkind: plan\ntypes: ac\n---\n\nList the test cases.',
			'break-down-acceptance-criterion'
		)
	]
);

/** A criterion the way `write-acceptance-criterion` shapes one. */
const CRITERION =
	'**Given** a registered user\n**When** they sign in with a wrong password\n' +
	'**Then** a generic error is shown';

/** Records what the flow asked, and answers with what the test scripted. */
class ScriptedPrompts implements GeneratePrompts {
	readonly errors: string[] = [];
	readonly infos: string[] = [];
	/** The titles the flow offered, as the last pick saw them. */
	offered: string[] = [];
	/** Every list the review screen was shown, one per round. */
	readonly offeredRounds: string[][] = [];
	/** The follow-ups each round was told the list reflects. */
	readonly followUpsSeen: string[][] = [];
	/** The conversation the flow offered to continue, if it offered one. */
	continueAsked: GenerateSession | undefined;
	agentAsked = false;
	/** The long steps, in the order they ran — what drives the tab's screens. */
	readonly steps: GenerateStep[] = [];
	/** Everything that would have reached the tab's log. */
	readonly log: string[] = [];
	/** Each ticket as it landed, which is what the tab's list is built from. */
	readonly announced: { key: string; described: boolean }[] = [];
	/**
	 * Every lane transition, which is what the tab's per-agent rows are built
	 * from.
	 *
	 * Not a measure of concurrency: a lane turns `done` when its **ticket** is
	 * created, not when its run finished, so two lanes read as running while one
	 * of them is really just queued behind the ordered creates. What was actually
	 * in flight is `FakeAiProvider.running`.
	 */
	readonly lanes: { lane: number; title: string; status: GenerateLaneStatus }[] = [];

	/** Follow-ups still to send from the review screen, one per round. */
	private readonly pendingFollowUps: string[];

	constructor(
		private readonly script: {
			agent?: AgentDefinition;
			instruction?: string;
			/** Which of the offered titles to keep; `undefined` keeps them all. */
			keep?: (titles: readonly string[]) => string[] | undefined;
			/**
			 * Sent from the review screen one per round, before `keep` decides.
			 * Each replaces the list — or leaves it, when its run stopped or
			 * failed — and the next round sees whatever stands.
			 */
			followUps?: string[];
			/** The answer to "continue the previous conversation?", when offered. */
			continueSession?: boolean;
			/** The tab's model pick, as the form would send it — unsanitised. */
			model?: string;
			/** Called before each progress task, so a test can cancel one. */
			beforeProgress?: (step: GenerateStep, cancel: () => void) => void;
		} = {}
	) {
		this.pendingFollowUps = [...(script.followUps ?? [])];
	}

	async pickAgent(agents: readonly AgentDefinition[]): Promise<AgentDefinition | undefined> {
		this.agentAsked = true;
		return this.script.agent ?? agents[0];
	}

	async askInstruction(): Promise<string | undefined> {
		return this.script.instruction ?? '';
	}

	async continueSession(previous: GenerateSession): Promise<boolean> {
		this.continueAsked = previous;
		return this.script.continueSession ?? false;
	}

	async pickModel(): Promise<string | undefined> {
		return this.script.model;
	}

	async pickChildren(
		titles: readonly string[],
		_parent: TicketSummary,
		followUps: readonly string[]
	): Promise<ChildrenChoice | undefined> {
		this.offered = [...titles];
		this.offeredRounds.push([...titles]);
		this.followUpsSeen.push([...followUps]);

		const ask = this.pendingFollowUps.shift();
		if (ask !== undefined) {
			return { kind: 'refine', instruction: ask };
		}
		const kept = this.script.keep ? this.script.keep(titles) : [...titles];
		return kept === undefined ? undefined : { kind: 'create', titles: kept };
	}

	async withProgress<T>(
		step: GenerateStep,
		title: string,
		task: (report: GenerateReport, token: vscode.CancellationToken) => Promise<T>
	): Promise<T> {
		this.steps.push(step);
		// One source per step, as the tab does: a cancelled refine must not
		// leave the writing that follows it cancelled too.
		const cancellation = new vscode.CancellationTokenSource();
		this.script.beforeProgress?.(step, () => cancellation.cancel());
		return task(
			{
				log: (line, lane) => this.log.push(lane === undefined ? line : `${lane}: ${line}`),
				lane: (lane, laneTitle, status) =>
					this.lanes.push({ lane, title: laneTitle, status })
			},
			cancellation.token
		);
	}

	created(ticket: TicketSummary, described: boolean): void {
		this.announced.push({ key: ticket.key, described });
	}

	info(message: string): void {
		this.infos.push(message);
	}

	error(message: string): void {
		this.errors.push(message);
	}
}

/**
 * Waits for a condition the flow reaches on its own microtasks.
 *
 * A fan-out settles over several ticks — a semaphore slot frees, the next write
 * starts — so a single `await` is not enough and a fixed sleep is a flake.
 */
async function settled(until: () => boolean, ticks = 200): Promise<void> {
	for (let attempt = 0; attempt < ticks && !until(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The real store over a plain-object memento, for the batches that remember. */
function memorySessions(): GenerateSessionStore {
	const state = new Map<string, unknown>();
	return mementoSessionStore({
		get: <T>(key: string) => state.get(key) as T | undefined,
		update: async (key, value) => {
			state.set(key, value);
		}
	});
}

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Never existed.
	}
}

suite('Generate children', () => {
	let store: FileTicketStore;
	let epic: TicketSummary;

	setup(async () => {
		await reset();
		store = new FileTicketStore(context);
		epic = await store.createTicket({
			type: 'epic',
			title: 'Authentication',
			description: 'Sign-in is missing.'
		});
	});

	suiteTeardown(reset);

	function deps(
		ai: FakeAiProvider,
		prompts: GeneratePrompts,
		extra: Partial<GenerateChildrenDeps> = {}
	): GenerateChildrenDeps {
		return {
			store,
			ai,
			aiAgents: async () => [ANALYST, OWNER],
			planSkill: async (agent) => agent.skills.find((skill) => skill.kind === 'plan'),
			refresh: () => undefined,
			prompts,
			...extra
		};
	}

	test('plans the titles, then writes one description each', async () => {
		const ai = new FakeAiProvider({
			answers: [
				'- Sign in with email\n- Reset a password',
				'The sign-in story.',
				'The reset story.'
			]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(
			created.map((ticket) => ticket.id),
			['ST-1.1', 'ST-1.2']
		);
		assert.deepStrictEqual(prompts.offered, ['Sign in with email', 'Reset a password']);
		assert.strictEqual(ai.requests.length, 3, 'one plan run and one write run per title');

		const [first, second] = created;
		assert.strictEqual((await store.getDetail(first.id))?.description, 'The sign-in story.');
		assert.strictEqual((await store.getDetail(second.id))?.description, 'The reset story.');
		assert.strictEqual(prompts.errors.length, 0);
	});

	// What the tab renders is built entirely from these three: the step drives
	// which screen is up, the log is the only proof a long run is alive, and the
	// created list fills in as the run goes rather than all at once at the end.
	test('tells the surface which step it is on, what it is doing, and what landed', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Sign in\n- Reset a password', 'Body one.', 'Body two.']
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.steps, ['planning', 'writing']);
		assert.deepStrictEqual(prompts.announced, [
			{ key: 'ST-1', described: true },
			{ key: 'ST-2', described: true }
		]);

		// Each child gets its own row, and moves through it.
		assert.deepStrictEqual(
			prompts.lanes.filter((entry) => entry.lane === 0).map((entry) => entry.status),
			['waiting', 'running', 'done']
		);
		assert.deepStrictEqual(
			prompts.lanes.filter((entry) => entry.lane === 1).map((entry) => entry.status),
			['waiting', 'running', 'done']
		);
	});

	// The runs fan out; the creates do not. Ids come from `nextOrdinal` in the
	// order it is asked, so letting the creates race would make ST-1 whichever
	// agent happened to finish first.
	test('writes several children at once but creates them in the proposed order', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha\n- Beta\n- Gamma\n- Delta', 'A.', 'B.', 'C.', 'D.'],
			hangFrom: 1
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const flow = generateChildren(
			deps(ai, prompts, { aiSettings: () => ({ concurrency: 3 }) }),
			epic.id,
			'story'
		);

		// Three writes in flight at once, and the fourth held back by the limit.
		await settled(() => ai.running.length === 3);
		assert.strictEqual(ai.running.length, 3, 'the concurrency setting bounds the fan-out');

		// Settle them out of order; the ids must not follow.
		const [alpha, beta, gamma] = ai.running;
		gamma.resolveNow('C.');
		beta.resolveNow('B.');
		await settled(() => ai.running.length === 2);
		ai.running[ai.running.length - 1].resolveNow('D.');
		alpha.resolveNow('A.');

		const created = await flow;

		assert.deepStrictEqual(
			created.map((ticket) => [ticket.id, ticket.title]),
			[
				['ST-1.1', 'Alpha'],
				['ST-1.2', 'Beta'],
				['ST-1.3', 'Gamma'],
				['ST-1.4', 'Delta']
			]
		);
		assert.strictEqual((await store.getDetail('ST-1.3'))?.description, 'C.');
	});

	test('runs one at a time when the setting says so', async () => {
		const ai = new FakeAiProvider({ answers: ['- Alpha\n- Beta'], hangFrom: 1 });
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const flow = generateChildren(
			deps(ai, prompts, { aiSettings: () => ({ concurrency: 1 }) }),
			epic.id,
			'story'
		);

		await settled(() => ai.running.length > 0);
		assert.strictEqual(ai.running.length, 1, 'the second write must wait for the first');

		ai.running[0].resolveNow('A.');
		await settled(() => ai.running.length > 0);
		assert.strictEqual(ai.running.length, 1);

		ai.running[0].resolveNow('B.');
		assert.strictEqual((await flow).length, 2);
	});

	// With a limit of two and three titles, the third has not started — a row
	// that is simply missing reads as one that was dropped.
	test('announces every child up front, including the ones still queued', async () => {
		const ai = new FakeAiProvider({ answers: ['- Alpha\n- Beta\n- Gamma'], hangFrom: 1 });
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const flow = generateChildren(
			deps(ai, prompts, { aiSettings: () => ({ concurrency: 2 }) }),
			epic.id,
			'story'
		);
		await settled(() => ai.running.length === 2);

		const waiting = prompts.lanes.filter((entry) => entry.status === 'waiting');
		assert.deepStrictEqual(
			waiting.map((entry) => entry.title),
			['Alpha', 'Beta', 'Gamma']
		);

		for (const run of [...ai.running]) {
			run.resolveNow('Body.');
		}
		await settled(() => ai.running.length === 1);
		ai.running[0].resolveNow('Body.');
		await flow;
	});

	test('marks a child whose description could not be written', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Sign in', ''],
			failWith: new AiError('provider-error', 'boom'),
			failAt: [1]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.announced, [{ key: 'ST-1', described: false }]);
	});

	test('gives pass 1 the parent and pass 2 the title and its parent', async () => {
		const ai = new FakeAiProvider({ answers: ['- Sign in with email', 'Body.'] });
		await generateChildren(
			deps(ai, new ScriptedPrompts({ agent: ANALYST, instruction: 'focus on SSO' })),
			epic.id,
			'story'
		);

		const [plan, write] = ai.requests;

		// Pass 1 reads the epic, and runs the plan skill rather than the write one.
		assert.ok(plan.prompt.includes('Sign-in is missing.'));
		assert.ok(plan.prompt.includes('List the stories.'));
		assert.ok(!plan.prompt.includes('Shape a story.'));
		assert.ok(plan.prompt.includes('focus on SSO'));

		// Pass 2 writes a ticket that does not exist yet: the title is all it has,
		// and the epic reaches it as the parent block rather than as a draft.
		assert.ok(write.prompt.includes('Shape a story.'));
		assert.ok(write.prompt.includes('Sign in with email'));
		assert.ok(write.prompt.includes('It belongs under the epic EP-1 — “Authentication”:'));
		assert.strictEqual(write.ticket.id, '', 'the child has no id before it is created');
	});

	test('creates only what the user kept', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Sign in\n- Reset a password\n- Lock the account', 'Body.']
		});
		const prompts = new ScriptedPrompts({
			agent: ANALYST,
			keep: (titles) => [titles[1]]
		});

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0].title, 'Reset a password');
		assert.strictEqual(ai.requests.length, 2, 'the two unwanted titles cost nothing');
	});

	test('backing out of the pick writes nothing', async () => {
		const ai = new FakeAiProvider({ answers: ['- Sign in'] });
		const prompts = new ScriptedPrompts({ agent: ANALYST, keep: () => undefined });

		assert.deepStrictEqual(await generateChildren(deps(ai, prompts), epic.id, 'story'), []);
		assert.strictEqual(ai.requests.length, 1);
	});

	// The author is the person who pressed the button; the comment is what says a
	// model was involved, so spend stays auditable in git.
	test('records the provenance on the created ticket, under the human author', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Sign in', 'Body.'],
			meta: { model: 'claude-test', turns: 3, costUsd: 0.02 }
		});

		const [created] = await generateChildren(
			deps(ai, new ScriptedPrompts({ agent: ANALYST })),
			epic.id,
			'story'
		);

		const [entry] = (await store.getDetail(created.id))!.history;
		assert.strictEqual(entry.action, 'created');
		assert.strictEqual(entry.author, 'Test Runner');
		assert.ok(entry.comment?.includes('“Analyst”'));
		assert.ok(entry.comment?.includes('write-story'));
		assert.ok(entry.comment?.includes('claude-test'));
	});

	// The title was the user's choice, so the ticket is still what they asked
	// for. One flaky run must not discard the runs that worked.
	test('a failed description still creates the ticket, and the batch continues', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Sign in\n- Reset a password', '', 'The reset story.'],
			failWith: new AiError('provider-error', 'boom'),
			failAt: [1]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.strictEqual(created.length, 2);
		assert.strictEqual((await store.getDetail(created[0].id))?.description, '');
		assert.strictEqual((await store.getDetail(created[1].id))?.description, 'The reset story.');
		assert.ok(prompts.infos[0]?.includes('No description was written for “Sign in”'));
	});

	// Cancelling is "I have enough", not "undo": ordinals are never reused, so a
	// rollback would leave a gap anyway, and it would race the tracker watcher.
	test('cancelling mid-batch keeps what was already created', async () => {
		const ai = new FakeAiProvider({ answers: ['- Sign in\n- Reset a password', 'Body.'] });
		const prompts = new ScriptedPrompts({
			agent: ANALYST,
			beforeProgress: (step, cancel) => {
				if (step === 'writing') {
					cancel();
				}
			}
		});

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(created, []);
		assert.ok(prompts.infos[0]?.includes('Cancelled the rest.'));
		// The epic is still the only ticket: the cancel landed before the first
		// write, and nothing half-made was left behind.
		assert.deepStrictEqual(
			(await store.listSummaries()).map((ticket) => ticket.id),
			['EP-1']
		);
	});

	test('acceptance criteria hang under their story, with no test case', async () => {
		const story = await store.createTicket({
			parentId: epic.id,
			type: 'story',
			title: 'Sign in with email',
			description: 'The story body.'
		});

		const ai = new FakeAiProvider({
			answers: ['- Wrong password shows a generic error', 'Given … When … Then …']
		});
		const analyst: AgentDefinition = {
			...ANALYST,
			types: ['ac' as TicketType],
			skills: [
				parseSkill('---\nname: write-acceptance-criterion\ntypes: ac\n---\n\nOne GWT.', 'write-acceptance-criterion'),
				parseSkill(
					'---\nname: break-down-story\nkind: plan\ntypes: story\n---\n\nList the criteria.',
					'break-down-story'
				)
			]
		};

		const created = await generateChildren(
			deps(ai, new ScriptedPrompts({ agent: analyst }), {
				aiAgents: async () => [analyst]
			}),
			story.id,
			'ac'
		);

		assert.deepStrictEqual(
			created.map((ticket) => ticket.id),
			['AC-1.1.1']
		);

		const summaries = await store.listSummaries();
		const criterion = summaries.find((ticket) => ticket.id === 'AC-1.1.1');
		assert.strictEqual(criterion?.parentId, story.id);
		assert.ok(!summaries.some((ticket) => ticket.type === 'testcase'));
		// Flagged, never blocked: the sidebar shows it and the user adds one.
		assert.strictEqual(criterion?.warning, 'No test case yet');
		// Only a criterion's parent is read as well: a story carries its own
		// context, so the epic above it reaches neither pass.
		assert.ok(ai.requests.every((request) => !request.prompt.includes('Sign-in is missing.')));
	});

	/** A story, and one criterion under it carrying `description`. */
	async function criterionUnderStory(
		description = CRITERION
	): Promise<{ story: TicketSummary; ac: TicketSummary }> {
		const story = await store.createTicket({
			parentId: epic.id,
			type: 'story',
			title: 'Sign in with email',
			description: 'A registered user signs in on the sign-in page.'
		});
		const ac = await store.createTicket({
			parentId: story.id,
			type: 'ac',
			title: 'Wrong password shows a generic error',
			description
		});
		return { story, ac };
	}

	test('test cases hang under their criterion, and its warning goes away', async () => {
		const { ac } = await criterionUnderStory();
		assert.strictEqual((await store.getSummary(ac.id))?.warning, 'No test case yet');

		const ai = new FakeAiProvider({
			answers: [
				'- Wrong password shows the generic error\n- Unknown email shows the same error',
				'## Preconditions\n\nOne.',
				'## Preconditions\n\nTwo.'
			]
		});
		const prompts = new ScriptedPrompts();

		const created = await generateChildren(
			deps(ai, prompts, { aiAgents: async () => [ANALYST, TESTER] }),
			ac.id,
			'testcase'
		);

		// Only the agent that writes test cases is offered, so nothing is asked.
		assert.strictEqual(prompts.agentAsked, false);
		assert.deepStrictEqual(
			created.map((ticket) => [ticket.id, ticket.parentId]),
			[
				['TC-1.1.1.1', ac.id],
				['TC-1.1.1.2', ac.id]
			]
		);
		assert.strictEqual((await store.getDetail('TC-1.1.1.2'))?.description, '## Preconditions\n\nTwo.');
		assert.deepStrictEqual(prompts.infos, ['Created 2 test cases.']);
		assert.strictEqual((await store.getSummary(ac.id))?.warning, undefined);
	});

	// The test case's preconditions, steps and expected result *are* the
	// criterion's Given, When and Then. Without them the agent would invent the
	// test, so the flow stops before spending a run.
	test('refuses a criterion with no Given / When / Then, and runs nothing', async () => {
		const { story } = await criterionUnderStory();
		for (const description of ['', 'A wrong password should show an error.']) {
			const ac = await store.createTicket({
				parentId: story.id,
				type: 'ac',
				title: `Unwritten ${description.length}`,
				description
			});
			const ai = new FakeAiProvider({ answers: ['- A test'] });
			const prompts = new ScriptedPrompts();

			const created = await generateChildren(
				deps(ai, prompts, { aiAgents: async () => [TESTER] }),
				ac.id,
				'testcase'
			);

			assert.deepStrictEqual(created, []);
			assert.strictEqual(ai.requests.length, 0, JSON.stringify(description));
			assert.ok(prompts.errors[0]?.includes(`${ac.id} has no Given / When / Then yet`));
			assert.deepStrictEqual(await store.listChildren(ac.id), []);
		}
	});

	// A criterion names neither the screen nor the user; its story does.
	test('gives both passes the story the criterion belongs to', async () => {
		const { ac } = await criterionUnderStory();
		const ai = new FakeAiProvider({ answers: ['- Wrong password shows the generic error', 'Body.'] });

		await generateChildren(
			deps(ai, new ScriptedPrompts(), { aiAgents: async () => [TESTER] }),
			ac.id,
			'testcase'
		);

		const [plan, write] = ai.requests;

		// Pass 1 reads the criterion as its own ticket, the story as its parent.
		assert.ok(plan.prompt.includes('List the test cases.'));
		assert.ok(plan.prompt.includes('**When** they sign in with a wrong password'));
		assert.ok(plan.prompt.includes('It belongs under the story ST-1.1 — “Sign in with email”:'));
		assert.ok(plan.prompt.includes('A registered user signs in on the sign-in page.'));

		// Pass 2 writes from the criterion, with the story beneath it for context.
		assert.ok(write.prompt.includes('One runnable test.'));
		assert.ok(
			write.prompt.includes(
				'It belongs under the acceptance criterion AC-1.1.1 — “Wrong password shows a generic error”:'
			)
		);
		assert.ok(write.prompt.includes('**Then** a generic error is shown'));
		assert.ok(
			write.prompt.includes(
				'That acceptance criterion is part of the story ST-1.1 — “Sign in with email”, given for context:'
			)
		);
		assert.ok(write.prompt.includes('A registered user signs in on the sign-in page.'));
	});

	test('says no new test cases were proposed when every one already exists', async () => {
		const { ac } = await criterionUnderStory();
		await store.createTicket({
			parentId: ac.id,
			type: 'testcase',
			title: 'Wrong password shows the generic error',
			description: ''
		});
		const ai = new FakeAiProvider({ answers: ['- Wrong password shows the generic error'] });
		const prompts = new ScriptedPrompts();

		const created = await generateChildren(
			deps(ai, prompts, { aiAgents: async () => [TESTER] }),
			ac.id,
			'testcase'
		);

		assert.deepStrictEqual(created, []);
		assert.ok(prompts.log.some((line) => line.includes('already exists as TC-1.1.1.1')));
		assert.ok(prompts.errors[0]?.startsWith('The agent proposed no new test cases.'));
		assert.strictEqual(ai.requests.length, 1, 'nothing was left to write');
	});

	test('says so rather than creating anything when nothing parses', async () => {
		const ai = new FakeAiProvider({
			answers: [
				'This epic is really about authentication and it covers a great many things ' +
					'that would each take some time to build properly.'
			]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		assert.deepStrictEqual(await generateChildren(deps(ai, prompts), epic.id, 'story'), []);
		assert.ok(prompts.errors[0]?.includes('proposed no stories'));
	});

	test('skips the agent pick when only one agent writes the type', async () => {
		const ai = new FakeAiProvider({ answers: ['- Sign in', 'Body.'] });
		const prompts = new ScriptedPrompts();

		await generateChildren(
			deps(ai, prompts, { aiAgents: async () => [ANALYST] }),
			epic.id,
			'story'
		);

		assert.strictEqual(prompts.agentAsked, false);
	});

	test('reports the reason when no agent writes the child type', async () => {
		const ai = new FakeAiProvider();
		const prompts = new ScriptedPrompts();

		await generateChildren(
			deps(ai, prompts, { aiAgents: async () => [] }),
			epic.id,
			'story'
		);

		assert.ok(prompts.errors[0]?.includes('No agent writes a story'));
		assert.strictEqual(ai.requests.length, 0);
	});

	// The bug this replaced: `running` was one module-wide boolean, so a batch
	// under *any* ticket refused every other one. Different parents draw their
	// ordinals from disjoint sibling sets, so there was never anything to refuse.
	test('generates under two parents at once', async () => {
		const second = await store.createTicket({ type: 'epic', title: 'Billing' });

		const firstAi = new FakeAiProvider({ answers: ['- Alpha\n- Beta'], hangFrom: 1 });
		const secondAi = new FakeAiProvider({ answers: ['- Gamma\n- Delta'], hangFrom: 1 });
		const firstPrompts = new ScriptedPrompts({ agent: ANALYST });
		const secondPrompts = new ScriptedPrompts({ agent: ANALYST });

		const firstFlow = generateChildren(deps(firstAi, firstPrompts), epic.id, 'story');
		await settled(() => firstAi.running.length > 0);

		// The second batch starts while the first is mid-write, and is neither
		// refused nor held until it finishes.
		const secondFlow = generateChildren(deps(secondAi, secondPrompts), second.id, 'story');
		await settled(() => secondAi.running.length > 0);
		assert.deepStrictEqual(secondPrompts.errors, [], 'the second batch was not refused');
		assert.ok(firstAi.running.length > 0, 'and the first is still going');

		for (const run of [...firstAi.running, ...secondAi.running]) {
			run.resolveNow('Body.');
		}
		await settled(() => firstAi.running.length + secondAi.running.length === 0);
		for (const run of [...firstAi.running, ...secondAi.running]) {
			run.resolveNow('Body.');
		}

		// Disjoint id sets, each in its own proposed order — the thing the
		// module-wide lock was protecting, which the nesting already guaranteed.
		assert.deepStrictEqual(
			(await firstFlow).map((ticket) => ticket.id),
			['ST-1.1', 'ST-1.2']
		);
		assert.deepStrictEqual(
			(await secondFlow).map((ticket) => ticket.id),
			['ST-2.1', 'ST-2.2']
		);
	});

	// The cap has to be the window's, or it multiplies by the number of open
	// tabs and stops being a spend dial at all.
	test('two batches sharing a limiter never exceed it together', async () => {
		const second = await store.createTicket({ type: 'epic', title: 'Billing' });
		const slots = sharedLimiter(() => 2);

		const firstAi = new FakeAiProvider({ answers: ['- Alpha\n- Beta'], hangFrom: 1 });
		const secondAi = new FakeAiProvider({ answers: ['- Gamma\n- Delta'], hangFrom: 1 });
		const firstPrompts = new ScriptedPrompts({ agent: ANALYST });
		const secondPrompts = new ScriptedPrompts({ agent: ANALYST });

		// Four writes between them, and a per-batch cap of two would run all four.
		const firstFlow = generateChildren(
			deps(firstAi, firstPrompts, { slots, aiSettings: () => ({ concurrency: 2 }) }),
			epic.id,
			'story'
		);
		const secondFlow = generateChildren(
			deps(secondAi, secondPrompts, { slots, aiSettings: () => ({ concurrency: 2 }) }),
			second.id,
			'story'
		);

		await settled(() => firstAi.running.length + secondAi.running.length >= 2);
		assert.strictEqual(
			firstAi.running.length + secondAi.running.length,
			2,
			'the cap is shared, not one per batch'
		);
		// Which batch holds them is not asserted: whoever reaches the writes
		// first takes what is free, and the turn-taking that matters only starts
		// once someone is queued — `semaphore.test.ts` pins that directly.
		while (firstAi.running.length + secondAi.running.length > 0) {
			for (const run of [...firstAi.running, ...secondAi.running]) {
				run.resolveNow('Body.');
			}
			await settled(() => firstAi.running.length + secondAi.running.length === 0);
			await settled(() => firstAi.running.length + secondAi.running.length > 0, 20);
		}

		assert.strictEqual((await firstFlow).length, 2);
		assert.strictEqual((await secondFlow).length, 2);
	});

	// The review is a conversation: a follow-up goes back to the same session,
	// and the list on screen is replaced by the answer rather than patched.
	test('a follow-up on the review screen asks the same conversation again and replaces the list', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha\n- Beta\n- Gamma', '- Alpha\n- Beta one\n- Beta two', 'A.', 'B1.', 'B2.'],
			metas: [{ sessionId: 's1' }]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST, followUps: ['split the second'] });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.steps, ['planning', 'refining', 'writing']);
		assert.deepStrictEqual(prompts.offeredRounds, [
			['Alpha', 'Beta', 'Gamma'],
			['Alpha', 'Beta one', 'Beta two']
		]);
		assert.deepStrictEqual(prompts.followUpsSeen, [[], ['split the second']]);

		const [, refine] = ai.requests;
		assert.strictEqual(refine.resumeSessionId, 's1');
		assert.ok(refine.prompt.includes('split the second'));
		assert.ok(refine.prompt.includes('complete updated list'));
		assert.ok(!refine.prompt.includes('List the stories.'), 'the skill is already in the session');
		assert.deepStrictEqual(
			created.map((ticket) => ticket.title),
			['Alpha', 'Beta one', 'Beta two']
		);
	});

	// Pass 2 runs fresh, so the conversation reaches it only through the
	// instruction — and through provenance, so the history says what steered it.
	test('pass 2 carries the instruction and every follow-up, and so does the history', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha', '- Alpha', '- Alpha', 'Body.'],
			metas: [{ sessionId: 's1' }]
		});
		const prompts = new ScriptedPrompts({
			agent: ANALYST,
			instruction: 'focus on SSO',
			followUps: ['drop billing', 'add the empty state']
		});

		const [created] = await generateChildren(deps(ai, prompts), epic.id, 'story');

		const write = ai.requests[3];
		assert.ok(write.prompt.includes('Additional instruction from the user:'));
		assert.ok(write.prompt.includes('focus on SSO'));
		assert.ok(write.prompt.includes('1. drop billing'));
		assert.ok(write.prompt.includes('2. add the empty state'));

		const [entry] = (await store.getDetail(created.id))!.history;
		assert.ok(entry.comment?.includes('drop billing'));
		assert.ok(entry.comment?.includes('add the empty state'));
	});

	test('a follow-up with no conversation to continue re-plans from the combined instruction', async () => {
		const ai = new FakeAiProvider({ answers: ['- Alpha', '- Alpha\n- Beta', 'A.', 'B.'] });
		const prompts = new ScriptedPrompts({ agent: ANALYST, followUps: ['add one more'] });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		const [, refine] = ai.requests;
		assert.strictEqual(refine.resumeSessionId, undefined);
		assert.ok(refine.prompt.includes('List the stories.'), 'the plan skill is sent again');
		assert.ok(refine.prompt.includes('add one more'));
		assert.ok(prompts.log.some((line) => line.includes('No conversation to continue')));
		assert.strictEqual(created.length, 2);
	});

	// Stop during a follow-up is "never mind", not "discard the batch".
	test('stopping a follow-up keeps the list the user had', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha\n- Beta', '', 'A.', 'B.'],
			metas: [{ sessionId: 's1' }],
			hangAt: [1]
		});
		const prompts = new ScriptedPrompts({
			agent: ANALYST,
			followUps: ['split the second'],
			beforeProgress: (step, cancel) => {
				if (step === 'refining') {
					cancel();
				}
			}
		});

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.steps, ['planning', 'refining', 'writing']);
		assert.deepStrictEqual(prompts.offeredRounds, [
			['Alpha', 'Beta'],
			['Alpha', 'Beta']
		]);
		assert.deepStrictEqual(
			prompts.followUpsSeen[1],
			[],
			'a stopped follow-up is not part of the conversation'
		);
		assert.deepStrictEqual(prompts.errors, []);
		assert.ok(prompts.log.some((line) => line.includes('the list you had stands')));
		assert.strictEqual(created.length, 2);
	});

	test('a failed follow-up keeps the list the user had, and says so', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha\n- Beta', '', 'A.', 'B.'],
			metas: [{ sessionId: 's1' }],
			failWith: new AiError('provider-error', 'boom'),
			failAt: [1]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST, followUps: ['split the second'] });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.offeredRounds, [
			['Alpha', 'Beta'],
			['Alpha', 'Beta']
		]);
		assert.ok(prompts.errors[0]?.includes('boom'));
		assert.ok(prompts.errors[0]?.includes('The list you had stands.'));
		assert.strictEqual(created.length, 2);
	});

	test('an empty follow-up answer keeps the list the user had', async () => {
		const ai = new FakeAiProvider({
			answers: [
				'- Alpha',
				'This list is really about authentication and it covers a great many things ' +
					'that would each take some time to build properly, so I would leave it.',
				'A.'
			],
			metas: [{ sessionId: 's1' }]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST, followUps: ['make it shorter'] });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.offeredRounds, [['Alpha'], ['Alpha']]);
		assert.ok(prompts.errors[0]?.includes('returned no titles'));
		assert.strictEqual(created.length, 1);
	});

	test('remembers the conversation after a successful plan, under the provider that ran it', async () => {
		const sessions = memorySessions();
		const ai = new FakeAiProvider({ answers: ['- Alpha', 'A.'], metas: [{ sessionId: 's1' }] });

		await generateChildren(
			deps(ai, new ScriptedPrompts({ agent: ANALYST }), { sessions }),
			epic.id,
			'story'
		);

		const session = sessions.get(epic.id, 'story');
		assert.strictEqual(session?.sessionId, 's1');
		assert.strictEqual(session?.provider, 'fake');
		assert.ok(session && !Number.isNaN(Date.parse(session.at)));
	});

	// "Run again", or a tab opened onto an old conversation: the agent is told
	// what became a ticket and asked for the rest, never for the list again.
	test('continues a remembered conversation when asked, telling the agent what already exists', async () => {
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in', description: '' });
		const sessions = memorySessions();
		await sessions.set(epic.id, 'story', {
			sessionId: 'old',
			provider: 'fake',
			at: new Date().toISOString()
		});
		const ai = new FakeAiProvider({
			answers: ['- Reset a password', 'Body.'],
			metas: [{ sessionId: 'old' }]
		});
		const prompts = new ScriptedPrompts({
			agent: ANALYST,
			instruction: 'the recovery flows',
			continueSession: true
		});

		const created = await generateChildren(deps(ai, prompts, { sessions }), epic.id, 'story');

		assert.strictEqual(prompts.continueAsked?.sessionId, 'old');
		const [plan] = ai.requests;
		assert.strictEqual(plan.resumeSessionId, 'old');
		assert.ok(plan.prompt.includes('ST-1.1 — Sign in'));
		assert.ok(plan.prompt.includes('still missing'));
		assert.ok(plan.prompt.includes('the recovery flows'));
		assert.ok(!plan.prompt.includes('List the stories.'));
		assert.deepStrictEqual(
			created.map((ticket) => ticket.id),
			['ST-1.2']
		);
	});

	test('starts fresh when the remembered conversation belongs to another provider', async () => {
		const sessions = memorySessions();
		await sessions.set(epic.id, 'story', {
			sessionId: 'old',
			provider: 'claude-cli',
			at: new Date().toISOString()
		});
		const ai = new FakeAiProvider({ answers: ['- Alpha', 'A.'] });
		const prompts = new ScriptedPrompts({ agent: ANALYST, continueSession: true });

		await generateChildren(deps(ai, prompts, { sessions }), epic.id, 'story');

		assert.strictEqual(prompts.continueAsked, undefined, 'not even offered');
		assert.strictEqual(ai.requests[0].resumeSessionId, undefined);
	});

	test('starts fresh when the user says so', async () => {
		const sessions = memorySessions();
		await sessions.set(epic.id, 'story', {
			sessionId: 'old',
			provider: 'fake',
			at: new Date().toISOString()
		});
		const ai = new FakeAiProvider({ answers: ['- Alpha', 'A.'] });
		const prompts = new ScriptedPrompts({ agent: ANALYST, continueSession: false });

		await generateChildren(deps(ai, prompts, { sessions }), epic.id, 'story');

		assert.strictEqual(prompts.continueAsked?.sessionId, 'old', 'offered');
		assert.strictEqual(ai.requests[0].resumeSessionId, undefined);
		assert.ok(ai.requests[0].prompt.includes('List the stories.'));
	});

	// No guessing whether the session file still exists: the error says which
	// box to untick, and the user decides.
	test('a continued conversation that cannot be resumed says how to start fresh', async () => {
		const sessions = memorySessions();
		await sessions.set(epic.id, 'story', {
			sessionId: 'gone',
			provider: 'fake',
			at: new Date().toISOString()
		});
		const ai = new FakeAiProvider({
			failWith: new AiError('provider-error', 'No conversation found'),
			failAt: [0]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST, continueSession: true });

		assert.deepStrictEqual(
			await generateChildren(deps(ai, prompts, { sessions }), epic.id, 'story'),
			[]
		);
		assert.ok(prompts.errors[0]?.includes('No conversation found'));
		assert.ok(prompts.errors[0]?.includes('Untick'));
	});

	// One pick for the whole batch — the plan, every refine and every write —
	// ranked over the workspace setting, and checked rather than trusted, since
	// it arrived from a webview and becomes an argv element.
	test('the tab’s model pick reaches every run of the batch, over the setting', async () => {
		const ai = new FakeAiProvider({
			answers: ['- Alpha\n- Beta\n- Gamma', '- Alpha\n- Beta one\n- Beta two', 'A.', 'B1.', 'B2.'],
			metas: [{ sessionId: 's1' }]
		});
		const prompts = new ScriptedPrompts({ agent: ANALYST, followUps: ['split the second'], model: ' opus ' });

		await generateChildren(
			deps(ai, prompts, { aiSettings: () => ({ model: 'sonnet' }) }),
			epic.id,
			'story'
		);

		assert.strictEqual(ai.requests.length, 5, 'plan, refine and three writes');
		assert.deepStrictEqual(
			ai.requests.map((request) => request.model),
			['opus', 'opus', 'opus', 'opus', 'opus']
		);
	});

	test('with no pick the batch runs on the setting, and an unusable pick falls back to it', async () => {
		// A fresh title per round, or `dropExisting` would drop the repeat.
		const rounds: [pick: string | undefined, title: string][] = [
			[undefined, 'Alpha'],
			['a b', 'Beta'],
			['', 'Gamma']
		];
		for (const [pick, title] of rounds) {
			const ai = new FakeAiProvider({ answers: [`- ${title}`, 'Body.'] });
			const prompts = new ScriptedPrompts({ agent: ANALYST, ...(pick === undefined ? {} : { model: pick }) });
			await generateChildren(
				deps(ai, prompts, { aiSettings: () => ({ model: 'sonnet' }) }),
				epic.id,
				'story'
			);
			assert.deepStrictEqual(
				ai.requests.map((request) => request.model),
				['sonnet', 'sonnet'],
				`pick ${JSON.stringify(pick)}`
			);
		}

		const ai = new FakeAiProvider({ answers: ['- Delta', 'Body.'] });
		await generateChildren(deps(ai, new ScriptedPrompts({ agent: ANALYST })), epic.id, 'story');
		assert.deepStrictEqual(
			ai.requests.map((request) => request.model),
			[undefined, undefined],
			'no pick and no setting is the provider default'
		);
	});

	test('never proposes a title that already exists under the parent', async () => {
		await store.createTicket({ parentId: epic.id, type: 'story', title: 'Sign in', description: '' });
		const ai = new FakeAiProvider({ answers: ['- Sign in!\n- Reset a password', 'Body.'] });
		const prompts = new ScriptedPrompts({ agent: ANALYST });

		const created = await generateChildren(deps(ai, prompts), epic.id, 'story');

		assert.deepStrictEqual(prompts.offered, ['Reset a password']);
		assert.ok(prompts.log.some((line) => line.includes('already exists as ST-1.1')));
		assert.deepStrictEqual(
			created.map((ticket) => ticket.title),
			['Reset a password']
		);
	});
});

suite('Generate children — is a criterion written', () => {
	test('reads Given, When and Then by word, in any case, bold or not', () => {
		assert.ok(hasGivenWhenThen(CRITERION));
		assert.ok(hasGivenWhenThen('given a user, when they sign in, then they see home'));
	});

	test('wants all three', () => {
		assert.ok(!hasGivenWhenThen(''));
		assert.ok(!hasGivenWhenThen('   \n'));
		assert.ok(!hasGivenWhenThen('When the user signs in, then the dashboard shows.'));
		// Inside another word is not the keyword.
		assert.ok(!hasGivenWhenThen('Forgiven whenever, and thenceforth.'));
	});
});
