// Port allocation for environments.
//
// `planPorts` is the pure core — first free candidates in range order — and
// `allocatePorts` is the same walk with a liveness probe per candidate, so a
// port some other program already holds is skipped rather than handed out.
// The probe is injectable (`PortProbe`) so tests never bind a socket.
//
// `reserved` is the union of every existing marker's port values: two
// environments never overlap, even while both stacks are down.

import { createServer } from 'net';
import { EnvironmentError } from './environmentProvider';

export interface PortRange {
	start: number;
	end: number;
}

/**
 * Assigns each name the next free port in range order, skipping `reserved`.
 * Pure and synchronous; `undefined` when the range cannot hold them all.
 */
export function planPorts(
	names: readonly string[],
	range: PortRange,
	reserved: ReadonlySet<number>
): Record<string, number> | undefined {
	const ports: Record<string, number> = {};
	let candidate = range.start;
	for (const name of names) {
		while (candidate <= range.end && reserved.has(candidate)) {
			candidate++;
		}
		if (candidate > range.end) {
			return undefined;
		}
		ports[name] = candidate++;
	}
	return ports;
}

/** `true` when the port is actually free to bind right now. */
export type PortProbe = (port: number) => Promise<boolean>;

/**
 * Tries to listen on the loopback interface — the same bind a published
 * container port needs to win — and immediately lets go.
 */
export const probePort: PortProbe = (port) =>
	new Promise((resolve) => {
		const server = createServer();
		server.once('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(true));
		});
	});

/**
 * `planPorts` with the probe folded into the walk: a candidate that turns out
 * taken is treated as reserved and the walk continues. Throws
 * `EnvironmentError('no-ports')` when the range cannot satisfy the names.
 */
export async function allocatePorts(
	names: readonly string[],
	range: PortRange,
	reserved: ReadonlySet<number>,
	probe: PortProbe = probePort
): Promise<Record<string, number>> {
	const ports: Record<string, number> = {};
	let candidate = range.start;

	for (const name of names) {
		let found: number | undefined;
		while (candidate <= range.end) {
			const port = candidate++;
			if (reserved.has(port)) {
				continue;
			}
			if (await probe(port)) {
				found = port;
				break;
			}
		}
		if (found === undefined) {
			throw new EnvironmentError(
				'no-ports',
				`The port range ${range.start}–${range.end} has no free port left for ${name}. ` +
					'Widen the range in BFAST settings or delete an environment.'
			);
		}
		ports[name] = found;
	}

	return ports;
}
