// The models the AI assistant can be asked to run on.
//
// Pure data, no `vscode` import and no Node: every picker (the board's AI panel,
// the generate tab, the settings form) builds its dropdown from `MODELS`, and
// the host validates a pick and a hand-edited `bfast.json` with `isModelId` —
// the `languages.ts` split, so the form and the writer cannot disagree.
//
// Neither the `claude` CLI nor the Agent SDK can list models, so this is bundled
// and will age. Two things keep that cheap: the **aliases** lead, because Claude
// Code re-points them at each release and `opus` keeps meaning "the current
// Opus"; and `isModelId` is a *format* rule, never a membership test, so a model
// that shipped after the extension did is typed in and passes everywhere.
// docs/ai/models.md is the spec.

export interface ModelOption {
	/** What is stored and what reaches `--model` / the SDK's `model`. */
	id: string;
	/** Shown in the dropdown. */
	label: string;
	/** A qualitative tier, never a price — prices change faster than releases. */
	hint: string;
	/** An alias is Claude Code's to resolve; an id names one release. */
	kind: 'alias' | 'id';
}

/**
 * Aliases first, then pinned ids. There is deliberately no `default` entry:
 * "absent" already means the provider's own default, and two spellings of one
 * thing would be a trap.
 */
export const MODELS: readonly ModelOption[] = [
	{ id: 'best', label: 'Best available', hint: 'the most capable model this account can use', kind: 'alias' },
	{ id: 'opus', label: 'Opus', hint: 'most capable', kind: 'alias' },
	{ id: 'sonnet', label: 'Sonnet', hint: 'balanced', kind: 'alias' },
	{ id: 'haiku', label: 'Haiku', hint: 'fastest, cheapest', kind: 'alias' },
	{ id: 'fable', label: 'Fable', hint: 'the frontier tier, where available', kind: 'alias' },
	{ id: 'opusplan', label: 'Opus plans, Sonnet writes', hint: 'Opus for planning, Sonnet for the rest', kind: 'alias' },
	{ id: 'opus[1m]', label: 'Opus, 1M context', hint: 'most capable, long context', kind: 'alias' },
	{ id: 'sonnet[1m]', label: 'Sonnet, 1M context', hint: 'balanced, long context', kind: 'alias' },
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'most capable', kind: 'id' },
	{ id: 'claude-opus-5', label: 'Claude Opus 5', hint: 'previous Opus', kind: 'id' },
	{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', hint: 'balanced', kind: 'id' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'fastest, cheapest', kind: 'id' },
	{ id: 'claude-fable-5-1', label: 'Claude Fable 5.1', hint: 'the frontier tier', kind: 'id' },
	{ id: 'claude-fable-5', label: 'Claude Fable 5', hint: 'the frontier tier, previous release', kind: 'id' },
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'older Opus', kind: 'id' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'previous Sonnet', kind: 'id' }
];

/** What a picker can tell apart from a custom value. */
export const MODEL_IDS: ReadonlySet<string> = new Set(MODELS.map((model) => model.id));

export const MAX_MODEL_ID_LENGTH = 100;

/**
 * The one format rule: one token of printable ASCII, no whitespace, at most
 * `MAX_MODEL_ID_LENGTH` characters.
 *
 * That loose on purpose. The value becomes one argv element (`--model <id>`) or
 * one SDK option, so whitespace and control characters are what must not get
 * through — while `opus[1m]` and a Bedrock `us.anthropic.claude-opus-5` are
 * both real, so `[a-z0-9-]` would refuse names Claude Code accepts. Whether a
 * name *exists* is Claude Code's to say, and it says so at the first request.
 */
export function isModelId(value: unknown): value is string {
	return typeof value === 'string' && /^[\x21-\x7e]{1,100}$/.test(value);
}

/** The trimmed id when it passes `isModelId`, `undefined` otherwise. */
export function sanitizeModelId(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return isModelId(trimmed) ? trimmed : undefined;
}

/**
 * What to call a model on screen: its label when the list knows it, the id
 * itself when it does not, and "provider default" for none at all.
 */
export function modelLabel(id: string | undefined): string {
	if (id === undefined || id.length === 0) {
		return 'provider default';
	}
	return MODELS.find((model) => model.id === id)?.label ?? id;
}
