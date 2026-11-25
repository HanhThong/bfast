// Breaking a ticket into its children, in two passes.
//
// Pass 1 asks a *plan* skill for the titles of the children; pass 2 asks the
// ordinary *write* skill for one child's description, once per title the user
// kept. Two passes rather than one structured answer because the second pass
// reuses the shipped `write-story` / `write-acceptance-criterion` /
// `write-test-case` skills untouched — the shape of a story is the same however
// the story was proposed, and a bespoke "return N descriptions" contract would
// be a second place for that shape to drift.
//
// Pure and `vscode`-free, the way `promptTemplate.ts` and `ticketTree.ts` are:
// everything here is prompt building, provider plumbing and parsing, so the
// quick picks and the progress notification can be scripted in a test.

import { composeInstruction, type AgentDefinition, type AgentSkill } from './agent';
import {
	type AiProgress,
	type AiProvider,
	type AiResultMeta,
	type AiTicketContext
} from './aiProvider';
import { parseTitleList, provenance, sanitizeAiDescription } from './aiResult';
import { buildPrompt, languageBlock } from './promptTemplate';
import type { TicketType } from '../data/types';

/** What the caller passes in to follow one run and to be able to stop it. */
export interface RunHooks {
	/** A line for the progress notification. */
	report?: (message: string) => void;
	/**
	 * Handed the live run's `cancel` the moment there is one.
	 *
	 * A callback rather than a token parameter so this module never learns what a
	 * `CancellationToken` is: the vscode half bridges the two, and a test passes a
	 * plain function.
	 */
	onCancel?: (cancel: (reason?: string) => void) => void;
}

/** Everything both passes need, minus what changes between them. */
interface RunSettings {
	agent: AgentDefinition;
	instruction: string;
	workingDirectory?: string;
	model?: string;
	maxTurns?: number;
	/** English name, from `aiLanguageName`. */
	language?: string;
	/** From `aiIdleTimeoutMs`; how long one run may say nothing before it stops. */
	idleTimeoutMs?: number;
}

/** A child that already exists under the parent, as a continued conversation is told about it. */
export interface ExistingChild {
	id: string;
	title: string;
}

/**
 * Continue the conversation an earlier plan run left, rather than start one.
 *
 * `followUp` is what the user typed on the review screen. `existing` marks a
 * *continued batch* — "Run again", or a tab reopened onto an old conversation —
 * where the agent has to be told which of its titles have since become tickets
 * and asked for the ones still missing, never for the whole list again.
 */
export interface PlanResume {
	sessionId: string;
	followUp?: string;
	existing?: readonly ExistingChild[];
}

export interface PlanRequest extends RunSettings {
	/** The ticket being broken down. Its type chooses the plan skill. */
	parent: AiTicketContext;
	/** The ticket `parent` hangs under, when `parent` alone is too thin to plan from. */
	grandparent?: AiTicketContext;
	/** From `AgentStore.planSkill`, so a role with none still gets the bundled one. */
	planSkill: AgentSkill | undefined;
	max?: number;
	/** Set to ask again in the same conversation; the skill is already in it. */
	resume?: PlanResume;
}

/** Pass 1's answer, with the conversation it can be continued in. */
export interface PlannedChildren {
	titles: string[];
	/** Absent when the provider reported none; a follow-up then re-plans fresh. */
	sessionId?: string;
}

export interface WriteRequest extends RunSettings {
	parent: AiTicketContext;
	/** As on `PlanRequest`: the same context reaches both passes. */
	grandparent?: AiTicketContext;
	childType: TicketType;
	/** The write skill for `childType`; absent means the role runs alone. */
	writeSkill: AgentSkill | undefined;
	label: string;
}

/** One child's description and the history note that records who wrote it. */
export interface WrittenChild {
	description: string;
	note: string;
}

/**
 * Pass 1: the titles of the children this ticket breaks into.
 *
 * Returns `[]` rather than throwing when nothing parses — an answer that is
 * prose instead of a list is a bad run, not a broken extension, and the caller
 * says so far better than an exception would.
 */
export async function planChildren(
	ai: AiProvider,
	request: PlanRequest,
	hooks?: RunHooks
): Promise<PlannedChildren> {
	const result = await runOnce(
		ai,
		{
			instruction: request.instruction,
			prompt: request.resume
				? buildResumedPrompt(request.resume, request.parent, request.language)
				: buildPrompt(
						composeInstruction(request.agent, request.planSkill),
						request.parent,
						request.instruction,
						// The ticket being planned is the prompt's own; the one above it
						// is its parent block.
						{ language: request.language, parent: request.grandparent }
					),
			ticket: request.parent,
			workingDirectory: request.workingDirectory,
			model: request.model,
			maxTurns: request.maxTurns,
			idleTimeoutMs: request.idleTimeoutMs,
			resumeSessionId: request.resume?.sessionId
		},
		hooks
	);

	return { titles: parseTitleList(result.text, request.max), sessionId: result.meta?.sessionId };
}

/** What a ticket of each type breaks into, as a follow-up names them. */
const CHILDREN_OF: Record<string, string> = {
	epic: 'stories',
	story: 'acceptance criteria',
	ac: 'test cases'
};

/**
 * The list format the shipped plan skills end with, restated for a follow-up.
 *
 * The skill stated it a turn ago, but a model answering "split the third one"
 * otherwise returns the third one alone and drops the format with it. The last
 * sentence is the output contract every skill carries, and a test in
 * `bundledAgents.test.ts` holds this copy to it.
 */
export const TITLE_LIST_FORMAT =
	'Same format as before: only the list, one title per line, each line beginning with `- `. ' +
	'Write nothing before the first line and nothing after the last: no preamble, no ' +
	'numbering, no descriptions, no code fence. A title is a sentence fragment of at most 80 ' +
	'characters. Do not write or modify any files, and do not explain what you did.';

/**
 * The follow-up turn of a resumed plan conversation.
 *
 * Deliberately not `buildPrompt`: the skill, the parent and the first
 * instruction are already in the session, and sending them again would read as
 * a new ticket. What the turn has to carry is the ask — and the whole list
 * back, not a diff, which is the failure the restated contract exists to
 * prevent. With `existing` the ask flips to the titles still missing, since a
 * title that is already a ticket could only be created twice.
 */
export function buildResumedPrompt(
	resume: PlanResume,
	parent: AiTicketContext,
	language?: string
): string {
	const children = CHILDREN_OF[parent.type] ?? 'children';
	const blocks: string[] = [];

	if (resume.existing) {
		blocks.push(
			resume.existing.length > 0
				? [
						`Since your last answer, these ${children} now exist under ` +
							`${parent.id || parent.title}:`,
						'',
						...resume.existing.map((child) => `- ${child.id} — ${child.title}`)
					].join('\n')
				: `None of the ${children} you proposed has been created.`
		);
	}

	const followUp = resume.followUp?.trim() ?? '';
	if (followUp.length > 0) {
		blocks.push(`The user has reviewed your list and asks:\n\n${followUp}`);
	}

	blocks.push(
		resume.existing
			? `Propose the ${children} still missing. Return the complete list of titles to ` +
					'create now — never one that already exists above, nor a rewording of one.'
			: 'Return the complete updated list — every title to keep, changed or not, in the ' +
					'order to build them — not only what changed.'
	);
	blocks.push(TITLE_LIST_FORMAT);

	const tail = languageBlock(language);
	if (tail.length > 0) {
		blocks.push(tail.join('\n'));
	}

	return blocks.join('\n\n---\n\n');
}

/**
 * Pass 2's instruction: what the user typed on the form, then every follow-up
 * from the review screen, in order.
 *
 * Pass 2 runs fresh — several at once, each from a title and the parent — so
 * the conversation that shaped the list reaches it only this way. Into the
 * instruction rather than a block of its own so `provenance` records it too,
 * and the history says what the descriptions were steered by. Byte-identical
 * to `instruction` when there were no follow-ups, so an unrefined batch prompts
 * exactly as it always did.
 */
export function combineInstruction(instruction: string, followUps: readonly string[]): string {
	const asks = followUps.map((ask) => ask.trim()).filter((ask) => ask.length > 0);
	if (asks.length === 0) {
		return instruction;
	}

	const head = instruction.trim();
	const list = [
		'The user then refined the proposed list with these follow-ups, in order:',
		...asks.map((ask, index) => `${index + 1}. ${ask.replace(/\n/g, '\n   ')}`)
	].join('\n');

	return head.length > 0 ? `${head}\n\n${list}` : list;
}

/**
 * Whether an acceptance criterion says Given, When and Then — what its test
 * cases' preconditions, steps and expected result are made from. Without all
 * three there is nothing to turn into a test, so a breakdown is refused rather
 * than left to invent one.
 *
 * By word and in any case, bold or not: the shipped skill writes `**Given**`,
 * but a criterion typed by hand is no less a criterion for leaving it plain.
 */
export function hasGivenWhenThen(description: string): boolean {
	return ['given', 'when', 'then'].every((word) =>
		new RegExp(`\\b${word}\\b`, 'i').test(description)
	);
}

/**
 * Pass 2: the description for one proposed child.
 *
 * The child does not exist yet, so it is described to the prompt by title
 * alone; `buildPrompt`'s `parent` block is what gives the model the epic or
 * story it hangs under. Nothing is written here — the caller creates the ticket,
 * so a failure costs one description rather than a half-made folder.
 */
export async function writeChild(
	ai: AiProvider,
	request: WriteRequest,
	title: string,
	hooks?: RunHooks
): Promise<WrittenChild> {
	const proposed: AiTicketContext = {
		// No id: it is allocated by the store when the folder is claimed, and
		// `buildPrompt` leaves the field out rather than printing an empty one.
		id: '',
		type: request.childType,
		title,
		status: 'todo',
		description: ''
	};

	const result = await runOnce(
		ai,
		{
			instruction: request.instruction,
			prompt: buildPrompt(
				composeInstruction(request.agent, request.writeSkill),
				proposed,
				request.instruction,
				{
					language: request.language,
					parent: request.parent,
					grandparent: request.grandparent
				}
			),
			ticket: proposed,
			workingDirectory: request.workingDirectory,
			model: request.model,
			maxTurns: request.maxTurns,
			idleTimeoutMs: request.idleTimeoutMs
		},
		hooks
	);

	return {
		description: sanitizeAiDescription(result.text, title),
		note: provenance(
			request.agent.name,
			request.writeSkill?.name,
			request.label,
			result.meta,
			request.instruction
		)
	};
}

/** Starts a run, wires progress and cancellation, and waits for it. */
async function runOnce(
	ai: AiProvider,
	request: Parameters<AiProvider['run']>[0],
	hooks?: RunHooks
): Promise<{ text: string; meta?: AiResultMeta }> {
	const run = ai.run(request, (progress) => {
		const line = describe(progress);
		if (line) {
			hooks?.report?.(line);
		}
	});
	// After `run`, because the handle is what gets cancelled — and immediately,
	// because a user can press the × while the child process is still spawning.
	hooks?.onCancel?.((reason) => run.cancel(reason));
	return run.completed;
}

/**
 * One progress event as a line for the notification.
 *
 * The token counter is the real heartbeat — it starts within a second, long
 * before there is any text — so it is what a silent run shows. Same mapping the
 * board uses, in a form a single-line notification can hold.
 */
function describe(progress: AiProgress): string | undefined {
	switch (progress.kind) {
		case 'started':
			return progress.model ? `Started — ${progress.model}` : 'Started';
		case 'tool-result':
			// Bookkeeping for adoption, not an event worth a line.
			return undefined;
		case 'denied':
			return `Denied: ${progress.tool}${progress.filePath ? ` ${progress.filePath}` : ''}`;
		case 'thinking':
			return progress.tokens !== undefined
				? `Thinking — ${formatTokens(progress.tokens)} tokens`
				: firstLine(progress.text) || 'Thinking…';
		case 'tool':
			return progress.detail ? `${progress.name} ${progress.detail}` : progress.name;
		case 'turn':
			return `Turn ${progress.index}`;
		case 'text':
			return firstLine(progress.text) || 'Writing…';
	}
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

/** A notification is one line high, so a reasoning block is cut to its first. */
function firstLine(text: string | undefined): string {
	const line = (text ?? '').split('\n').find((part) => part.trim().length > 0)?.trim() ?? '';
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
