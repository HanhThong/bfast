// The model picker — one component for the settings form, the board's AI panel
// and the generate tab, so the three cannot offer different lists.
//
// A `<select>` over `MODELS` with a "Custom…" entry that reveals a text box:
// the list is bundled and will age (docs/ai/models.md), so a model that shipped
// after the extension did has to be typeable. Whatever is typed leaves this
// component only once it passes `isModelId` — the value becomes an argv element
// on the host, and the host sanitises again, but a picker that hands on
// something it knows is unusable would be lying about what will run.

import { useState } from 'react';
import { isModelId, MODEL_IDS, MODELS, sanitizeModelId } from '../../settings/models';

/** The `<option>` that opens the text box; never a model id, so it cannot collide. */
const CUSTOM = '__custom';

interface ModelSelectProps {
	id: string;
	/** The current pick; `undefined` is the first entry, `defaultLabel`. */
	value?: string;
	/** What the first entry says — "Provider default", or "Default — Opus". */
	defaultLabel: string;
	className?: string;
	disabled?: boolean;
	/** `undefined` means "the default" — the setting on a board, nothing in the form. */
	onChange: (value: string | undefined) => void;
}

export function ModelSelect({ id, value, defaultLabel, className, disabled, onChange }: ModelSelectProps) {
	// Whether the text box is open, and what is in it. A value the list does not
	// know opens it, since that is the only place it could have come from.
	const known = value === undefined || MODEL_IDS.has(value);
	const [custom, setCustom] = useState(!known);
	const [text, setText] = useState(known ? '' : (value ?? ''));

	const selected = custom ? CUSTOM : (value ?? '');
	const trimmed = text.trim();
	// Typed, non-empty, and not yet usable — the one state worth a hint.
	const unusable = custom && trimmed.length > 0 && !isModelId(trimmed);

	return (
		<>
			<select
				id={id}
				className={className}
				disabled={disabled}
				value={selected}
				onChange={(event) => {
					const next = event.target.value;
					if (next === CUSTOM) {
						setCustom(true);
						// Whatever is already typed stands; the pick only changes once
						// something usable is in the box.
						return;
					}
					setCustom(false);
					setText('');
					onChange(next === '' ? undefined : next);
				}}
			>
				<option value="">{defaultLabel}</option>
				<optgroup label="Aliases — follow each Claude Code release">
					{MODELS.filter((model) => model.kind === 'alias').map((model) => (
						<option key={model.id} value={model.id}>
							{model.label} — {model.hint}
						</option>
					))}
				</optgroup>
				<optgroup label="Pinned models">
					{MODELS.filter((model) => model.kind === 'id').map((model) => (
						<option key={model.id} value={model.id}>
							{model.label} — {model.hint}
						</option>
					))}
				</optgroup>
				<option value={CUSTOM}>Custom…</option>
			</select>
			{custom && (
				<input
					className={className}
					type="text"
					spellCheck={false}
					disabled={disabled}
					value={text}
					placeholder="a model id or alias Claude Code accepts"
					aria-label="Custom model"
					aria-invalid={unusable}
					onChange={(event) => {
						const typed = event.target.value;
						setText(typed);
						const usable = sanitizeModelId(typed);
						if (usable !== undefined) {
							onChange(usable);
						} else if (typed.trim().length === 0) {
							onChange(undefined);
						}
						// Otherwise the last usable value stands until this one is.
					}}
				/>
			)}
			{unusable && (
				<span className="model-select-hint">One token — no spaces — of at most 100 characters.</span>
			)}
		</>
	);
}
