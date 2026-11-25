// How the board reaches a file in a test case's run folder — and how the host
// decides whether it may.
//
// Bundled into the webview and used by the host, so no `vscode` and no `node:`
// import. The names come from disk, and the results folder may be pulled from
// git, so a name is data: it is checked against the same allow-list
// `evidenceFileName` writes to before it is joined onto anything — a url, a
// path, a shell line.

import { isEvidenceFileName } from '../testing/testResultsPaths';

/**
 * True for a run id or a file name that is exactly one path segment of the
 * characters BFAST itself writes: no separators, no leading dot, so neither
 * `..` nor a hidden file nor a nested path can pass. The same allow-list
 * `evidenceFileName` writes to — one rule, so a name BFAST wrote is always
 * usable and a name from elsewhere is only ever listed.
 */
export function isSafeEvidenceSegment(value: string): boolean {
	return isEvidenceFileName(value);
}

/**
 * The url a board loads `<run>/<file>` from, resolved against the test case's
 * `evidenceBase` — its folder in the results store, as a uri the webview may
 * load, with a trailing slash. Each segment is checked and encoded, so a name
 * with a `#` or a space cannot break the url and a crafted `..` cannot climb
 * out of the folder. `undefined` when there is no base or a segment is unsafe;
 * the caller then shows the name and offers nothing that would fetch it.
 */
export function evidenceUrl(
	base: string | undefined,
	run: string,
	file: string
): string | undefined {
	if (!base || !isSafeEvidenceSegment(run) || !isSafeEvidenceSegment(file)) {
		return undefined;
	}
	try {
		return new URL(`${encodeURIComponent(run)}/${encodeURIComponent(file)}`, base).toString();
	} catch {
		return undefined;
	}
}
