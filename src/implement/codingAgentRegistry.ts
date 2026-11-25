// Which `CodingAgent` a click reaches.
//
// Every agent is built once and kept, and the setting only decides which one a
// call reaches — the `providerRegistry.ts` shape: building lazily would mean a
// settings change could not take effect until the window reloaded, and building
// on every call would throw away the CLI agent's remembered probe.
//
// What comes back is itself a `CodingAgent`, so the command layer never learns
// there is a choice. The two Claude Code agents are real; the six others are
// `comingSoonAgent` stubs, each the one line a real implementation replaces.

import { implementAgentId, type ImplementAgentId } from '../settings/implementSettings';
import { configuredProvider } from '../platform/providerRegistry';
import { ClaudeCodeAgent } from './claudeCodeAgent';
import { ClaudeCodeCliAgent, claudeCodeCliDeps, type ClaudeCodeCliDeps } from './claudeCodeCliAgent';
import type { CodingAgent, CodingAgentContext } from './codingAgent';
import { comingSoonAgent } from './comingSoonAgent';

/** The agent `implement.agent` names, read at call time. */
export function configuredCodingAgent(
	context: CodingAgentContext,
	cliDeps: ClaudeCodeCliDeps = claudeCodeCliDeps()
): CodingAgent {
	return configuredProvider<ImplementAgentId, CodingAgent>(
		{
			'claude-code': new ClaudeCodeAgent(),
			'claude-code-cli': new ClaudeCodeCliAgent(context, cliDeps),
			codex: comingSoonAgent('codex'),
			'codex-cli': comingSoonAgent('codex-cli'),
			opencode: comingSoonAgent('opencode'),
			'opencode-cli': comingSoonAgent('opencode-cli'),
			cursor: comingSoonAgent('cursor'),
			'github-copilot': comingSoonAgent('github-copilot')
		},
		() => implementAgentId(context.settings())
	);
}
