// When a run has stopped being alive.
//
// The assistant used to arm one `setTimeout` for a whole run, which made "how
// long may a generation take" and "how long may it say nothing" the same
// number — and they are not the same question. Breaking a large epic down
// legitimately runs past any total anyone would pick, and that ceiling killed
// runs that were actively streaming. The failure actually worth catching is a
// child that has said *nothing at all* for minutes, and that one is caught
// whatever the run's age.
//
// Pure and `vscode`-free, and in `platform/` rather than inside `ai/` or
// `environments/` because both use it: an agent's stdout and `docker compose
// build`'s stdout raise exactly the same question. Not `src/shared/`, which is
// the host↔webview seam and this never crosses it.

/**
 * How long a run may be completely silent before its caller stops it.
 *
 * Three minutes of true silence is already generous: the CLI's
 * `system`/`thinking_tokens` heartbeat starts within a second and arrives
 * several times a second thereafter, and the watchdog is reset by raw bytes on
 * either pipe rather than by anything as narrow as a parsed event.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

/**
 * A watchdog that fires only when whatever it is watching has gone quiet.
 *
 * `touch()` is called from a stdout `data` handler, which on a chatty run fires
 * several times a second for minutes, so it must not go near a timer: it writes
 * one field. The timer re-arms *itself* for whatever is left of the window,
 * which means a steadily streaming run pays one `setTimeout` per window rather
 * than one per chunk, and the wake-up still lands within a millisecond or two
 * of the real deadline — the accuracy a fixed polling tick would trade away.
 *
 * `Date.now()` rather than a monotonic clock on purpose: a laptop resume jumps
 * the clock forward *and* freezes the timer, so both readings agree the child
 * has been quiet — which is the answer you want.
 */
export class IdleWatchdog {
	private last = Date.now();
	private timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Armed at construction rather than on the first `touch()`. A child that
	 * spawns and then says nothing — no init, no heartbeat, not even a line on
	 * stderr — is the exact failure this exists to end, and it is the one case a
	 * watchdog started by the first sign of life would wait on forever.
	 */
	constructor(
		private readonly idleMs: number,
		private readonly onIdle: () => void
	) {
		this.arm(Math.max(1, idleMs));
	}

	/** Records that something arrived. One assignment: no timer is touched here. */
	touch(): void {
		this.last = Date.now();
	}

	/**
	 * Idempotent, and safe after the run settled or after it already fired — it
	 * is called from a `finally` that does not know which happened.
	 */
	stop(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private arm(delay: number): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const quietFor = Date.now() - this.last;
			if (quietFor >= this.idleMs) {
				// No re-arm: a run is stopped once, and the caller is about to kill
				// the child out from under us.
				this.onIdle();
				return;
			}
			// Something arrived while we slept, so the deadline moved with it.
			this.arm(this.idleMs - quietFor);
		}, delay);
	}
}

/**
 * What the user is told, built from the window that was actually enforced so
 * the number in the sentence cannot drift from the number in the code.
 *
 * It has to say *silence*, not slowness: "took too long" reads as a cap on the
 * work, which is precisely what this stopped being, and it would send someone
 * looking for a setting to raise.
 */
export function idleTimeoutMessage(idleMs: number, what = 'The AI assistant'): string {
	const minutes = idleMs / 60_000;
	const window =
		minutes >= 1
			? `${round(minutes)} minute${round(minutes) === 1 ? '' : 's'}`
			: `${round(idleMs / 1000)} second${round(idleMs / 1000) === 1 ? '' : 's'}`;

	return (
		`${what} sent nothing for ${window} and was stopped. Anything still working ` +
		'keeps reporting progress, so it had hung.'
	);
}

function round(value: number): number {
	return Math.max(1, Math.round(value));
}
