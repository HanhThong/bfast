// The assistant: provider, default model, agents and their skills, language, limits.

import { AGENTS_FOLDER, skillKind, skillLabel } from '../../../ai/agent';
import { ModelSelect } from '../modelSelect';
import {
	AI_PROVIDER_IDS,
	DEFAULT_AI_PROVIDER,
	DEFAULT_CONCURRENCY,
	DEFAULT_IDLE_SECONDS,
	DEFAULT_TURNS,
	MAX_CONCURRENCY,
	MAX_IDLE_SECONDS,
	MAX_TURNS,
	MIN_CONCURRENCY,
	MIN_IDLE_SECONDS,
	MIN_TURNS,
	type AiProviderId
} from '../../../settings/aiSettings';
import { LANGUAGES } from '../../../settings/languages';
import { TYPE_LABEL, PROVIDER_LABEL, postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function AiTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const { settings, agents, aiError, updateAi } = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<div className="settings-field">
					<label className="settings-label" htmlFor="aiProvider">
						Provider
					</label>
					<select
						id="aiProvider"
						className="settings-input"
						value={settings.ai?.provider ?? DEFAULT_AI_PROVIDER}
						onChange={(event) => updateAi({ provider: event.target.value as AiProviderId })}
					>
						{AI_PROVIDER_IDS.map((id) => (
							<option key={id} value={id}>
								{PROVIDER_LABEL[id]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						The CLI runs the <code>claude</code> you already have installed. The SDK is bundled but
						ships a binary per platform.
					</p>
				</div>

				{/* Right under the provider, above the long agents list: the default is
				    the one thing here every run reads, and the pickers on the board and
				    the generate tab name it as "Default — …". */}
				<div className="settings-field">
					<label className="settings-label" htmlFor="aiModel">
						Default model
					</label>
					<ModelSelect
						id="aiModel"
						className="settings-input"
						value={settings.ai?.model}
						defaultLabel="Provider default (whatever Claude Code runs on)"
						onChange={(model) => updateAi({ model })}
					/>
					<p className="settings-hint">
						What every AI run uses unless a board or generate tab picks another model for its own
						runs. An alias follows whatever Claude Code currently points it at; a pinned id stays
						put. A name is checked only when the first request is sent, so a mistyped one shows up
						as that run’s error.
					</p>
				</div>

				{/* Agents are files, so this lists them and hands editing to a real
				    editor tab — wrapping, spell-check, undo and a git diff that reads,
				    none of which a textarea in a webview gives you. */}
				<div className="settings-field">
					<div className="settings-row">
						<label className="settings-label">Agents</label>
						<button
							type="button"
							className="settings-button secondary"
							onClick={() => postMessage({ type: 'newAgent' })}
						>
							New agent…
						</button>
					</div>

					{agents.length === 0 ? (
						<p className="settings-hint">No agents yet — they appear once a folder is open.</p>
					) : (
						<ul className="agent-list">
							{agents.map((agent) => (
								<li className="agent" key={agent.slug}>
									<div className="agent-head">
										<div className="agent-text">
											<span className="agent-name">{agent.name}</span>
											<span className="agent-types">
												{agent.types.map((type) => TYPE_LABEL[type]).join(' · ')}
											</span>
											{agent.description && <p className="settings-hint">{agent.description}</p>}
										</div>
										<button
											type="button"
											className="settings-button secondary"
											onClick={() => postMessage({ type: 'openAgent', slug: agent.slug })}
										>
											Edit role
										</button>
									</div>

									{/* The role is the voice; a skill is how it shapes one kind of
									    ticket. Listing them here is what makes that split visible
									    rather than something you discover in the folder. */}
									<ul className="skill-list">
										{agent.skills.map((skill) => (
											<li className="skill" key={skill.slug}>
												<span className="skill-name">{skillLabel(skill)}</span>
												{/* A plan skill declares the type it *reads*, so listing
												    its types the same way would read as "writes epics" —
												    the opposite of what it does. */}
												<span className="agent-types">
													{skillKind(skill) === 'plan'
														? `Proposes the children of ${skill.types
																.map((type) => TYPE_LABEL[type].toLowerCase())
																.join(' · ')}`
														: skill.types.map((type) => TYPE_LABEL[type]).join(' · ')}
												</span>
												<button
													type="button"
													className="settings-button secondary"
													onClick={() =>
														postMessage({
															type: 'openSkill',
															agent: agent.slug,
															skill: skill.slug
														})
													}
												>
													Edit
												</button>
											</li>
										))}
										<li className="skill">
											<span className="agent-types">
												{agent.skills.length === 0
													? 'No skills — this agent writes from its role alone.'
													: ''}
											</span>
											<button
												type="button"
												className="settings-button secondary"
												onClick={() => postMessage({ type: 'newSkill', agent: agent.slug })}
											>
												New skill…
											</button>
										</li>
									</ul>
								</li>
							))}
						</ul>
					)}

					<p className="settings-hint">
						An agent is a role — the voice and the standard of evidence — and its skills say how
						that role shapes each kind of ticket. The ones above were written for you to edit:
						they are markdown files under <code>{AGENTS_FOLDER}</code>, a{' '}
						<code>business-analyst.md</code> beside a <code>business-analyst/</code> folder
						holding <code>write-epic/SKILL.md</code> and the rest. Commit them and the whole team
						writes the same way.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="aiLanguage">
						Ticket language
					</label>
					<select
						id="aiLanguage"
						className="settings-input"
						value={settings.ai?.language ?? ''}
						onChange={(event) =>
							updateAi({ language: event.target.value === '' ? undefined : event.target.value })
						}
					>
						<option value="">No preference (the agent decides)</option>
						{LANGUAGES.map((language) => (
							<option key={language.code} value={language.code}>
								{language.name} — {language.native}
							</option>
						))}
					</select>
					<p className="settings-hint">
						The language a generated description is written in. Code, identifiers, file paths and
						ticket ids are left alone, and descriptions already written are never translated.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="aiMaxTurns">
						Maximum turns
					</label>
					<input
						id="aiMaxTurns"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_TURNS}
						max={MAX_TURNS}
						value={settings.ai?.maxTurns ?? ''}
						placeholder={String(DEFAULT_TURNS)}
						onChange={(event) =>
							updateAi({
								maxTurns: event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						Bounds how many times one run may come back for another go, and so what it
						costs. Only the Agent SDK provider is given the flag.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="aiIdleTimeout">
						Idle timeout <span className="generate-optional">seconds</span>
					</label>
					<input
						id="aiIdleTimeout"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_IDLE_SECONDS}
						max={MAX_IDLE_SECONDS}
						value={settings.ai?.idleTimeout ?? ''}
						placeholder={String(DEFAULT_IDLE_SECONDS)}
						onChange={(event) =>
							updateAi({
								idleTimeout:
									event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						How long a run may produce no output at all before it is stopped. It is not a
						limit on the work: a run that keeps reporting progress is never stopped,
						however long it takes — only silence counts.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="aiConcurrency">
						Agents at once
					</label>
					<input
						id="aiConcurrency"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_CONCURRENCY}
						max={MAX_CONCURRENCY}
						value={settings.ai?.concurrency ?? ''}
						placeholder={String(DEFAULT_CONCURRENCY)}
						onChange={(event) =>
							updateAi({
								concurrency:
									event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						How many children the generate tab writes in parallel. Each one is a separate run,
						so this is a spend and rate-limit dial as much as a speed one. The board is
						unaffected — it has only ever one description to write.
					</p>
					{aiError && <p className="settings-error">{aiError}</p>}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="aiExecutablePath">
						Claude executable
					</label>
					<input
						id="aiExecutablePath"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.ai?.executablePath ?? ''}
						placeholder="found on PATH"
						onChange={(event) => updateAi({ executablePath: event.target.value })}
					/>
					<p className="settings-hint">
						Only needed when <code>claude</code> is not on your PATH, or on a platform the bundled
						binary does not cover.
					</p>
				</div>

				<p className="settings-hint">
					The API key is never stored here — this file is committed to git. Run{' '}
					<strong>BFAST: Set AI API key</strong> from the command palette instead.
				</p>
		</div>
	);
}
