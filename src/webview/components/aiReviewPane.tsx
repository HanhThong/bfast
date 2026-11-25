// The review an answer waits in when it is replacing text that already exists:
// the diff, and the three ways out of it.
//
// It stands where the text it would replace stands — in place of the rendered
// description, or of the design document — rather than above it, because the
// diff already shows that text and showing it twice is what makes a review
// screen unreadable. docs/ai/review.md is the spec.

import { useMemo, useState } from 'react';
import type { AiReview } from '../../shared/aiReview';
import { collapseUnchanged, diffLines, diffStats, type DiffRow } from '../../shared/textDiff';
import { Markdown } from './markdown';

interface AiReviewPaneProps {
	review: AiReview;
	/** What is being replaced, for the heading: "description", "sequence diagram". */
	label: string;
	/** The ticket's folder, so images in the answer resolve on the New text tab. */
	assetBase?: string;
	onApprove: () => void;
	onRewrite: () => void;
	onDiscard: () => void;
}

export function AiReviewPane({
	review,
	label,
	assetBase,
	onApprove,
	onRewrite,
	onDiscard
}: AiReviewPaneProps) {
	// Whole documents, and the diff is rebuilt on every repaint otherwise — a
	// watcher event on an unrelated ticket is enough to cause one.
	const lines = useMemo(
		() => diffLines(review.base, review.proposal),
		[review.base, review.proposal]
	);
	// Counted before the collapse, not after: a gap row hides only unchanged
	// lines, but the count has to be of the diff and not of what is on screen.
	const stats = useMemo(() => diffStats(lines), [lines]);
	const rows = useMemo(() => collapseUnchanged(lines), [lines]);
	const [view, setView] = useState<'changes' | 'text'>('changes');

	const identical = review.base === review.proposal;

	return (
		<section className="ai-review">
			<header className="ai-review-head">
				<strong>The assistant rewrote this {label}</strong>
				{review.round > 1 && <span className="ai-review-round">Attempt {review.round}</span>}
				<span className="ai-review-stats">
					<span className="ai-review-added">+{stats.added}</span>
					<span className="ai-review-removed">−{stats.removed}</span>
				</span>
				{/* Two views of one answer: what changed, and what it will read like
				    once saved. A diff of markdown is not the second of those. */}
				<div className="ai-review-views" role="tablist" aria-label="Review">
					<button
						type="button"
						role="tab"
						aria-selected={view === 'changes'}
						className={view === 'changes' ? 'tab active' : 'tab'}
						onClick={() => setView('changes')}
					>
						Changes
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === 'text'}
						className={view === 'text' ? 'tab active' : 'tab'}
						onClick={() => setView('text')}
					>
						New text
					</button>
				</div>
			</header>

			{/* Said outright rather than shown as an empty diff: "it changed nothing"
			    is an answer, and a blank panel reads as a bug. */}
			{identical && (
				<p className="ai-review-note">
					The assistant returned exactly what is already there — nothing would change.
				</p>
			)}

			{/* The base is deliberately not moved when the file changes underneath:
			    the answer really was written against what the diff shows. Approving
			    carries this through to the editor's own warning, so Save still does
			    the `updatedAt` check with its eyes open. */}
			{review.stale && (
				<p className="detail-notice">
					This {label} changed on disk after the assistant read it. The diff below is against
					what it was given.
				</p>
			)}

			{view === 'changes' ? (
				<DiffView rows={rows} />
			) : (
				<div className="description markdown ai-review-text">
					<Markdown text={review.proposal} assetBase={assetBase} />
				</div>
			)}

			<div className="ai-review-actions">
				<button type="button" className="button" onClick={onApprove}>
					Approve
				</button>
				<button type="button" className="button secondary" onClick={onRewrite}>
					Rewrite
				</button>
				<button type="button" className="button secondary" onClick={onDiscard}>
					Cancel
				</button>
				<span className="ai-prompt-hint ai-review-hint">
					Approve opens it in the editor — nothing is written until you save. Rewrite asks
					again, against the original.
				</span>
			</div>
		</section>
	);
}

/** The unified diff itself: one column, `-` then `+`, gaps for the rest. */
function DiffView({ rows }: { rows: DiffRow[] }) {
	if (rows.length === 0) {
		return <p className="empty">No changes.</p>;
	}

	return (
		<div className="diff" role="table" aria-label="Changes">
			{rows.map((row, index) =>
				row.op === 'gap' ? (
					<p className="diff-gap" key={index}>
						⋯ {row.hidden} unchanged {row.hidden === 1 ? 'line' : 'lines'}
					</p>
				) : (
					<p className={`diff-line diff-${row.op}`} key={index}>
						<span className="diff-marker" aria-hidden="true">
							{row.op === 'added' ? '+' : row.op === 'removed' ? '−' : ' '}
						</span>
						<span className="diff-text">
							{row.parts
								? row.parts.map((part, at) =>
										part.changed ? (
											<mark className="diff-word" key={at}>
												{part.text}
											</mark>
										) : (
											<span key={at}>{part.text}</span>
										)
									)
								: // A blank line still needs a row to stand in, or a
									// paragraph break disappears from the diff.
									row.text === ''
									? ' '
									: row.text}
						</span>
					</p>
				)
			)}
		</div>
	);
}
