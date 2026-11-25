import type { TicketType } from '../data/types';
import type { ScanTargetRef } from '../scan/scanReport';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// May only be called once per webview document.
const api = acquireVsCodeApi();

/**
 * The board's in-tab tabs. Declared here because the persisted state names one.
 *
 * A design tab is `design:<document id>` rather than a member of its own,
 * because how many there are is a property of the ticket, not of the board.
 * Keeping it a plain string is what lets `setState` carry it unchanged — and
 * what makes the restore guard necessary: a document can be gone by the time the
 * window reloads, so `app.tsx` checks the id against the list that arrives with
 * `ticketDetail` and falls back to the description.
 */
export type DetailTab = 'description' | 'history' | 'tests' | `design:${string}`;

/** The document a design tab is showing, or `undefined` for the fixed tabs. */
export function designTabId(tab: DetailTab): string | undefined {
	return tab.startsWith('design:') ? tab.slice('design:'.length) : undefined;
}

/** The tab that shows one design document. */
export function designTab(id: string): DetailTab {
	return `design:${id}`;
}

/**
 * State kept across a window reload, restored by the panel serializer.
 *
 * `tab` comes back too: a lead clicking through test cases stays on Tests. A
 * live batch never does — a run was a child process the old session owned.
 */
export interface BoardState {
	selectedId?: string;
	tab?: DetailTab;
	/**
	 * The model this tab's AI runs go to, when the user picked one. Kept per
	 * tab and never written to `bfast.json`: the setting is the team's default,
	 * a pick is one person's choice for one ticket. Absent means the setting.
	 */
	aiModel?: string;
}

/**
 * The generate tab's half of that state: which ticket it was breaking down.
 *
 * A run itself is never restored — it was a child process this session owned —
 * so this only says which form to come back to.
 */
export interface GenerateState {
	parentId?: string;
	childType?: TicketType;
	/** The model the form picked, kept the way `BoardState.aiModel` is. */
	model?: string;
}

/**
 * The scan tab's half: which target it was scanning.
 *
 * A run is never restored either, for the same reason — and a log that never
 * advanced again would be a lie about a run that is not happening.
 */
export interface ScanState {
	scanTarget?: ScanTargetRef;
}

/**
 * The container log tab's half: which container it was following.
 *
 * Unlike the three above, this one **is** restored to a live view rather than
 * to a form — a run was a child process that spent money and cannot be
 * resumed, while a log is a view of live state and re-opening it is exactly
 * what the person who left the tab open wanted. The container's **name**, not
 * its id: a Start recreates every container and only the name survives it.
 */
export interface ContainerLogState {
	environmentId?: string;
	containerName?: string;
}

/**
 * Every document shares one store, since each webview has only its own.
 *
 * An intersection of the named halves rather than one grab-bag interface: each
 * tab then declares what it keeps, and adding another document does not widen
 * the others' contract.
 */
type PanelState = BoardState & GenerateState & ScanState & ContainerLogState;

/** One webview document's typed line to its panel: what it may send, and what it is sent. */
export interface Channel<ToHost, FromHost> {
	postMessage(message: ToHost): void;
	/** Subscribes to messages from the extension host; returns an unsubscribe. */
	onMessage(handler: (message: FromHost) => void): () => void;
}

/**
 * The channel for one document, typed by its own pair of unions from
 * `shared/protocol` — so the settings form cannot post a board's message, and
 * a document's handler is checked against exactly what its panel sends.
 *
 * Nothing is narrowed at runtime: there is one `postMessage` and one `message`
 * event per webview, and each document's panel is the only thing on the other
 * end of it.
 */
export function channel<ToHost, FromHost>(): Channel<ToHost, FromHost> {
	return {
		postMessage: (message) => api.postMessage(message),
		onMessage: (handler) => {
			const listener = (event: MessageEvent<FromHost>) => handler(event.data);
			window.addEventListener('message', listener);
			return () => window.removeEventListener('message', listener);
		}
	};
}

export function getState(): PanelState {
	return (api.getState() as PanelState | undefined) ?? {};
}

export function setState(state: PanelState): void {
	api.setState(state);
}
