// A long operation's progress, written to an output channel.

import type * as vscode from 'vscode';

/** The progress shape the environment and scan seams share. */
type Progress = { kind: 'phase'; label: string } | { kind: 'output'; text: string };

/**
 * A progress listener that appends a child's raw output as it arrives and
 * marks each phase with a `— …` line, so a log reads as steps with their
 * output under them.
 */
export function outputProgress(channel: vscode.OutputChannel): (progress: Progress) => void {
	return (progress) => {
		if (progress.kind === 'output') {
			channel.append(progress.text);
		} else {
			channel.appendLine(`— ${progress.label}`);
		}
	};
}
