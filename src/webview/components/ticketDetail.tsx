import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry, TicketDetail, TicketLinkView } from '../../data/types';
import { LINK_RELATION_INFO, LINK_RELATIONS, type LinkRelation } from '../../data/ticketLinks';
import type { AgentDefinition } from '../../ai/agent';
import type { AiState, BoardMode, DesignState, TestsState } from '../app';
import { designTab, designTabId, type DetailTab } from '../vscodeApi';
import { resolveStyle, type DesignStyle } from '../../design/designDocument';
import type { AiEditedTicket } from '../../shared/protocol';
import type { AiReview } from '../../shared/aiReview';
import type { ImageSource } from '../imageInsert';
import { AiPrompt } from './aiPrompt';
import { AiReviewPane } from './aiReviewPane';
import { DescriptionEditor } from './descriptionEditor';
import { DesignPane } from './designPane';
import { PlusIcon, SparkleIcon } from './icons';
import { STATUS_LABEL, TYPE_BADGE, TYPE_LABEL } from './labels';
import { Markdown } from './markdown';
import { TestsPane } from './testRuns';

interface TicketDetailPaneProps {
	ticket?: TicketDetail;
	/** The ticket's folder, so the images in its description resolve. */
	assetBase?: string;
	/** Which in-tab tab is up — the app's, so it can be persisted across a reload. */
	tab: DetailTab;
	onTabChange: (tab: DetailTab) => void;
	designs: DesignState;
	onDesignCreate: (style: string, title: string) => void;
	onDesignRename: (design: string, title: string) => void;
	onDesignDelete: (design: string) => void;
	onDesignEdit: () => void;
	onDesignCancel: () => void;
	onDesignSave: () => void;
	onDesignDraftChange: (draft: string) => void;
	onDesignImage: (source: ImageSource, start: number, end: number) => void;
	onDesignImageError: (message: string) => void;
	tests: TestsState;
	onTestsRun: () => void;
	onTestsCancel: () => void;
	onTestsLoadRuns: (testCase: string) => void;
	onTestsLoadOutput: (testCase: string, run: string) => void;
	onTestsLoadMedia: (testCase: string, run: string, file: string, convert?: boolean) => void;
	onTestsLoadTrace: (testCase: string, run: string, file: string) => void;
	onTestsLoadTraceFrame: (testCase: string, run: string, file: string, frame: string) => void;
	onTestsOpenTraceViewer: (testCase: string, run: string, file: string) => void;
	onTestsOpenTraceSource: (file: string, line: number, column?: number) => void;
	/** The hierarchy row picked on a parent's board. */
	onTestsSelectCase: (id: string) => void;
	/** The history row picked on a test case's board; `undefined` follows the latest. */
	onTestsSelectRun: (id: string | undefined) => void;
	onOpenEvidence: (testCase: string, run: string, file?: string) => void;
	onOpenTicket: (id: string) => void;
	onOpenSettings: () => void;
	onSetTestCaseService: (service: string | null) => void;
	/** "Link ticket": the host asks for the relation and the ticket. */
	onLinkTicket: () => void;
	onUnlinkTicket: (relation: LinkRelation, targetId: string) => void;
	mode: BoardMode;
	draft: string;
	error?: string;
	staleOnDisk: boolean;
	/** Images the host is still copying in. */
	copying: number;
	aiOpen: boolean;
	aiState: AiState;
	aiInstruction: string;
	aiAvailable: boolean;
	/** Why the assistant cannot run, for the disabled button's tooltip. */
	aiUnavailable?: string;
	aiLabel?: string;
	aiAgents: AgentDefinition[];
	/** Slug the picker is on; absent means "the first that fits this ticket". */
	aiAgent?: string;
	/** This tab's model pick, and the workspace default it falls back to. */
	aiModel?: string;
	aiDefaultModel?: string;
	/**
	 * The conversation the design document on screen could continue, when there
	 * is one: its document id and when it last spoke. Never its session id — the
	 * host is the one that resolves that.
	 */
	aiPrevious?: { design: string; at: string };
	/** Whether the next run continues it. */
	aiContinueSession: boolean;
	/** Other tickets the last run edited on disk. */
	aiEdited: AiEditedTicket[];
	/**
	 * An answer waiting to be approved over the description that is already
	 * there. The design tabs' own rides on `designs.review`.
	 */
	aiReview?: AiReview;
	onAiReviewApprove: () => void;
	onAiReviewRewrite: () => void;
	onAiReviewDiscard: () => void;
	onDesignReviewApprove: () => void;
	onDesignReviewRewrite: () => void;
	onDesignReviewDiscard: () => void;
	onDraftChange: (draft: string) => void;
	onEdit: () => void;
	onCancel: () => void;
	onSave: () => void;
	onRequestImage: (source: ImageSource, start: number, end: number) => void;
	onImageError: (message: string) => void;
	onAiToggle: () => void;
	onAiInstructionChange: (value: string) => void;
	onAiAgentChange: (slug: string) => void;
	onAiModelChange: (model: string | undefined) => void;
	onAiContinueSessionChange: (value: boolean) => void;
	onAiGenerate: () => void;
	onAiCancel: () => void;
}

export function TicketDetailPane({
	ticket,
	assetBase,
	tab,
	onTabChange,
	designs,
	onDesignCreate,
	onDesignRename,
	onDesignDelete,
	onDesignEdit,
	onDesignCancel,
	onDesignSave,
	onDesignDraftChange,
	onDesignImage,
	onDesignImageError,
	tests,
	onTestsRun,
	onTestsCancel,
	onTestsLoadRuns,
	onTestsLoadOutput,
	onTestsLoadMedia,
	onTestsLoadTrace,
	onTestsLoadTraceFrame,
	onTestsOpenTraceViewer,
	onTestsOpenTraceSource,
	onTestsSelectCase,
	onTestsSelectRun,
	onOpenEvidence,
	onOpenTicket,
	onOpenSettings,
	onSetTestCaseService,
	onLinkTicket,
	onUnlinkTicket,
	mode,
	draft,
	error,
	staleOnDisk,
	copying,
	aiOpen,
	aiState,
	aiInstruction,
	aiAvailable,
	aiUnavailable,
	aiLabel,
	aiAgents,
	aiAgent,
	aiModel,
	aiDefaultModel,
	aiPrevious,
	aiContinueSession,
	aiEdited,
	aiReview,
	onAiReviewApprove,
	onAiReviewRewrite,
	onAiReviewDiscard,
	onDesignReviewApprove,
	onDesignReviewRewrite,
	onDesignReviewDiscard,
	onDraftChange,
	onEdit,
	onCancel,
	onSave,
	onRequestImage,
	onImageError,
	onAiToggle,
	onAiInstructionChange,
	onAiAgentChange,
	onAiModelChange,
	onAiContinueSessionChange,
	onAiGenerate,
	onAiCancel
}: TicketDetailPaneProps) {
	if (!ticket) {
		return <p className="empty">Select a ticket in the BFAST sidebar to see its details.</p>;
	}

	const editing = mode !== 'view';
	const designOpen = designTabId(tab) !== undefined;
	// A design tab's own editor is up: its Save and Cancel are the controls then,
	// so the shared AI button steps aside exactly as it does for the description.
	const designMode = designOpen ? designs.mode : 'view';

	return (
		<article className="detail">
			<header className="detail-header">
				<div className="detail-meta">
					<span className={`type-badge type-${ticket.type}`}>{TYPE_BADGE[ticket.type]}</span>
					<span className="detail-key">{ticket.key}</span>
					<span className="detail-type">{TYPE_LABEL[ticket.type]}</span>
					<span className={`status-pill status-${ticket.status}`}>{STATUS_LABEL[ticket.status]}</span>
					<span className="detail-assignee">{ticket.assignee ?? 'Unassigned'}</span>
				</div>
				<h1 className="detail-title">{ticket.title}</h1>
			</header>

			{/* The tab buttons scroll on their own: `.tabs` is a flex row whose
			    `.detail-actions` is pushed right by `margin-left: auto`, so putting
			    the overflow on the row itself would scroll the Edit and AI buttons
			    away with the tabs. "+" is pinned beside them for the same reason —
			    at the end of the scroller, ten designs would hide it. */}
			<nav className="tabs" role="tablist">
				<div className="tabs-scroll">
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'description'}
					className={tab === 'description' ? 'tab active' : 'tab'}
					onClick={() => onTabChange('description')}
				>
					Description
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'history'}
					className={tab === 'history' ? 'tab active' : 'tab'}
					onClick={() => onTabChange('history')}
				>
					History <span className="tab-count">{ticket.history.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'tests'}
					className={tab === 'tests' ? 'tab active' : 'tab'}
					onClick={() => onTabChange('tests')}
				>
					Tests
					{/* The space is explicit: JSX drops the one a line break would leave,
					    and History's badge sits one space off its label. */}
					{tests.report && (
						<>
							{' '}
							<span className="tab-count">{tests.report.testCases.length}</span>
						</>
					)}
				</button>

				{designs.documents.map((design) => {
					const id = designTab(design.id);
					return (
						<button
							key={design.id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							className={tab === id ? 'tab active' : 'tab'}
							title={`${resolveStyle(designs.styles, design.prefix).label} — ${design.id}`}
							onClick={() => onTabChange(id)}
						>
							{design.title}
						</button>
					);
				})}
				</div>

				{/* An absent `designStyles` is how the host says this ticket type
				    carries no designs, so the webview needs no rule of its own. */}
				{designs.styles.length > 0 && !editing && (
					<AddDesign styles={designs.styles} onCreate={onDesignCreate} />
				)}

				{/* The wrapper is not decoration: `.detail-edit` carried the
				    `margin-left: auto` that pushes this group to the right, and a
				    second button beside it would have taken the spacing instead. */}
				{/* The assistant works on a design tab too: same button, same single
				    run — only which skill the host resolves and which draft the answer
				    lands in differ. The design tab has its own Edit inside its pane, so
				    only the AI button is shared. */}
				{(tab === 'description' || designOpen) && !editing && designMode === 'view' && (
					<div className="detail-actions">
						<button
							type="button"
							className={aiOpen ? 'button secondary detail-ai active' : 'button secondary detail-ai'}
							aria-pressed={aiOpen}
							title={aiAvailable ? 'Write this description with the AI assistant' : aiUnavailable}
							onClick={onAiToggle}
						>
							<SparkleIcon />
							AI Assistant
						</button>
						{/* Hidden while an answer is waiting to be approved: the review's
						    own three buttons are the way out of it, and an Edit here
						    would throw that answer away without saying so. */}
						{tab === 'description' && !aiReview && (
							<button type="button" className="button secondary" onClick={onEdit}>
								Edit
							</button>
						)}
					</div>
				)}
			</nav>

			<div className="tab-panel" role="tabpanel">
				{(tab === 'description' || designOpen) && aiOpen && !editing && designMode === 'view' && (
					<AiPrompt
						state={aiState}
						instruction={aiInstruction}
						available={aiAvailable}
						unavailable={aiUnavailable}
						providerLabel={aiLabel}
						agents={
							designOpen
								? aiAgents
								: aiAgents.filter((agent) => agent.types.includes(ticket.type))
						}
						agent={aiAgent}
						model={aiModel}
						defaultModel={aiDefaultModel}
						ticketType={ticket.type}
						designStyle={
							designOpen
								? resolveStyle(
										designs.styles,
										designs.documents.find((design) => design.id === designTabId(tab))
											?.prefix ?? ''
									).id
								: undefined
						}
						previousSession={
							designOpen && aiPrevious && aiPrevious.design === designTabId(tab)
								? { at: aiPrevious.at }
								: undefined
						}
						continueSession={aiContinueSession}
						onAgentChange={onAiAgentChange}
						onModelChange={onAiModelChange}
						onContinueSessionChange={onAiContinueSessionChange}
						onInstructionChange={onAiInstructionChange}
						onGenerate={onAiGenerate}
						onCancel={onAiCancel}
						onClose={onAiToggle}
					/>
				)}

				{(tab === 'description' || designOpen) && aiEdited.length > 0 && (
					<EditedNotice edited={aiEdited} />
				)}

				{tab === 'description' ? (
					editing ? (
						<DescriptionEditor
							draft={draft}
							saving={mode === 'saving'}
							error={error}
							staleOnDisk={staleOnDisk}
							copying={copying}
							onDraftChange={onDraftChange}
							onCancel={onCancel}
							onSave={onSave}
							onRequestImage={onRequestImage}
							onImageError={onImageError}
						/>
					) : (
						<>
							{error && <p className="detail-error">{error}</p>}
							{/* In place of the description, not above it: the diff already
							    shows that text, and showing it twice is what makes a
							    review screen unreadable. */}
							{aiReview ? (
								<AiReviewPane
									review={aiReview}
									label="description"
									assetBase={assetBase}
									onApprove={onAiReviewApprove}
									onRewrite={onAiReviewRewrite}
									onDiscard={onAiReviewDiscard}
								/>
							) : (
								<>
									<div className="description markdown">
										<Markdown text={ticket.description} assetBase={assetBase} />
									</div>
									<LinkedTickets
										links={ticket.links ?? []}
										onAdd={onLinkTicket}
										onRemove={onUnlinkTicket}
										onOpen={onOpenTicket}
									/>
								</>
							)}
						</>
					)
				) : tab === 'history' ? (
					<History entries={ticket.history} />
				) : designTabId(tab) !== undefined ? (
					<DesignPane
						state={designs}
						designId={designTabId(tab)!}
						assetBase={assetBase}
						copying={copying}
						onEdit={onDesignEdit}
						onCancel={onDesignCancel}
						onSave={onDesignSave}
						onDraftChange={onDesignDraftChange}
						onRename={(title) => onDesignRename(designTabId(tab)!, title)}
						onDelete={() => onDesignDelete(designTabId(tab)!)}
						onRequestImage={onDesignImage}
						onImageError={onDesignImageError}
						onReviewApprove={onDesignReviewApprove}
						onReviewRewrite={onDesignReviewRewrite}
						onReviewDiscard={onDesignReviewDiscard}
					/>
				) : (
					<TestsPane
						ticket={ticket}
						state={tests}
						onRun={onTestsRun}
						onCancel={onTestsCancel}
						onLoadRuns={onTestsLoadRuns}
						onLoadOutput={onTestsLoadOutput}
						onLoadMedia={onTestsLoadMedia}
						onLoadTrace={onTestsLoadTrace}
						onLoadTraceFrame={onTestsLoadTraceFrame}
						onOpenTraceViewer={onTestsOpenTraceViewer}
						onOpenTraceSource={onTestsOpenTraceSource}
						onSelectTestCase={onTestsSelectCase}
						onSelectRun={onTestsSelectRun}
						onOpenEvidence={onOpenEvidence}
						onOpenTicket={onOpenTicket}
						onOpenSettings={onOpenSettings}
						onSetService={onSetTestCaseService}
					/>
				)}
			</div>
		</article>
	);
}

/**
 * "Linked tickets" under the description, grouped by relation in the order
 * `LINK_RELATIONS` lists them. A row opens the other ticket's board; × removes the link
 * from both tickets. A link whose ticket is gone keeps its row, greyed, so it
 * can be seen and removed rather than silently disappearing.
 */
function LinkedTickets({
	links,
	onAdd,
	onRemove,
	onOpen
}: {
	links: TicketLinkView[];
	onAdd: () => void;
	onRemove: (relation: LinkRelation, targetId: string) => void;
	onOpen: (id: string) => void;
}) {
	const groups = LINK_RELATIONS.map((relation) => ({
		relation,
		links: links.filter((link) => link.relation === relation)
	})).filter((group) => group.links.length > 0);

	return (
		<section className="links">
			<header className="links-header">
				<h2 className="links-title">
					Linked tickets
					{links.length > 0 && <span className="tab-count">{links.length}</span>}
				</h2>
				<button type="button" className="button secondary links-add" onClick={onAdd}>
					<PlusIcon />
					Link ticket
				</button>
			</header>
			{groups.length === 0 ? (
				<p className="links-empty">No linked tickets.</p>
			) : (
				groups.map((group) => (
					<div key={group.relation} className="links-group">
						<h3 className="links-relation">{LINK_RELATION_INFO[group.relation].label}</h3>
						<ul className="links-list">
							{group.links.map((link) => (
								<li key={link.id} className={link.target ? 'link-row' : 'link-row missing'}>
									{link.target ? (
										<button
											type="button"
											className="link-open"
											title={`Open ${link.target.id}`}
											onClick={() => onOpen(link.target!.id)}
										>
											<span className={`type-badge type-${link.target.type}`}>
												{TYPE_BADGE[link.target.type]}
											</span>
											<span className="link-id">{link.target.id}</span>
											<span className="link-title">{link.target.title}</span>
											<span className={`status-pill status-${link.target.status}`}>
												{STATUS_LABEL[link.target.status]}
											</span>
										</button>
									) : (
										<span className="link-open" title="This ticket is not in the tracker folder">
											<span className="link-id">{link.id}</span>
											<span className="link-title">Not in the tracker</span>
										</span>
									)}
									<button
										type="button"
										className="link-remove"
										title={`Remove “${LINK_RELATION_INFO[link.relation].label} ${link.id}”`}
										aria-label={`Remove link to ${link.id}`}
										onClick={() => onRemove(link.relation, link.id)}
									>
										×
									</button>
								</li>
							))}
						</ul>
					</div>
				))
			)}
		</section>
	);
}

/**
 * What the last run did to *other* tickets. A notice rather than a toast:
 * the change is already on disk and in that ticket's history, and the reader
 * of this board needs to know it before pressing Save here.
 */
function EditedNotice({ edited }: { edited: AiEditedTicket[] }) {
	return (
		<div className="detail-notice detail-notice-list">
			{edited.map((entry) => (
				<p key={entry.id}>
					{entry.adopted
						? `The assistant also changed ${entry.id} ${entry.title} — recorded in its history.`
						: entry.reason === 'own-ticket'
							? 'The assistant edited this ticket’s own file on disk; the answer above is what will be saved.'
							: entry.reason === 'superseded'
								? `The assistant changed ${entry.id} ${entry.title}, but a save from its board got there first, so nothing more was recorded.`
								: entry.reason === 'unchanged'
									? `The assistant edited ${entry.id} ${entry.title} and left it as it was.`
									: `The assistant edited ${entry.title}, which no ticket owns; nothing was recorded.`}
				</p>
			))}
		</div>
	);
}

/**
 * The "+" on the tab bar: one panel, the styles to pick from and the title to
 * give the document — the two facts a new design needs and nothing else.
 *
 * A list with a selected row rather than a `<select>`, because that is what
 * every other picker in the editor looks like; and one panel rather than two
 * steps, because the second step was where the last version went wrong.
 */
function AddDesign({
	styles,
	onCreate
}: {
	styles: DesignStyle[];
	onCreate: (style: string, title: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [style, setStyle] = useState<string | undefined>(undefined);
	const [title, setTitle] = useState('');
	const root = useRef<HTMLDivElement>(null);

	const close = useCallback(() => {
		setOpen(false);
		setTitle('');
	}, []);

	// A click anywhere else closes it, the way a menu closes.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) {
				close();
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [open, close]);

	const selected = styles.find((candidate) => candidate.id === style) ?? styles[0];

	return (
		<div className="tab-add" ref={root}>
			<button
				type="button"
				className="tab tab-add-button"
				title="New design document"
				aria-label="New design document"
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => (open ? close() : setOpen(true))}
			>
				<PlusIcon />
			</button>

			{open && selected && (
				<form
					className="tab-add-menu"
					role="dialog"
					aria-label="New design document"
					onSubmit={(event) => {
						event.preventDefault();
						const trimmed = title.trim();
						if (trimmed.length > 0) {
							onCreate(selected.id, trimmed);
							close();
						}
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							close();
						}
					}}
				>
					<div className="tab-add-heading">New design</div>

					<ul className="tab-add-styles" role="listbox" aria-label="Style">
						{styles.map((option) => (
							<li key={option.id} role="presentation">
								<button
									type="button"
									role="option"
									aria-selected={option.id === selected.id}
									className={
										option.id === selected.id ? 'tab-add-style is-selected' : 'tab-add-style'
									}
									onClick={() => setStyle(option.id)}
								>
									<span className="tab-add-style-label">{option.label}</span>
									<code className="tab-add-style-prefix">{option.prefix}</code>
								</button>
							</li>
						))}
					</ul>

					<input
						className="settings-input tab-add-input"
						value={title}
						autoFocus
						placeholder="Title"
						aria-label="Title"
						onChange={(event) => setTitle(event.target.value)}
					/>

					<div className="tab-add-actions">
						<button type="button" className="button secondary" onClick={close}>
							Cancel
						</button>
						<button type="submit" className="button" disabled={title.trim().length === 0}>
							Create
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

function History({ entries }: { entries: HistoryEntry[] }) {
	if (entries.length === 0) {
		return <p className="empty">No changes recorded yet.</p>;
	}

	return (
		<ol className="history">
			{[...entries].reverse().map((entry) => (
				<li key={entry.id} className="history-item">
					<div className="history-head">
						<span className="history-author">{entry.author}</span>
						<span className="history-action">{entry.action}</span>
						{entry.field && <span className="history-field">{entry.field}</span>}
						<time className="history-time" dateTime={entry.timestamp}>
							{formatTimestamp(entry.timestamp)}
						</time>
					</div>
					{/* An entry with neither side — a `created`, or a hand-written note —
					    would only render an empty "— → —" row. */}
					{entry.field && (entry.from !== undefined || entry.to !== undefined) && (
						<HistoryChange from={entry.from} to={entry.to} />
					)}
					{entry.comment && <p className="history-comment">{entry.comment}</p>}
				</li>
			))}
		</ol>
	);
}

/** Longer than this and the two sides stop fitting on one line together. */
const INLINE_CHANGE_LIMIT = 60;

/**
 * A status or title change reads best inline, struck-through and arrowed. A
 * description does not — two paragraphs on that row would bury the timeline —
 * so it collapses behind a disclosure and shows both versions in full when
 * asked. Either way the entry says what the value actually was, not just that
 * it moved.
 */
function HistoryChange({ from, to }: { from?: string; to?: string }) {
	const inline = fitsInline(from) && fitsInline(to);

	if (inline) {
		return (
			<div className="history-change">
				<span className="history-from">{from || '—'}</span>
				<span className="history-arrow">→</span>
				<span className="history-to">{to || '—'}</span>
			</div>
		);
	}

	return (
		<details className="history-diff">
			<summary>See before and after</summary>
			<HistoryValue label="Before" value={from} />
			<HistoryValue label="After" value={to} />
		</details>
	);
}

function HistoryValue({ label, value }: { label: string; value?: string }) {
	return (
		<div className="history-value">
			<span className="history-value-label">{label}</span>
			{value === undefined || value === '' ? (
				<p className="history-value-empty">Empty</p>
			) : (
				<pre className="history-value-text">{value}</pre>
			)}
		</div>
	);
}

function fitsInline(value: string | undefined): boolean {
	return value === undefined || (!value.includes('\n') && value.length <= INLINE_CHANGE_LIMIT);
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}
	return date.toLocaleString();
}
