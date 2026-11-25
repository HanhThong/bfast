import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDefinition } from '../ai/agent';
import type { TestRunRecord, TicketDetail } from '../data/types';
import type { LinkRelation } from '../data/ticketLinks';
import type { TestLane, TestLogLine, TestReport, TestServiceOption } from '../testing/testReport';
import type { TraceReport } from '../shared/playwrightTrace';
import { toggleAiPanel } from '../shared/aiPanel';
import { markReviewStale, needsReview, openReview, type AiReview } from '../shared/aiReview';
import { applyTextEdit, imageMarkdown, insertText } from '../shared/markdownFormat';
import { TicketDetailPane } from './components/ticketDetail';
import type { ImageSource } from './imageInsert';
import { channel, designTab, designTabId, getState, setState, type DetailTab } from './vscodeApi';
import type { BoardToHost, HostToBoard } from '../shared/protocol';
import type {
	DesignDocument,
	DesignStyle,
	DesignSummary
} from '../design/designDocument';
import type { AiEditedTicket } from '../shared/protocol';
import { CONVERTED_MEDIA_SUFFIX, MAX_TEST_LOG_LINES } from './components/testRuns';

const { onMessage, postMessage } = channel<BoardToHost, HostToBoard>();

/** `saving` disables the editor while the host writes; an error returns to `edit`. */
export type BoardMode = 'view' | 'edit' | 'saving';

/**
 * What the AI panel is doing.
 *
 * `activity` is the scrolling log — reasoning and tool calls as they happen —
 * and `thinkingTokens` the counter beside it. Between them they answer the only
 * question a run this long raises: is it working, or has it hung?
 */
export type AiState =
	| { status: 'idle' }
	| {
			status: 'running';
			requestId: string;
			note: string;
			activity: string[];
			thinkingTokens?: number;
	  };

/** Enough to scroll through, few enough that the log never grows unbounded. */
const MAX_ACTIVITY = 200;

/**
 * Everything the Tests tab shows: the report the host built, and the batch
 * it is following — its lanes and its log, kept whole-line from the runner's
 * chunks. `runs` and `output` are the tiers fetched on demand, keyed by test
 * case and by `<testCase>/<run>`; both are dropped when a new report lands.
 * The two selections live here rather than in the pane, which unmounts on a
 * tab switch. They are not persisted across a reload: a run folder may not
 * survive a `git pull`, and the default is what a reload wants anyway.
 */
export interface TestsState {
	report?: TestReport;
	evidenceBases: Record<string, string>;
	configured: boolean;
	evidenceConfigured: boolean;
	canOpenEvidence: boolean;
	concurrency: number;
	/** `tests.services`, for a test case board's service picker. */
	services: TestServiceOption[];
	/** The root of the batch being followed, while one runs. */
	running?: string;
	/** Run was pressed and the host has not answered yet — Stop is up already. */
	starting: boolean;
	loading: boolean;
	lanes: Record<string, TestLane>;
	log: TestLogLine[];
	/** The unfinished last line of each test case's output. */
	partial: Record<string, string>;
	done?: string;
	error?: string;
	runs: Record<string, { runs: TestRunRecord[]; total: number }>;
	output: Record<string, { text: string; truncated: boolean }>;
	/** Bytes fetched for the fallback player, by `<testCase>/<run>/<file>`. */
	media: Record<string, { data: string; mime: string } | { error: string }>;
	/**
	 * Traces read for the inline viewer, by `<testCase>/<run>/<file>`; kept
	 * across reports, since a run's files never change. `notATrace` is the zip
	 * that turned out to be something else, and the row falls back.
	 */
	traces: Record<string, { status: 'loading' } | { trace: TraceReport } | { error: string; notATrace?: boolean }>;
	/** Screencast frames fetched for it, by `<testCase>/<run>/<file>#<frame>`; the other traces' are dropped as a new one opens. */
	traceFrames: Record<string, { data: string; mime: string } | { error: string }>;
	/** What "Open in Playwright Trace Viewer" will do. */
	traceViewer: 'command' | 'playwright' | 'none';
	/**
	 * The hierarchy row picked on a parent's board. `undefined` is the default
	 * (`defaultTestCase`), so a stale id costs nothing: the pane resolves it
	 * at render time and falls back.
	 */
	selectedTestCase?: string;
	/**
	 * The history row picked on a test case's board. `undefined` follows the
	 * latest run — what a run landing mid-batch should do — and only a click
	 * on an earlier run pins one.
	 */
	selectedRun?: string;
}

const EMPTY_TESTS: TestsState = {
	evidenceBases: {},
	configured: false,
	evidenceConfigured: false,
	canOpenEvidence: false,
	concurrency: 1,
	services: [],
	starting: false,
	loading: false,
	lanes: {},
	log: [],
	partial: {},
	runs: {},
	output: {},
	media: {},
	traces: {},
	traceFrames: {},
	traceViewer: 'none'
};

/**
 * The design tabs' slice.
 *
 * `documents` and `styles` arrive on `ticketDetail`, so the tab bar is right on
 * the board's first paint. Everything else is the open tab's editing state, and
 * mirrors the description's: one draft, one mode, one conflict flag — the design
 * tabs share the description's editor, so they share its shape.
 */
export interface DesignState {
	documents: DesignSummary[];
	styles: DesignStyle[];
	/** The document currently open, once its body has arrived. */
	open?: DesignDocument;
	mode: BoardMode;
	draft: string;
	error?: string;
	/** The document moved on disk while it was being edited. */
	staleOnDisk: boolean;
	/** Provenance for the next save, when the draft came from a run. */
	aiNote?: string;
	/**
	 * An answer waiting to be approved, when the run was over a document that
	 * already had something in it. The description's own is `aiReview` below;
	 * they are the same state for the same reason and never both apply, since
	 * one board has one run at a time.
	 *
	 * It carries the document it belongs to rather than leaning on `open`, so
	 * reading another tab and coming back does not throw an unapproved answer
	 * away — the board keeps one, the way it keeps one run.
	 */
	review?: AiReview & { design: string };
}

/** Said rather than swallowed: the file really is on disk by this point. */
const IMAGE_LOST =
	'The image was copied into the ticket’s assets folder, but the editor had moved on, ' +
	'so the markdown was not inserted.';

const AI_LOST =
	'The AI assistant finished, but the board had moved on, so the text was not inserted.';

const AI_LOST_EDITING =
	'The AI assistant finished, but you had started editing, so the text was not inserted — ' +
	'nothing you typed was touched.';

const EMPTY_DESIGNS: DesignState = {
	documents: [],
	styles: [],
	mode: 'view',
	draft: '',
	staleOnDisk: false
};

/** Where an image should land, and what the draft looked like when it was asked for. */
interface PendingImage {
	ticketId: string;
	/** The design document that asked, or absent for the description. */
	design?: string;
	start: number;
	end: number;
	draft: string;
}

/**
 * Puts an image's markdown where the caret was — or appends it when the draft
 * moved on while the host was writing the file, which can never corrupt what was
 * typed in the meantime.
 */
function spliceImage(draft: string, request: PendingImage, markdown: string): string {
	if (request.draft === draft) {
		return applyTextEdit(draft, insertText(draft, request.start, request.end, markdown));
	}
	return `${draft}${draft === '' || draft.endsWith('\n') ? '' : '\n\n'}${markdown}\n`;
}

export function App() {
	const restored = useRef(getState()).current;

	const [ticket, setTicket] = useState<TicketDetail | undefined>(undefined);
	/** Which in-tab tab is up; persisted, so a reload lands back on it. */
	const [tab, setTab] = useState<DetailTab>(restored.tab ?? 'description');
	const [tests, setTests] = useState<TestsState>(EMPTY_TESTS);
	const [designs, setDesigns] = useState<DesignState>(EMPTY_DESIGNS);
	/**
	 * Bumped whenever the report should be read again: the ticket changed, a
	 * batch finished, or the ticket reloaded while no batch was live (a pulled
	 * status change). The effect below asks only while the Tests tab is up.
	 */
	const [reportVersion, setReportVersion] = useState(0);
	const [assetBase, setAssetBase] = useState<string | undefined>(undefined);
	const [mode, setMode] = useState<BoardMode>('view');
	const [draft, setDraft] = useState('');
	const [error, setError] = useState<string | undefined>(undefined);
	/** The tracker changed under an edit in progress; the draft is kept regardless. */
	const [staleOnDisk, setStaleOnDisk] = useState(false);
	/** How many images the host is still copying, so the editor can say so. */
	const [copying, setCopying] = useState(0);

	/** Whether the AI panel is open, and what the assistant is doing. */
	const [aiOpen, setAiOpen] = useState(false);
	const [aiState, setAiState] = useState<AiState>({ status: 'idle' });
	const [aiInstruction, setAiInstruction] = useState('');
	const [aiAvailable, setAiAvailable] = useState(false);
	const [aiUnavailable, setAiUnavailable] = useState<string | undefined>(undefined);
	const [aiLabel, setAiLabel] = useState<string | undefined>(undefined);
	/** Every agent on disk; the pane offers the ones that write this ticket type. */
	const [aiAgents, setAiAgents] = useState<AgentDefinition[]>([]);
	const [aiAgent, setAiAgent] = useState<string | undefined>(undefined);
	/**
	 * This tab's model pick, restored with the tab: one person's choice for one
	 * ticket, where the setting is the team's default. `undefined` is the
	 * setting, which `aiDefaultModel` names so the picker's "Default" is never
	 * blind. Read through a ref by the two whole-object `setState` writes below,
	 * which would otherwise drop it.
	 */
	const [aiModel, setAiModel] = useState<string | undefined>(restored.aiModel);
	const [aiDefaultModel, setAiDefaultModel] = useState<string | undefined>(undefined);
	/**
	 * The conversation the design document on screen could continue, when the
	 * host says there is one — its document id, so a switch to another tab does
	 * not offer that one's session, and its timestamp, which is all the webview
	 * ever learns about it.
	 */
	const [aiPrevious, setAiPrevious] = useState<{ design: string; at: string } | undefined>(
		undefined
	);
	/**
	 * Whether the next run continues it. Ticked whenever one is offered, the way
	 * the generate tab offers its own: the conversation is the cheaper and better
	 * answer, and unticking is the deliberate gesture.
	 */
	const [aiContinueSession, setAiContinueSession] = useState(true);
	/**
	 * The provenance line for the run whose text is in the draft, so saving it
	 * records which provider and model wrote it. Cleared whenever the draft stops
	 * being that text.
	 */
	const [aiNote, setAiNote] = useState<string | undefined>(undefined);
	/**
	 * The answer waiting to be approved, when the run was over a description that
	 * already said something. It is held here rather than in `draft` on purpose:
	 * that is what keeps the text on disk the base of the diff *and* the text the
	 * next run is handed, so a Rewrite is compared with the original rather than
	 * with the answer before it. `aiReview.ts` is where the rule lives.
	 */
	const [aiReview, setAiReview] = useState<AiReview | undefined>(undefined);
	/** Other tickets the last run edited on disk; shown until the draft is saved or the board moves on. */
	const [aiEdited, setAiEdited] = useState<AiEditedTicket[]>([]);

	// The message handler is subscribed once, so it cannot close over `mode`,
	// `draft` or `ticket` without reading a stale value; a ref always has the
	// current one.
	const modeRef = useRef(mode);
	modeRef.current = mode;
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const ticketRef = useRef(ticket);
	ticketRef.current = ticket;
	const tabRef = useRef(tab);
	tabRef.current = tab;
	const aiModelRef = useRef(aiModel);
	aiModelRef.current = aiModel;
	const aiReviewRef = useRef(aiReview);
	aiReviewRef.current = aiReview;
	const testsRef = useRef(tests);
	testsRef.current = tests;
	// Same reason as the three above: the message handler subscribes once, so
	// anything it reads has to be a ref rather than a closed-over value.
	const designsRef = useRef(designs);
	designsRef.current = designs;

	// The live AI run. Every AI reply compares against this and drops one that
	// belongs to a run the board has already moved past — and like the three
	// above it has to be a ref, since the handler subscribes once.
	const aiRunRef = useRef<
		{ requestId: string; ticketId: string; design?: string } | undefined
	>(undefined);

	const pending = useRef(new Map<string, PendingImage>()).current;
	const lastRequestId = useRef(0);

	/**
	 * Takes the design list that rode in on a `ticketDetail`.
	 *
	 * This is also where the restored tab is checked. A window reload comes back
	 * on the tab it left, and `design:ERD-1` may name a document that has since
	 * been deleted — or one belonging to the ticket the board *used* to show. An
	 * absent list means this ticket type carries no designs at all, which is the
	 * same answer.
	 */
	const adoptDesigns = useCallback(
		(documents: DesignSummary[] | undefined, styles: DesignStyle[] | undefined, ticketId: string) => {
			const changed = ticketRef.current?.id !== ticketId;
			setDesigns((state) => ({
				...(changed ? EMPTY_DESIGNS : state),
				documents: documents ?? [],
				styles: styles ?? [],
				// A review belongs to a document, so it dies with one: a deleted
				// document's answer has nothing left to be approved over, and the id
				// could otherwise be handed to a document created later.
				...(changed || (documents ?? []).some((design) => design.id === state.review?.design)
					? {}
					: { review: undefined })
			}));

			const open = designTabId(tabRef.current);
			if (open !== undefined && !(documents ?? []).some((design) => design.id === open)) {
				changeTab('description');
			}
		},
		[]
	);

	useEffect(() => {
		const unsubscribe = onMessage((message) => {
			switch (message.type) {
				case 'ticketDetail': {
					const editing = modeRef.current !== 'view';
					setAssetBase(message.assetBase);

					if (ticketRef.current?.id !== message.ticket.id) {
						// A different ticket: nothing of the old one's runs applies.
						setTests(EMPTY_TESTS);
						setReportVersion((version) => version + 1);
					} else if (testsRef.current.running === undefined && !testsRef.current.starting) {
						// The same ticket reloaded with no batch live — a `git pull`, a status
						// written by hand. A parent's own `updatedAt` never moves when a child's
						// run lands, so the reload is the only signal; the host coalesces builds.
						setReportVersion((version) => version + 1);
					}

					setTicket((current) => {
						if (current?.id === message.ticket.id) {
							// A reload of the ticket being edited must not throw away
							// what the user has typed: keep the draft, flag the drift.
							//
							// Only flag it when the ticket itself actually moved: writing
							// an image into `assets/` deliberately leaves `updatedAt`
							// alone, and its watcher event can land after the write, so
							// warning here would fire after every image the user inserts.
							const moved = message.ticket.updatedAt !== current.updatedAt;
							setStaleOnDisk(editing && moved);
							// A review open over text that has since changed still shows the
							// text the answer was written against — moving the base would
							// claim the agent read something it never saw. It is said
							// instead, and carried into the editor on Approve.
							if (moved) {
								setAiReview(markReviewStale);
							}
							return editing ? current : message.ticket;
						}

						// A different ticket replaces the pane outright.
						setMode('view');
						setDraft('');
						setError(undefined);
						setStaleOnDisk(false);
						setAiOpen(false);
						setAiInstruction('');
						setAiNote(undefined);
						// Another ticket's answer has nothing to be approved against.
						setAiReview(undefined);
						setAiEdited([]);
						// Another ticket's documents are other conversations; the open
						// design tab's `designOpen` brings back whichever this one has.
						setAiPrevious(undefined);
						return message.ticket;
					});

					adoptDesigns(message.designs, message.designStyles, message.ticket.id);

					// A whole-object replace: the tab and the model pick have to be
					// written every time too.
					setState({ selectedId: message.ticket.id, tab: tabRef.current, aiModel: aiModelRef.current });
					break;
				}

				case 'ticketSaved': {
					setTicket(message.ticket);
					setAssetBase(message.assetBase);
					adoptDesigns(message.designs, message.designStyles, message.ticket.id);
					setMode('view');
					setDraft('');
					setError(undefined);
					setStaleOnDisk(false);
					setAiNote(undefined);
					// The save that just landed is the end of whatever was reviewed.
					setAiReview(undefined);
					setAiEdited([]);
					break;
				}

				case 'ticketError': {
					setError(message.message);
					// Back to the editor with the text intact, so nothing is lost.
					setMode((current) => (current === 'saving' ? 'edit' : current));
					break;
				}

				case 'designDocument': {
					if (message.id !== ticketRef.current?.id) {
						break;
					}
					setDesigns((state) => {
						// A reload of the document being edited keeps the draft and flags
						// the drift, exactly as the description does.
						const editing = state.mode !== 'view' && state.open?.id === message.document.id;
						// A review open on this document, over a body that has since
						// moved: said rather than re-based, the description's rule. A
						// review of *another* document is left alone — it carries the id
						// it belongs to, so switching tabs does not throw an answer away.
						const moved =
							state.review?.design === message.document.id &&
							state.open?.id === message.document.id &&
							message.document.updatedAt !== state.open?.updatedAt;
						return {
							...state,
							open: message.document,
							mode: editing ? state.mode : 'view',
							draft: editing ? state.draft : message.document.body,
							error: undefined,
							...(moved ? { review: markDesignReviewStale(state.review) } : {}),
							staleOnDisk:
								editing && message.document.updatedAt !== state.open?.updatedAt
						};
					});
					break;
				}

				case 'designSaved': {
					if (message.id !== ticketRef.current?.id) {
						break;
					}
					setDesigns((state) => ({
						...state,
						documents: message.designs,
						...(message.document
							? {
									open: message.document,
									mode: 'view' as BoardMode,
									draft: message.document.body,
									staleOnDisk: false,
									aiNote: undefined
								}
							: {}),
						error: undefined
					}));
					// A create lands on its own tab with the assistant already open: the
					// document is empty by design, and what it should show is the first
					// thing to say. Anything else stays where it was.
					if (message.document && !designsRef.current.documents.some(
						(design) => design.id === message.document!.id
					)) {
						changeTab(designTab(message.document.id));
						setAiInstruction('');
						setAiOpen(true);
					}
					break;
				}

				case 'aiSession': {
					if (message.id !== ticketRef.current?.id) {
						break;
					}
					setAiPrevious(
						message.previous ? { design: message.design, at: message.previous.at } : undefined
					);
					// A newly offered conversation arrives ticked; the box is not a
					// preference to remember across documents.
					setAiContinueSession(true);
					break;
				}

				case 'designError': {
					if (message.id !== ticketRef.current?.id) {
						break;
					}
					setDesigns((state) => ({
						...state,
						error: message.message,
						// Back to the editor with the text intact, so nothing is lost.
						mode: state.mode === 'saving' ? 'edit' : state.mode
					}));
					break;
				}

				case 'imageInserted': {
					const request = take(pending, message.requestId, setCopying);
					if (!request) {
						// A reply to a request from before the pane was replaced.
						break;
					}

					const markdown = imageMarkdown(message.alt, message.path);

					if (request.design !== undefined) {
						// The design editor asked. Same two cases as below, against that
						// tab's draft — the images themselves land in the ticket's
						// `assets/` either way, so nothing else differs.
						setDesigns((state) => {
							if (state.mode === 'view' || state.open?.id !== request.design) {
								return { ...state, error: IMAGE_LOST };
							}
							return { ...state, draft: spliceImage(state.draft, request, markdown) };
						});
						break;
					}

					if (modeRef.current === 'view' || request.ticketId !== ticketRef.current?.id) {
						// The file really is on disk, so say what happened rather than
						// dropping it silently.
						setError(IMAGE_LOST);
						break;
					}

					setDraft(spliceImage(draftRef.current, request, markdown));
					break;
				}

				case 'imageFailed': {
					take(pending, message.requestId, setCopying);
					// Absent for a cancelled file dialog: there is nothing to report.
					if (message.message) {
						setError(message.message);
					}
					break;
				}

				case 'aiAvailability': {
					setAiAvailable(message.available);
					setAiUnavailable(message.message);
					setAiLabel(message.label);
					setAiAgents(message.agents ?? []);
					setAiDefaultModel(message.model);
					break;
				}

				case 'aiStarted': {
					if (aiRunRef.current?.requestId !== message.requestId) {
						break;
					}
					setAiState((current) => ({
						status: 'running',
						requestId: message.requestId,
						note: `${message.label} is working…`,
						activity: current.status === 'running' ? current.activity : []
					}));
					break;
				}

				case 'aiProgress': {
					if (aiRunRef.current?.requestId !== message.requestId) {
						break;
					}
					setAiState((current) => {
						if (current.status !== 'running') {
							return current;
						}

						// A bare token count is the heartbeat, not an event: it arrives
						// several times a second, so it updates the counter and never
						// touches the log.
						if (message.thinkingTokens !== undefined && !message.thinking) {
							return { ...current, note: 'Thinking…', thinkingTokens: message.thinkingTokens };
						}

						const entry = message.thinking
							? `🧠 ${message.thinking}`
							: message.tool
								? `🔍 ${message.tool}`
								: message.text
									? `✍️ ${message.text}`
									: undefined;

						return entry
							? {
									...current,
									// A "Started — <model>" line rides on `tool`, since it is one
								// event rather than text or thought; it is not a read.
								note: message.tool
									? message.tool.startsWith('Started')
										? 'Started…'
										: 'Reading the repository…'
									: 'Thinking…',
									// Capped, and appended rather than replaced, so the log is the
									// history of the run rather than only its latest line.
									activity: [...current.activity, entry].slice(-MAX_ACTIVITY)
								}
							: current;
					});
					break;
				}

				case 'aiResult': {
					const run = aiRunRef.current;
					if (run?.requestId !== message.requestId) {
						break;
					}
					aiRunRef.current = undefined;
					setAiState({ status: 'idle' });

					if (run.design !== undefined) {
						const designId = run.design;
						setAiEdited(message.edited ?? []);
						// A design run. Into that tab's draft, under the same rule: the
						// user reads it, edits it, and their Save does the check.
						setDesigns((state) => {
							const open = state.open;
							if (run.ticketId !== ticketRef.current?.id || open?.id !== designId) {
								return { ...state, error: AI_LOST };
							}
							if (state.mode !== 'view') {
								return { ...state, error: AI_LOST_EDITING };
							}
							// A document that already says something is reviewed before it
							// is replaced — and the answer stays out of the draft, which is
							// what keeps the body on disk both the diff's base and what the
							// next run is handed. docs/ai/review.md.
							if (needsReview(open.body)) {
								return {
									...state,
									review: {
										...openReview(
											state.review?.design === designId ? state.review : undefined,
											open.body,
											message.text,
											message.note
										),
										design: designId
									},
									error: undefined
								};
							}
							return {
								...state,
								mode: 'edit',
								draft: message.text,
								aiNote: message.note,
								error: undefined,
								staleOnDisk: false
							};
						});
						setAiOpen(false);
						break;
					}

					// The same two guards the late-image branch above uses, and for the
					// same reason: the reply outlived the state that asked for it.
					if (run.ticketId !== ticketRef.current?.id) {
						setError(
							'The AI assistant finished, but the board had moved on to another ' +
								'ticket, so the text was not inserted.'
						);
						break;
					}
					if (modeRef.current !== 'view') {
						setError(
							'The AI assistant finished, but you had started editing, so the ' +
								'text was not inserted — nothing you typed was touched.'
						);
						break;
					}

					setAiEdited(message.edited ?? []);
					setError(undefined);
					setAiOpen(false);

					// A description that already says something is reviewed before it is
					// replaced: the answer waits beside the text on disk rather than in
					// the draft, which is what keeps that text both the diff's base and
					// the text the next run is handed — so a Rewrite is compared with
					// the original and not with the answer before it. docs/ai/review.md.
					if (needsReview(ticketRef.current.description)) {
						setAiReview(
							openReview(
								aiReviewRef.current,
								ticketRef.current.description,
								message.text,
								message.note
							)
						);
						break;
					}

					// Nothing to compare, so it goes where every answer went before the
					// review existed: into the draft, not onto disk — the user reads it,
					// edits it, and their Save does the `updatedAt` check with a value
					// read now rather than one held across a run that took minutes.
					setDraft(message.text);
					setAiNote(message.note);
					setStaleOnDisk(false);
					setMode('edit');
					break;
				}

				case 'aiFailed': {
					if (aiRunRef.current?.requestId !== message.requestId) {
						break;
					}
					// A stopped or failed run's edits are on disk all the same.
					setAiEdited(message.edited ?? []);
					aiRunRef.current = undefined;
					setAiState({ status: 'idle' });
					// Absent when the user cancelled: they know, so say nothing.
					if (message.message) {
						setError(message.message);
					}
					break;
				}

				case 'testsReport': {
					// Built for a ticket this board has since left: nowhere to go.
					if (message.id !== ticketRef.current?.id) {
						break;
					}
					setTests((current) => ({
						...current,
						report: message.report,
						evidenceBases: message.evidenceBases,
						configured: message.configured,
						evidenceConfigured: message.evidenceConfigured,
						canOpenEvidence: message.canOpenEvidence,
						traceViewer: message.traceViewer,
						concurrency: message.concurrency,
						services: message.services,
						running: message.running,
						starting: false,
						loading: false,
						error: undefined,
						// A live batch's snapshot is authoritative; otherwise the last
						// batch's lanes and log stay on screen to be read.
						lanes: message.batch ? message.batch.lanes : current.lanes,
						log: message.batch ? message.batch.log : current.log,
						// The earlier-runs tier may have grown; a run's output never changes,
						// and a card that already asked for it would not ask again.
						runs: {}
					}));
					break;
				}

				case 'testsRuns':
					if (message.id === ticketRef.current?.id) {
						setTests((current) => ({
							...current,
							runs: { ...current.runs, [message.testCase]: { runs: message.runs, total: message.total } }
						}));
					}
					break;

				case 'testsOutput':
					if (message.id === ticketRef.current?.id) {
						setTests((current) => ({
							...current,
							output: {
								...current.output,
								[`${message.testCase}/${message.run}`]: {
									text: message.text,
									truncated: message.truncated
								}
							}
						}));
					}
					break;

				case 'testsProgress': {
					const event = message.event;
					setTests((current) => {
						if (event.kind === 'scope') {
							if (current.running !== undefined && current.running !== message.id) {
								// Two disjoint batches can both reach an epic's board; it follows
								// the first until that one is done.
								return current;
							}
							const lanes: Record<string, TestLane> = {};
							for (const testCase of event.testCases) {
								lanes[testCase.id] = { status: 'waiting' };
							}
							return {
								...current,
								running: message.id,
								starting: false,
								error: undefined,
								done: undefined,
								lanes,
								log: [],
								partial: {}
							};
						}
						if (current.running !== message.id) {
							if (
								event.kind === 'done' &&
								current.running === undefined &&
								current.starting &&
								message.id === ticketRef.current?.id
							) {
								// The board's own batch ended before it had a scope — a missing
								// working directory, say. Stop has to come down.
								return {
									...current,
									starting: false,
									done: event.message,
									...(event.summary === undefined || event.summary.abortedWith
										? { error: event.message }
										: {})
								};
							}
							// Another batch this board follows while one is live: a straggler.
							return current;
						}
						switch (event.kind) {
							case 'started':
								return {
									...current,
									lanes: {
										...current.lanes,
										[event.ticket.id]: {
											status: 'running',
											line: event.line,
											startedAt: event.startedAt
										}
									}
								};
							case 'output': {
								// Chunks are not lines; whole lines are what the pane shows.
								const key = event.testCase ?? '';
								const pieces = ((current.partial[key] ?? '') + event.text).split('\n');
								const rest = pieces.pop() ?? '';
								const lines = pieces
									.filter((line) => line.trim().length > 0)
									.map((line) => ({ ...(event.testCase ? { testCase: event.testCase } : {}), text: line }));
								return {
									...current,
									log: [...current.log, ...lines].slice(-MAX_TEST_LOG_LINES),
									partial: { ...current.partial, [key]: rest }
								};
							}
							case 'result': {
								const id = event.result.ticket.id;
								const rest = current.partial[id];
								const flushed =
									rest && rest.trim().length > 0 ? [{ testCase: id, text: rest }] : [];
								const { [id]: _dropped, ...partial } = current.partial;
								const run = event.result.run;
								const { [id]: _stale, ...runs } = current.runs;
								return {
									...current,
									lanes: {
										...current.lanes,
										[id]: {
											...current.lanes[id],
											status: event.result.outcome,
											...(event.result.message ? { note: event.result.message } : {})
										}
									},
									log: [...current.log, ...flushed].slice(-MAX_TEST_LOG_LINES),
									partial,
									// The new run is the latest at once — the video is watchable
									// before the batch ends; the earlier-runs tier is re-read.
									...(run && current.report
										? {
												report: {
													...current.report,
													testCases: current.report.testCases.map((testCase) =>
														testCase.id === id
															? { ...testCase, latest: run, runCount: testCase.runCount + 1 }
															: testCase
													)
												},
												runs
											}
										: {})
								};
							}
							case 'done': {
								const flushed = Object.entries(current.partial)
									.filter(([, rest]) => rest.trim().length > 0)
									.map(([key, rest]) => ({ ...(key ? { testCase: key } : {}), text: rest }));
								return {
									...current,
									running: undefined,
									starting: false,
									done: event.message,
									// An abort or a thrown runner is an error whichever side of
									// `scope` it landed on.
									...(event.summary === undefined || event.summary.abortedWith
										? { error: event.message }
										: {}),
									log: [...current.log, ...flushed].slice(-MAX_TEST_LOG_LINES),
									partial: {}
								};
							}
						}
						return current;
					});
					if (event.kind === 'done') {
						// Reconcile with disk: statuses landed, and the host's summary is
						// the one the channel and the notification show.
						setReportVersion((version) => version + 1);
					}
					break;
				}

				case 'testsMedia':
					if (message.id === ticketRef.current?.id) {
						setTests((current) => ({
							...current,
							media: {
								...current.media,
								[`${message.testCase}/${message.run}/${message.file}${message.converted ? CONVERTED_MEDIA_SUFFIX : ''}`]:
									message.data !== undefined
										? { data: message.data, mime: message.mime ?? 'video/webm' }
										: { error: message.error ?? 'The file could not be read.' }
							}
						}));
					}
					break;

				case 'testsTrace':
					if (message.id === ticketRef.current?.id) {
						const key = `${message.testCase}/${message.run}/${message.file}`;
						setTests((current) => {
							// One trace's frames at a time: a person browsing three traces
							// would otherwise hold every screenshot of all of them.
							const traceFrames: TestsState['traceFrames'] = {};
							for (const [frameKey, value] of Object.entries(current.traceFrames)) {
								if (frameKey.startsWith(`${key}#`)) {
									traceFrames[frameKey] = value;
								}
							}
							return {
								...current,
								traceFrames,
								traces: {
									...current.traces,
									[key]:
										message.trace !== undefined
											? { trace: message.trace }
											: {
													error: message.error ?? 'The trace could not be read.',
													...(message.notATrace ? { notATrace: true } : {})
												}
								}
							};
						});
					}
					break;

				case 'testsTraceFrame':
					if (message.id === ticketRef.current?.id) {
						setTests((current) => ({
							...current,
							traceFrames: {
								...current.traceFrames,
								[`${message.testCase}/${message.run}/${message.file}#${message.frame}`]:
									message.data !== undefined
										? { data: message.data, mime: message.mime ?? 'image/jpeg' }
										: { error: message.error ?? 'The frame could not be read.' }
							}
						}));
					}
					break;

				case 'testsError':
					if (message.id === ticketRef.current?.id) {
						setTests((current) => ({
							...current,
							starting: false,
							loading: false,
							error: message.message
						}));
					}
					break;
			}
		});

		// Tell the host we are up, and which ticket to restore after a reload.
		postMessage({ type: 'ready', selectedId: restored.selectedId });

		return unsubscribe;
	}, [pending, restored.selectedId]);

	// The Tests tab reads its report when it opens, when the ticket changes
	// under it, when a batch finishes and when the ticket reloads with no batch
	// live — every moment is a bump of `reportVersion`, and the ask only goes
	// out while the tab is up.
	useEffect(() => {
		if (tab === 'tests' && ticket) {
			setTests((current) => ({ ...current, loading: current.report === undefined }));
			postMessage({ type: 'testsReport', id: ticket.id });
		}
	}, [tab, ticket?.id, reportVersion]);

	const changeTab = useCallback((next: DetailTab) => {
		setTab(next);
		setState({ selectedId: ticketRef.current?.id, tab: next, aiModel: aiModelRef.current });
	}, []);

	/** The pick is this tab's, so it is written where the tab is. */
	const changeAiModel = useCallback((next: string | undefined) => {
		aiModelRef.current = next;
		setAiModel(next);
		setState({ selectedId: ticketRef.current?.id, tab: tabRef.current, aiModel: next });
	}, []);

	/**
	 * Opens the assistant or closes it. The instruction box is emptied on open,
	 * not on close, and left alone while a run is going — the rule, and why,
	 * is `toggleAiPanel`'s, where a test can hold it.
	 */
	const toggleAi = useCallback(() => {
		const next = toggleAiPanel(
			{ open: aiOpen, instruction: aiInstruction },
			aiRunRef.current !== undefined
		);
		setAiOpen(next.open);
		setAiInstruction(next.instruction);
	}, [aiInstruction, aiOpen]);

	const runTests = useCallback(() => {
		const current = ticketRef.current;
		if (!current) {
			return;
		}
		// Stop is up before the host has spoken; the first event hands authority back.
		setTests((state) => ({ ...state, starting: true, error: undefined, done: undefined }));
		postMessage({ type: 'testsRun', id: current.id });
	}, []);

	const cancelTests = useCallback(() => {
		const current = ticketRef.current;
		if (current) {
			const root = testsRef.current.running;
			postMessage({ type: 'testsCancel', id: current.id, ...(root ? { root } : {}) });
		}
	}, []);

	const loadRuns = useCallback((testCase: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'testsRuns', id: current.id, testCase });
		}
	}, []);

	const loadOutput = useCallback((testCase: string, run: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'testsOutput', id: current.id, testCase, run });
		}
	}, []);

	const selectTestCase = useCallback((id: string) => {
		// A new test case starts on its latest run; a pinned older run was the other's.
		setTests((state) => ({ ...state, selectedTestCase: id, selectedRun: undefined }));
	}, []);

	const selectRun = useCallback((id: string | undefined) => {
		setTests((state) => ({ ...state, selectedRun: id }));
	}, []);

	const openEvidence = useCallback((testCase: string, run: string, file?: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'openEvidence', id: current.id, testCase, run, ...(file ? { file } : {}) });
		}
	}, []);

	const loadMedia = useCallback((testCase: string, run: string, file: string, convert?: boolean) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'testsMedia', id: current.id, testCase, run, file, ...(convert ? { convert: true } : {}) });
		}
	}, []);

	const loadTrace = useCallback((testCase: string, run: string, file: string) => {
		const current = ticketRef.current;
		if (current) {
			const key = `${testCase}/${run}/${file}`;
			setTests((state) => ({ ...state, traces: { ...state.traces, [key]: { status: 'loading' } } }));
			postMessage({ type: 'testsTrace', id: current.id, testCase, run, file });
		}
	}, []);

	const loadTraceFrame = useCallback((testCase: string, run: string, file: string, frame: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'testsTraceFrame', id: current.id, testCase, run, file, frame });
		}
	}, []);

	const openTraceViewer = useCallback((testCase: string, run: string, file: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'openTraceViewer', id: current.id, testCase, run, file });
		}
	}, []);

	const openTraceSource = useCallback((file: string, line: number, column?: number) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({
				type: 'openTraceSource',
				id: current.id,
				file,
				line,
				...(column !== undefined ? { column } : {})
			});
		}
	}, []);

	const openTicket = useCallback((id: string) => postMessage({ type: 'openTicket', id }), []);
	const openSettings = useCallback(() => postMessage({ type: 'openSettings' }), []);
	const setTestCaseService = useCallback((service: string | null) => {
		const id = ticketRef.current?.id;
		if (id !== undefined) {
			postMessage({ type: 'testsSetService', id, service });
		}
	}, []);
	const linkTicket = useCallback(() => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'linkTicket', id: current.id });
		}
	}, []);
	const unlinkTicket = useCallback((relation: LinkRelation, targetId: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'unlinkTicket', id: current.id, relation, targetId });
		}
	}, []);

	const startEdit = useCallback(() => {
		setDraft(ticket?.description ?? '');
		setError(undefined);
		// This draft is the ticket's own text, not a generated one.
		setAiNote(undefined);
		setMode('edit');
		// Work began: the host pins a preview tab, the webview knows no more.
		if (ticket) {
			postMessage({ type: 'editStarted', id: ticket.id });
		}
	}, [ticket]);

	const cancelEdit = useCallback(() => {
		setMode('view');
		setDraft('');
		setError(undefined);
		setAiNote(undefined);
	}, []);

	/**
	 * The three ways out of a review. Approve is the only one that moves the
	 * answer anywhere, and it moves it into the draft — not onto disk, which is
	 * still the user's own Save. Rewrite is shared with the design tabs: it only
	 * reopens the assistant, since the run that follows is an ordinary run and
	 * the host reads the original from disk the way it always does.
	 */
	const approveAiReview = useCallback(() => {
		const review = aiReviewRef.current;
		if (!review) {
			return;
		}
		setDraft(review.proposal);
		setAiNote(review.note);
		// The ticket moved while the review was open: the editor's own warning
		// carries that through, so Save does its check knowing the base has moved.
		setStaleOnDisk(review.stale);
		setError(undefined);
		setAiReview(undefined);
		setMode('edit');
	}, []);

	const discardAiReview = useCallback(() => {
		setAiReview(undefined);
		setError(undefined);
	}, []);

	const rewriteAiReview = useCallback(() => {
		// The answer stays on screen to say what was wrong with it, and the box is
		// emptied the way opening the panel empties it: what was typed belonged to
		// the run that produced what is being rejected.
		setAiInstruction('');
		setAiOpen(true);
	}, []);

	const approveDesignReview = useCallback(() => {
		setDesigns((state) => {
			const review = state.review;
			if (!review || review.design !== state.open?.id) {
				return state;
			}
			return {
				...state,
				mode: 'edit',
				draft: review.proposal,
				aiNote: review.note,
				staleOnDisk: review.stale,
				error: undefined,
				review: undefined
			};
		});
	}, []);

	const discardDesignReview = useCallback(() => {
		setDesigns((state) => ({ ...state, review: undefined, error: undefined }));
	}, []);

	const save = useCallback(() => {
		if (!ticket) {
			return;
		}
		setMode('saving');
		setError(undefined);
		postMessage({
			type: 'saveDescription',
			id: ticket.id,
			description: draft,
			baseUpdatedAt: ticket.updatedAt,
			aiNote
		});
	}, [aiNote, draft, ticket]);

	/**
	 * Starts a run. Nothing is written by it: the reply lands in the draft, and
	 * the Save that follows carries the `updatedAt` read at that moment.
	 */
	const generate = useCallback(() => {
		const current = ticketRef.current;
		if (!current || aiRunRef.current) {
			return;
		}

		// One button, one run at a time, whichever tab it is on — only which skill
		// the host resolves and which draft the answer lands in differ.
		const design = designTabId(tabRef.current);

		const requestId = `ai-${++lastRequestId.current}`;
		aiRunRef.current = { requestId, ticketId: current.id, ...(design ? { design } : {}) };
		setAiState({ status: 'running', requestId, note: 'Starting…', activity: [] });
		setError(undefined);
		setAiEdited([]);
		postMessage({
			type: 'aiGenerate',
			requestId,
			id: current.id,
			instruction: aiInstruction,
			agent: aiAgent,
			// A name the host sanitises; absent means the workspace setting.
			...(aiModel ? { model: aiModel } : {}),
			...(design ? { design } : {}),
			// Only ever for the document it was offered on, and only as a boolean:
			// the host resolves which conversation that is.
			...(design && aiPrevious?.design === design && aiContinueSession
				? { continueSession: true }
				: {})
		});
	}, [aiAgent, aiContinueSession, aiInstruction, aiModel, aiPrevious]);

	const cancelGenerate = useCallback(() => {
		const run = aiRunRef.current;
		if (run) {
			postMessage({ type: 'aiCancel', requestId: run.requestId });
		}
	}, []);

	/**
	 * Asks the host to copy an image in. The selection is remembered now, because
	 * the reply comes back after a file dialog or a disk write and the caret may
	 * have moved by then.
	 */
	const requestImage = useCallback(
		(source: ImageSource, start: number, end: number, design?: string) => {
			const current = ticketRef.current;
			if (!current) {
				return;
			}

			const requestId = `img-${++lastRequestId.current}`;
			// The images themselves land in the ticket's `assets/` either way; only
			// which draft the markdown is spliced into differs.
			pending.set(requestId, {
				ticketId: current.id,
				...(design ? { design } : {}),
				start,
				end,
				draft: design ? designsRef.current.draft : draftRef.current
			});
			setCopying(pending.size);
			setError(undefined);

			switch (source.kind) {
				case 'pick':
					postMessage({ type: 'pickImage', requestId, id: current.id });
					break;
				case 'bytes':
					postMessage({
						type: 'insertImage',
						requestId,
						id: current.id,
						fileName: source.fileName,
						data: source.data
					});
					break;
				case 'uri':
					postMessage({ type: 'insertImageFromUri', requestId, id: current.id, uri: source.uri });
					break;
			}
		},
		[pending]
	);

	// The open design tab reads its body when it opens and when the ticket
	// reloads under it — the Tests tab's shape. The list itself always rode in on
	// `ticketDetail`, so this only ever fetches the one document being shown.
	//
	// The document's own `updatedAt` is a dependency too: a design write never
	// bumps the ticket's (that would fail a description save mid-edit), so a
	// document rewritten from outside — over MCP, or by another window — would
	// otherwise leave the open tab on the old body until it was reopened.
	const openDesign = designTabId(tab);
	const openDesignStamp = designs.documents.find((design) => design.id === openDesign)?.updatedAt;
	useEffect(() => {
		if (openDesign !== undefined && ticket) {
			postMessage({ type: 'designOpen', id: ticket.id, design: openDesign });
		}
	}, [openDesign, openDesignStamp, ticket?.id, ticket?.updatedAt]);

	const createDesign = useCallback((style: string, title: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'designCreate', id: current.id, style, title });
		}
	}, []);

	const renameDesign = useCallback((design: string, title: string) => {
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'designRename', id: current.id, design, title });
		}
	}, []);

	const deleteDesign = useCallback((design: string) => {
		const current = ticketRef.current;
		if (current) {
			// The host confirms — a webview cannot open a modal.
			postMessage({ type: 'designDelete', id: current.id, design });
		}
	}, []);

	const editDesign = useCallback(() => {
		setDesigns((state) => ({
			...state,
			mode: 'edit',
			draft: state.open?.body ?? '',
			error: undefined,
			staleOnDisk: false
		}));
		const current = ticketRef.current;
		if (current) {
			postMessage({ type: 'editStarted', id: current.id });
		}
	}, []);

	const cancelDesign = useCallback(() => {
		setDesigns((state) => ({
			...state,
			mode: 'view',
			draft: state.open?.body ?? '',
			error: undefined,
			staleOnDisk: false,
			aiNote: undefined
		}));
	}, []);

	const changeDesignDraft = useCallback((draft: string) => {
		setDesigns((state) => ({ ...state, draft }));
	}, []);

	const designError = useCallback((message: string) => {
		setDesigns((state) => ({ ...state, error: message }));
	}, []);

	const saveDesign = useCallback(() => {
		const current = ticketRef.current;
		const state = designsRef.current;
		if (!current || !state.open) {
			return;
		}
		setDesigns((previous) => ({ ...previous, mode: 'saving', error: undefined }));
		postMessage({
			type: 'designSave',
			id: current.id,
			design: state.open.id,
			body: state.draft,
			// The document's own token, never the ticket's.
			...(state.open.updatedAt ? { baseUpdatedAt: state.open.updatedAt } : {}),
			...(state.aiNote ? { aiNote: state.aiNote } : {})
		});
	}, []);

	const requestDesignImage = useCallback(
		(source: ImageSource, start: number, end: number) => {
			const open = designsRef.current.open;
			if (open) {
				requestImage(source, start, end, open.id);
			}
		},
		[requestImage]
	);

	return (
		<div className="app">
			<TicketDetailPane
				ticket={ticket}
				assetBase={assetBase}
				tab={tab}
				onTabChange={changeTab}
				designs={designs}
				onDesignCreate={createDesign}
				onDesignRename={renameDesign}
				onDesignDelete={deleteDesign}
				onDesignEdit={editDesign}
				onDesignCancel={cancelDesign}
				onDesignSave={saveDesign}
				onDesignDraftChange={changeDesignDraft}
				onDesignImage={requestDesignImage}
				onDesignImageError={designError}
				tests={tests}
				onTestsRun={runTests}
				onTestsCancel={cancelTests}
				onTestsLoadRuns={loadRuns}
				onTestsLoadOutput={loadOutput}
				onTestsLoadMedia={loadMedia}
				onTestsLoadTrace={loadTrace}
				onTestsLoadTraceFrame={loadTraceFrame}
				onTestsOpenTraceViewer={openTraceViewer}
				onTestsOpenTraceSource={openTraceSource}
				onTestsSelectCase={selectTestCase}
				onTestsSelectRun={selectRun}
				onOpenEvidence={openEvidence}
				onOpenTicket={openTicket}
				onOpenSettings={openSettings}
				onSetTestCaseService={setTestCaseService}
				onLinkTicket={linkTicket}
				onUnlinkTicket={unlinkTicket}
				mode={mode}
				draft={draft}
				error={error}
				staleOnDisk={staleOnDisk}
				copying={copying}
				aiOpen={aiOpen}
				aiState={aiState}
				aiInstruction={aiInstruction}
				aiAvailable={aiAvailable}
				aiUnavailable={aiUnavailable}
				aiLabel={aiLabel}
				aiAgents={aiAgents}
				aiAgent={aiAgent}
				aiModel={aiModel}
				aiDefaultModel={aiDefaultModel}
				aiPrevious={aiPrevious}
				aiContinueSession={aiContinueSession}
				aiEdited={aiEdited}
				aiReview={aiReview}
				onAiReviewApprove={approveAiReview}
				onAiReviewRewrite={rewriteAiReview}
				onAiReviewDiscard={discardAiReview}
				onDesignReviewApprove={approveDesignReview}
				onDesignReviewRewrite={rewriteAiReview}
				onDesignReviewDiscard={discardDesignReview}
				onDraftChange={setDraft}
				onEdit={startEdit}
				onCancel={cancelEdit}
				onSave={save}
				onRequestImage={requestImage}
				onImageError={setError}
				onAiToggle={toggleAi}
				onAiInstructionChange={setAiInstruction}
				onAiAgentChange={setAiAgent}
				onAiModelChange={changeAiModel}
				onAiContinueSessionChange={setAiContinueSession}
				onAiGenerate={generate}
				onAiCancel={cancelGenerate}
			/>
		</div>
	);
}

/**
 * `markReviewStale` for a design review, which carries the document it belongs
 * to. One rule, one place it is written — the wrapper only puts the id back.
 */
function markDesignReviewStale(
	review: (AiReview & { design: string }) | undefined
): (AiReview & { design: string }) | undefined {
	if (!review) {
		return undefined;
	}
	const next = markReviewStale(review);
	return next === review ? review : { ...next!, design: review.design };
}

/** Removes a request and reports the new count, whether or not it was there. */
function take(
	pending: Map<string, PendingImage>,
	requestId: string,
	setCopying: (count: number) => void
): PendingImage | undefined {
	const request = pending.get(requestId);
	pending.delete(requestId);
	setCopying(pending.size);
	return request;
}
