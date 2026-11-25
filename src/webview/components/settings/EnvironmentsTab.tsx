// Per-story environments: the provider, the stack, its ports and where worktrees live.

import {
	DEFAULT_COMPOSE_FILE,
	DEFAULT_ENVIRONMENT_PROVIDER,
	DEFAULT_LOG_TAIL,
	DEFAULT_PORT_RANGE_END,
	DEFAULT_PORT_RANGE_START,
	ENVIRONMENT_PROVIDER_IDS,
	MAX_LOG_TAIL,
	parsePortVariableList,
	type EnvironmentProviderId
} from '../../../settings/environmentSettings';
import { ENVIRONMENT_PROVIDER_LABEL, postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function EnvironmentsTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const {
		settings,
		worktreesDefault,
		portVariablesText,
		setPortVariablesText,
		envError,
		portTextError,
		worktreesError,
		updateEnvironments,
		portVariables,
	} = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<div className="settings-field">
					<label className="settings-label" htmlFor="envProvider">
						Provider
					</label>
					<select
						id="envProvider"
						className="settings-input"
						value={settings.environments?.provider ?? DEFAULT_ENVIRONMENT_PROVIDER}
						onChange={(event) =>
							updateEnvironments({ provider: event.target.value as EnvironmentProviderId })
						}
					>
						{ENVIRONMENT_PROVIDER_IDS.map((id) => (
							<option key={id} value={id} disabled={id === 'k8s'}>
								{ENVIRONMENT_PROVIDER_LABEL[id]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						What runs an environment's stack. Docker Compose uses the repo's compose file; see{' '}
						<code>docs/environments/docker-compose.md</code> for the contract it must satisfy.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envWorktreesFolder">
						Worktrees folder
					</label>
					<div className="settings-input-row">
						<input
							id="envWorktreesFolder"
							className="settings-input"
							type="text"
							spellCheck={false}
							value={settings.environments?.worktreesFolder ?? ''}
							placeholder={worktreesDefault ?? '<os temp>/bfast-worktrees'}
							onChange={(event) =>
								updateEnvironments({
									worktreesFolder: event.target.value === '' ? undefined : event.target.value
								})
							}
						/>
						<button
							type="button"
							className="settings-button secondary"
							onClick={() => postMessage({ type: 'pickWorktreesFolder' })}
						>
							Browse…
						</button>
					</div>
					<p className="settings-hint">
						Where an environment's checkout is created — a <code>&lt;workspace&gt;</code> folder
						is always made beneath it, so two repos never share one. Empty means the folder
						above, which the system may clean: point it somewhere you control to keep
						uncommitted work in a worktree safe. It must be outside the workspace, and a folder
						in your home folder is stored as <code>~/…</code> — the one value a Windows and a
						macOS teammate can share, since this file is committed to git.
					</p>
					{worktreesError && <p className="settings-error">{worktreesError}</p>}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envPortVariables">
						Port variables
					</label>
					<input
						id="envPortVariables"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={portVariablesText}
						placeholder="e.g. WEB_PORT, AUTH_PORT, DB_PORT"
						onChange={(event) => {
							setPortVariablesText(event.target.value);
							const names = parsePortVariableList(event.target.value);
							updateEnvironments({
								portVariables: names.length > 0 ? names : undefined
							});
						}}
					/>
					<p className="settings-hint">
						The names are yours — no role is baked in. One free port is allocated per name for
						every environment and passed to the stack as environment variables. A single proxy
						port, one frontend plus many backends, or a classic 3-tier are all just different
						lists.
					</p>
					{portVariables.length > 0 && (
						<p className="settings-hint">Will allocate: {portVariables.join(', ')}</p>
					)}
					{portTextError && <p className="settings-error">{portTextError}</p>}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envMainPort">
						Main port
					</label>
					<select
						id="envMainPort"
						className="settings-input"
						value={settings.environments?.mainPort ?? ''}
						onChange={(event) =>
							updateEnvironments({
								mainPort: event.target.value === '' ? undefined : event.target.value
							})
						}
					>
						<option value="">
							{portVariables.length > 0
								? `First variable (${portVariables[0]})`
								: 'First variable'}
						</option>
						{portVariables.map((name) => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
					<p className="settings-hint">
						The environment's front door — the URL a developer opens, usually the frontend.
						Shown first in the sidebar.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envPortRangeStart">
						Port range
					</label>
					<div className="settings-input-row">
						<input
							id="envPortRangeStart"
							className="settings-input settings-input-compact"
							type="number"
							min={1024}
							max={65535}
							value={settings.environments?.portRangeStart ?? ''}
							placeholder={String(DEFAULT_PORT_RANGE_START)}
							onChange={(event) =>
								updateEnvironments({
									portRangeStart:
										event.target.value === '' ? undefined : Number(event.target.value)
								})
							}
						/>
						<input
							id="envPortRangeEnd"
							className="settings-input settings-input-compact"
							type="number"
							min={1024}
							max={65535}
							value={settings.environments?.portRangeEnd ?? ''}
							placeholder={String(DEFAULT_PORT_RANGE_END)}
							onChange={(event) =>
								updateEnvironments({
									portRangeEnd:
										event.target.value === '' ? undefined : Number(event.target.value)
								})
							}
						/>
					</div>
					<p className="settings-hint">
						Where allocated ports come from. Two environments never share a port, even while
						stopped.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envLogTail">
						Log history
					</label>
					<input
						id="envLogTail"
						className="settings-input settings-input-compact"
						type="number"
						min={0}
						max={MAX_LOG_TAIL}
						value={settings.environments?.logTail ?? ''}
						placeholder={String(DEFAULT_LOG_TAIL)}
						onChange={(event) =>
							updateEnvironments({
								logTail: event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						Lines a container's log tab starts with before it follows. Enough to hold a
						service's whole startup, which is where a failure usually explains itself;{' '}
						<code>0</code> starts from the next line printed.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="envComposeFile">
						Compose file
					</label>
					<input
						id="envComposeFile"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.environments?.composeFile ?? ''}
						placeholder={DEFAULT_COMPOSE_FILE}
						onChange={(event) =>
							updateEnvironments({
								composeFile: event.target.value === '' ? undefined : event.target.value
							})
						}
					/>
					<p className="settings-hint">
						Relative to the repository root — it must be committed, since an environment runs
						from a fresh worktree checkout.
					</p>
				</div>

				<div className="settings-field">
					<div className="settings-row">
						<label className="settings-label">Compose override files</label>
						<button
							type="button"
							className="settings-button secondary"
							onClick={() =>
								updateEnvironments({
									composeOverrides: [...(settings.environments?.composeOverrides ?? []), '']
								})
							}
						>
							Add file…
						</button>
					</div>
					{(settings.environments?.composeOverrides ?? []).map((file, index) => (
						<div className="settings-input-row" key={index}>
							<input
								className="settings-input"
								type="text"
								spellCheck={false}
								value={file}
								placeholder="e.g. docker-compose.override.yml"
								onChange={(event) => {
									const next = [...(settings.environments?.composeOverrides ?? [])];
									next[index] = event.target.value;
									updateEnvironments({ composeOverrides: next });
								}}
							/>
							<button
								type="button"
								className="settings-button secondary"
								onClick={() => {
									const next = (settings.environments?.composeOverrides ?? []).filter(
										(_, other) => other !== index
									);
									updateEnvironments({
										composeOverrides: next.length > 0 ? next : undefined
									});
								}}
							>
								Remove
							</button>
						</div>
					))}
					<p className="settings-hint">
						Each file becomes one more <code>--file</code> flag, in this order — later files
						override earlier ones, standard compose merging. Relative to the repository and
						committed, like the base file. An empty row is dropped on save.
					</p>
					{envError && <p className="settings-error">{envError}</p>}
				</div>
		</div>
	);
}
