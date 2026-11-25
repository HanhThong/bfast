// What a board asks the host to do with a test run's evidence.
//
// `openEvidence` for a file the board cannot show, `readEvidenceVideo` for a
// video the webview's own loader could not deliver, `readTrace` /
// `readTraceFrame` for a Playwright trace shown inline and `openTraceViewer`
// for the same trace in Playwright's own viewer. All go through
// `resolveEvidenceTarget`, which is where a name that arrived from git is
// checked before it reaches a path, a shell line or a read — against the
// results store, where runs live, never the tracker.
//
// Here rather than beside the Run Tests command because the board is what
// calls it: the sidebar's command never touches an evidence file.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { runProcess, type ProcessRunner } from '../platform/runProcess';
import { substituteCommand, testsCwd, testsEvidenceCommand, type TestsSettings } from '../settings/testsSettings';
import { isSafeEvidenceSegment } from '../shared/evidencePath';
import { videoMime } from '../shared/mediaError';
import { quoteShellArgument, shellCommand } from '../platform/shellCommand';
import { testCaseResultsFolder } from './testResultsPaths';
import { convertToVp8 } from './videoConvert';
import type { TestResultsStore } from './testResultsStore';
import { evidenceKind, formatBytes, MAX_EVIDENCE_FILE_BYTES } from './testReport';
import type { TraceFrameResult, TraceReader, TraceReadResult } from './traceReader';
import type { TraceViewerLauncher } from './traceViewerLauncher';
import { errorMessage } from '../platform/errors';

/** What `openEvidence` and the trace routes need — a subset of the services, so the board can be handed it alone. */
export interface EvidenceServices {
	/** Where runs are filed; what an evidence name is resolved against. */
	results: TestResultsStore;
	/** Read at call time, never captured — the settings may change between runs. */
	tests: () => TestsSettings | undefined;
	/** Where a relative `tests.cwd` resolves from. */
	workspaceRoot: () => string | undefined;
	/** The "BFAST Tests" channel. */
	output: vscode.OutputChannel;
	/** Injection seam for the evidence command; absent means the real `runProcess`. */
	runner?: ProcessRunner;
	/** Reads a `trace.zip` for the board. */
	traces: TraceReader;
	/** Runs the workspace's Playwright when no `tests.evidenceCommand` is set. */
	traceViewer: TraceViewerLauncher;
}

/**
 * Where an evidence name points, once it has been checked: the segments must
 * be ones BFAST would have written itself, and the real path must sit under
 * the test case's folder in the results store. The root is the *results
 * folder's* real path plus the test case's segment — never the real path of
 * the test case folder itself, which a committed symlink would resolve
 * elsewhere and so pass its own containment check.
 */
async function resolveEvidenceTarget(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file?: string
): Promise<{ target: string } | { error: string }> {
	if (!isSafeEvidenceSegment(run) || (file !== undefined && !isSafeEvidenceSegment(file))) {
		return { error: 'BFAST will not open that: the name is not one it would have written itself.' };
	}

	const root = services.results.rootUri();
	if (!root) {
		return { error: 'Open a workspace folder to open evidence.' };
	}
	const segment = testCaseResultsFolder(ticketId);
	const evidenceRoot = path.join(root.fsPath, segment);
	const requested =
		file === undefined ? path.join(evidenceRoot, run) : path.join(evidenceRoot, run, file);

	let realRoot: string;
	let target: string;
	try {
		[realRoot, target] = await Promise.all([
			fs.realpath(root.fsPath).then((real) => path.join(real, segment)),
			fs.realpath(requested)
		]);
	} catch {
		return { error: `BFAST could not find ${file ?? run} in ${ticketId}'s test results.` };
	}
	if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
		return { error: `BFAST will not open \`${file ?? run}\` — it is outside the test case's results folder.` };
	}
	return { target };
}

/**
 * Opens one evidence file, or reveals the run folder when `file` is absent.
 * Text opens in an editor tab; a video or an image in VS Code's own media
 * preview; a zip in Playwright's trace viewer (`openTraceViewer`); anything
 * else through `tests.evidenceCommand`, or the file manager when none is
 * configured.
 */
export async function openEvidence(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file?: string
): Promise<void> {
	const resolved = await resolveEvidenceTarget(services, ticketId, run, file);
	if ('error' in resolved) {
		void vscode.window.showWarningMessage(resolved.error);
		return;
	}
	const target = resolved.target;

	if (file === undefined) {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
		return;
	}

	const kind = evidenceKind(file);
	if (kind === 'text') {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
			await vscode.window.showTextDocument(document, { preview: false });
		} catch {
			void vscode.window.showWarningMessage(`BFAST could not open \`${file}\`.`);
		}
		return;
	}
	if (kind === 'video' || kind === 'image') {
		// VS Code's own media preview — an editor tab, which plays a video over a
		// remote connection too. The board's inline player is the first choice;
		// this is the one that cannot depend on the webview's media pipeline.
		try {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
		} catch {
			void vscode.window.showWarningMessage(`BFAST could not open \`${file}\`.`);
		}
		return;
	}

	if (kind === 'archive') {
		await openTraceTarget(services, target);
		return;
	}

	const command = testsEvidenceCommand(services.tests());
	if (command === undefined) {
		await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
		return;
	}
	runEvidenceCommand(services, command, target);
}

/**
 * The trace in Playwright's own viewer. A configured `tests.evidenceCommand`
 * always wins — a line the user typed is never replaced by a guess; otherwise
 * the launcher finds the workspace's Playwright, and says so when there is none.
 */
export async function openTraceViewer(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file: string
): Promise<void> {
	const resolved = await resolveEvidenceTarget(services, ticketId, run, file);
	if ('error' in resolved) {
		void vscode.window.showWarningMessage(resolved.error);
		return;
	}
	await openTraceTarget(services, resolved.target);
}

async function openTraceTarget(services: EvidenceServices, target: string): Promise<void> {
	const command = testsEvidenceCommand(services.tests());
	if (command !== undefined) {
		runEvidenceCommand(services, command, target);
		return;
	}
	const outcome = await services.traceViewer.open(target);
	switch (outcome.kind) {
		case 'opened':
		case 'reused':
			return;
		case 'not-found': {
			const choice = await vscode.window.showWarningMessage(
				'Playwright was not found under `node_modules` in the workspace (or under `tests.cwd`). Install it, or set "Open evidence with" in the settings to a viewer command.',
				'Open Settings'
			);
			if (choice === 'Open Settings') {
				void vscode.commands.executeCommand('bfast.openSettings');
			}
			return;
		}
		case 'failed': {
			const choice = await vscode.window.showWarningMessage(
				`BFAST could not open the trace viewer: ${outcome.message}`,
				'Show Log'
			);
			if (choice === 'Show Log') {
				services.output.show(true);
			}
			return;
		}
	}
}

/**
 * The board's inline trace: the archive read on the host and reduced to a
 * `TraceReport`. Same gate as every other evidence route; the reader confirms
 * the zip is a trace and says `notATrace` when it is not, so the row can fall
 * back to Open / Reveal without a dialog.
 */
export async function readTrace(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file: string
): Promise<TraceReadResult> {
	const resolved = await resolveEvidenceTarget(services, ticketId, run, file);
	if ('error' in resolved) {
		return { error: resolved.error };
	}
	if (evidenceKind(file) !== 'archive') {
		return { error: `${file} is not a zip archive.` };
	}
	const result = await services.traces.readReport(resolved.target);
	if ('error' in result) {
		services.output.appendLine(`— Could not read ${file} as a trace for ${ticketId}'s board: ${result.error}`);
	}
	return result;
}

/** One screencast frame of that trace, by a name the report listed — the reader is the allow-list. */
export async function readTraceFrame(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file: string,
	frame: string
): Promise<TraceFrameResult> {
	const resolved = await resolveEvidenceTarget(services, ticketId, run, file);
	if ('error' in resolved) {
		return { error: resolved.error };
	}
	if (evidenceKind(file) !== 'archive' || frame.includes('/') || frame.includes('\\') || frame.startsWith('.')) {
		return { error: `BFAST will not read \`${frame}\` from ${file}.` };
	}
	return services.traces.readFrame(resolved.target, frame);
}

/**
 * A source location a trace named, in an editor at that line. The path is
 * the recording machine's: when it is not on this one, its trailing segments
 * are tried under each workspace folder, longest first, so a trace from CI
 * still lands on the spec file here. Read-only — a `file:` open and nothing
 * else.
 */
export async function openTraceSource(file: string, line: number, column?: number): Promise<void> {
	const target = await resolveSourceFile(file);
	if (target === undefined) {
		void vscode.window.showWarningMessage(`BFAST could not find \`${file}\` in this workspace.`);
		return;
	}
	const row = Math.max(0, Math.floor(line) - 1);
	const col = Math.max(0, Math.floor(column ?? 1) - 1);
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
		const position = new vscode.Position(Math.min(row, Math.max(0, document.lineCount - 1)), col);
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(position, position)
		});
	} catch {
		void vscode.window.showWarningMessage(`BFAST could not open \`${target}\`.`);
	}
}

/** Most trailing path segments tried under a workspace folder. */
const MAX_SOURCE_SUFFIX_SEGMENTS = 6;

async function resolveSourceFile(file: string): Promise<string | undefined> {
	if (!Number.isFinite(file.length) || file.length === 0 || file.length > 4096) {
		return undefined;
	}
	if (path.isAbsolute(file) && (await isFile(file))) {
		return file;
	}
	const segments = file.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '..' && segment !== '.');
	const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
	for (let take = Math.min(MAX_SOURCE_SUFFIX_SEGMENTS, segments.length); take >= 1; take--) {
		const suffix = segments.slice(segments.length - take);
		for (const folder of folders) {
			const candidate = path.join(folder, ...suffix);
			if (await isFile(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

async function isFile(candidate: string): Promise<boolean> {
	try {
		return (await fs.stat(candidate)).isFile();
	} catch {
		return false;
	}
}

/**
 * The bytes of one evidence video, for the board's fallback player — the
 * route the board takes when the webview's own resource loader handed the
 * `<video>` nothing it could demux, which happens over some remote
 * connections. Same checks as `openEvidence`, then a read capped at what the
 * runner would have copied in the first place; base64, since a webview may
 * only be posted json-serializable values (the `insertImage` convention).
 *
 * `convert` is the last route: the editor has no decoder for the recording
 * (VS Code on Windows and VP9, which Playwright records from 1.65), so the
 * file is re-encoded as VP8 WebM by `ffmpeg` on this machine first — see
 * `videoConvert.ts`. Nothing is written beside the original.
 */
export async function readEvidenceVideo(
	services: EvidenceServices,
	ticketId: string,
	run: string,
	file: string,
	convert = false
): Promise<{ data: string; mime: string } | { error: string }> {
	const refuse = (error: string): { error: string } => {
		services.output.appendLine(`— Could not serve ${file} to ${ticketId}'s board: ${error}`);
		return { error };
	};
	const resolved = await resolveEvidenceTarget(services, ticketId, run, file);
	if ('error' in resolved) {
		return refuse(resolved.error);
	}
	if (evidenceKind(file) !== 'video') {
		return refuse(`${file} is not a video.`);
	}
	try {
		const stat = await fs.stat(resolved.target);
		if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
			return refuse(
				`The file is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over what the board loads directly. Open it in the editor instead.`
			);
		}
		if (convert) {
			services.output.appendLine(
				`— Converting ${file} (${formatBytes(stat.size)}) to VP8 with ffmpeg for ${ticketId}'s board: the editor has no decoder for it.`
			);
			const converted = await convertToVp8(resolved.target, services.runner ?? runProcess);
			if (converted.length > MAX_EVIDENCE_FILE_BYTES) {
				return refuse(
					`The converted file is ${(converted.length / 1024 / 1024).toFixed(1)} MB, over what the board loads directly.`
				);
			}
			services.output.appendLine(`— Serving ${file} converted to VP8 (${formatBytes(converted.length)}).`);
			return { data: converted.toString('base64'), mime: 'video/webm' };
		}
		const bytes = await fs.readFile(resolved.target);
		// The line that says the inline player took the bytes route — the only
		// trace of it outside the board, which is what a bug report can quote.
		services.output.appendLine(
			`— Serving ${file} (${formatBytes(stat.size)}) to ${ticketId}'s board directly: the webview's own loader could not play it.`
		);
		return { data: bytes.toString('base64'), mime: videoMime(file) };
	} catch (error) {
		return refuse(errorMessage(error));
	}
}

/**
 * Runs `tests.evidenceCommand` for one file, the way `tests.command` runs:
 * through the platform shell wrap, in the tests working directory, tree-killed
 * if it ever has to be — and never typed into a terminal, whose shell BFAST
 * does not know. `{{file}}` is substituted with the path already quoted for
 * that shell. No idle window: a trace viewer is silent until its window closes.
 */
export function runEvidenceCommand(
	services: EvidenceServices,
	command: string,
	target: string
): void {
	const root = services.workspaceRoot();
	if (root === undefined) {
		void vscode.window.showWarningMessage('Open a workspace folder to open evidence.');
		return;
	}
	let quoted: string;
	try {
		quoted = quoteShellArgument(target, process.platform);
	} catch (error) {
		void vscode.window.showWarningMessage(errorMessage(error));
		return;
	}
	const line = substituteCommand(command, { file: quoted });
	const relativeCwd = testsCwd(services.tests());
	const cwd = relativeCwd === undefined ? root : path.join(root, relativeCwd);
	const name = path.basename(target);

	services.output.appendLine(`— Opening ${name}: ${line}`);
	const shell = shellCommand(line, process.platform);
	const run = (services.runner ?? runProcess)({
		executable: shell.executable,
		args: shell.args,
		...(shell.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
		cwd,
		killTree: true,
		onOutput: (text) => services.output.append(text)
	});
	run.completed.then(
		() => services.output.appendLine(`— ${name}: viewer closed.`),
		(error: unknown) =>
			services.output.appendLine(
				`— ${name}: ${errorMessage(error)}`
			)
	);
}
