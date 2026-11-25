// The generate tab — breaking a ticket down into its children.
//
// One file per webview concern, joined in `index.ts`. See the note there.

import type { AgentDefinition } from '../../ai/agent';
import type { TicketType } from '../../data/types';

/** What this part of the webview sends to the extension host. */
export type GenerateToHost =
	/**
	 * The generate tab, where breaking a ticket down happens.
	 *
	 * A tab rather than a quick pick and a notification because the flow has
	 * three moments a modal cannot hold at once: a form, minutes of log that say
	 * the run has not hung, and a list to tick through. A notification cannot be
	 * live while a quick pick has focus, and neither survives a click elsewhere.
	 */
	| { type: 'generateReady'; parentId?: string; childType?: TicketType }
	| {
			type: 'generateStart';
			/** A slug, never the instruction: the host resolves and composes. */
			agent?: string;
			instruction: string;
			/**
			 * Continue the conversation an earlier batch left, when the host said
			 * there is one. A boolean, never a session id: the host resolves what
			 * to resume from its own store, the way it resolves the agent from a slug.
			 */
			continueSession: boolean;
			/**
			 * The model for this batch — the plan, every refine and every write.
			 * Absent means the workspace setting; sanitised by the host, as on
			 * `aiGenerate`.
			 */
			model?: string;
	  }
	/** The titles the user kept, out of the ones proposed. */
	| { type: 'generateChoose'; titles: string[] }
	/** Ask the agent again, in the same conversation; the list on screen is replaced. */
	| { type: 'generateRefine'; instruction: string }
	| { type: 'generateCancel' }
	/** Back to the form, to run it again with a different agent or instruction. */
	| { type: 'generateReset' };

/** What the extension host sends back. */
export type HostToGenerate =
	/** Everything the generate form needs to paint itself, sent on `generateReady`. */
	| {
			type: 'generateContext';
			parent: { id: string; key: string; title: string; type: TicketType };
			childType: TicketType;
			/** Already filtered to the agents that write `childType`. */
			agents: AgentDefinition[];
			available: boolean;
			/** Why the assistant cannot run, when it cannot. */
			unavailable?: string;
			providerLabel?: string;
			/** The workspace's `ai.model`, so the picker can name what "Default" means. */
			model?: string;
	  }
	/**
	 * Whether there is a conversation this tab can continue. Sent after the
	 * context and after every run, since a run may just have started one. Only
	 * when the current provider is the one that ran it — and only the fact,
	 * never the id.
	 */
	| { type: 'generateSession'; previous?: { at: string } }
	/** Which of the six screens the tab is on. `total` is set while writing. */
	| { type: 'generatePhase'; phase: GeneratePhase; total?: number }
	/**
	 * One line for the log. The whole reason this is a tab: a run takes minutes
	 * and says nothing on its own, so without this there is no telling working
	 * from hung.
	 *
	 * `lane` is which child it came from, since several agents write at once and
	 * an unlabelled interleaving of their heartbeats says nothing at all. Absent
	 * means the flow itself rather than one of its children.
	 */
	| { type: 'generateLog'; line: string; lane?: number }
	/**
	 * One child's own row: what it is, what it is doing now, and how it ended.
	 *
	 * Separate from the log because they answer different questions — this one is
	 * "what is each agent doing right now", which a chronological stream of a
	 * dozen interleaved heartbeats cannot show.
	 */
	| {
			type: 'generateLane';
			lane: number;
			title: string;
			status: GenerateLaneStatus;
			/** Its latest line of activity, when it has one. */
			note?: string;
	  }
	/**
	 * The list to review, and the follow-ups it reflects. The transcript is the
	 * host's: the webview never appends a follow-up itself, so one that was
	 * stopped or failed changes nothing on screen and stays in the box to retry.
	 */
	| { type: 'generateProposed'; titles: string[]; followUps: string[] }
	/**
	 * A ticket landed on disk. Sent one at a time so the list fills in as the
	 * run goes, rather than appearing all at once at the end.
	 */
	| {
			type: 'generateCreated';
			id: string;
			key: string;
			title: string;
			/** False when its run failed: the ticket exists, its description is empty. */
			described: boolean;
	  }
	| { type: 'generateDone'; message: string }
	| { type: 'generateError'; message: string };

/**
 * The screens the generate tab moves through, in order. `refining` is the
 * review screen with a follow-up in flight: the list stays up, greyed, and
 * comes back replaced.
 */
export type GeneratePhase = 'setup' | 'planning' | 'review' | 'refining' | 'writing' | 'done';

/**
 * Where one child's own run got to.
 *
 * `waiting` is real and worth showing: with a concurrency of three, a breakdown
 * of eight has five children that have not started, and a row that simply is
 * not there yet reads as one that was dropped.
 */
export type GenerateLaneStatus = 'waiting' | 'running' | 'done' | 'failed';
