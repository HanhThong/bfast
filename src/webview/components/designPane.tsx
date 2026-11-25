// One design document's tab: the diagram when viewing, the shared markdown
// editor when editing, and the rename / delete controls.
//
// It reuses `DescriptionEditor` outright rather than growing an editor of its
// own — a design document is markdown with a mermaid fence in it, so the same
// toolbar, the same undo behaviour and the same three ways an image can arrive
// are all exactly right.

import { useEffect, useState } from 'react';
import { resolveStyle, type DesignStyle } from '../../design/designDocument';
import type { BoardMode, DesignState } from '../app';
import type { ImageSource } from '../imageInsert';
import { AiReviewPane } from './aiReviewPane';
import { DescriptionEditor } from './descriptionEditor';
import { Markdown } from './markdown';

interface DesignPaneProps {
	state: DesignState;
	/** The document this tab shows, which may not have arrived yet. */
	designId: string;
	assetBase?: string;
	copying: number;
	onEdit: () => void;
	onCancel: () => void;
	onSave: () => void;
	onDraftChange: (draft: string) => void;
	onRename: (title: string) => void;
	onDelete: () => void;
	onRequestImage: (source: ImageSource, start: number, end: number) => void;
	onImageError: (message: string) => void;
	/** The three ways out of a review, when an answer is waiting on this tab. */
	onReviewApprove: () => void;
	onReviewRewrite: () => void;
	onReviewDiscard: () => void;
}

export function DesignPane({
	state,
	designId,
	assetBase,
	copying,
	onEdit,
	onCancel,
	onSave,
	onDraftChange,
	onRename,
	onDelete,
	onRequestImage,
	onImageError,
	onReviewApprove,
	onReviewRewrite,
	onReviewDiscard
}: DesignPaneProps) {
	const document = state.open?.id === designId ? state.open : undefined;
	const summary = state.documents.find((design) => design.id === designId);
	const [renaming, setRenaming] = useState(false);

	// A different tab is a different document: an open rename box belongs to the
	// one it was opened on.
	useEffect(() => setRenaming(false), [designId]);

	if (!summary) {
		return <p className="empty">This design is no longer on the ticket.</p>;
	}

	const style: DesignStyle = resolveStyle(state.styles, summary.prefix);
	const editing: BoardMode = state.mode;
	// Only this tab's: a review carries the document it belongs to, so reading
	// another tab and coming back does not throw an unapproved answer away.
	const review = state.review?.design === designId ? state.review : undefined;

	return (
		<section className="design">
			<header className="design-header">
				<div className="design-meta">
					<span className="design-style">{style.label}</span>
					<span className="design-id">{summary.id}</span>
				</div>
				{renaming ? (
					<RenameBox
						title={summary.title}
						onCancel={() => setRenaming(false)}
						onSubmit={(title) => {
							setRenaming(false);
							onRename(title);
						}}
					/>
				) : (
					<div className="design-title-row">
						<h2 className="design-title">{summary.title}</h2>
						{editing === 'view' && (
							<div className="design-actions">
								{/* Hidden while an answer is waiting: the review's own three
								    buttons are the way out, and an Edit here would throw it
								    away without saying so. */}
								{!review && (
									<button type="button" className="button secondary" onClick={onEdit}>
										Edit
									</button>
								)}
								<button
									type="button"
									className="button secondary"
									onClick={() => setRenaming(true)}
								>
									Rename
								</button>
								<button type="button" className="button secondary" onClick={onDelete}>
									Delete
								</button>
							</div>
						)}
					</div>
				)}
			</header>

			{editing !== 'view' ? (
				<DescriptionEditor
					draft={state.draft}
					saving={editing === 'saving'}
					error={state.error}
					staleOnDisk={state.staleOnDisk}
					copying={copying}
					onDraftChange={onDraftChange}
					onCancel={onCancel}
					onSave={onSave}
					onRequestImage={onRequestImage}
					onImageError={onImageError}
				/>
			) : (
				<>
					{state.error && <p className="detail-error">{state.error}</p>}
					{/* In place of the document, not above it: the diff already shows
					    what is there. */}
					{review ? (
						<AiReviewPane
							review={review}
							label={style.label.toLowerCase()}
							assetBase={assetBase}
							onApprove={onReviewApprove}
							onRewrite={onReviewRewrite}
							onDiscard={onReviewDiscard}
						/>
					) : !document ? (
						<p className="empty">Loading…</p>
					) : document.body.trim().length === 0 ? (
						// A new design starts empty on purpose: it is written by the
						// assistant from what the user says it should show, or by hand.
						<p className="empty">
							Nothing drawn yet. Tell the AI assistant what this {style.label.toLowerCase()}{' '}
							should show, or press Edit to write it yourself.
						</p>
					) : (
						<div className="description markdown">
							<Markdown text={document.body} assetBase={assetBase} />
						</div>
					)}
				</>
			)}
		</section>
	);
}

function RenameBox({
	title,
	onCancel,
	onSubmit
}: {
	title: string;
	onCancel: () => void;
	onSubmit: (title: string) => void;
}) {
	const [value, setValue] = useState(title);

	return (
		<form
			className="design-rename"
			onSubmit={(event) => {
				event.preventDefault();
				const trimmed = value.trim();
				if (trimmed.length > 0) {
					onSubmit(trimmed);
				}
			}}
		>
			<input
				className="input"
				value={value}
				autoFocus
				aria-label="Design title"
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						onCancel();
					}
				}}
			/>
			<button type="submit" className="button">
				Rename
			</button>
			<button type="button" className="button secondary" onClick={onCancel}>
				Cancel
			</button>
		</form>
	);
}
