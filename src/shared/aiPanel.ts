// The board's AI assistant panel: what pressing its button does to the panel
// and to the instruction box.
//
// Bundled into the webview, so no `vscode` and no `node:` import — and out of
// `app.tsx`, because the webview has no DOM test runner: the rule lives here so
// `aiPanel.test.ts` can hold it, the `mediaError.ts` precedent.
//
// The box is emptied on open rather than on close. What was typed belongs to
// the run it was typed for, and the panel is closed by a finished run as much
// as by the user, so a reopen would otherwise offer last time's instruction to
// a ticket that has since been rewritten with it. While a run is going the box
// is disabled and shows what that run was asked, so it is left alone: the text
// on screen has to be the text the run has.

export interface AiPanelState {
	/** Whether the panel is on screen. */
	open: boolean;
	/** What the instruction box holds. */
	instruction: string;
}

/**
 * The state after the AI Assistant button, or the panel's own Close, is
 * pressed, given whether a run is in flight.
 */
export function toggleAiPanel(state: AiPanelState, running: boolean): AiPanelState {
	if (state.open) {
		return { open: false, instruction: state.instruction };
	}
	return { open: true, instruction: running ? state.instruction : '' };
}
