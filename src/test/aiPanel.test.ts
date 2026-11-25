import * as assert from 'assert';
import { toggleAiPanel } from '../shared/aiPanel';

suite('AI assistant panel', () => {
	// The bug this pins: the box used to keep whatever the last run was asked,
	// so a reopen offered it again to a ticket already rewritten with it.
	test('opening the panel starts with an empty instruction box', () => {
		const opened = toggleAiPanel({ open: false, instruction: 'Focus on the error copy' }, false);
		assert.deepStrictEqual(opened, { open: true, instruction: '' });
	});

	test('closing leaves the text alone, and it is the next open that empties it', () => {
		const closed = toggleAiPanel({ open: true, instruction: 'Focus on the error copy' }, false);
		assert.deepStrictEqual(closed, { open: false, instruction: 'Focus on the error copy' });
		assert.deepStrictEqual(toggleAiPanel(closed, false), { open: true, instruction: '' });
	});

	// The box is disabled while a run is going and shows what that run was
	// asked; emptying it then would show a run with no instruction at all.
	test('reopening while a run is going shows what that run was asked', () => {
		const closed = toggleAiPanel({ open: true, instruction: 'Focus on the error copy' }, true);
		assert.deepStrictEqual(
			toggleAiPanel(closed, true),
			{ open: true, instruction: 'Focus on the error copy' }
		);
	});
});
