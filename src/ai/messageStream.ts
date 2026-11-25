// Turning Claude Code's message stream into an `AiResult`.
//
// Both providers feed this the same objects: the CLI's `--output-format
// stream-json` emits one of these per line, and the Agent SDK yields the very
// same shapes from `query()`. Keeping the mapping here means the two
// implementations cannot drift, and it is pure, so it is testable without
// spawning anything.
//
// Everything is read defensively. These messages come from a program that
// updates independently of this extension, so an unknown `type`, a missing
// field or a new block kind must be *ignored*, never fatal.

import { AiError, type AiProgress, type AiResult, type AiResultMeta } from './aiProvider';

/** One line of `stream-json`, or one `SDKMessage`. Deliberately loose. */
export type AgentMessage = Record<string, unknown>;

/**
 * Accumulates a run.
 *
 * Stateful rather than a fold, because a run is consumed as it arrives and the
 * caller needs progress out of the same pass that builds the result.
 */
export class AgentStream {
	private readonly parts: string[] = [];
	private meta: AiResultMeta = {};
	private outcome: AiResult | undefined;
	private failure: AiError | undefined;

	/** Feeds one message in, emitting whatever progress it represents. */
	accept(message: AgentMessage, onProgress?: (progress: AiProgress) => void): void {
		switch (message.type) {
			case 'system':
				if (message.subtype === 'init') {
					this.meta.model = text(message.model) ?? this.meta.model;
					this.meta.sessionId = text(message.session_id) ?? this.meta.sessionId;
					onProgress?.({ kind: 'started', model: this.meta.model });
				} else if (message.subtype === 'thinking_tokens') {
					// The heartbeat. These start arriving within a second and keep
					// coming while the model reasons, which is the only evidence a
					// long, quiet run is working rather than hung.
					onProgress?.({ kind: 'thinking', tokens: number(message.estimated_tokens) });
				} else if (message.subtype === 'permission_denied') {
					// Best-effort by the SDK's own account; `result.permission_denials`
					// is the record. Surfaced so the log can say *why* a file the user
					// asked for was left alone.
					onProgress?.({
						kind: 'denied',
						tool: text(message.tool_name) ?? 'a tool',
						reason: text(message.decision_reason)
					});
				}
				break;

			case 'assistant':
				for (const block of contentBlocks(message.message)) {
					if (block.type === 'text') {
						const value = text(block.text);
						if (value !== undefined) {
							this.parts.push(value);
							onProgress?.({ kind: 'text', text: value });
						}
					} else if (block.type === 'thinking') {
						// A completed reasoning block. It contributes nothing to the
						// answer — only to showing what the agent is actually doing.
						const value = text(block.thinking)?.trim();
						if (value) {
							onProgress?.({ kind: 'thinking', text: value });
						}
					} else if (block.type === 'tool_use') {
						onProgress?.({
							kind: 'tool',
							name: text(block.name) ?? 'a tool',
							detail: toolDetail(block.input),
							id: text(block.id),
							...toolFacts(block.input)
						});
					}
					// Anything newer falls through on purpose.
				}
				break;

			case 'user':
				// The tool results. A denied `Edit` and one whose `old_string` did
				// not match both look like an `Edit` in the request stream; this is
				// the only message that says whether anything happened.
				for (const block of contentBlocks(message.message)) {
					if (block.type === 'tool_result') {
						const id = text(block.tool_use_id);
						if (id !== undefined) {
							onProgress?.({ kind: 'tool-result', id, error: block.is_error === true });
						}
					}
				}
				break;

			case 'result':
				this.finish(message);
				break;
		}
	}

	private finish(message: AgentMessage): void {
		const denials = Array.isArray(message.permission_denials)
			? (message.permission_denials as { tool_name?: unknown; tool_input?: unknown }[])
					.map((denial) => ({
						tool: text(denial.tool_name) ?? 'a tool',
						filePath: toolFacts(denial.tool_input).filePath
					}))
			: undefined;

		this.meta = {
			...this.meta,
			turns: number(message.num_turns) ?? this.meta.turns,
			costUsd: number(message.total_cost_usd) ?? this.meta.costUsd,
			sessionId: text(message.session_id) ?? this.meta.sessionId,
			...(denials && denials.length > 0 ? { denials } : {})
		};

		if (message.subtype !== 'success' || message.is_error === true) {
			this.failure = new AiError(
				'provider-error',
				`The agent stopped: ${text(message.subtype) ?? 'unknown error'}.`
			);
			return;
		}

		// `result` is the authoritative answer; the accumulated assistant text is
		// the fallback, because a future version could report success with an
		// empty one and losing the whole run to that would be absurd.
		const answer = text(message.result)?.trim();
		this.outcome = {
			text: answer && answer.length > 0 ? answer : this.parts.join('').trim(),
			meta: this.meta
		};
	}

	/** True once a `result` message has been seen, whichever way it went. */
	get done(): boolean {
		return this.outcome !== undefined || this.failure !== undefined;
	}

	/**
	 * The finished run, or throws. Called after the stream ends, so a stream that
	 * stopped without a `result` at all is a failure rather than a hang.
	 */
	result(): AiResult {
		if (this.failure) {
			throw this.failure;
		}
		if (!this.outcome) {
			throw new AiError('provider-error', 'The agent stopped before it answered.');
		}
		if (this.outcome.text.length === 0) {
			throw new AiError('empty-result', 'The agent returned no description.');
		}
		return this.outcome;
	}
}

/** Splits `stream-json` stdout into whole lines, holding a partial one back. */
export class LineBuffer {
	private pending = '';

	push(chunk: string): string[] {
		this.pending += chunk;
		const lines = this.pending.split('\n');
		// The last piece has no newline yet, so it is the start of the next line.
		this.pending = lines.pop() ?? '';
		return lines.map((line) => line.trim()).filter((line) => line.length > 0);
	}

	/** Whatever is left when the stream ends, if it is a whole value after all. */
	flush(): string[] {
		const rest = this.pending.trim();
		this.pending = '';
		return rest.length > 0 ? [rest] : [];
	}
}

/** `undefined` for a line that is not json — the CLI can print diagnostics too. */
export function parseAgentMessage(line: string): AgentMessage | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === 'object' && parsed !== null ? (parsed as AgentMessage) : undefined;
	} catch {
		return undefined;
	}
}

interface ContentBlock {
	type?: string;
	text?: unknown;
	thinking?: unknown;
	name?: unknown;
	id?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	is_error?: unknown;
}

/**
 * The raw facts out of a tool call's input, for adoption: the file it names,
 * and for `Edit` the replacement it makes — enough to reconstruct what the file
 * held before, when the snapshot came too late.
 */
function toolFacts(input: unknown): {
	filePath?: string;
	edit?: { oldString: string; newString: string; replaceAll: boolean };
} {
	if (typeof input !== 'object' || input === null) {
		return {};
	}
	const fields = input as Record<string, unknown>;
	const filePath = text(fields.file_path)?.trim() || undefined;
	const oldString = text(fields.old_string);
	const newString = text(fields.new_string);
	return {
		...(filePath ? { filePath } : {}),
		...(oldString !== undefined && newString !== undefined
			? { edit: { oldString, newString, replaceAll: fields.replace_all === true } }
			: {})
	};
}

/**
 * The one useful field out of a tool call's input — the file it read, or the
 * pattern it searched for. "Read src/data/ticketStore.ts" says far more about
 * what the agent is doing than "Read" does.
 */
function toolDetail(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const fields = input as Record<string, unknown>;
	for (const key of ['file_path', 'pattern', 'path', 'query', 'command']) {
		const value = text(fields[key])?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function contentBlocks(message: unknown): ContentBlock[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
