import * as assert from 'assert';
import {
	DESIGN_SESSIONS_KEY,
	designSessionKey,
	keyedSessionStore,
	usableSession,
	type SessionMemento
} from '../ai/aiSessions';
import { GENERATE_SESSIONS_KEY, mementoSessionStore } from '../ai/generateSessions';

/** A `workspaceState` stand-in: the two members the store uses, over a map. */
function memento(initial: Record<string, unknown> = {}): SessionMemento & {
	state: Map<string, unknown>;
} {
	const state = new Map<string, unknown>(Object.entries(initial));
	return {
		state,
		get: <T>(key: string) => state.get(key) as T | undefined,
		update: async (key, value) => {
			state.set(key, value);
		}
	};
}

suite('BFAST AI sessions', () => {
	test('reads back what it stored, per key', async () => {
		const store = keyedSessionStore(memento(), DESIGN_SESSIONS_KEY);
		assert.strictEqual(store.get('ST-1.1:ERD-1'), undefined);

		await store.set('ST-1.1:ERD-1', {
			sessionId: 's1',
			provider: 'claude-cli',
			at: '2026-09-06T10:00:00.000Z'
		});

		assert.deepStrictEqual(store.get('ST-1.1:ERD-1'), {
			sessionId: 's1',
			provider: 'claude-cli',
			at: '2026-09-06T10:00:00.000Z'
		});
	});

	// Two diagrams on one story are two conversations: resuming the ERD's to draw
	// the sequence diagram would hand the model the wrong document and the wrong
	// contract.
	test('a design conversation belongs to the document, not the ticket', async () => {
		const store = keyedSessionStore(memento(), DESIGN_SESSIONS_KEY);
		await store.set(designSessionKey('ST-1.1', 'ERD-1'), {
			sessionId: 'erd',
			provider: 'fake',
			at: 'a'
		});

		assert.strictEqual(store.get(designSessionKey('ST-1.1', 'ERD-1'))?.sessionId, 'erd');
		assert.strictEqual(store.get(designSessionKey('ST-1.1', 'SEQ-1')), undefined);
		assert.strictEqual(store.get(designSessionKey('ST-1.2', 'ERD-1')), undefined);
	});

	test('overwrites the earlier session for the same key, and only that one', async () => {
		const memory = memento();
		const store = keyedSessionStore(memory, DESIGN_SESSIONS_KEY);
		await store.set('a', { sessionId: 's1', provider: 'fake', at: 'a' });
		await store.set('b', { sessionId: 's2', provider: 'fake', at: 'a' });
		await store.set('a', { sessionId: 's3', provider: 'fake', at: 'b' });

		assert.strictEqual(store.get('a')?.sessionId, 's3');
		assert.strictEqual(store.get('b')?.sessionId, 's2');
		// One key holding all of them, so the state stays a single readable object.
		assert.deepStrictEqual(Object.keys(memory.state.get(DESIGN_SESSIONS_KEY) as object), [
			'a',
			'b'
		]);
	});

	// The `yaml.ts` posture: a value that is not the shape written here reads as
	// no session, never as a session with holes in it.
	test('ignores a stored value it does not recognise', async () => {
		for (const stored of [
			'not an object',
			['a', 'list'],
			{ a: 'a string' },
			{ a: { sessionId: '', provider: 'fake', at: 'a' } },
			{ a: { sessionId: 's1', provider: 7, at: 'a' } },
			{ a: { sessionId: 's1' } }
		]) {
			const store = keyedSessionStore(
				memento({ [DESIGN_SESSIONS_KEY]: stored }),
				DESIGN_SESSIONS_KEY
			);
			assert.strictEqual(store.get('a'), undefined, JSON.stringify(stored));
		}

		// Writing over junk still works, and keeps nothing of it.
		const store = keyedSessionStore(
			memento({ [DESIGN_SESSIONS_KEY]: 'junk' }),
			DESIGN_SESSIONS_KEY
		);
		await store.set('a', { sessionId: 's1', provider: 'fake', at: 'a' });
		assert.strictEqual(store.get('a')?.sessionId, 's1');
	});

	// One rule, asked by both halves: the offer a board paints and the resume a
	// run performs. Split, a checkbox could offer a conversation the run would
	// then silently ignore.
	test('a session is usable only by the provider that ran it', () => {
		const session = { sessionId: 's1', provider: 'claude-cli', at: 'a' };

		assert.strictEqual(usableSession(session, 'claude-cli'), session);
		assert.strictEqual(
			usableSession(session, 'claude-agent-sdk'),
			undefined,
			'a session id is one provider’s own'
		);
		assert.strictEqual(usableSession(session, undefined), undefined, 'no provider, no resume');
		assert.strictEqual(usableSession(undefined, 'claude-cli'), undefined);
	});

	// The generate tab and the board share the store and must not share a shelf:
	// a design document keyed `ST-1.1:ERD-1` and a generate batch keyed
	// `ST-1.1:ac` would otherwise be one namespace with two grammars in it.
	test('the two flows keep separate storage keys', async () => {
		const memory = memento();
		await keyedSessionStore(memory, DESIGN_SESSIONS_KEY).set(
			designSessionKey('ST-1.1', 'ERD-1'),
			{ sessionId: 'design', provider: 'fake', at: 'a' }
		);
		await mementoSessionStore(memory).set('ST-1.1', 'ac', {
			sessionId: 'generate',
			provider: 'fake',
			at: 'a'
		});

		assert.notStrictEqual(DESIGN_SESSIONS_KEY, GENERATE_SESSIONS_KEY);
		assert.strictEqual(mementoSessionStore(memory).get('ST-1.1', 'ac')?.sessionId, 'generate');
		assert.strictEqual(
			keyedSessionStore(memory, DESIGN_SESSIONS_KEY).get(designSessionKey('ST-1.1', 'ERD-1'))
				?.sessionId,
			'design'
		);
	});
});
