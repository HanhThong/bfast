import * as assert from 'assert';
import { configuredProvider, delegateTo, ProviderRegistry } from '../platform/providerRegistry';

interface Seam {
	readonly id: string;
	greet(name: string): string;
	/** Optional on the seam, the `reclaim?` / `server?` idiom. */
	extra?(): string;
	dispose(): void;
}

class Plain implements Seam {
	disposed = false;
	constructor(readonly id: string) {}
	greet(name: string): string {
		// Reads `this`, so a method handed back unbound would throw here.
		return `${this.id} greets ${name}`;
	}
	dispose(): void {
		this.disposed = true;
	}
}

class WithExtra extends Plain {
	extra(): string {
		return `${this.id} has more`;
	}
}

suite('Provider registry', () => {
	test('the setting is read at call time, not captured', () => {
		let picked: 'a' | 'b' = 'a';
		const registry = new ProviderRegistry<'a' | 'b', Seam>(
			{ a: new Plain('a'), b: new Plain('b') },
			() => picked
		);
		assert.strictEqual(registry.current.id, 'a');
		picked = 'b';
		assert.strictEqual(registry.current.id, 'b');
	});

	test('every member reaches the selected implementation, bound to it', () => {
		let picked: 'a' | 'b' = 'a';
		const provider = configuredProvider<'a' | 'b', Seam>(
			{ a: new Plain('a'), b: new Plain('b') },
			() => picked
		);
		assert.strictEqual(provider.id, 'a');
		assert.strictEqual(provider.greet('you'), 'a greets you');

		// Detached, the way a destructured method would be.
		const { greet } = provider;
		assert.strictEqual(greet('you'), 'a greets you');

		picked = 'b';
		assert.strictEqual(provider.id, 'b');
		assert.strictEqual(provider.greet('you'), 'b greets you');
	});

	test('an optional member is there exactly when the selected implementation has it', () => {
		let picked: 'plain' | 'extra' = 'plain';
		const provider = configuredProvider<'plain' | 'extra', Seam>(
			{ plain: new Plain('plain'), extra: new WithExtra('extra') },
			() => picked
		);
		const extra = (): string | undefined => provider.extra?.();
		assert.strictEqual(extra(), undefined);
		assert.strictEqual('extra' in provider, false);

		picked = 'extra';
		assert.strictEqual(extra(), 'extra has more');
		assert.strictEqual('extra' in provider, true);
	});

	test('disposing the wrapper disposes every implementation, selected or not', () => {
		const a = new Plain('a');
		const b = new Plain('b');
		const provider = configuredProvider<'a' | 'b', Seam>({ a, b }, () => 'a');
		provider.dispose();
		assert.deepStrictEqual([a.disposed, b.disposed], [true, true]);
	});

	test('an implementation with no dispose is left alone', () => {
		const provider = configuredProvider<'a', { id: string }>({ a: { id: 'a' } }, () => 'a');
		assert.doesNotThrow(() => provider.dispose());
	});

	test('a wrapper’s own members win over the implementation’s', () => {
		const target = new Plain('a');
		const wrapped = delegateTo<Seam>(() => target, { greet: () => 'mine' });
		assert.strictEqual(wrapped.greet('you'), 'mine');
		assert.strictEqual(wrapped.id, 'a');
	});
});
