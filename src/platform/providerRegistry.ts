// Picking one implementation of a seam by a setting, read at call time.
//
// Four seams do this — the AI provider, the environment provider, the scan
// tool and the coding agent — and each used to be a hand-written class that
// held a `Record<Id, Provider>` and forwarded the interface a member at a time.
// The table was always safe: `Record<Id, …>` does not compile with an id
// missing. The forwarding was not. A member added to a seam and not to its
// wrapper read as "this implementation does not have it" with no error
// anywhere, which is exactly how a scan tool's project file went unread once.
//
// So the forwarding is a `Proxy`: every member the seam has, required or
// optional, is read off whichever implementation the setting names *now*. An
// optional member the current one lacks is `undefined` on the wrapper too —
// the seam's own meaning of "optional", where a hand-written forwarder had to
// invent a no-op.
//
// The cost is that "Find references" on a member does not stop here, which is
// why each seam's registry has a test that a required and an optional member
// both reach through.

/**
 * Every implementation of one seam, and which of them the setting names.
 *
 * All of them are built by the caller, once, and kept: per-call building would
 * throw away whatever an implementation remembers (a docker probe, a CLI
 * version check), and `current` is a getter so that a settings change takes
 * effect on the very next operation.
 */
export class ProviderRegistry<Id extends string, T extends object> {
	constructor(
		private readonly providers: Readonly<Record<Id, T>>,
		private readonly pick: () => Id
	) {}

	/** The implementation the setting names at this moment. */
	get current(): T {
		return this.providers[this.pick()];
	}

	/** Every implementation, selected or not. */
	get all(): T[] {
		return Object.values<T>(this.providers);
	}

	/**
	 * Disposes every implementation that can be, not just the selected one: any
	 * of them may hold a live operation started before the setting moved.
	 */
	dispose(): void {
		for (const provider of this.all) {
			(provider as { dispose?: () => void }).dispose?.();
		}
	}
}

/**
 * An object that *is* a `T`, each member read from `current()` at the moment
 * it is touched. `own` members win — the place for what belongs to the wrapper
 * and not to any one implementation, `dispose` above all.
 *
 * A method comes back bound to the implementation it was read from, so
 * `wrapper.run(…)` and `const { run } = wrapper` both call it with the right
 * `this`.
 */
export function delegateTo<T extends object>(current: () => T, own: Partial<T> = {}): T {
	const overrides = own as Record<PropertyKey, unknown>;
	return new Proxy({} as T, {
		get(_target, property) {
			if (Object.hasOwn(overrides, property)) {
				return overrides[property];
			}
			const target = current();
			const value = (target as Record<PropertyKey, unknown>)[property];
			return typeof value === 'function'
				? (value as (...args: unknown[]) => unknown).bind(target)
				: value;
		},
		has(_target, property) {
			return Object.hasOwn(overrides, property) || property in current();
		}
	});
}

/**
 * The usual pairing: a registry, and the wrapper that forwards to its current
 * implementation and disposes all of them.
 */
export function configuredProvider<Id extends string, T extends object>(
	providers: Readonly<Record<Id, T>>,
	pick: () => Id
): T & { dispose(): void } {
	const registry = new ProviderRegistry(providers, pick);
	return delegateTo<T & { dispose(): void }>(
		() => registry.current as T & { dispose(): void },
		{ dispose: () => registry.dispose() } as Partial<T & { dispose(): void }>
	);
}
