// The coding agents Implement can hand a prompt to — the offer the settings
// form lists, keyed by `ImplementAgentId`.
//
// A pure data module, the `models.ts` shape: no `vscode`, no Node, so the
// settings webview and the host read one list and cannot disagree. `available`
// is what the form's `disabled` reads; the registry is where a stub becomes a
// real agent, and a test holds the two to each other so they flip together.

import { IMPLEMENT_AGENT_IDS, type ImplementAgentId } from './implementSettings';

export interface CodingAgentOption {
	id: ImplementAgentId;
	/** Shown in the dropdown. */
	label: string;
	/** What picking it means: the sentence under the dropdown. */
	hint: string;
	/** False for a registered stub — "(coming soon)" and disabled in the form. */
	available: boolean;
}

export const CODING_AGENTS: readonly CodingAgentOption[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		hint: 'The Claude Code VS Code extension: a new tab opens with the prompt in its input, unsent.',
		available: true
	},
	{
		id: 'claude-code-cli',
		label: 'Claude Code CLI',
		hint:
			'The claude CLI in a terminal: the prompt is written to .bfast/implement/prompts/ and one line ' +
			'naming that file is typed, waiting for Enter.',
		available: true
	},
	{
		id: 'codex',
		label: 'Codex',
		hint: 'The OpenAI Codex extension.',
		available: false
	},
	{
		id: 'codex-cli',
		label: 'Codex CLI',
		hint: 'The codex CLI in a terminal.',
		available: false
	},
	{
		id: 'opencode',
		label: 'OpenCode',
		hint: 'The OpenCode extension.',
		available: false
	},
	{
		id: 'opencode-cli',
		label: 'OpenCode CLI',
		hint: 'The opencode CLI in a terminal.',
		available: false
	},
	{
		id: 'cursor',
		label: 'Cursor',
		hint: 'Cursor’s chat.',
		available: false
	},
	{
		id: 'github-copilot',
		label: 'GitHub Copilot',
		hint: 'Copilot Chat.',
		available: false
	}
];

/** The option for an id. Every id has one — a test pins the two lists to each other. */
export function codingAgentOption(id: ImplementAgentId): CodingAgentOption {
	return (
		CODING_AGENTS.find((option) => option.id === id) ?? {
			id,
			label: id,
			hint: '',
			available: false
		}
	);
}

export function codingAgentLabel(id: ImplementAgentId): string {
	return codingAgentOption(id).label;
}

export function codingAgentAvailable(id: ImplementAgentId): boolean {
	return codingAgentOption(id).available;
}

/** Every id the settings accept, in the order the form lists them. */
export const CODING_AGENT_IDS: readonly ImplementAgentId[] = IMPLEMENT_AGENT_IDS;
