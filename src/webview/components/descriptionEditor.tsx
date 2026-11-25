// The description editor: the textarea, its formatting toolbar and the image
// plumbing behind paste, drop and the toolbar's picker.
//
// Its own module because a design document's tab edits markdown too, and wants
// exactly this — the same toolbar, the same undo behaviour, the same three
// routes an image can arrive by. It moved out of `ticketDetail.tsx` whole:
// `FormatToolbar` and `ToolbarButton` are only ever used from here, and leaving
// them behind would have made the two files import each other.

import {
	useCallback,
	useRef,
	useState,
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode
} from 'react';
import {
	blockStateAt,
	setHeading,
	toggleBullet,
	toggleWrap,
	type BlockState,
	type HeadingLevel,
	type TextEdit,
	type WrapStyle
} from '../../shared/markdownFormat';
import { MAX_IMAGE_BYTES } from '../../shared/protocol';
import {
	pastedFileName,
	readDrop,
	readPaste,
	toBase64,
	tooLargeMessage,
	type ImageSource
} from '../imageInsert';
import { BulletListIcon, ImageIcon } from './icons';

export interface DescriptionEditorProps {
	draft: string;
	saving: boolean;
	error?: string;
	staleOnDisk: boolean;
	copying: number;
	onDraftChange: (draft: string) => void;
	onCancel: () => void;
	onSave: () => void;
	onRequestImage: (source: ImageSource, start: number, end: number) => void;
	onImageError: (message: string) => void;
}

/** The shortcut each style answers to, alongside Ctrl+Enter and Esc. */
const SHORTCUTS: Record<string, WrapStyle> = { b: 'bold', i: 'italic', u: 'underline' };

export function DescriptionEditor({
	draft,
	saving,
	error,
	staleOnDisk,
	copying,
	onDraftChange,
	onCancel,
	onSave,
	onRequestImage,
	onImageError
}: DescriptionEditorProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// Where the caret was when the textarea last had it. A toolbar button reached
	// by keyboard does take focus, and then the textarea's own offsets are gone.
	const selection = useRef({ start: 0, end: 0 });
	/** What the heading picker and the bullet button should be showing. */
	const [block, setBlock] = useState<BlockState>({ heading: 0, bulleted: false });

	const rememberSelection = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}

		selection.current = { start: textarea.selectionStart, end: textarea.selectionEnd };

		const next = blockStateAt(textarea.value, textarea.selectionStart, textarea.selectionEnd);
		// Every caret move calls this, so hand back the old object when nothing
		// moved rather than re-rendering the pane on each arrow key.
		setBlock((current) =>
			current.heading === next.heading && current.bulleted === next.bulleted ? current : next
		);
	}, []);

	/**
	 * Applies an edit through `execCommand`, which is deprecated but not gone and
	 * is the only insert that keeps the browser's own undo stack — so a bold click
	 * is one Ctrl+Z, exactly like typing. It also fires a real `input` event, so
	 * React's controlled textarea sees the change; `setRangeText` does neither,
	 * which is why it is only the fallback.
	 */
	const apply = useCallback(
		(edit: TextEdit) => {
			const textarea = textareaRef.current;
			if (!textarea) {
				return;
			}

			textarea.focus();
			textarea.setSelectionRange(edit.replaceStart, edit.replaceEnd);

			if (!document.execCommand('insertText', false, edit.replacement)) {
				textarea.setRangeText(edit.replacement, edit.replaceStart, edit.replaceEnd, 'end');
				onDraftChange(textarea.value);
			}

			textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
			rememberSelection();
		},
		[onDraftChange, rememberSelection]
	);

	/** Runs a formatter over whatever is selected right now. */
	const format = useCallback(
		(edit: (text: string, start: number, end: number) => TextEdit) => {
			const textarea = textareaRef.current;
			const { start, end } = textarea
				? { start: textarea.selectionStart, end: textarea.selectionEnd }
				: selection.current;

			apply(edit(draft, start, end));
		},
		[apply, draft]
	);

	const wrap = useCallback(
		(style: WrapStyle) => format((text, start, end) => toggleWrap(text, start, end, style)),
		[format]
	);

	/**
	 * Turns a `File` from a paste or a drop into a request the host can serve.
	 * The name is the caller's to decide: a dropped file has one worth keeping,
	 * while a pasted screenshot is called `image.png` by the browser and would
	 * collide with every other paste.
	 */
	const sendFile = useCallback(
		async (file: File, fileName: string, start: number, end: number) => {
			if (file.size > MAX_IMAGE_BYTES) {
				onImageError(tooLargeMessage(file.size));
				return;
			}

			try {
				onRequestImage({ kind: 'bytes', fileName, data: await toBase64(file) }, start, end);
			} catch {
				onImageError('That image could not be read.');
			}
		},
		[onImageError, onRequestImage]
	);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		const modifier = event.metaKey || event.ctrlKey;

		if (modifier && event.key === 'Enter') {
			event.preventDefault();
			onSave();
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onCancel();
			return;
		}

		const style = modifier && !event.altKey ? SHORTCUTS[event.key.toLowerCase()] : undefined;
		if (style) {
			event.preventDefault();
			wrap(style);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
		const file = readPaste(event.clipboardData);
		if (!file) {
			// An ordinary text paste is left to the browser, which keeps its own
			// undo entry for it.
			return;
		}

		event.preventDefault();
		const textarea = event.currentTarget;
		void sendFile(file, pastedFileName(file.type), textarea.selectionStart, textarea.selectionEnd);
	};

	const onDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
		const payload = readDrop(event.dataTransfer);
		if (payload.kind === 'text') {
			// A dropped snippet of text belongs in the textarea as text.
			return;
		}

		event.preventDefault();
		const textarea = event.currentTarget;
		const { selectionStart, selectionEnd } = textarea;

		if (payload.kind === 'file') {
			void sendFile(payload.file, payload.file.name, selectionStart, selectionEnd);
		} else if (payload.kind === 'uri') {
			// A drag out of the VS Code explorer hands over a uri and no bytes, so
			// the host has to be the one to read the file.
			onRequestImage({ kind: 'uri', uri: payload.uri }, selectionStart, selectionEnd);
		} else {
			onImageError('Drop an image file, or use the image button.');
		}
	};

	const onDragOver = (event: DragEvent<HTMLTextAreaElement>): void => {
		const carriesFile = event.dataTransfer.types.some(
			(type) => type === 'Files' || type === 'text/uri-list'
		);
		if (!carriesFile) {
			return;
		}

		// Without this the browser refuses the drop outright.
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	};

	return (
		<div className="description-editor">
			{error && <p className="detail-error">{error}</p>}
			{staleOnDisk && (
				<p className="detail-notice">
					This ticket changed on disk while you were editing. Your text is untouched — saving
					will be refused if it would overwrite that change.
				</p>
			)}

			<FormatToolbar
				disabled={saving}
				block={block}
				onWrap={wrap}
				onHeading={(level) => format((text, start, end) => setHeading(text, start, end, level))}
				onBullet={() => format(toggleBullet)}
				onPickImage={() =>
					onRequestImage({ kind: 'pick' }, selection.current.start, selection.current.end)
				}
			/>

			<textarea
				ref={textareaRef}
				className="description-textarea"
				value={draft}
				disabled={saving}
				autoFocus
				spellCheck={false}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				onDrop={onDrop}
				onDragOver={onDragOver}
				onSelect={rememberSelection}
			/>

			<div className="editor-actions">
				<button type="button" className="button" disabled={saving} onClick={onSave}>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button type="button" className="button secondary" disabled={saving} onClick={onCancel}>
					Cancel
				</button>
				{copying > 0 ? (
					// Not a disabled textarea: that would take the focus and the
					// selection away, which is the very thing being preserved.
					<span className="editor-progress">
						Copying {copying === 1 ? 'image' : `${copying} images`}…
					</span>
				) : (
					<span className="editor-hint">Ctrl+Enter to save, Esc to cancel</span>
				)}
			</div>
		</div>
	);
}

/** The text levels the picker offers, in the order it lists them. */
const HEADING_LEVELS: readonly { level: HeadingLevel; label: string }[] = [
	{ level: 0, label: 'Normal' },
	{ level: 1, label: 'Heading 1' },
	{ level: 2, label: 'Heading 2' },
	{ level: 3, label: 'Heading 3' },
	{ level: 4, label: 'Heading 4' },
	{ level: 5, label: 'Heading 5' },
	{ level: 6, label: 'Heading 6' }
];

interface FormatToolbarProps {
	disabled: boolean;
	block: BlockState;
	onWrap: (style: WrapStyle) => void;
	onHeading: (level: HeadingLevel) => void;
	onBullet: () => void;
	onPickImage: () => void;
}

function FormatToolbar({
	disabled,
	block,
	onWrap,
	onHeading,
	onBullet,
	onPickImage
}: FormatToolbarProps) {
	return (
		<div className="format-toolbar" role="toolbar" aria-label="Formatting">
			<select
				className="format-select"
				title="Text level"
				aria-label="Text level"
				disabled={disabled}
				value={block.heading}
				// A select has to keep its focus to be usable, so unlike the buttons
				// it restores the caret afterwards instead of never taking it.
				onChange={(event) => onHeading(Number(event.target.value) as HeadingLevel)}
			>
				{HEADING_LEVELS.map(({ level, label }) => (
					<option key={level} value={level}>
						{label}
					</option>
				))}
			</select>

			<span className="format-separator" />

			<ToolbarButton label="Bold (Ctrl+B)" disabled={disabled} onPress={() => onWrap('bold')}>
				<strong>B</strong>
			</ToolbarButton>
			<ToolbarButton label="Italic (Ctrl+I)" disabled={disabled} onPress={() => onWrap('italic')}>
				<em>I</em>
			</ToolbarButton>
			<ToolbarButton
				label="Underline (Ctrl+U)"
				disabled={disabled}
				onPress={() => onWrap('underline')}
			>
				<u>U</u>
			</ToolbarButton>

			<span className="format-separator" />

			<ToolbarButton
				label="Bulleted list"
				disabled={disabled}
				pressed={block.bulleted}
				onPress={onBullet}
			>
				<BulletListIcon />
			</ToolbarButton>
			<ToolbarButton
				label="Insert image — or paste or drop one"
				disabled={disabled}
				onPress={onPickImage}
			>
				<ImageIcon />
			</ToolbarButton>
		</div>
	);
}

function ToolbarButton({
	label,
	disabled,
	pressed,
	onPress,
	children
}: {
	label: string;
	disabled: boolean;
	pressed?: boolean;
	onPress: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			className={pressed ? 'format-button active' : 'format-button'}
			title={label}
			aria-label={label}
			aria-pressed={pressed}
			disabled={disabled}
			// Never taking focus is simpler than saving and restoring it: the
			// textarea keeps both its focus and its selection through the click.
			onMouseDown={(event) => event.preventDefault()}
			onClick={onPress}
		>
			{children}
		</button>
	);
}
