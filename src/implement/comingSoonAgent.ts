// A coding agent that is registered, selectable, and not implemented — the
// `k8sProvider.ts` posture: availability says why, `open` rejects with the
// same, and nothing else in the feature knows the difference. A settings value
// committed ahead of its implementation is then a sentence in a toast, never
// a crash. The real implementation replaces the one line in
// `configuredCodingAgent` that builds this.

import { codingAgentLabel } from '../settings/codingAgents';
import type { ImplementAgentId } from '../settings/implementSettings';
import { ImplementError, type CodingAgent } from './codingAgent';

export function comingSoonAgent(id: ImplementAgentId): CodingAgent {
	const label = codingAgentLabel(id);
	const message = `${label} is coming soon — pick Claude Code in Settings → Implement.`;

	return {
		id,
		label,
		availability: () => Promise.resolve({ ok: false, reason: 'not-implemented', message }),
		open: () => Promise.reject(new ImplementError('not-implemented', message))
	};
}
