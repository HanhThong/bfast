// The AI assistant's panel on the board.
//
// Inline above the description rather than a host-side `showInputBox`, because
// a modal cannot show progress and cannot be cancelled from where it started.

import { useEffect, useRef } from 'react';
import { resolveDesignSkill, resolveSkill, skillLabel, type AgentDefinition } from '../../ai/agent';
import { BUILT_IN_STYLES } from '../../design/designDocument';
import type { TicketType } from '../../data/types';
import { modelLabel } from '../../settings/models';
import type { AiState } from '../app';
import { relativeTime } from './labels';
import { ModelSelect } from './modelSelect';

interface AiPromptProps {
	state: AiState;
	instruction: string;
	available: boolean;
	/** Why the assistant cannot run, when it cannot. */
	unavailable?: string;
	providerLabel?: string;
	/** Already filtered to the agents that write this ticket's type. */
	agents: AgentDefinition[];
	agent?: string;
	/** This tab's model pick; absent means `defaultModel`. */
	model?: string;
	/** The workspace's `ai.model`, so "Default" can say what it is. */
	defaultModel?: string;
	/** What is being written, which is what decides the skill. */
	ticketType: TicketType;
	/** Set on a design tab: the style being written, which picks the skill. */
	designStyle?: string;
	/**
	 * The conversation the next run could continue, when the host says there is
	 * one: only when it spoke, never its id. Absent means a fresh conversation is
	 * the only option, and the box is not shown at all.
	 */
	previousSession?: { at: string };
	/** Whether the next run continues it. */
	continueSession: boolean;
	onAgentChange: (slug: string) => void;
	onModelChange: (model: string | undefined) => void;
	onContinueSessionChange: (value: boolean) => void;
	onInstructionChange: (value: string) => void;
	onGenerate: () => void;
	onCancel: () => void;
	onClose: () => void;
}

export function AiPrompt({
	state,
	instruction,
	available,
	unavailable,
	providerLabel,
	agents,
	agent,
	model,
	defaultModel,
	ticketType,
	designStyle,
	previousSession,
	continueSession,
	onAgentChange,
	onModelChange,
	onContinueSessionChange,
	onInstructionChange,
	onGenerate,
	onCancel,
	onClose
}: AiPromptProps) {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const logRef = useRef<HTMLDivElement>(null);

	// Opening the panel is an explicit act, so the caret belongs in the box.
	useEffect(() => inputRef.current?.focus(), []);

	const running = state.status === 'running';
	const activity = running ? state.activity : [];
	// On a design tab the roles offered are the ones that can draw the style: any
	// of them for a built-in style, since the host falls back to the shipped
	// skill; only those holding the skill for a style the workspace declared,
	// since there is nothing to fall back to. The host makes the same decision.
	const builtIn = designStyle !== undefined && BUILT_IN_STYLES.some((style) => style.id === designStyle);
	const usable =
		designStyle && !builtIn
			? agents.filter((option) => resolveDesignSkill(option, designStyle) !== undefined)
			: agents;
	// The same fallback `resolveAgent` applies on the host, so what the picker
	// shows is what will actually run even before anything has been chosen.
	const selected = usable.find((option) => option.slug === agent) ?? usable[0];
	// The same pure resolution the host performs, so what is shown is what runs.
	// A design tab resolves by style rather than by ticket type, because two
	// design skills cover the same types and only the style tells them apart.
	const skill = designStyle
		? resolveDesignSkill(selected, designStyle)
		: resolveSkill(selected, ticketType);
	// A design run without a skill has no "one mermaid fence" contract to give the
	// model, so the shipped one stands in for a built-in style — and a custom
	// style with no holder cannot run at all.
	const canRun = designStyle === undefined || skill !== undefined || (builtIn && selected !== undefined);

	// Follow the tail, so the newest line is the one on screen. Scrolling up to
	// read something older parks it there until the user returns to the bottom.
	useEffect(() => {
		const log = logRef.current;
		if (!log) {
			return;
		}
		const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
		if (atBottom) {
			log.scrollTop = log.scrollHeight;
		}
	}, [activity.length]);

	return (
		<section className="ai-prompt">
			<div className="ai-prompt-head">
				<strong>AI assistant</strong>
				{providerLabel && <span className="ai-prompt-provider">{providerLabel}</span>}
				<button type="button" className="button secondary ai-prompt-close" onClick={onClose}>
					Close
				</button>
			</div>

			{available && agents.length === 0 && (
				<p className="ai-prompt-hint">
					No agent writes this kind of ticket yet. Add one in <code>.bfast/agents</code>, or give
					an existing one this type.
				</p>
			)}

			{available && agents.length > 0 ? (
				<>
					<div className="ai-prompt-agent">
						<label className="ai-prompt-label" htmlFor="aiAgent">
							Agent
						</label>
						<select
							id="aiAgent"
							className="ai-prompt-input ai-prompt-select"
							disabled={running}
							// Falling back to the first agent keeps the picker and what the
							// host actually resolves in step, without storing a default.
							value={selected?.slug ?? ''}
							onChange={(event) => onAgentChange(event.target.value)}
						>
							{usable.map((option) => (
								<option key={option.slug} value={option.slug}>
									{option.name}
								</option>
							))}
						</select>
					</div>
					{/* Which skill runs is decided by the ticket's type, not by the user,
					    so naming it here is the only way they can tell before pressing
					    Generate — and it is the file to go and edit if the shape is
					    wrong. */}
					<p className="ai-prompt-hint">
						{skill ? (
							<strong>{skillLabel(skill)}</strong>
						) : designStyle && builtIn ? (
							// The host falls back to the shipped skill for a built-in style;
							// naming that here is what stops "no skill" reading as "no AI".
							<>
								<strong>{skillLabel({ name: `design-${designStyle}` })}</strong> — the shipped
								skill; give this role its own in Settings → Design to change how it draws
							</>
						) : designStyle ? (
							// Unlike a write skill, this one is not optional: it is where the
							// "exactly one mermaid fence" contract lives, so a run without it
							// would return prose nothing can draw.
							'No role holds a skill for this style yet — add one in Settings → Design'
						) : (
							'Writing from its role alone'
						)}
						{skill?.description ? ` — ${skill.description}` : ''}
					</p>

					{/* The model is the one thing here that is the user's to choose per
					    run. The pick is this tab's alone — the setting stays the team's
					    default — and "Default" names it so the choice is never blind. */}
					<div className="ai-prompt-agent">
						<label className="ai-prompt-label" htmlFor="aiModel">
							Model
						</label>
						<ModelSelect
							id="aiModel"
							className="ai-prompt-input ai-prompt-select"
							value={model}
							defaultLabel={`Default — ${modelLabel(defaultModel)}`}
							disabled={running}
							onChange={onModelChange}
						/>
					</div>

					<textarea
						ref={inputRef}
						className="ai-prompt-input"
						rows={2}
						spellCheck={false}
						disabled={running}
						value={instruction}
						placeholder={
							designStyle
								? 'What should this diagram show? The ticket is already in front of it.'
								: 'Optional: anything extra it should know or focus on'
						}
						onChange={(event) => onInstructionChange(event.target.value)}
						onKeyDown={(event) => {
							// The same shortcut the description editor saves with.
							if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !running && canRun) {
								event.preventDefault();
								onGenerate();
							}
						}}
					/>

					{/* Only when there is one to continue — a checkbox for a conversation
					    that does not exist would be a promise the host cannot keep. Ticked
					    by default: the agent already has this diagram in mind, and starting
					    fresh is the deliberate act. The document itself goes into the
					    prompt either way, so a resume that is refused loses no context. */}
					{previousSession && (
						<label className="ai-prompt-continue">
							<input
								type="checkbox"
								disabled={running}
								checked={continueSession}
								onChange={(event) => onContinueSessionChange(event.target.checked)}
							/>
							<span>
								Continue the previous conversation{' '}
								<span className="ai-prompt-optional">
									from {relativeTime(previousSession.at)}
								</span>
							</span>
						</label>
					)}

					<div className="ai-prompt-actions">
						{/* The status line and the log below it go here rather than into
						    the editor: watching text arrive in a box you are about to edit
						    is jarring, and it makes Cancel ambiguous about the partial
						    text. */}
						<span className="ai-progress">
							{running ? state.note : ''}
							{running && state.thinkingTokens !== undefined && (
								<span className="ai-tokens">
									{' '}
									· {state.thinkingTokens.toLocaleString()} thinking tokens
								</span>
							)}
						</span>
						{running ? (
							<button type="button" className="button danger" onClick={onCancel}>
								Stop
							</button>
						) : (
							<button type="button" className="button" disabled={!canRun} onClick={onGenerate}>
								Generate
							</button>
						)}
					</div>

					{/* The whole point: a run takes minutes and says nothing on its own,
					    so without this there is no way to tell working from hung. */}
					{running && activity.length > 0 && (
						<div className="ai-activity" ref={logRef} aria-live="polite">
							{activity.map((entry, index) => (
								<p className="ai-activity-line" key={index}>
									{entry}
								</p>
							))}
						</div>
					)}

					<p className="ai-prompt-hint">
						The result opens in the editor for you to review — nothing is written until you save.
					</p>
				</>
			) : (
				<p className="ai-prompt-hint">
					{unavailable ?? 'The AI assistant is not available in this workspace.'}
				</p>
			)}
		</section>
	);
}
