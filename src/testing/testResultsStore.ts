// The test results store: every recorded run of every test case, filed
// **outside the tracker** under `tests.resultsFolder` — see
// `testResultsPaths.ts` for the layout and why it is keyed by id.
//
// This is the other history. `history.md` inside a ticket folder records what
// changed about the ticket; a run folder here records what happened when its
// tests ran. They used to share a file — every run appended a `tested` or a
// status entry naming its evidence folder, which sat inside the ticket — and
// the ticket's history read as a test log. Now a run writes here and nothing
// else, and the one thing that still reaches `history.md` is a status the run
// changed, which *is* a change to the ticket.
//
// The `FileTicketStore` posture throughout: reading is forgiving (a folder made
// by hand, a `run.json` that is gone, a results folder that does not exist yet
// all list rather than throw), writing is strict and serialised through a
// queue, and nothing is read through a symbolic link.

import * as vscode from 'vscode';
import type { TestRunFile, TestRunRecord } from '../data/types';
import { suffixFileName } from '../data/trackerPaths';
import { evidenceFileName, testCaseResultsFolder } from './testResultsPaths';
import {
	OUTPUT_FILE,
	parseTestRun,
	RUN_FILE,
	runIdFor,
	serializeTestRun,
	type NewTestRun,
	type RunFolderEntry
} from './testRunFile';
import { errorMessage } from '../platform/errors';

/**
 * Everything the store needs from the outside world, read at call time — the
 * `TrackerContext` shape, so it can be built before settings have been read
 * and a test can point it at a scratch folder.
 */
export interface TestResultsContext {
	/** Absolute uri of the results folder, or `undefined` with no workspace open. */
	rootUri(): vscode.Uri | undefined;
	/** The author recorded in each `run.json`. */
	author(): string;
}

/** Thrown when a run is recorded before there is a workspace to file it in. */
export class TestResultsNotConfiguredError extends Error {
	constructor() {
		super('Open a workspace folder before recording a test run.');
		this.name = 'TestResultsNotConfiguredError';
	}
}

/** How many numbered siblings are tried before a name is given up on. */
const MAX_NAME_ATTEMPTS = 10;

export class TestResultsStore {
	/** Serialises writes, so two runs landing at once cannot pick the same folder. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly context: TestResultsContext) {}

	/** The results root, for a watcher; `undefined` with no workspace open. */
	rootUri(): vscode.Uri | undefined {
		return this.context.rootUri();
	}

	/**
	 * Where one test case's runs live — `<root>/<testCaseResultsFolder(id)>` —
	 * whether or not it exists yet. The board turns it into the base its
	 * evidence urls resolve against, and `openEvidence` checks a name against it.
	 */
	testCaseFolder(id: string): vscode.Uri | undefined {
		const root = this.context.rootUri();
		return root ? vscode.Uri.joinPath(root, testCaseResultsFolder(id)) : undefined;
	}

	/**
	 * Files one run: the evidence files copied in, then `output.log`, then
	 * `run.json` last — so a folder without one is a write that died, not a
	 * verdict. Creates the folders on first use. Files are copied provider-side
	 * (`workspace.fs.copy`), never read into memory.
	 *
	 * Touches nothing in the tracker: the runner's status write, when the
	 * verdict moves the ticket, is the only thing that does.
	 */
	async addRun(id: string, run: NewTestRun): Promise<TestRunRecord> {
		return this.write(async () => {
			const folder = await this.writableTestCaseFolder(id);

			// The start time names the folder; two runs starting in one millisecond
			// (a test's fake, more likely than a suite) get a numbered sibling.
			const desired = runIdFor(run.startedAt);
			let runId = desired;
			for (let attempt = 2; await this.exists(vscode.Uri.joinPath(folder, runId)); attempt++) {
				if (attempt > MAX_NAME_ATTEMPTS) {
					throw new Error(`Could not find a free run folder name for ${desired}.`);
				}
				runId = `${desired}-${attempt}`;
			}
			const target = vscode.Uri.joinPath(folder, runId);
			await vscode.workspace.fs.createDirectory(target);

			const warnings = [...(run.warnings ?? [])];
			const files: TestRunFile[] = [];
			const taken = new Set<string>([RUN_FILE, OUTPUT_FILE]);
			for (const source of run.files) {
				let name = evidenceFileName(source);
				for (let attempt = 1; taken.has(name); attempt++) {
					name = suffixFileName(evidenceFileName(source), attempt);
				}
				const copy = vscode.Uri.joinPath(target, name);
				try {
					await vscode.workspace.fs.copy(vscode.Uri.file(source), copy, { overwrite: false });
					taken.add(name);
					const size = (await vscode.workspace.fs.stat(copy)).size;
					files.push({ name, size });
				} catch (error) {
					// The reporter may still be rewriting its folder; one lost file is a
					// warning on the run, not a lost run.
					warnings.push(
						`${source} could not be copied: ${errorMessage(error)}`
					);
				}
			}

			await this.writeFile(target, OUTPUT_FILE, run.output);
			await this.writeFile(
				target,
				RUN_FILE,
				serializeTestRun({
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					outcome: run.outcome,
					exitCode: run.exitCode,
					author: this.context.author(),
					command: run.command,
					...(run.evidencePattern ? { evidencePattern: run.evidencePattern } : {}),
					files,
					...(run.outputTruncated ? { outputTruncated: true } : {}),
					...(warnings.length > 0 ? { warnings } : {})
				})
			);

			// Read back through the same parser the board uses, so what the runner
			// holds is exactly what disk says.
			return this.readRun(target, runId);
		});
	}

	/**
	 * A test case's run folders, newest first — the folder name is the start
	 * time, so a descending sort by name is a sort by time. Only the first
	 * `limit` folders are read; the rest are counted. A read, not queued: what
	 * it finds is whatever is on disk right now.
	 */
	async listRuns(
		id: string,
		limit = Number.POSITIVE_INFINITY
	): Promise<{ runs: TestRunRecord[]; total: number }> {
		const folder = await this.readableTestCaseFolder(id);
		if (!folder) {
			return { runs: [], total: 0 };
		}
		const names = (await this.readDirectory(folder))
			.filter(([, fileType]) => fileType & vscode.FileType.Directory)
			// A symlinked folder is not a run: following it could leave the store.
			.filter(([, fileType]) => !(fileType & vscode.FileType.SymbolicLink))
			.map(([name]) => name)
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

		const runs: TestRunRecord[] = [];
		for (const name of names.slice(0, Math.max(0, limit))) {
			runs.push(await this.readRun(vscode.Uri.joinPath(folder, name), name));
		}
		return { runs, total: names.length };
	}

	/** The tail of a run's `output.log`; `undefined` when the run or the file is gone. */
	async readOutput(
		id: string,
		runId: string,
		maxChars: number
	): Promise<{ text: string; truncated: boolean } | undefined> {
		const folder = await this.readableTestCaseFolder(id);
		if (!folder) {
			return undefined;
		}
		// The same posture as the listing: a symlinked run folder or log is not a run.
		const runEntry = (await this.readDirectory(folder)).find(([name]) => name === runId);
		if (!runEntry || runEntry[1] & vscode.FileType.SymbolicLink) {
			return undefined;
		}
		const run = vscode.Uri.joinPath(folder, runId);
		const logEntry = (await this.readDirectory(run)).find(([name]) => name === OUTPUT_FILE);
		if (!logEntry || logEntry[1] & vscode.FileType.SymbolicLink) {
			return undefined;
		}
		const text = await this.readFile(run, OUTPUT_FILE);
		if (text === undefined) {
			return undefined;
		}
		return text.length > maxChars
			? { text: text.slice(text.length - maxChars), truncated: true }
			: { text, truncated: false };
	}

	/**
	 * The test case's folder when it is a real directory; `undefined` when it
	 * is absent (no runs yet) or a symbolic link — the results folder may be
	 * pulled from git, and a link there would point every run's folder —
	 * listed, played, opened — somewhere else on the disk.
	 */
	private async readableTestCaseFolder(id: string): Promise<vscode.Uri | undefined> {
		const root = this.context.rootUri();
		if (!root) {
			return undefined;
		}
		const name = testCaseResultsFolder(id);
		const entry = (await this.readDirectory(root)).find(([entryName]) => entryName === name);
		if (!entry || entry[1] & vscode.FileType.SymbolicLink || !(entry[1] & vscode.FileType.Directory)) {
			return undefined;
		}
		return vscode.Uri.joinPath(root, name);
	}

	/** The same, for a write: created when absent, refused when a link. */
	private async writableTestCaseFolder(id: string): Promise<vscode.Uri> {
		const root = this.context.rootUri();
		if (!root) {
			throw new TestResultsNotConfiguredError();
		}
		const name = testCaseResultsFolder(id);
		const entry = (await this.readDirectory(root)).find(([entryName]) => entryName === name);
		if (entry && entry[1] & vscode.FileType.SymbolicLink) {
			throw new Error(`${id}'s results folder is a symbolic link; BFAST will not write through it.`);
		}
		const folder = vscode.Uri.joinPath(root, name);
		await vscode.workspace.fs.createDirectory(folder);
		return folder;
	}

	/** One run folder, read forgivingly: the listing is the truth, `run.json` annotates it. */
	private async readRun(folder: vscode.Uri, name: string): Promise<TestRunRecord> {
		const entries: RunFolderEntry[] = [];
		for (const [entryName, fileType] of await this.readDirectory(folder)) {
			const kind: RunFolderEntry['kind'] =
				fileType & vscode.FileType.SymbolicLink
					? 'symlink'
					: fileType & vscode.FileType.File
						? 'file'
						: fileType & vscode.FileType.Directory
							? 'directory'
							: 'other';
			let size: number | undefined;
			if (kind === 'file' && entryName !== RUN_FILE && entryName !== OUTPUT_FILE) {
				try {
					size = (await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, entryName))).size;
				} catch {
					// Vanished between the listing and the stat; listed without a size.
				}
			}
			entries.push({ name: entryName, kind, ...(size !== undefined ? { size } : {}) });
		}
		return parseTestRun(await this.readFile(folder, RUN_FILE), name, entries);
	}

	private write<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		try {
			return await vscode.workspace.fs.readDirectory(uri);
		} catch {
			return [];
		}
	}

	private async readFile(folder: vscode.Uri, name: string): Promise<string | undefined> {
		try {
			return new TextDecoder().decode(
				await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, name))
			);
		} catch {
			return undefined;
		}
	}

	private async writeFile(folder: vscode.Uri, name: string, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(folder, name),
			new TextEncoder().encode(content)
		);
	}

	private async exists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}
}
