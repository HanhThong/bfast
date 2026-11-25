// The generate tab.
//
// Six screens in one document — form, planning, review, refining, writing,
// done — rather than a quick pick and a notification, because the middle ones
// have to show minutes of log while the review has to be tickable. `phase` is
// owned by the host: it is the flow, not the view, that knows which step it is
// on, so the tab cannot show a Cancel button for a run that already finished.
//
// The review is a conversation: a follow-up typed under the list goes back to
// the same agent session and the list comes back replaced. The transcript is
// the host's too — `generateProposed` carries the follow-ups the list on screen
// reflects — so a follow-up that was stopped or failed changes nothing here and
// stays in the box to retry.

import { useEffect, useRef, useState } from 'react';
import { resolveSkill, skillLabel, type AgentDefinition } from '../../ai/agent';
import type { TicketType } from '../../data/types';
import { modelLabel } from '../../settings/models';
import type { GenerateLaneStatus, GeneratePhase } from '../../shared/protocol';
import { relativeTime } from './labels';
import { ModelSelect } from './modelSelect';
import { channel, getState, setState } from '../vscodeApi';
import type { GenerateToHost, HostToGenerate } from '../../shared/protocol';

const { onMessage, postMessage } = channel<GenerateToHost, HostToGenerate>();

interface Parent {
	id: string;
	key: string;
	title: string;
	type: TicketType;
}

interface Context {
	parent: Parent;
	childType: TicketType;
	agents: AgentDefinition[];
	available: boolean;
	unavailable?: string;
	providerLabel?: string;
	/** The workspace's `ai.model`, so "Default" can say what it is. */
	model?: string;
}

interface Created {
	id: string;
	key: string;
	title: string;
	described: boolean;
}

/** One child's own run, as the right-hand pane shows it. */
interface Lane {
	title: string;
	status: GenerateLaneStatus;
	note?: string;
}

interface LogLine {
	line: string;
	lane?: number;
}

/**
 * The review screen's state, as one object.
 *
 * One rather than four `useState`s because the message handler subscribes once
 * and would close over stale values: replacing the list has to read the ticks
 * the user had *and* the titles they belonged to in a single functional update,
 * and clearing the follow-up box has to know whether the transcript grew.
 */
interface Review {
	titles: string[];
	kept: Set<string>;
	/** The follow-ups the list reflects, as the host reports them. */
	followUps: string[];
	/** What is typed in the follow-up box. */
	draft: string;
}

const EMPTY_REVIEW: Review = { titles: [], kept: new Set(), followUps: [], draft: '' };

const TYPE_PLURAL: Record<TicketType, string> = {
	epic: 'epics',
	story: 'stories',
	ac: 'acceptance criteria',
	testcase: 'test cases'
};

const TYPE_ONE: Record<TicketType, string> = {
	epic: 'epic',
	story: 'story',
	ac: 'acceptance criterion',
	testcase: 'test case'
};

export function GenerateApp() {
	const [context, setContext] = useState<Context | undefined>(undefined);
	const [phase, setPhase] = useState<GeneratePhase>('setup');
	const [agent, setAgent] = useState<string | undefined>(undefined);
	/**
	 * This tab's model pick, restored with the tab the way the board's is. A
	 * ref as well, since the message handler subscribes once and writes the
	 * whole state object on `generateContext`.
	 */
	const [model, setModel] = useState<string | undefined>(() => getState().model);
	const modelRef = useRef(model);
	modelRef.current = model;
	const [instruction, setInstruction] = useState('');
	const [log, setLog] = useState<LogLine[]>([]);
	const [lanes, setLanes] = useState<Map<number, Lane>>(new Map());
	const [review, setReview] = useState<Review>(EMPTY_REVIEW);
	const [created, setCreated] = useState<Created[]>([]);
	/** A conversation the host can continue, and whether the user wants to. */
	const [previousSession, setPreviousSession] = useState<{ at: string } | undefined>(undefined);
	const [continueSession, setContinueSession] = useState(true);
	const [summary, setSummary] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	/**
	 * Pressed Generate, host has not spoken yet.
	 *
	 * `phase` is the host's, and it cannot know a run started until its first
	 * message comes back — after a `getDetail`, an agents read and an availability
	 * probe. That gap is short, but it is exactly the moment the user is looking
	 * at the button, so the tab flips it itself and hands authority back the
	 * instant the host says anything at all.
	 */
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		const unsubscribe = onMessage((message) => {
			switch (message.type) {
				case 'generateContext':
					setContext(message);
					// Remembered so a reload comes back to the same ticket's form, with
					// the model it had picked.
					setState({
						parentId: message.parent.id,
						childType: message.childType,
						model: modelRef.current
					});
					break;

				case 'generatePhase':
					// Whatever phase it names, the host is the authority again.
					setStarting(false);
					setPhase(message.phase);
					break;

				case 'generateLog':
					// Capped: a long run emits a token counter several times a second,
					// and with several agents at once that is several times over — an
					// unbounded list is a slow leak in a tab left open.
					setLog((lines) =>
						[...lines, { line: message.line, lane: message.lane }].slice(-MAX_LOG_LINES)
					);
					break;

				case 'generateLane':
					setLanes((current) => {
						const next = new Map(current);
						next.set(message.lane, {
							title: message.title,
							status: message.status,
							// A finished lane keeps its last note only when the host sent
							// one; a `done` with no note means the heartbeat is over.
							note: message.note
						});
						return next;
					});
					break;

				case 'generateSession':
					setPreviousSession(message.previous);
					// A run in this tab just spoke in it, or the tab was opened onto
					// one: continuing is the default, starting fresh the deliberate act.
					if (message.previous) {
						setContinueSession(true);
					}
					break;

				case 'generateProposed':
					// The error banner is left alone: a failed follow-up reports and then
					// re-sends the list it left standing, and clearing here would wipe
					// the report before it was read. `start` and `refine` clear it.
					setReview((current) => ({
						titles: message.titles,
						// A surviving title keeps its tick; a new one arrives ticked, as
						// on the first list — the agent proposed it, and unticking is the
						// cheaper gesture than ticking each one back on.
						kept: new Set(
							message.titles.filter(
								(title) => !current.titles.includes(title) || current.kept.has(title)
							)
						),
						followUps: message.followUps,
						// Cleared only once the text became part of the conversation; a
						// follow-up that was stopped or failed stays there to retry.
						draft: message.followUps.length > current.followUps.length ? '' : current.draft
					}));
					break;

				case 'generateCreated':
					setCreated((list) => [...list, message]);
					break;

				case 'generateDone':
					setSummary(message.message);
					break;

				case 'generateError':
					// A run refused before it reached a phase would otherwise leave a Stop
					// button for a run that is not happening.
					setStarting(false);
					setError(message.message);
					break;
			}
		});

		const restored = getState();
		postMessage({
			type: 'generateReady',
			parentId: restored.parentId,
			childType: restored.childType
		});
		return unsubscribe;
	}, []);

	if (!context) {
		return <div className="generate empty">Loading…</div>;
	}

	const { parent, childType, agents, available } = context;
	const selected = agents.find((option) => option.slug === agent) ?? agents[0];
	// The same pure resolution the host performs, so the hint names what will run.
	const skill = resolveSkill(selected, childType);
	const running =
		starting || phase === 'planning' || phase === 'refining' || phase === 'writing';
	// `review` counts as busy even though nothing is running: the flow is parked
	// on `pickChildren`, and starting a second one would clear the list it is
	// waiting on while that promise never resolves — a permanently stuck tab.
	const busy = running || phase === 'review';
	// The list stays up while a follow-up runs, but nothing on it can be pressed:
	// it is about to be replaced, and a tick on a title that is going away is
	// a tick on nothing.
	const reviewLocked = phase === 'refining' || starting;
	const { titles, kept, followUps, draft } = review;

	const start = () => {
		setStarting(true);
		setLog([]);
		setLanes(new Map());
		setReview(EMPTY_REVIEW);
		setCreated([]);
		setSummary(undefined);
		setError(undefined);
		postMessage({
			type: 'generateStart',
			agent: selected?.slug,
			instruction,
			continueSession: previousSession !== undefined && continueSession,
			// A name the host sanitises; absent means the workspace setting.
			...(model ? { model } : {})
		});
	};

	/** The pick is this tab's, so it is written where the tab is. */
	const changeModel = (next: string | undefined) => {
		modelRef.current = next;
		setModel(next);
		setState({ ...getState(), model: next });
	};

	const toggle = (title: string) =>
		setReview((current) => {
			const next = new Set(current.kept);
			if (!next.delete(title)) {
				next.add(title);
			}
			return { ...current, kept: next };
		});

	const refine = () => {
		const ask = draft.trim();
		if (ask.length === 0 || reviewLocked) {
			return;
		}
		// Optimistic, the way Generate is: `phase` is the host's, and the button
		// must not stay pressable in the gap before it says `refining`.
		setStarting(true);
		setError(undefined);
		postMessage({ type: 'generateRefine', instruction: ask });
	};

	return (
		<div className="generate">
			<header className="generate-header">
				<h1 className="generate-title">Generate {TYPE_PLURAL[childType]}</h1>
				<p className="generate-subtitle">
					under <strong>{parent.key}</strong> — {parent.title}
				</p>
			</header>

			{/* Two columns: what you do on the left, what is happening on the right.
			    A tab is wide, and with several agents at once the activity is a
			    standing view rather than something to scroll past to reach the
			    controls. It collapses to one column on a narrow tab. */}
			<div className="generate-columns">
			<div className="generate-main">

			{error && <p className="settings-error-banner">{error}</p>}

			{!available && (
				<p className="settings-error-banner">
					{context.unavailable ?? 'The AI assistant is not available.'}
				</p>
			)}

			{/* The form stays mounted and disabled while a run is live, rather than
			    being swapped out: it is what says which agent and instruction the
			    log on screen belongs to. */}
			<section className="generate-section">
				<div className="settings-field">
					<label className="settings-label" htmlFor="generateAgent">
						Agent
					</label>
					{agents.length === 0 ? (
						<p className="settings-hint">
							No agent writes {TYPE_ONE[childType]}s. Add one in <code>.bfast/agents</code>, or
							give an existing one that type.
						</p>
					) : (
						<select
							id="generateAgent"
							className="settings-input"
							disabled={busy}
							value={selected?.slug ?? ''}
							onChange={(event) => setAgent(event.target.value)}
						>
							{agents.map((option) => (
								<option key={option.slug} value={option.slug}>
									{option.name}
								</option>
							))}
						</select>
					)}
					{/* Which skill shapes each child is decided by its type, not by the
					    user, so naming it is the only way to tell before pressing
					    Generate — and it is the file to edit when the shape is wrong. */}
					{selected && (
						<p className="settings-hint">
							{skill ? <strong>{skillLabel(skill)}</strong> : 'Writing from its role alone'}
							{skill?.description ? ` — ${skill.description}` : ''}
						</p>
					)}
				</div>

				{/* One pick for the batch: the plan, every follow-up and every write.
				    "Default" names the workspace setting, so the choice is never blind. */}
				<div className="settings-field">
					<label className="settings-label" htmlFor="generateModel">
						Model
					</label>
					<ModelSelect
						id="generateModel"
						className="settings-input"
						value={model}
						defaultLabel={`Default — ${modelLabel(context.model)}`}
						disabled={busy}
						onChange={changeModel}
					/>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="generateInstruction">
						Instruction <span className="generate-optional">optional</span>
					</label>
					<textarea
						id="generateInstruction"
						className="settings-input generate-instruction"
						rows={3}
						spellCheck={false}
						disabled={busy}
						value={instruction}
						placeholder={`Anything to steer the ${TYPE_PLURAL[childType]} — a focus, a constraint, what to leave out`}
						onChange={(event) => setInstruction(event.target.value)}
						onKeyDown={(event) => {
							if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy) {
								event.preventDefault();
								start();
							}
						}}
					/>
				</div>

				{/* Only when there is one to continue — a checkbox for a conversation
				    that does not exist would be a promise the host cannot keep. Ticked
				    by default: the agent already knows this ticket, and starting fresh
				    is the deliberate act. */}
				{previousSession && (
					<div className="settings-field">
						<label className="generate-continue">
							<input
								type="checkbox"
								disabled={busy}
								checked={continueSession}
								onChange={(event) => setContinueSession(event.target.checked)}
							/>
							<span>
								Continue the previous conversation{' '}
								<span className="generate-optional">from {relativeTime(previousSession.at)}</span>
							</span>
						</label>
					</div>
				)}

				<div className="generate-actions">
					{running ? (
						<button
							type="button"
							className="button danger"
							onClick={() => postMessage({ type: 'generateCancel' })}
						>
							Stop
						</button>
					) : (
						<button
							type="button"
							className="button"
							disabled={busy || !available || agents.length === 0}
							onClick={start}
						>
							{phase === 'done' ? 'Run again' : 'Generate'}
						</button>
					)}
					<span className="generate-status">
						{/* So the button does not flip alone. Mirrors the board's “Starting…”. */}
						{starting ? 'Starting…' : statusLine(phase, childType, created.length)}
					</span>
				</div>
			</section>

			{(phase === 'review' || phase === 'refining') && (
				<section className="generate-section">
					<h2 className="generate-heading">
						{phase === 'refining'
							? 'Updating the list…'
							: `${titles.length} proposed — untick anything you do not want`}
					</h2>
					<ul className="generate-choices">
						{titles.map((title) => (
							<li className="generate-choice" key={title}>
								<label>
									<input
										type="checkbox"
										disabled={reviewLocked}
										checked={kept.has(title)}
										onChange={() => toggle(title)}
									/>
									<span>{title}</span>
								</label>
							</li>
						))}
					</ul>

					{/* The conversation so far, so the list can be read as the answer to
					    what was asked. Each line is one the host confirmed the list reflects. */}
					{followUps.length > 0 && (
						<ul className="generate-followups">
							{followUps.map((text, index) => (
								<li className="generate-followup" key={index}>
									<span className="generate-followup-you">You:</span>
									{text}
								</li>
							))}
						</ul>
					)}

					<div className="settings-field">
						<label className="settings-label" htmlFor="generateFollowUp">
							Ask for changes
						</label>
						<textarea
							id="generateFollowUp"
							className="settings-input generate-instruction"
							rows={2}
							spellCheck={false}
							disabled={reviewLocked}
							value={draft}
							placeholder="Split one, merge two, drop a topic, add what is missing — the agent updates the list"
							onChange={(event) =>
								setReview((current) => ({ ...current, draft: event.target.value }))
							}
							onKeyDown={(event) => {
								if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
									event.preventDefault();
									refine();
								}
							}}
						/>
					</div>

					<div className="generate-actions">
						<button
							type="button"
							className="button"
							disabled={reviewLocked || kept.size === 0}
							onClick={() =>
								postMessage({
									type: 'generateChoose',
									// In the proposed order, not tick order: that is the order
									// the agent said to build them in, and it becomes the ids.
									titles: titles.filter((title) => kept.has(title))
								})
							}
						>
							Create {kept.size} {kept.size === 1 ? TYPE_ONE[childType] : TYPE_PLURAL[childType]}
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={reviewLocked || draft.trim().length === 0}
							onClick={refine}
						>
							Update list
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={reviewLocked}
							onClick={() => postMessage({ type: 'generateCancel' })}
						>
							Discard
						</button>
					</div>
				</section>
			)}

			{created.length > 0 && (
				<section className="generate-section">
					<h2 className="generate-heading">Created</h2>
					<ul className="generate-created">
						{created.map((ticket) => (
							<li className="generate-created-item" key={ticket.id}>
								<span className="generate-created-key">{ticket.key}</span>
								<span className="generate-created-title">{ticket.title}</span>
								{!ticket.described && (
									<span className="generate-created-warning">no description</span>
								)}
							</li>
						))}
					</ul>
					{summary && <p className="settings-hint">{summary}</p>}
				</section>
			)}

			</div>

			<aside className="generate-side">
				{/* The whole reason this is a tab: a run takes minutes and says nothing
				    on its own, so without this there is no telling working from hung. */}
				{lanes.size > 0 && <Runs lanes={lanes} />}
				{log.length === 0 ? (
					<section className="generate-section generate-idle">
						Progress and the agents’ activity appear here once a run starts.
					</section>
				) : (
					<ActivityLog lines={log} lanes={lanes} follow={running} />
				)}
			</aside>
			</div>
		</div>
	);
}

const STATUS_MARK: Record<GenerateLaneStatus, string> = {
	waiting: '○',
	running: '◍',
	done: '●',
	failed: '⚠'
};

/**
 * A row per child.
 *
 * Separate from the log because it answers a different question: with several
 * agents running at once, "what is each one doing right now" cannot be read out
 * of a chronological stream of their interleaved heartbeats.
 */
function Runs({ lanes }: { lanes: Map<number, Lane> }) {
	const rows = [...lanes.entries()].sort(([a], [b]) => a - b);
	const done = rows.filter(([, lane]) => lane.status === 'done' || lane.status === 'failed').length;

	return (
		<section className="generate-section">
			<h2 className="generate-heading">
				Agents <span className="generate-count">{done} of {rows.length} finished</span>
			</h2>
			<ul className="generate-runs">
				{rows.map(([index, lane]) => (
					<li className={`generate-run is-${lane.status}`} key={index}>
						<span className="generate-run-mark" aria-hidden="true">
							{STATUS_MARK[lane.status]}
						</span>
						<span className="generate-run-title">{lane.title}</span>
						<span className="generate-run-note">{lane.note ?? lane.status}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

const MAX_LOG_LINES = 500;

function ActivityLog({
	lines,
	lanes,
	follow
}: {
	lines: LogLine[];
	lanes: Map<number, Lane>;
	follow: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);

	// Follow the tail while it runs, so the newest line is the one on screen.
	// Once it stops, leave the scroll where the user put it.
	useEffect(() => {
		if (follow && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [lines, follow]);

	return (
		<section className="generate-section">
			<h2 className="generate-heading">Log</h2>
			<div className="generate-log" ref={ref} aria-live="polite">
				{lines.map((entry, index) => (
					<p className="generate-log-line" key={index}>
						{/* Which agent said it. Without this an interleaving of a
						    dozen heartbeats from three runs is unreadable. */}
						{entry.lane !== undefined && (
							<span className="generate-log-lane">
								{shortLane(lanes.get(entry.lane)?.title, entry.lane)}
							</span>
						)}
						{entry.line}
					</p>
				))}
			</div>
		</section>
	);
}

/** A log prefix narrow enough to keep the line readable: a few words, or `#2`. */
function shortLane(title: string | undefined, lane: number): string {
	if (!title) {
		return `#${lane + 1}`;
	}
	const words = title.split(/\s+/).slice(0, 3).join(' ');
	return words.length < title.length ? `${words}…` : words;
}

function statusLine(phase: GeneratePhase, childType: TicketType, createdCount: number): string {
	switch (phase) {
		case 'planning':
			return `Proposing ${TYPE_PLURAL[childType]}…`;
		case 'review':
			return 'Waiting for you';
		case 'refining':
			return 'Updating the list…';
		case 'writing':
			return createdCount > 0 ? `Written ${createdCount} so far…` : 'Writing…';
		case 'done':
			return createdCount > 0 ? 'Finished' : '';
		case 'setup':
			return '';
	}
}
