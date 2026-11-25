// One container's log, followed live.
//
// The document is a header and a scroller and nothing else — no search, no
// filter, no download: this story is `view`, and each of those is its own
// ticket. What it does owe the reader is three behaviours that a naive
// append-and-scroll gets wrong:
//
// - **Auto-scroll yields to reading.** New lines scroll the view only when it
//   is already at the bottom, so scrolling up to read a stack trace is not
//   undone by the next heartbeat line.
// - **Keys are stable.** Entries carry a monotonic id rather than their index,
//   so a batch arriving every tenth of a second mounts the new rows instead of
//   re-rendering every row above them once the cap starts dropping the oldest.
// - **Notes live in the stream.** "The stream ended" and the separator above a
//   restarted follow are entries like any other, so they sit where they
//   happened rather than in a banner that claims the whole document.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContainerState } from '../../environments/environmentProvider';
import { channel, getState, setState } from '../vscodeApi';
import type { ContainerLogToHost, HostToContainerLog } from '../../shared/protocol';

const { onMessage, postMessage } = channel<ContainerLogToHost, HostToContainerLog>();

interface Context {
	environment: string;
	container: string;
	service: string;
	state: ContainerState;
	status: string;
}

/** One rendered row: a line the container printed, or a note BFAST added. */
interface Entry {
	id: number;
	text: string;
	note?: boolean;
}

/**
 * The most the tab holds; older rows fall off the top. The engine still has
 * everything — `docker logs` on the container the title names — so this is a
 * bound on the view, not on the log.
 */
const MAX_LOG_LINES = 5000;

/** How near the bottom still counts as "at the bottom", in pixels. */
const STICK_SLACK = 24;

export function ContainerLogApp() {
	const [context, setContext] = useState<Context | undefined>(undefined);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [ended, setEnded] = useState<string | undefined>(undefined);

	const bodyRef = useRef<HTMLDivElement | null>(null);
	/** Whether the view was at the bottom before the last batch landed. */
	const stickRef = useRef(true);
	const nextId = useRef(0);

	useEffect(() => {
		const append = (texts: string[], note = false) =>
			setEntries((current) =>
				[
					...current,
					...texts.map((text) => ({ id: nextId.current++, text, ...(note ? { note } : {}) }))
				].slice(-MAX_LOG_LINES)
			);

		const unsubscribe = onMessage((message) => {
			switch (message.type) {
				case 'containerLog':
					setContext({
						environment: message.environment,
						container: message.container,
						service: message.service,
						state: message.state,
						status: message.status
					});
					// So a reloaded window comes back to this container. Unlike the
					// generate and scan tabs it comes back *following* — see the
					// panel's `revive`.
					setState({
						...getState(),
						environmentId: message.environmentId,
						containerName: message.containerName
					});
					// The message doubles as "a follow is starting": a tab that had
					// ended is live again, and what it already holds stays, with a
					// rule off where the old stream stopped.
					setEnded(undefined);
					setEntries((current) =>
						current.length === 0
							? current
							: [...current, { id: nextId.current++, text: '— Following again…', note: true }]
					);
					break;

				case 'containerLogLines':
					append(message.lines);
					break;

				case 'containerLogEnded':
					setEnded(message.reason);
					// The reason may be the backend's own sentence, which already
					// ends in a full stop — "…: No such container: web-1.." is the
					// kind of seam that reads as a bug.
					append(
						[`— The log stream ended: ${message.reason.replace(/\.$/, '')}.`],
						true
					);
					break;
			}
		});

		postMessage({ type: 'containerLogReady' });
		return unsubscribe;
	}, []);

	// Layout, not effect: the scroll has to be corrected in the same frame the
	// rows were added, or a long batch shows a visible jump.
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (body && stickRef.current) {
			body.scrollTop = body.scrollHeight;
		}
	}, [entries]);

	if (!context) {
		return <div className="log empty">Loading…</div>;
	}

	return (
		<div className="log">
			<header className="log-head">
				<h1 className="log-title">
					<span className="log-service">{context.service}</span>
					<span className="log-name">{context.container}</span>
					<span className="log-env">{context.environment}</span>
				</h1>
				<div className="log-meta">
					<span className={`log-state log-state-${context.state}`}>{context.state}</span>
					{context.status && <span className="log-status">{context.status}</span>}
					<span className={ended ? 'log-follow ended' : 'log-follow'}>
						{ended ? 'Not following' : 'Following'}
					</span>
				</div>
			</header>

			<div
				className="log-body"
				ref={bodyRef}
				onScroll={() => {
					const body = bodyRef.current;
					if (body) {
						stickRef.current =
							body.scrollHeight - body.scrollTop - body.clientHeight <= STICK_SLACK;
					}
				}}
			>
				{entries.length === 0 ? (
					<p className="log-idle">
						Waiting for output — the container has not printed anything yet.
					</p>
				) : (
					entries.map((entry) => (
						<div className={entry.note ? 'log-line log-note' : 'log-line'} key={entry.id}>
							{entry.text}
						</div>
					))
				)}
			</div>
		</div>
	);
}
