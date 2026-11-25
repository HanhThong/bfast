// Code Quality: the tool, where its server is, and how the scanner runs.

import {
	DEFAULT_SCAN_IDLE_SECONDS,
	DEFAULT_SCAN_MODE,
	DEFAULT_SCAN_PORT_RANGE_END,
	DEFAULT_SCAN_PORT_RANGE_START,
	DEFAULT_SCANNER_IMAGE,
	DEFAULT_SCANNER_MODE,
	MAX_SCAN_IDLE_SECONDS,
	MAX_SCAN_PORT,
	MIN_SCAN_IDLE_SECONDS,
	MIN_SCAN_PORT,
	SCAN_MODES,
	SCAN_TOOL_IDS,
	SCANNER_MODES,
	type ScanMode,
	type ScannerMode,
	type ScanToolId
} from '../../../settings/scanSettings';
import { SCAN_TOOL_LABEL, SCAN_MODE_LABEL, SCANNER_MODE_LABEL } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function ScanTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const {
		settings,
		scanError,
		strayScanPlaceholders,
		updateScan,
		updateScanProperties,
		currentScanMode,
		currentScannerMode,
		scanProperties,
	} = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<div className="settings-field">
					<label className="settings-label" htmlFor="scanTool">
						Tool
					</label>
					<select
						id="scanTool"
						className="settings-input"
						value={settings.scan?.tool ?? SCAN_TOOL_IDS[0]}
						onChange={(event) => updateScan({ tool: event.target.value as ScanToolId })}
					>
						{SCAN_TOOL_IDS.map((id) => (
							<option key={id} value={id}>
								{SCAN_TOOL_LABEL[id]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						What analyses the code. See <code>docs/scan/</code> for the contract.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scanMode">
						Server
					</label>
					<select
						id="scanMode"
						className="settings-input"
						value={settings.scan?.mode ?? DEFAULT_SCAN_MODE}
						onChange={(event) => updateScan({ mode: event.target.value as ScanMode })}
					>
						{SCAN_MODES.map((id) => (
							<option key={id} value={id}>
								{SCAN_MODE_LABEL[id]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						Deployed, BFAST runs one SonarQube for this workspace and generates its admin
						password and tokens for you — there is nothing to copy or paste.
					</p>
				</div>

				<div className="settings-field" hidden={currentScanMode !== 'external'}>
					<label className="settings-label" htmlFor="scanHostUrl">
						Server URL
					</label>
					<input
						id="scanHostUrl"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.hostUrl ?? ''}
						placeholder="https://sonarqube.example.com"
						onChange={(event) => updateScan({ hostUrl: event.target.value })}
					/>
					<p className="settings-hint">
						Your existing SonarQube Server, or <code>https://sonarcloud.io</code>. Never put a
						token in the URL — this file is committed to git.
					</p>
				</div>

				<div className="settings-field" hidden={currentScanMode !== 'external'}>
					<label className="settings-label" htmlFor="scanOrganization">
						Organization
					</label>
					<input
						id="scanOrganization"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.organization ?? ''}
						placeholder="SonarQube Cloud only"
						onChange={(event) => updateScan({ organization: event.target.value })}
					/>
					<p className="settings-hint">
						Mandatory on SonarQube Cloud, meaningless against a Server.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scanProjectKey">
						Project key
					</label>
					<input
						id="scanProjectKey"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.projectKey ?? ''}
						placeholder="the workspace folder name, slugified"
						onChange={(event) => updateScan({ projectKey: event.target.value })}
					/>
					<p className="settings-hint">
						The one SonarQube project every scan in this workspace files under. A{' '}
						<code>sonar-project.properties</code> in the analysed directory wins over this
						field — its <code>sonar.projectKey</code> is what the scanner would use anyway.
						Community Edition analyses the main branch only, so each scan replaces the last.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scanCwd">
						Directory to analyse
					</label>
					<input
						id="scanCwd"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.cwd ?? ''}
						placeholder="workspace root"
						onChange={(event) => updateScan({ cwd: event.target.value })}
					/>
					<p className="settings-hint">
						Relative to the workspace root — for monorepos. A ticket that has an environment is
						scanned in its worktree instead.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scanSources">
						Sources and exclusions
					</label>
					<div className="settings-input-row">
						<input
							id="scanSources"
							className="settings-input"
							type="text"
							spellCheck={false}
							value={settings.scan?.sources ?? ''}
							placeholder="sonar.sources"
							onChange={(event) => updateScan({ sources: event.target.value })}
						/>
						<input
							id="scanExclusions"
							className="settings-input"
							type="text"
							spellCheck={false}
							value={settings.scan?.exclusions ?? ''}
							placeholder="sonar.exclusions"
							onChange={(event) => updateScan({ exclusions: event.target.value })}
						/>
					</div>
					<p className="settings-hint">
						Sent only when set, so a committed <code>sonar-project.properties</code> keeps its
						own values.
					</p>
				</div>

				<div className="settings-field">
					<div className="settings-row">
						<label className="settings-label">Analysis properties</label>
						<button
							type="button"
							className="settings-button secondary"
							onClick={() => updateScanProperties([...scanProperties, { key: '', value: '' }])}
						>
							Add property…
						</button>
					</div>
					{scanProperties.map((property, index) => (
						<div className="settings-input-row" key={index}>
							<input
								className="settings-input"
								type="text"
								spellCheck={false}
								value={property.key}
								placeholder="sonar.something"
								onChange={(event) =>
									updateScanProperties(
										scanProperties.map((row, at) =>
											at === index ? { ...row, key: event.target.value } : row
										)
									)
								}
							/>
							<input
								className="settings-input"
								type="text"
								spellCheck={false}
								value={property.value}
								placeholder="value"
								onChange={(event) =>
									updateScanProperties(
										scanProperties.map((row, at) =>
											at === index ? { ...row, value: event.target.value } : row
										)
									)
								}
							/>
							<button
								type="button"
								className="settings-button secondary"
								onClick={() =>
									updateScanProperties(scanProperties.filter((_, at) => at !== index))
								}
							>
								Remove
							</button>
						</div>
					))}
					<p className="settings-hint">
						Extra <code>-D</code> flags for the analysis. Anything reading like a credential is
						refused — this file is committed to git — as are the four BFAST sets itself.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scannerMode">
						Scanner
					</label>
					<select
						id="scannerMode"
						className="settings-input"
						value={settings.scan?.scannerMode ?? DEFAULT_SCANNER_MODE}
						onChange={(event) =>
							updateScan({ scannerMode: event.target.value as ScannerMode })
						}
					>
						{SCANNER_MODES.map((id) => (
							<option key={id} value={id}>
								{SCANNER_MODE_LABEL[id]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						The image needs only the Docker you already have. Write your own line for a
						build-integrated scanner — Maven, Gradle, dotnet.
					</p>
				</div>

				<div className="settings-field" hidden={currentScannerMode !== 'docker'}>
					<label className="settings-label" htmlFor="scannerImage">
						Scanner image
					</label>
					<div className="settings-input-row">
						<input
							id="scannerImage"
							className="settings-input"
							type="text"
							spellCheck={false}
							value={settings.scan?.scannerImage ?? ''}
							placeholder={DEFAULT_SCANNER_IMAGE}
							onChange={(event) => updateScan({ scannerImage: event.target.value })}
						/>
						<input
							id="scannerNetwork"
							className="settings-input settings-input-compact"
							type="text"
							spellCheck={false}
							value={settings.scan?.scannerNetwork ?? ''}
							placeholder="network"
							onChange={(event) => updateScan({ scannerNetwork: event.target.value })}
						/>
					</div>
					<p className="settings-hint">
						Pin a tag if you need one. The network is the escape hatch for an external server
						bound to loopback on Linux — set it to <code>host</code>.
					</p>
				</div>

				<div className="settings-field" hidden={currentScannerMode !== 'command'}>
					<label className="settings-label" htmlFor="scanCommand">
						Scan command
					</label>
					<input
						id="scanCommand"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.command ?? ''}
						placeholder="e.g. mvn sonar:sonar -Dsonar.projectKey={{projectKey}}"
						onChange={(event) => updateScan({ command: event.target.value })}
					/>
					<p className="settings-hint">
						With <code>{'{{projectKey}}'}</code>, <code>{'{{hostUrl}}'}</code>,{' '}
						<code>{'{{folder}}'}</code>, <code>{'{{id}}'}</code> and <code>{'{{key}}'}</code>{' '}
						substituted. The token reaches your line as <code>$SONAR_TOKEN</code> — there is no{' '}
						<code>{'{{token}}'}</code>, because a secret in a shell line lands in the process
						table and the log.
					</p>
					{strayScanPlaceholders.length > 0 && (
						<p className="settings-hint">
							⚠ {strayScanPlaceholders.map((token) => `{{${token}}}`).join(', ')}{' '}
							{strayScanPlaceholders.length === 1 ? 'is' : 'are'} not substituted and will reach
							the shell as written.
						</p>
					)}
				</div>

				<div className="settings-field" hidden={currentScanMode !== 'auto'}>
					<label className="settings-label" htmlFor="scanComposeFile">
						Compose file
					</label>
					<input
						id="scanComposeFile"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.scan?.composeFile ?? ''}
						placeholder="the file BFAST ships"
						onChange={(event) => updateScan({ composeFile: event.target.value })}
					/>
					<p className="settings-hint">
						Replaces BFAST's own stack definition. It must satisfy the contract in{' '}
						<code>docs/scan/sonarqube.md</code>.
					</p>
				</div>

				<div className="settings-field" hidden={currentScanMode !== 'auto'}>
					<label className="settings-label" htmlFor="scanPortRangeStart">
						Port range
					</label>
					<div className="settings-input-row">
						<input
							id="scanPortRangeStart"
							className="settings-input settings-input-compact"
							type="number"
							min={MIN_SCAN_PORT}
							max={MAX_SCAN_PORT}
							value={settings.scan?.portRangeStart ?? ''}
							placeholder={String(DEFAULT_SCAN_PORT_RANGE_START)}
							onChange={(event) =>
								updateScan({
									portRangeStart:
										event.target.value === '' ? undefined : Number(event.target.value)
								})
							}
						/>
						<input
							id="scanPortRangeEnd"
							className="settings-input settings-input-compact"
							type="number"
							min={MIN_SCAN_PORT}
							max={MAX_SCAN_PORT}
							value={settings.scan?.portRangeEnd ?? ''}
							placeholder={String(DEFAULT_SCAN_PORT_RANGE_END)}
							onChange={(event) =>
								updateScan({
									portRangeEnd:
										event.target.value === '' ? undefined : Number(event.target.value)
								})
							}
						/>
					</div>
					<p className="settings-hint">
						Where the deployed server's host port comes from.
					</p>
				</div>

				<div className="settings-field" hidden={currentScanMode !== 'auto'}>
					<label className="settings-label" htmlFor="scanAutoProvision">
						<input
							id="scanAutoProvision"
							type="checkbox"
							checked={settings.scan?.autoProvision ?? true}
							onChange={(event) =>
								// Only `false` is ever stored: `true` is the default, and writing
								// it would create a `scan` block in a file that has none.
								updateScan({ autoProvision: event.target.checked ? undefined : false })
							}
						/>{' '}
						Generate credentials automatically
					</label>
					<p className="settings-hint">
						BFAST changes the factory <code>admin</code> password to a generated one and mints
						the tokens a scan needs. Turn it off to manage the instance yourself and supply a
						token with <strong>BFAST: Set SonarQube Token</strong>.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="scanIdleTimeout">
						Idle timeout <span className="generate-optional">seconds</span>
					</label>
					<input
						id="scanIdleTimeout"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_SCAN_IDLE_SECONDS}
						max={MAX_SCAN_IDLE_SECONDS}
						value={settings.scan?.idleTimeout ?? ''}
						placeholder={String(DEFAULT_SCAN_IDLE_SECONDS)}
						onChange={(event) =>
							updateScan({
								idleTimeout:
									event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						How long a scan or a server boot may produce no output at all before it is stopped.
						A first boot that keeps printing is never stopped — only silence counts.
					</p>
				</div>

				<p className="settings-hint">
					No token is ever stored here — this file is committed to git. Run{' '}
					<strong>BFAST: Set SonarQube Token</strong> from the command palette instead, or use
					the credential row in the <strong>Code Quality</strong> section.
				</p>
				{scanError && <p className="settings-error">{scanError}</p>}
		</div>
	);
}
