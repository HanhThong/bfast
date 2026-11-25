// Polling an HTTP endpoint until it says what you are waiting for.
//
// The idle-timeout doctrine needs restating here rather than reused, because a
// poll loop is the one case that breaks it: `runProcess`'s watchdog resets on
// bytes from a child, and a poll **manufactures its own traffic** — it would
// keep any request-counting watchdog alive for ever while the thing being
// polled sat frozen.
//
// So the signal is a **changed payload**, not a completed request. A compute
// engine task stuck at `PENDING` produces a perfectly healthy HTTP conversation
// and is exactly the hang this has to catch. The question is only ever "is
// anything happening at all", and a request that says the same thing as the last
// one is not something happening.

import { ScanCancelledError, ScanError } from './scanProvider';

export interface PollOptions<T> {
	/** One probe. May throw; a throw counts as a change, since the state moved. */
	read: () => Promise<T>;
	/** True when the wait is over. */
	done: (value: T) => boolean;
	/**
	 * What counts as "something happened", for the idle window. Defaults to a
	 * JSON comparison, which is right for a small status payload and wrong for
	 * anything large — pass a projection then.
	 */
	fingerprint?: (value: T) => string;
	/** How long the payload may stay identical before this is called a hang. */
	idleTimeoutMs: number;
	/** Between probes. */
	intervalMs?: number;
	/** Reported on every change, so a long wait has something on screen. */
	onChange?: (value: T) => void;
	/** Checked between probes; a cancel must not wait out the interval. */
	cancelled?: () => boolean;
	/** What the timeout message calls this wait. */
	label?: string;
	/** Injected so a test does not depend on the clock. */
	now?: () => number;
	/** Injected so a test does not wait in real time. */
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Polls until `done`, or throws `ScanError('timeout')` once the payload has been
 * unchanged for `idleTimeoutMs`.
 *
 * The first probe happens immediately: a wait that is already over must not cost
 * an interval.
 */
export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
	const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = options.now ?? (() => Date.now());
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const fingerprintOf = options.fingerprint ?? ((value: T) => safeStringify(value));
	const label = options.label ?? 'The server';

	let lastFingerprint: string | undefined;
	let lastChange = now();

	for (;;) {
		if (options.cancelled?.()) {
			throw new ScanCancelledError();
		}

		// A throw from `read` is deliberately not caught: a server that has
		// started refusing connections is not one worth waiting out, and the
		// caller's error vocabulary is better than anything this loop could
		// invent. Only *silence* is this function's business.
		const value = await options.read();
		const fingerprint = fingerprintOf(value);

		if (fingerprint !== lastFingerprint) {
			lastFingerprint = fingerprint;
			lastChange = now();
			options.onChange?.(value);
		}

		if (options.done(value)) {
			return value;
		}

		if (now() - lastChange >= options.idleTimeoutMs) {
			throw new ScanError(
				'timeout',
				`${label} said the same thing for ${Math.round(options.idleTimeoutMs / 1000)}s and was given up on.`
			);
		}

		await sleep(interval);
	}
}

/** `JSON.stringify` that cannot throw on a cycle — a payload is data, not a promise. */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
