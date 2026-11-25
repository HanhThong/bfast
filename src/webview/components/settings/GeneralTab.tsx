// The tracker folder, the author name, and the commit message template.

import { DEFAULT_TRACKER_FOLDER } from '../../../settings/bfastSettings';
import { COMMIT_MESSAGE_TOKENS, DEFAULT_COMMIT_MESSAGE } from '../../../settings/gitSettings';
import { postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function GeneralTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const { settings, folderError, nameError, gitError, strayCommitPlaceholders, update, updateGit } =
		form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
			<div className="settings-field">
				<label className="settings-label" htmlFor="trackerFolder">
					Tracker store folder
				</label>
				<div className="settings-input-row">
					<input
						id="trackerFolder"
						className="settings-input"
						type="text"
						spellCheck={false}
						value={settings.trackerFolder}
						placeholder={DEFAULT_TRACKER_FOLDER}
						onChange={(event) => update({ trackerFolder: event.target.value })}
					/>
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => postMessage({ type: 'pickTrackerFolder' })}
					>
						Browse…
					</button>
				</div>
				<p className="settings-hint">
					Where the tickets live, relative to the workspace root. Created if it does not exist.
				</p>
				{folderError && <p className="settings-error">{folderError}</p>}
		</div>

		<div className="settings-field">
			<label className="settings-label" htmlFor="userName">
				Your name
			</label>
			<input
				id="userName"
				className="settings-input"
				type="text"
				value={settings.userName}
				placeholder="e.g. Hanh Thong"
				onChange={(event) => update({ userName: event.target.value })}
			/>
			<p className="settings-hint">Shown as the author on ticket history entries.</p>
			{nameError && <p className="settings-error">{nameError}</p>}
		</div>

		<div className="settings-field">
			<label className="settings-label" htmlFor="commitMessage">
				Commit message
			</label>
			<input
				id="commitMessage"
				className="settings-input"
				type="text"
				spellCheck={false}
				value={settings.git?.commitMessage ?? ''}
				placeholder={DEFAULT_COMMIT_MESSAGE}
				onChange={(event) => updateGit({ commitMessage: event.target.value })}
			/>
			<p className="settings-hint">
				Pre-filled by <strong>Commit Ticket…</strong> (right-click a ticket), and editable before
				the commit. Placeholders:{' '}
				{COMMIT_MESSAGE_TOKENS.map((token) => `{{${token}}}`).join(', ')}.
			</p>
			{strayCommitPlaceholders.length > 0 && (
				<p className="settings-hint">
					Not a placeholder, left as written:{' '}
					{strayCommitPlaceholders.map((token) => `{{${token}}}`).join(', ')}
				</p>
			)}
			{gitError && <p className="settings-error">{gitError}</p>}
		</div>

		</div>
	);
}
