// What the settings form's tabs share: the form's line to its panel, and the
// labels for the enums its dropdowns offer.

import type { TicketType } from '../../../data/types';
import { type AiProviderId } from '../../../settings/aiSettings';
import { type EnvironmentProviderId } from '../../../settings/environmentSettings';
import { type McpReach } from '../../../settings/mcpSettings';
import { type ScanMode, type ScannerMode, type ScanToolId } from '../../../settings/scanSettings';
import { type TraceFrameSource } from '../../../shared/playwrightTrace';
import { BfastSettings, DEFAULT_TRACKER_FOLDER } from '../../../settings/bfastSettings';
import { channel } from '../../vscodeApi';
import type { SettingsToHost, HostToSettings } from '../../../shared/protocol';

export const { onMessage, postMessage } = channel<SettingsToHost, HostToSettings>();

/** A fresh form has no `ai` block at all, so every read of it is optional. */
export const EMPTY: BfastSettings = { trackerFolder: DEFAULT_TRACKER_FOLDER, userName: '' };

export const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'Epic',
	story: 'Story',
	ac: 'Acceptance criterion',
	testcase: 'Test case'
};

export const TRACE_FRAME_SOURCE_LABEL: Record<TraceFrameSource, string> = {
	auto: "Auto — by the trace's format",
	resources: 'resources/ — trace format 8 and older',
	screencast: 'screencast/ — trace format 9 and newer'
};

export type SettingsTab =
	| 'general'
	| 'ai'
	| 'design'
	| 'environments'
	| 'tests'
	| 'scan'
	| 'implement'
	| 'mcp';

export const MCP_REACH_LABEL: Record<McpReach, string> = {
	local: 'This machine only (127.0.0.1)',
	network: 'Any machine that can reach this one'
};

export const PROVIDER_LABEL: Record<AiProviderId, string> = {
	'claude-cli': 'Claude Code CLI (no extra install)',
	'claude-agent-sdk': 'Claude Agent SDK (bundled)'
};

export const ENVIRONMENT_PROVIDER_LABEL: Record<EnvironmentProviderId, string> = {
	'docker-compose': 'Docker Compose',
	k8s: 'Kubernetes (coming soon)'
};

export const SCAN_TOOL_LABEL: Record<ScanToolId, string> = {
	sonarqube: 'SonarQube'
};

export const SCAN_MODE_LABEL: Record<ScanMode, string> = {
	auto: 'BFAST deploys it (Docker Compose)',
	external: 'An existing server or SonarQube Cloud'
};

export const SCANNER_MODE_LABEL: Record<ScannerMode, string> = {
	docker: 'Official scanner image (nothing to install)',
	command: 'A command I write'
};
