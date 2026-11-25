// Design styles, as the skills that draw them — nothing here is written to `bfast.json`.

import { DesignStylesPanel } from '../designStyles';
import type { SettingsFormState } from './useSettingsForm';

export function DesignTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const { agents } = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
			<DesignStylesPanel agents={agents} />
		</div>
	);
}
