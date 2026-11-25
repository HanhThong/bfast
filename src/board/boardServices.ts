// What a board needs from the rest of the extension.

import type { AgentDefinition, AgentSkill } from '../ai/agent';
import type { AiProvider } from '../ai/aiProvider';
import type { SessionStore } from '../ai/aiSessions';
import type { WritableTicketStore } from '../data/ticketStore';
import type { DesignStyle } from '../design/designDocument';
import type { DesignStore } from '../design/designStore';
import type { AiSettings } from '../settings/aiSettings';
import type { TestsSettings } from '../settings/testsSettings';
import type { TestBatches } from '../testing/testBatches';
import type { TestResultsStore } from '../testing/testResultsStore';
import type { TraceFrameResult, TraceReadResult } from '../testing/traceReader';

/**
 * Gathered into one object rather than positional parameters threaded through
 * `register` / `open` / the constructor — and grouped by concern, so "this
 * board has no assistant" is one absent object rather than seven optional
 * fields that could disagree with each other.
 */
export interface BoardServices {
	store: WritableTicketStore;
	/**
	 * The technical design documents on a ticket. Optional for the same reason
	 * `ai` is: a test's services need not care, and a board without it simply
	 * grows no design tabs.
	 */
	designs?: DesignBoardServices;
	/**
	 * Absent means the assistant is not offered at all: no button, no messages.
	 * That is what lets a board survive a provider that cannot load.
	 */
	ai?: AiBoardServices;
	onChanged: () => void;
	/**
	 * A board was opened on this ticket, or its tab became the active one — the
	 * sidebar follows by revealing it. Optional: a test's services need not care.
	 */
	onDidShowTicket?: (id: string) => void;
	/** The Tests tab's half. Required: unlike `ai`, nothing here can fail to construct. */
	tests: TestBoardServices;
}

export interface DesignBoardServices {
	store: DesignStore;
	/**
	 * Read at call time, so a style added as a skill reaches the next paint.
	 * Asynchronous: a style is declared by a design skill, and skills are files.
	 */
	styles: () => Promise<DesignStyle[]>;
}

export interface AiBoardServices {
	provider: AiProvider;
	/** Read at call time, so a settings change reaches a run without re-wiring. */
	settings: () => AiSettings | undefined;
	/**
	 * The agents on disk, re-read on every call: an agent file edited in an
	 * editor tab has to take effect on the very next Generate.
	 */
	agents: () => Promise<AgentDefinition[]>;
	/**
	 * The design skill an agent shapes one style with, bundled fallback included.
	 * A function rather than the store, for the same reason `agents` is one.
	 */
	designSkill: (agent: AgentDefinition, style: string) => Promise<AgentSkill | undefined>;
	/**
	 * Where a design document's Claude conversation is remembered, so a second
	 * press can continue it rather than start over. Optional: without it every
	 * run is simply a fresh conversation, which is what every run was before
	 * this existed.
	 */
	sessions?: SessionStore;
	/** Absolute path file tools resolve against. Absent means no filesystem. */
	workingDirectory: () => string | undefined;
	/**
	 * The tracker folder, workspace-relative, read at call time. What a board run
	 * needs to be allowed to edit other tickets: absent, and a run stays read-only.
	 */
	trackerFolder: () => string | undefined;
}

export interface TestBoardServices {
	batches: TestBatches;
	/** Where runs are filed — the Tests tab's run history and the base its evidence urls resolve against. */
	results: TestResultsStore;
	/** Read at call time, so a settings change reaches the next paint. */
	settings: () => TestsSettings | undefined;
	/** Opens one evidence file or reveals a run folder — the host checks every name. */
	openEvidence: (ticketId: string, run: string, file?: string) => Promise<void>;
	/** The bytes of one evidence video, for the fallback player; the host checks every name here too. */
	readEvidence: (
		ticketId: string,
		run: string,
		file: string,
		/** Re-encode as VP8 first: the editor has no decoder for the recording. */
		convert?: boolean
	) => Promise<{ data: string; mime: string } | { error: string }>;
	/** A `trace.zip` read into the board's report — same checks. */
	readTrace: (ticketId: string, run: string, file: string) => Promise<TraceReadResult>;
	/** One screencast frame of that trace, by a name the report listed. */
	readTraceFrame: (ticketId: string, run: string, file: string, frame: string) => Promise<TraceFrameResult>;
	/** The trace in Playwright's own viewer — the command when set, the workspace's Playwright otherwise. */
	openTraceViewer: (ticketId: string, run: string, file: string) => Promise<void>;
	/** A source location a trace named, in an editor. */
	openTraceSource: (file: string, line: number, column?: number) => Promise<void>;
	/** Whether the workspace has a Playwright to open traces with — what the report's `traceViewer` says. */
	traceViewerAvailable: () => Promise<boolean>;
}
