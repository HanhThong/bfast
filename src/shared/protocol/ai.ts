// The AI assistant's messages on a board — a run, its progress, its answer.
//
// One file per webview concern, joined in `index.ts`. See the note there.

import type { AgentDefinition } from '../../ai/agent';

/**
 * A ticket an AI run edited on disk while writing another. `adopted` says the
 * change was recorded in that ticket's history and its `updatedAt` bumped;
 * when it was not, `reason` says why — the ticket being written (its answer is
 * the draft, not the file), a save from a board that got there first, a file
 * that turned out unchanged, or a path no ticket owns.
 */
export interface AiEditedTicket {
	id: string;
	title: string;
	adopted: boolean;
	reason?: 'own-ticket' | 'superseded' | 'unchanged' | 'unknown-ticket';
}

/** What this part of the webview sends to the extension host. */
export type AiToHost =
	/**
	 * Run the AI assistant against a ticket.
	 *
	 * `requestId` correlates the reply exactly as the three image requests do,
	 * and for stronger reasons: a run takes minutes, the panel may be showing a
	 * different ticket by the time it lands, and the tab may be gone.
	 *
	 * It carries no `updatedAt`. The result goes into the draft, and the *user's*
	 * Save does the conflict check with the value the board holds at that moment
	 * — holding one across a long run would turn every ticket touched meanwhile
	 * into a guaranteed conflict that discards the generated text.
	 */
	| {
			type: 'aiGenerate';
			requestId: string;
			id: string;
			instruction: string;
			/**
			 * Which agent to run. A slug rather than the instruction itself: the file
			 * is re-read at run time, so editing it in an editor tab takes effect on
			 * the very next Generate, and the host never trusts the webview with the
			 * prompt it is about to send.
			 */
			agent?: string;
			/**
			 * A design document id (`ERD-1`) when the run is writing one, rather than
			 * the ticket's description.
			 *
			 * The same message, and the same one-run-at-a-time rule, because a board
			 * has one Generate button whichever tab it is on — only which skill runs
			 * and where the answer lands differ. Echoed back on `aiResult` so the
			 * board knows which draft it belongs to.
			 */
			design?: string;
			/**
			 * Continue the Claude conversation the last run on this document left,
			 * when the host said on `aiSession` that there is one.
			 *
			 * A boolean, never a session id: the host resolves what to resume from
			 * its own store, exactly as it resolves the agent from a slug. Only a
			 * design run offers it — a description run has no second press to
			 * refine, its whole text is in the prompt already.
			 */
			continueSession?: boolean;
			/**
			 * The model this tab picked for its runs — an alias or id from
			 * `models.ts`, or one typed in. Absent means the workspace setting.
			 *
			 * A name the host sanitises (`aiModel`, through `isModelId`) before it
			 * becomes an argv element, the way `agent` is a slug the host resolves:
			 * the webview never hands the host a flag value it did not check.
			 */
			model?: string;
	  }
	| { type: 'aiCancel'; requestId: string };

/** What the extension host sends back. */
export type HostToAi =
	/**
	 * Whether there is a conversation the next run on this design document could
	 * continue. Sent when the document opens and after every run on it, since a
	 * run may just have started one.
	 *
	 * Only when the current provider is the one that ran it — and only the fact,
	 * never the id, which is the `generateSession` rule: the webview asks with a
	 * boolean and the host resolves what to resume.
	 */
	| { type: 'aiSession'; id: string; design: string; previous?: { at: string } }
	| { type: 'aiStarted'; requestId: string; label: string }
	/**
	 * One thing the agent did. `thinkingTokens` is a running total rather than an
	 * event — it is the heartbeat that says a long, quiet run has not hung, and
	 * it arrives long before there is any `thinking` text to show.
	 */
	| {
			type: 'aiProgress';
			requestId: string;
			text?: string;
			thinking?: string;
			thinkingTokens?: number;
			tool?: string;
	  }
	/** The generated description, already sanitised by the host. */
	| {
			type: 'aiResult';
			requestId: string;
			text: string;
			note?: string;
			design?: string;
			/** Other tickets the run edited on disk, and whether each was recorded. */
			edited?: AiEditedTicket[];
	  }
	| {
			/**
			 * Also sent when the user cancelled the run themselves, so the board can
			 * drop its pending state; `message` is absent in that case — the same
			 * convention `imageFailed` uses.
			 */
			type: 'aiFailed';
			requestId: string;
			/** Edits already on disk stay on disk, so a failed or stopped run reports them too. */
			edited?: AiEditedTicket[];
			message?: string;
			code?: string;
	  }
	/** Pushed on `ready`, on a settings change, and after the credential commands. */
	| {
			type: 'aiAvailability';
			available: boolean;
			label?: string;
			message?: string;
			/** Every agent on disk, so the board can offer the ones fitting this ticket. */
			agents?: AgentDefinition[];
			/** The workspace's `ai.model`, so the picker can name what "Default" means. */
			model?: string;
	  };
