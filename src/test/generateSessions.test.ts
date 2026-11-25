import * as assert from 'assert';
import {
	GENERATE_SESSIONS_KEY,
	mementoSessionStore,
	type SessionMemento
} from '../ai/generateSessions';

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

suite('BFAST generate sessions', () => {
	test('reads back what it stored, per parent and child type', async () => {
		const store = mementoSessionStore(memento());
		assert.strictEqual(store.get('EP-1', 'story'), undefined);

		await store.set('EP-1', 'story', { sessionId: 's1', provider: 'claude-cli', at: '2026-09-05T10:00:00.000Z' });
		await store.set('ST-1.1', 'ac', { sessionId: 's2', provider: 'claude-cli', at: '2026-09-05T11:00:00.000Z' });

		assert.deepStrictEqual(store.get('EP-1', 'story'), {
			sessionId: 's1',
			provider: 'claude-cli',
			at: '2026-09-05T10:00:00.000Z'
		});
		assert.strictEqual(store.get('ST-1.1', 'ac')?.sessionId, 's2');
		assert.strictEqual(store.get('EP-1', 'ac'), undefined, 'the pair is the key, not the parent');
	});

	test('overwrites the earlier session for the same pair, and only that one', async () => {
		const memory = memento();
		const store = mementoSessionStore(memory);
		await store.set('EP-1', 'story', { sessionId: 's1', provider: 'fake', at: 'a' });
		await store.set('EP-2', 'story', { sessionId: 's2', provider: 'fake', at: 'a' });
		await store.set('EP-1', 'story', { sessionId: 's3', provider: 'fake', at: 'b' });

		assert.strictEqual(store.get('EP-1', 'story')?.sessionId, 's3');
		assert.strictEqual(store.get('EP-2', 'story')?.sessionId, 's2');
		// One key holding all of them, so the state stays a single readable object.
		assert.deepStrictEqual(Object.keys(memory.state.get(GENERATE_SESSIONS_KEY) as object), [
			'EP-1:story',
			'EP-2:story'
		]);
	});

	// The `yaml.ts` posture: a value that is not the shape written here reads as
	// no session, never as a session with holes in it.
	test('ignores a stored value it does not recognise', async () => {
		for (const stored of [
			'not an object',
			['a', 'list'],
			{ 'EP-1:story': 'a string' },
			{ 'EP-1:story': { sessionId: '', provider: 'fake', at: 'a' } },
			{ 'EP-1:story': { sessionId: 's1', provider: 7, at: 'a' } },
			{ 'EP-1:story': { sessionId: 's1' } }
		]) {
			const store = mementoSessionStore(memento({ [GENERATE_SESSIONS_KEY]: stored }));
			assert.strictEqual(store.get('EP-1', 'story'), undefined, JSON.stringify(stored));
		}

		// Writing over junk still works, and keeps nothing of it.
		const store = mementoSessionStore(memento({ [GENERATE_SESSIONS_KEY]: 'junk' }));
		await store.set('EP-1', 'story', { sessionId: 's1', provider: 'fake', at: 'a' });
		assert.strictEqual(store.get('EP-1', 'story')?.sessionId, 's1');
	});
});
