// Which `AiProvider` a run uses.
//
// Both implementations are built once and kept, and the setting only decides
// which one a call reaches — building lazily would mean a settings change could
// not take effect until the window reloaded, and building on every call would
// throw away the CLI provider's cached `claude --version` probe.
//
// What comes back is itself an `AiProvider`, so `BoardServices` and the panel
// stay unaware that there is a choice at all. The forwarding is
// `platform/providerRegistry.ts`'s; this file is only the table.

import { aiProviderId, type AiProviderId } from '../settings/aiSettings';
import { configuredProvider } from '../platform/providerRegistry';
import type { AiContext } from './aiContext';
import type { AiProvider } from './aiProvider';
import { ClaudeAgentSdkProvider } from './claudeAgentSdkProvider';
import { ClaudeCliProvider } from './claudeCliProvider';

/** The `AiProvider` that `ai.provider` names, read at call time. Disposing it disposes both. */
export function configuredAiProvider(context: AiContext): AiProvider {
	return configuredProvider<AiProviderId, AiProvider>(
		{
			'claude-cli': new ClaudeCliProvider(context),
			'claude-agent-sdk': new ClaudeAgentSdkProvider(context)
		},
		() => aiProviderId(context.settings())
	);
}
