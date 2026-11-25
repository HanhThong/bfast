// Where a generate tab's conversation is remembered between openings.
//
// A follow-up on the review screen continues the Claude session the plan run
// opened, and a tab opened again later offers to continue it too. The store
// itself — the forgiving read, the single readable object, `workspaceState`
// rather than `metadata.yaml` — is `ai/aiSessions.ts`, shared with the board's
// design tabs; this file is only the key it is asked with: per (parent, child
// type), the pair a generate tab is keyed on.

import {
	keyedSessionStore,
	type AiSession,
	type SessionMemento
} from './aiSessions';
import type { TicketType } from '../data/types';

export type { SessionMemento };
/** Named for this flow, one shape with every other remembered conversation. */
export type GenerateSession = AiSession;

export interface GenerateSessionStore {
	get(parentId: string, childType: TicketType): GenerateSession | undefined;
	set(parentId: string, childType: TicketType, session: GenerateSession): Promise<void>;
}

/** One key for all of them, so the state stays a single readable object. */
export const GENERATE_SESSIONS_KEY = 'bfast.generateSessions';

export function mementoSessionStore(memento: SessionMemento): GenerateSessionStore {
	const store = keyedSessionStore(memento, GENERATE_SESSIONS_KEY);
	return {
		get: (parentId, childType) => store.get(sessionKey(parentId, childType)),
		set: (parentId, childType, session) => store.set(sessionKey(parentId, childType), session)
	};
}

export function sessionKey(parentId: string, childType: TicketType): string {
	return `${parentId}:${childType}`;
}
