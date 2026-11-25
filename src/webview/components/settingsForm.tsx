// The settings form: a frame around one tab per block of `bfast.json`.
//
// The state is `useSettingsForm`'s — one `BfastSettings` object, saved whole —
// and each tab in `settings/` is a view of it. Adding a tab is a component
// there and a row in `SETTINGS_TABS`.

import type { ComponentType } from 'react';
import { SETTINGS_FILE } from '../../settings/bfastSettings';
import { AiTab } from './settings/AiTab';
import { DesignTab } from './settings/DesignTab';
import { EnvironmentsTab } from './settings/EnvironmentsTab';
import { GeneralTab } from './settings/GeneralTab';
import { ImplementTab } from './settings/ImplementTab';
import { McpTab } from './settings/McpTab';
import { ScanTab } from './settings/ScanTab';
import { postMessage, type SettingsTab } from './settings/shared';
import { TestsTab } from './settings/TestsTab';
import { useSettingsForm, type SettingsFormState } from './settings/useSettingsForm';

/** The tabs, in the order the tab bar shows them. */
const SETTINGS_TABS: readonly {
	id: SettingsTab;
	label: string;
	Component: ComponentType<{ form: SettingsFormState; hidden: boolean }>;
}[] = [
	{ id: 'general', label: 'General', Component: GeneralTab },
	{ id: 'ai', label: 'AI assistant', Component: AiTab },
	{ id: 'design', label: 'Design', Component: DesignTab },
	{ id: 'environments', label: 'Environments', Component: EnvironmentsTab },
	{ id: 'tests', label: 'Tests', Component: TestsTab },
	{ id: 'scan', label: 'Scan', Component: ScanTab },
	{ id: 'implement', label: 'Implement', Component: ImplementTab },
	{ id: 'mcp', label: 'MCP server', Component: McpTab },
];

export function SettingsForm() {
	const form = useSettingsForm();
	const { configured, tab, setTab, saved, error, canSave, save, version } = form;

	return (
		<form
			className="settings"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<header className="settings-header">
				<h1 className="settings-title">BFAST settings</h1>
				<p className="settings-subtitle">
					{configured
						? `Saved in ${SETTINGS_FILE} in this workspace.`
						: `Not configured yet — saving writes ${SETTINGS_FILE} in this workspace.`}
				</p>
			</header>

			<nav className="tabs" role="tablist">
				{SETTINGS_TABS.map(({ id, label }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						className={tab === id ? 'tab active' : 'tab'}
						onClick={() => setTab(id)}
					>
						{label}
					</button>
				))}
			</nav>

			{/* Every panel stays mounted and all but one are hidden, rather than only
			    the selected one being rendered: the form is a single `settings` object
			    and Save writes all of it, so switching tabs must not look like it
			    discarded what was typed on the other. */}
			{SETTINGS_TABS.map(({ id, Component }) => (
				<Component key={id} form={form} hidden={tab !== id} />
			))}

			{saved && <p className="settings-hint settings-saved">Settings saved.</p>}
			{error && <p className="settings-error settings-error-banner">{error}</p>}

			<div className="settings-actions">
				{/* Which BFAST this is, for anyone reporting a problem — the Extensions
				    view says it too, but this is where people already are. */}
				{version && <span className="settings-hint settings-version">BFAST v{version}</span>}
				<button
					type="button"
					className="settings-button secondary"
					onClick={() => postMessage({ type: 'cancelSettings' })}
				>
					Cancel
				</button>
				<button type="submit" className="settings-button" disabled={!canSave}>
					Save
				</button>
			</div>
		</form>
	);
}
