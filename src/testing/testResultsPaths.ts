// Pure naming rules for the test results folder — where every test case's
// recorded runs live, **outside the tracker**:
//
//   <workspace>/<tests.resultsFolder>/          default `.bfast/test-results`
//     TC-1.2.1.1/                               one folder per test case, by id
//       2026-09-05T10-22-33.123Z/               one folder per run: when it started
//         run.json  output.log  <evidence files the tests.evidence glob matched>
//
// Keyed by the test case's full id rather than mirroring the tracker's nesting:
// an id is unique across the tracker, a rename of the ticket moves nothing here,
// and the board can reach a run from the id alone. The tracker holds what a
// ticket *is* and `history.md` what changed about it; this folder is the other
// history — what happened when its tests ran — and the two never share a file.
//
// No `vscode` and no `node:` import: `shared/evidencePath.ts` (bundled into the
// webview) reads the allow-list from here, and the store reads the folder names.

import { isReservedFileName } from '../data/trackerPaths';

/**
 * The folder a test case's runs live under. Its id verbatim — `TC-1.2.1.1` is
 * a safe name on every OS — except that a rank's `#` (a duplicate folder in
 * the tracker, `TC-1#2.1.1`) becomes `_`: `#` breaks a url and a shell line,
 * and no other id carries an underscore, so the name still cannot collide.
 */
export function testCaseResultsFolder(id: string): string {
	return id.replace(/#/g, '_');
}

/** Longest an evidence file's stem may be. Tool-generated names run long. */
const MAX_EVIDENCE_STEM = 80;

/**
 * Every character an evidence file name — or a run folder's, or a test case
 * folder's — may carry. The same set the board's url builder and the "open
 * with" command accept, so a name BFAST wrote is always usable and a name that
 * arrived by other means (a `git pull` of the results folder) is only ever
 * listed.
 */
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A file name safe to write inside a run folder **and** to put in a url or a
 * shell line: the source's own name, with anything outside `EVIDENCE_NAME`
 * turned into `_`. Unlike `assetFileName` it keeps every dot — `TC-1.2.page-2.webm`
 * is one name, not a stem and an extension — and adds no extension of its own.
 *
 * Any directory part is dropped, so a match under a nested folder cannot carry
 * a path into the run folder.
 */
export function evidenceFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? '';
	let safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
	if (safe.length > MAX_EVIDENCE_STEM) {
		// Keep the extension: it is what makes a video a video on the board.
		const dot = safe.lastIndexOf('.');
		const extension = dot > 0 && safe.length - dot <= 9 ? safe.slice(dot) : '';
		safe = safe.slice(0, MAX_EVIDENCE_STEM - extension.length) + extension;
	}
	if (safe === '' || !EVIDENCE_NAME.test(safe)) {
		return 'file';
	}
	const stem = safe.includes('.') ? safe.slice(0, safe.indexOf('.')) : safe;
	return isReservedFileName(stem) ? `${stem}_${safe.slice(stem.length)}` : safe;
}

/** Whether a name is one `evidenceFileName` could have produced. */
export function isEvidenceFileName(name: string): boolean {
	return EVIDENCE_NAME.test(name);
}
