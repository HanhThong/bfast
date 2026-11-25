// The settings form's Design tab: every design style, and under each one the
// roles that can draw it with the two files that make that true — the skill,
// and the example of the expected output the prompt is shown.
//
// Styles are not a list in `bfast.json`: a style *is* a design skill, so this
// panel is the AI tab's agents-and-skills list turned on its side, grouped by
// style rather than by role. `stylesFromAgents` is the same rule the host reads,
// so what is listed here is what the board's "+" menu offers.

import { resolveDesignSkill, skillLabel, stylesFromAgents, type AgentDefinition } from '../../ai/agent';
import { BUILT_IN_STYLES, type DesignStyle } from '../../design/designDocument';
import { channel } from '../vscodeApi';
import type { SettingsToHost, HostToSettings } from '../../shared/protocol';

const { postMessage } = channel<SettingsToHost, HostToSettings>();

export function DesignStylesPanel({ agents }: { agents: AgentDefinition[] }) {
	const { styles, warnings } = stylesFromAgents(agents);

	return (
		<div className="settings-field">
			<p className="settings-hint">
				A style is a design skill. Each role that can draw one holds the skill under{' '}
				<code>.bfast/agents/&lt;role&gt;/design-&lt;style&gt;/</code>: its <code>SKILL.md</code>{' '}
				and, under <code>resources/</code>, the expected output the assistant is shown. The two
				built-in styles are drawn by every role — with the shipped skill unless the role has
				its own. A new tab starts empty, with the assistant open to be told what to draw.
			</p>

			<ul className="agent-list">
				{styles.map((style) => (
					<StyleCard key={style.id} style={style} agents={agents} />
				))}
			</ul>

			{warnings.map((warning) => (
				<p className="settings-error" key={warning}>
					{warning}
				</p>
			))}

			<div className="settings-actions-row">
				<button
					type="button"
					className="settings-button secondary"
					onClick={() => postMessage({ type: 'newDesignStyle' })}
				>
					New style…
				</button>
			</div>
		</div>
	);
}

function StyleCard({ style, agents }: { style: DesignStyle; agents: AgentDefinition[] }) {
	const builtIn = BUILT_IN_STYLES.some((candidate) => candidate.id === style.id);
	const holders = agents
		.map((agent) => ({ agent, skill: resolveDesignSkill(agent, style.id) }))
		.filter((entry): entry is { agent: AgentDefinition; skill: NonNullable<typeof entry.skill> } =>
			entry.skill !== undefined
		);
	const everyone = holders.length === agents.length;

	return (
		<li className="agent">
			<div className="agent-head">
				<div className="agent-text">
					<span className="agent-name">
						{style.label} <code className="design-prefix">{style.prefix}</code>
					</span>
					<span className="agent-types">
						{builtIn ? 'Built in — every role can draw it' : `Declared by ${holders[0]?.agent.name ?? 'no role'}`}
						{' · '}
						files start with <code>{style.prefix}-1-…</code>
					</span>
				</div>
				{!everyone && (
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => postMessage({ type: 'addDesignStyle', style: style.id })}
					>
						Add to a role…
					</button>
				)}
			</div>

			<ul className="skill-list">
				{holders.map(({ agent, skill }) => (
					<li className="skill" key={agent.slug}>
						<span className="skill-name">{agent.name}</span>
						<span className="agent-types">{skillLabel(skill)}</span>
						<span className="design-parts">
							<button
								type="button"
								className="settings-button secondary"
								onClick={() =>
									postMessage({ type: 'openSkill', agent: agent.slug, skill: skill.slug })
								}
							>
								Skill
							</button>
							{skill.resources.map((resource) => (
								<button
									key={resource.name}
									type="button"
									className="settings-button secondary"
									onClick={() =>
										postMessage({
											type: 'openSkillResource',
											agent: agent.slug,
											skill: skill.slug,
											name: resource.name
										})
									}
								>
									{resourceLabel(resource.name)}
								</button>
							))}
						</span>
					</li>
				))}
				{holders.length === 0 && (
					<li className="skill">
						<span className="agent-types">
							{builtIn
								? 'No role has its own copy yet; each draws it with the shipped skill.'
								: 'No role holds this skill any more, so it cannot be offered.'}
						</span>
					</li>
				)}
			</ul>
		</li>
	);
}

/** `expected-output.md` → `Expected output`. */
function resourceLabel(name: string): string {
	const stem = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
	return stem.charAt(0).toUpperCase() + stem.slice(1);
}
