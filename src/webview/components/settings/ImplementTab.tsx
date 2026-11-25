// Implement: the coding agent, and the prompt templates as files.

import { CODING_AGENTS } from '../../../settings/codingAgents';
import {
	DEFAULT_IMPLEMENT_AGENT,
	type ImplementAgentId
} from '../../../settings/implementSettings';
import {
	IMPLEMENT_FOLDER,
	IMPLEMENT_RULES_FILE,
	IMPLEMENT_TEMPLATE_FILE
} from '../../../implement/implementPrompt';
import { TICKET_TYPES } from '../../../data/types';
import { TYPE_LABEL, postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function ImplementTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const { settings, implementPrompts, implementError, updateImplement, currentCodingAgent } = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<div className="settings-field">
					<label className="settings-label" htmlFor="implementAgent">
						Coding agent
					</label>
					{/* A coming-soon entry is listed and disabled, the k8s precedent: the
					    setting can be committed ahead of the implementation, and a
					    hand-edited file naming one still loads. */}
					<select
						id="implementAgent"
						className="settings-input"
						value={settings.implement?.agent ?? DEFAULT_IMPLEMENT_AGENT}
						onChange={(event) =>
							updateImplement({ agent: event.target.value as ImplementAgentId })
						}
					>
						{CODING_AGENTS.map((option) => (
							<option key={option.id} value={option.id} disabled={!option.available}>
								{option.available ? option.label : `${option.label} (coming soon)`}
							</option>
						))}
					</select>
					<p className="settings-hint">
						{currentCodingAgent.hint} Right-click a ticket → <strong>Implement…</strong> builds
						its prompt and hands it over; nothing is written into the ticket. See{' '}
						<code>docs/implement/</code>.
					</p>
				</div>

				{/* The templates are files, so this lists them and hands editing to a
				    real editor tab — the agents list's reason. */}
				<div className="settings-field">
					<label className="settings-label">Prompts</label>
					<p className="settings-hint">
						One template per ticket type under <code>{IMPLEMENT_FOLDER}</code>, seeded from the
						shipped ones and yours to edit. The ticket's description goes in; its criteria, test
						cases, design documents and parents are named by path for the agent to read. The
						working rules — how to approach any ticket — are one file every template includes as{' '}
						<code>{'{{rules}}'}</code>.
					</p>
					<ul className="skill-list">
						<li className="skill">
							<span className="skill-name">Working rules</span>
							<span className="agent-types">
								Shared by every template: think before coding, simplicity first, surgical changes,
								goal-driven execution ({IMPLEMENT_FOLDER}/{IMPLEMENT_RULES_FILE})
							</span>
							<button
								type="button"
								className="settings-button secondary"
								onClick={() => postMessage({ type: 'openImplementRules' })}
							>
								Open
							</button>
						</li>
						{TICKET_TYPES.map((type) => {
							const info = implementPrompts.find((prompt) => prompt.type === type);
							return (
								<li className="skill" key={type}>
									<span className="skill-name">{TYPE_LABEL[type]}</span>
									<span className="agent-types">
										{info?.description ?? `${IMPLEMENT_FOLDER}/${IMPLEMENT_TEMPLATE_FILE[type]}`}
										{info?.source === 'bundled' ? ' — shipped template (not in the workspace)' : ''}
									</span>
									<button
										type="button"
										className="settings-button secondary"
										onClick={() => postMessage({ type: 'openImplementPrompt', ticketType: type })}
									>
										Open
									</button>
								</li>
							);
						})}
					</ul>
				</div>
				{implementError && <p className="settings-error">{implementError}</p>}
		</div>
	);
}
