// A container's log tab.
//
// One file per webview concern, joined in `index.ts`. See the note there.

// `environmentProvider.ts` is the environments seam and Node-free — the
// `ScanServerStatus` precedent below. `ContainerState` is the one type taken
// from it, and it is a string union: nothing runtime crosses.
import type { ContainerState } from '../../environments/environmentProvider';

/** What this part of the webview sends to the extension host. */
export type ContainerLogToHost =
	/**
	 * The container log tab. One message, and no key on it: the tab is opened
	 * on one container and never moves to another, so the host already knows
	 * whose `ready` this is.
	 */
	| { type: 'containerLogReady' };

/** What the extension host sends back. */
export type HostToContainerLog =
	/**
	 * The container log tab's context, **and** the signal that a follow is
	 * starting: the webview clears any "ended" state on it and puts a separator
	 * above the new lines when it already had some. Sent on `containerLogReady`
	 * and again whenever the tab is re-opened on a container that had gone.
	 */
	| {
			type: 'containerLog';
			/** `'ST-1.2'`, or `'Master'`. */
			environment: string;
			/** The container's own name without the project prefix: `'web-1'`. */
			container: string;
			service: string;
			state: ContainerState;
			/** The backend's own words, as the sidebar row shows them. */
			status: string;
			/**
			 * What the tab keeps in `setState` so a reloaded window can be revived
			 * onto the same container — never shown. The container's **name**,
			 * because a Start recreates it and only the name survives that.
			 */
			environmentId: string;
			containerName: string;
	  }
	/**
	 * A batch of whole lines, oldest first.
	 *
	 * A batch rather than a line, and that is the feature: a crash-looping
	 * container prints faster than the bridge can carry one message per line,
	 * and the cost is the message, not the text. The host coalesces on a timer.
	 */
	| { type: 'containerLogLines'; lines: string[] }
	/**
	 * No more lines are coming, and why — the container stopped or was removed,
	 * or the follow could not be started at all. One message for both, because
	 * they are one fact. What is already on screen stays.
	 */
	| { type: 'containerLogEnded'; reason: string };
