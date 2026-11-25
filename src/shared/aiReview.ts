// What happens to an answer written over text that already exists: it waits in
// a review, beside the text on disk, until the user approves it.
//
// Bundled into the webview, so no `vscode` and no `node:` import — and out of
// `app.tsx`, because the webview has no DOM test runner: the rules live here so
// `aiReview.test.ts` can hold them, the `aiPanel.ts` precedent.
//
// The invariant this module exists for: **the base never moves**. A rewrite is
// compared with the text the first answer was written against, never with that
// answer. Two halves make that true — the host re-reads the file at the start
// of every run and nothing is written until Save, so the *prompt* carries the
// original either way, and `openReview` keeps the base of the review already
// open, so the *diff* does too. See docs/ai/review.md.

export interface AiReview {
	/**
	 * The text on disk when this review opened: the diff's base, and what every
	 * rewrite in this review is compared against.
	 */
	base: string;
	/** The latest answer. Nothing has been written anywhere. */
	proposal: string;
	/** Provenance for the save that follows an Approve. */
	note?: string;
	/** How many answers this review has seen; 2 or more means a rewrite. */
	round: number;
	/**
	 * The file moved on disk since `base` was read — a `git pull`, another
	 * window, the assistant's own edit of another ticket. The base is left where
	 * it is: the answer really was written against what the diff shows.
	 */
	stale: boolean;
}

/**
 * Whether an answer replacing this text has to be reviewed first.
 *
 * Empty text has nothing to compare, so the answer goes straight into the
 * editor the way every answer did before this existed — a review showing
 * "everything was added" would be a screen that says nothing.
 */
export function needsReview(base: string): boolean {
	return base.trim().length > 0;
}

/**
 * Takes an answer into the review.
 *
 * `base` is used only when no review is open. A rewrite lands in the review
 * already there and keeps its base, which is the whole rule: were it re-read
 * here it would still be right today, but it would be one edit away from
 * comparing each answer with the one before it.
 */
export function openReview(
	current: AiReview | undefined,
	base: string,
	proposal: string,
	note?: string
): AiReview {
	return {
		base: current ? current.base : base,
		proposal,
		...(note !== undefined ? { note } : {}),
		round: (current?.round ?? 0) + 1,
		stale: current?.stale ?? false
	};
}

/**
 * Records that the file moved on disk under an open review.
 *
 * Returns the same object when there is nothing to record, so a caller can
 * hand the result straight to `setState` without repainting on every watcher
 * event.
 */
export function markReviewStale(current: AiReview | undefined): AiReview | undefined {
	if (!current || current.stale) {
		return current;
	}
	return { ...current, stale: true };
}
