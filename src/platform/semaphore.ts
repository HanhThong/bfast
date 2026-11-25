// In `platform/` for the same reason `idleWatchdog.ts` is: two
// subsystems fan work out under a cap — the generate tab's writes and the test
// runner's commands — and a liveness fix to the handoff must reach both. No
// `vscode` import, so the `vscode`-free half of either flow can take it.

/** A slot, released by the function it resolves to. */
export interface SharedLimiter {
	/**
	 * Waits for a slot. `group` is the batch's own handle — any object will do,
	 * and it is used only to take turns between batches, never to key anything
	 * that outlives the wait.
	 */
	acquire(group: object): Promise<() => void>;
}

/**
 * At most `limit()` holders at once, **across every batch that shares it**.
 *
 * One of these per window rather than one per batch, because `ai.concurrency`
 * and `tests.concurrency` are spend and rate-limit dials — and a dial that
 * multiplies by the number of open tabs is not a dial. Three details are
 * load-bearing:
 *
 * - **`limit` is a getter, read as each slot is taken**, the same "at call
 *   time" posture as `providerRegistry` and `TrackerContext`. A shared cap that
 *   two batches disagreed about would not be a cap, so it cannot be snapshotted
 *   per batch the way a batch's command and timeout are.
 * - **Groups take turns, rather than waiters being served first-come.** Under
 *   FIFO a second ticket's whole batch queues behind the first's, so its tab
 *   sits at `waiting` for a round — which is the very complaint a shared cap is
 *   supposed not to reintroduce. `waiting` is insertion-ordered and a served
 *   group is moved to the back, so two batches alternate.
 * - **`release` is idempotent.** A double release would inflate the cap for the
 *   rest of the window, and the blast radius of that is every open tab.
 *
 * Hand-rolled and short, rather than a dependency: the host's only dependency
 * is the assistant's optional SDK, and that stays true.
 */
export function sharedLimiter(limit: () => number): SharedLimiter {
	let active = 0;
	const waiting = new Map<object, (() => void)[]>();

	const wake = (): void => {
		while (active < limit()) {
			const group = [...waiting.keys()][0];
			if (group === undefined) {
				return;
			}

			const queue = waiting.get(group)!;
			const resume = queue.shift()!;
			// To the back of the rotation, so the next slot goes to the other
			// batch rather than straight back to this one.
			waiting.delete(group);
			if (queue.length > 0) {
				waiting.set(group, queue);
			}

			// Counted here, not in the continuation: an `acquire` landing before
			// the resumed one runs would otherwise see a slot that is spoken for.
			active += 1;
			resume();
		}
	};

	return {
		acquire: async (group) => {
			// Queued even when a slot is free, if anyone is already waiting —
			// otherwise a newcomer takes the turn of a batch that has been waiting.
			if (waiting.size > 0 || active >= limit()) {
				await new Promise<void>((resume) => {
					const queue = waiting.get(group);
					if (queue) {
						queue.push(resume);
					} else {
						waiting.set(group, [resume]);
					}
				});
			} else {
				active += 1;
			}

			let released = false;
			return () => {
				if (released) {
					return;
				}
				released = true;
				active -= 1;
				wake();
			};
		}
	};
}
