// Run Tests: the command template, where it runs, evidence and limits.

import {
	DEFAULT_TEST_RESULTS_FOLDER,
	DEFAULT_TEST_CONCURRENCY,
	DEFAULT_TEST_IDLE_SECONDS,
	MAX_TEST_CONCURRENCY,
	MAX_TEST_IDLE_SECONDS,
	MIN_TEST_CONCURRENCY,
	MIN_TEST_IDLE_SECONDS
} from '../../../settings/testsSettings';
import {
	DEFAULT_TRACE_FRAME_SOURCE,
	TRACE_FRAME_SOURCES,
	type TraceFrameSource
} from '../../../shared/playwrightTrace';
import { ServicesSection } from './ServicesSection';
import { TRACE_FRAME_SOURCE_LABEL } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function TestsTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const {
		settings,
		testsError,
		strayPlaceholders,
		strayEvidencePlaceholders,
		strayEvidenceCommandPlaceholders,
		updateTests,
	} = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<div className="settings-field">
					<label className="settings-label" htmlFor="testsCommand">
						Test command
					</label>
					<input
						id="testsCommand"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.command ?? ''}
						placeholder="e.g. npm test -- --grep {{id}}"
						onChange={(event) => updateTests({ command: event.target.value })}
					/>
					<p className="settings-hint">
						Run once per test case when Run Tests is picked on a ticket, with{' '}
						<code>{'{{id}}'}</code>, <code>{'{{key}}'}</code> and <code>{'{{folder}}'}</code>{' '}
						substituted from the test-case ticket. BFAST runs exactly what this says — the file
						is committed, so review it like <code>tasks.json</code>. Empty means the feature is
						off.
					</p>
					{strayPlaceholders.length > 0 && (
						<p className="settings-hint">
							⚠ {strayPlaceholders.map((token) => `{{${token}}}`).join(', ')}{' '}
							{strayPlaceholders.length === 1 ? 'is' : 'are'} not substituted and will reach the
							shell as written.
						</p>
					)}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsCwd">
						Working directory
					</label>
					<input
						id="testsCwd"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.cwd ?? ''}
						placeholder="workspace root"
						onChange={(event) => updateTests({ cwd: event.target.value })}
					/>
					<p className="settings-hint">
						Where every test command runs, relative to the workspace root — for monorepos.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsResultsFolder">
						Results folder
					</label>
					<input
						id="testsResultsFolder"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.resultsFolder ?? ''}
						placeholder={DEFAULT_TEST_RESULTS_FOLDER}
						onChange={(event) => updateTests({ resultsFolder: event.target.value })}
					/>
					<p className="settings-hint">
						Where every run is filed, relative to the workspace root: one folder per test
						case, one per run inside it — the command's output, its record and the evidence
						files. Outside the tracker, so a run never touches a ticket's history; commit it
						or gitignore it as the team prefers.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsEvidence">
						Evidence files <span className="generate-optional">optional</span>
					</label>
					<input
						id="testsEvidence"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.evidence ?? ''}
						placeholder="e.g. e2e/evidence/**/{{id}}.*"
						onChange={(event) => updateTests({ evidence: event.target.value })}
					/>
					<p className="settings-hint">
						A glob, relative to the working directory, for what the test tool leaves behind
						for one test case — a video, a trace — with <code>{'{{id}}'}</code> or{' '}
						<code>{'{{key}}'}</code> substituted. Every match written during the run is copied
						into the test case's run folder under the results folder and shown on its board. If your
						test tool clears its output folder when a run starts (Playwright reporters often
						do), keep Tests at once at 1.
					</p>
					{strayEvidencePlaceholders.length > 0 && (
						<p className="settings-hint">
							⚠ {strayEvidencePlaceholders.map((token) => `{{${token}}}`).join(', ')}{' '}
							{strayEvidencePlaceholders.length === 1 ? 'is' : 'are'} not substituted in a pattern
							— only <code>{'{{id}}'}</code> and <code>{'{{key}}'}</code> are.
						</p>
					)}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsEvidenceCommand">
						Open evidence with <span className="generate-optional">optional</span>
					</label>
					<input
						id="testsEvidenceCommand"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.evidenceCommand ?? ''}
						placeholder="e.g. npx playwright show-trace {{file}}"
						onChange={(event) => updateTests({ evidenceCommand: event.target.value })}
					/>
					<p className="settings-hint">
						Run by the board's Open in Playwright Trace Viewer, and by Open for any other file
						it cannot show inline. <code>{'{{file}}'}</code> is the file's path, already quoted
						for the shell — do not add quotes. Empty means a trace opens with the Playwright
						installed in the workspace, and any other file is revealed in the file manager.
					</p>
					{strayEvidenceCommandPlaceholders.length > 0 && (
						<p className="settings-hint">
							⚠ {strayEvidenceCommandPlaceholders.map((token) => `{{${token}}}`).join(', ')}{' '}
							{strayEvidenceCommandPlaceholders.length === 1 ? 'is' : 'are'} not substituted here
							— only <code>{'{{file}}'}</code> is.
						</p>
					)}
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsTraceFrames">
						Trace screenshots
					</label>
					<select
						id="testsTraceFrames"
						className="settings-input"
						value={settings.tests?.traceFrames ?? DEFAULT_TRACE_FRAME_SOURCE}
						onChange={(event) => {
							const source = event.target.value as TraceFrameSource;
							updateTests({ traceFrames: source === DEFAULT_TRACE_FRAME_SOURCE ? undefined : source });
						}}
					>
						{TRACE_FRAME_SOURCES.map((source) => (
							<option key={source} value={source}>
								{TRACE_FRAME_SOURCE_LABEL[source]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						Where the board's trace viewer takes a trace's screenshots from. Playwright moved them
						in trace format 9: up to format 8 a frame is <code>resources/&lt;sha1&gt;</code>, from
						9 it is the <code>screencast/…</code> file the frame names. Auto reads each trace by its
						own format; pick one layout only for a trace that is wrong about it.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsConcurrency">
						Tests at once
					</label>
					<input
						id="testsConcurrency"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_TEST_CONCURRENCY}
						max={MAX_TEST_CONCURRENCY}
						value={settings.tests?.concurrency ?? ''}
						placeholder={String(DEFAULT_TEST_CONCURRENCY)}
						onChange={(event) =>
							updateTests({
								concurrency:
									event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						How many test commands run in parallel. Sequential by default on purpose: parallel
						runs sharing one database corrupt each other — raise it only when the tests are
						isolated.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsIdleTimeout">
						Idle timeout <span className="generate-optional">seconds</span>
					</label>
					<input
						id="testsIdleTimeout"
						className="settings-input settings-input-compact"
						type="number"
						min={MIN_TEST_IDLE_SECONDS}
						max={MAX_TEST_IDLE_SECONDS}
						value={settings.tests?.idleTimeout ?? ''}
						placeholder={String(DEFAULT_TEST_IDLE_SECONDS)}
						onChange={(event) =>
							updateTests({
								idleTimeout:
									event.target.value === '' ? undefined : Number(event.target.value)
							})
						}
					/>
					<p className="settings-hint">
						How long a run may produce no output at all before it is stopped and recorded as a
						failure. A suite that keeps printing is never stopped — only silence counts.
					</p>
				</div>

				<div className="settings-field">
					<label className="settings-label" htmlFor="testsCoverage">
						Project e2e coverage
					</label>
					<input
						id="testsCoverage"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.tests?.coverage ?? ''}
						placeholder="coverage/e2e/lcov.info"
						onChange={(event) => updateTests({ coverage: event.target.value || undefined })}
					/>
					<p className="settings-hint">
						An lcov file the test command above writes, relative to the working directory — one of
						the sources of the project’s merged coverage.
					</p>
				</div>

				<ServicesSection form={form} />

				{testsError && <p className="settings-error">{testsError}</p>}
		</div>
	);
}
