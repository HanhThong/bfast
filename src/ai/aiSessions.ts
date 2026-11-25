// Where a Claude conversation is remembered between runs, so a second press
// continues it instead of starting over.
//
// The store is `workspaceState`, never `metadata.yaml`: a Claude session is a
// file under `~/.claude/projects/<cwd>` on this machine, so committing its id
// would hand a teammate one that resolves to nothing.
//
// Keyed by an opaque string, because the two callers key on different things —
// a generate tab on (parent, child type), a board's design tab on (ticket,
// document) — and the shape of the value, the forgiving read and the "one key
// holding all of them" rule are the same either way. This module is the one
// place that decides them; `ai/generateSessions.ts` is a thin adapter over
// it, and so is the board's use.
//
// `vscode`-free, like the rest of the AI seams, so a test hands in a plain
// object where the extension hands in `context.workspaceState`. Host-only all
// the same: the webview learns whether there is a session, never what it is.

export interface AiSession {
	sessionId: string;
	/** `AiProvider.id`. A continuation is offered only to the provider that ran it. */
	provider: string;
	/** ISO timestamp of the last run that spoke in it — what a form shows as "from 5 minutes ago". */
	at: string;
}

/** The slice of `vscode.Memento` the store uses, so a test hands it a plain object. */
export interface SessionMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface SessionStore {
	get(key: string): AiSession | undefined;
	set(key: string, session: AiSession): Promise<void>;
}

/** Where a board's design tab conversations live. Its own key, its own subject. */
export const DESIGN_SESSIONS_KEY = 'bfast.designSessions';

/**
 * A design run's key: the document, not the ticket. Two diagrams on one story
 * are two conversations — resuming the ERD's session to draw the sequence
 * diagram would hand the model the wrong document and the wrong contract.
 */
export function designSessionKey(ticketId: string, designId: string): string {
	return `${ticketId}:${designId}`;
}

/**
 * The way out of a conversation that will not resume: the checkbox that offered
 * it, never a guess. One address, because both surfaces that offer a resume have
 * to name the same way back out of one.
 */
export const START_FRESH_HINT = 'Untick “Continue the previous conversation” to start fresh.';

/**
 * The one rule for whether a remembered conversation can be used right now: it
 * has to exist, and the provider that ran it has to be the one that would run
 * next — a session id is the CLI's or the SDK's own, and one handed to the
 * other resolves to nothing.
 *
 * Both halves ask through here: the offer a surface paints, and the resume the
 * run performs. Split, a checkbox could offer a conversation the run would then
 * silently ignore — a promise the host cannot keep.
 */
export function usableSession(
	session: AiSession | undefined,
	provider: string | undefined
): AiSession | undefined {
	return session && provider !== undefined && session.provider === provider ? session : undefined;
}

/**
 * Reads forgivingly, the `yaml.ts` posture: an entry that is not the shape
 * written here — a hand edit, an older build — reads as no session rather than
 * as a session with holes in it. No `clear`: a later run's success overwrites,
 * and nothing else wants to forget one.
 */
export function keyedSessionStore(memento: SessionMemento, storageKey: string): SessionStore {
	const read = (): Record<string, unknown> => {
		const stored = memento.get<unknown>(storageKey);
		return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: {};
	};

	return {
		get: (key) => parseSession(read()[key]),

		set: async (key, session) => {
			await memento.update(storageKey, {
				...read(),
				[key]: { sessionId: session.sessionId, provider: session.provider, at: session.at }
			});
		}
	};
}

export function parseSession(value: unknown): AiSession | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { sessionId, provider, at } = value as Record<string, unknown>;
	return typeof sessionId === 'string' &&
		sessionId.length > 0 &&
		typeof provider === 'string' &&
		typeof at === 'string'
		? { sessionId, provider, at }
		: undefined;
}
