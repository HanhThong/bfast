// The settings form's state: one `BfastSettings` object every tab edits, the
// text of the two inputs that cannot round-trip through a parse, what the host
// last said, and the validation the Save button reads.
//
// One hook rather than state per tab, because Save writes the whole object:
// the tabs are views of one form, and a tab that owned its block could not be
// validated — or saved — while another was on screen.

import { useEffect, useState } from 'react';
import { type AgentDefinition } from '../../../ai/agent';
import { validateAiSettings, type AiSettings } from '../../../settings/aiSettings';
import {
	environmentPortVariables,
	validateEnvironmentsSettings,
	validatePortVariableText,
	validateWorktreesFolder,
	type EnvironmentsSettings
} from '../../../settings/environmentSettings';
import { codingAgentOption } from '../../../settings/codingAgents';
import {
	unknownCommitMessagePlaceholders,
	validateGitSettings,
	type GitSettings
} from '../../../settings/gitSettings';
import {
	implementAgentId,
	validateImplementSettings,
	type ImplementSettings
} from '../../../settings/implementSettings';
import { type ImplementPromptInfo } from '../../../implement/implementPrompt';
import {
	DEFAULT_MCP_PORT,
	MCP_FUNCTION_IDS,
	mcpEnabled,
	mcpFunctions,
	mcpPort,
	validateMcpPortText,
	validateMcpSettings,
	type McpFunctionId,
	type McpSettings
} from '../../../settings/mcpSettings';
import type { McpServerStatus } from '../../../mcp/mcpStatus';
import {
	scanMode as resolveScanMode,
	scannerMode as resolveScannerMode,
	unknownScanPlaceholders,
	validateScanSettings,
	type ScanProperty,
	type ScanSettings
} from '../../../settings/scanSettings';
import {
	unknownEvidenceCommandPlaceholders,
	unknownEvidencePlaceholders,
	unknownPlaceholders,
	validateTestsSettings,
	type TestsSettings
} from '../../../settings/testsSettings';
import {
	suggestServiceId,
	unknownServicePlaceholders,
	type TestService
} from '../../../settings/testServices';
import {
	BfastSettings,
	validateTrackerFolder,
	validateUserName
} from '../../../settings/bfastSettings';
import { EMPTY, onMessage, postMessage } from './shared';
import type { SettingsTab } from './shared';

export function useSettingsForm() {
	const [settings, setSettings] = useState<BfastSettings>(EMPTY);
	const [loaded, setLoaded] = useState(false);
	const [configured, setConfigured] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [tab, setTab] = useState<SettingsTab>('general');
	/** Listed only; the files themselves are edited in an ordinary editor tab. */
	const [agents, setAgents] = useState<AgentDefinition[]>([]);
	/** Implement's templates, the same way. */
	const [implementPrompts, setImplementPrompts] = useState<ImplementPromptInfo[]>([]);
	// `<os temp>/bfast-worktrees` resolved for this machine — the host's to know,
	// since a webview has no `os`. Undefined until the first `settings` message.
	const [worktreesDefault, setWorktreesDefault] = useState<string>();
	/** The running extension's version, for the footer. Undefined until the first `settings` message. */
	const [version, setVersion] = useState<string>();
	/**
	 * What the port-variables input shows. Local state rather than a round-trip
	 * through the parsed list, or a half-typed name would be eaten mid-keystroke;
	 * the parsed list is what lands in `settings`.
	 */
	const [portVariablesText, setPortVariablesText] = useState('');
	/**
	 * What the MCP port input shows. Local state for the `portVariablesText`
	 * reason: the parse turns an unusable value into "use the default", so an
	 * erased field would otherwise save fine and surface as a server on a port
	 * nobody asked for.
	 */
	const [mcpPortText, setMcpPortText] = useState(String(DEFAULT_MCP_PORT));
	/** Where the server has got to. The host pushes it; the form never guesses. */
	const [mcpStatus, setMcpStatus] = useState<McpServerStatus>({ state: 'stopped' });
	/**
	 * Whether the last Save landed. The panel no longer closes itself — the MCP
	 * tab has a result to show — so the form has to say that something happened,
	 * and clear it again on the next edit.
	 */
	const [saved, setSaved] = useState(false);
	/**
	 * What the compose chain declares, for the Services checklist — the host's
	 * answer to `listComposeServices`. `undefined` until asked; `error` means
	 * the checklist falls back to free text.
	 */
	const [composeList, setComposeList] = useState<
		{ services: string[]; files: string[]; error?: string } | undefined
	>(undefined);

	useEffect(() => {
		const unsubscribe = onMessage((message) => {
			switch (message.type) {
				case 'settings':
					setSettings(message.settings);
					setConfigured(message.configured);
					setAgents(message.agents ?? []);
					setImplementPrompts(message.implementPrompts ?? []);
					setWorktreesDefault(message.worktreesDefault);
					setVersion(message.version);
					setPortVariablesText((message.settings.environments?.portVariables ?? []).join(', '));
					setMcpPortText(String(mcpPort(message.settings.mcp)));
					setLoaded(true);
					break;
				case 'trackerFolderPicked':
					setSettings((current) => ({ ...current, trackerFolder: message.folder }));
					setError(undefined);
					break;
				case 'worktreesFolderPicked': {
					// The functional form, like the line above: this handler
					// subscribes once and would otherwise close over the first
					// render's `settings`.
					const worktreesFolder = message.folder;
					setSettings((current) => ({
						...current,
						environments: { ...current.environments, worktreesFolder }
					}));
					setError(undefined);
					break;
				}
				case 'serviceFolderPicked': {
					// Functional, for the `worktreesFolderPicked` reason. A blank id and
					// name are proposed from the folder; anything typed is kept.
					const { index, folder } = message;
					setSettings((current) => {
						const services = [...(current.tests?.services ?? [])];
						const row = services[index];
						if (row === undefined) {
							return current;
						}
						const suggested = suggestServiceId(folder);
						services[index] = {
							...row,
							folder,
							id: row.id?.trim() ? row.id : suggested,
							...(row.name?.trim() || !suggested ? {} : { name: folder.split('/').pop() })
						};
						return { ...current, tests: { ...current.tests, services } };
					});
					setError(undefined);
					setSaved(false);
					break;
				}
				case 'composeServices':
					setComposeList({ services: message.services, files: message.files, error: message.error });
					break;
				case 'mcpStatus':
					setMcpStatus(message.status);
					break;
				case 'settingsSaved':
					setSaved(true);
					setError(undefined);
					break;
				case 'settingsError':
					setError(message.message);
					setSaved(false);
					break;
			}
		});

		postMessage({ type: 'settingsReady' });
		return unsubscribe;
	}, []);

	const folderError = validateTrackerFolder(settings.trackerFolder);
	const nameError = validateUserName(settings.userName);
	const aiError = validateAiSettings(settings.ai);
	const envError = validateEnvironmentsSettings(settings.environments);
	// The parse silently drops an unusable token, so the *raw* text needs its
	// own check — otherwise a typo saves fine and only surfaces at Start.
	const portTextError = validatePortVariableText(portVariablesText);
	// Shown under its own field rather than with `envError` at the foot of the
	// tab: the block's one error line is a long scroll away from this input.
	const worktreesError = validateWorktreesFolder(settings.environments?.worktreesFolder ?? '');
	const testsError = validateTestsSettings(settings.tests, settings.trackerFolder);
	const scanError = validateScanSettings(settings.scan);
	const implementError = validateImplementSettings(settings.implement);
	const mcpError = validateMcpSettings(settings.mcp);
	const gitError = validateGitSettings(settings.git);
	// The same trap as the port variables: the parse would quietly fall back to
	// the default, so the raw text is what an empty or non-numeric field is
	// caught by — and only while the server is switched on.
	const mcpPortTextError = validateMcpPortText(mcpPortText, mcpEnabled(settings.mcp));
	// Advisory only, never a refusal: an unknown token is left in the command at
	// render, and a pulled file must not open the form pre-invalid.
	const strayPlaceholders = unknownPlaceholders(settings.tests?.command ?? '');
	const strayEvidencePlaceholders = unknownEvidencePlaceholders(settings.tests?.evidence ?? '');
	const strayEvidenceCommandPlaceholders = unknownEvidenceCommandPlaceholders(
		settings.tests?.evidenceCommand ?? ''
	);
	const strayScanPlaceholders = unknownScanPlaceholders(settings.scan?.command ?? '');
	const strayCommitPlaceholders = unknownCommitMessagePlaceholders(settings.git?.commitMessage ?? '');
	const canSave =
		loaded &&
		!folderError &&
		!nameError &&
		!aiError &&
		!envError &&
		!portTextError &&
		!worktreesError &&
		!testsError &&
		!scanError &&
		!implementError &&
		!mcpError &&
		!gitError &&
		!mcpPortTextError;

	const update = (patch: Partial<BfastSettings>) => {
		setSettings((current) => ({ ...current, ...patch }));
		setError(undefined);
		// The confirmation belongs to the settings that were saved, not to the
		// ones now on screen.
		setSaved(false);
	};

	/** Edits the `ai` block, creating it on first touch. */
	const updateAi = (patch: Partial<AiSettings>) => update({ ai: { ...settings.ai, ...patch } });


	/** Edits the `environments` block, creating it on first touch. */
	const updateEnvironments = (patch: Partial<EnvironmentsSettings>) =>
		update({ environments: { ...settings.environments, ...patch } });

	/** Edits the `tests` block, creating it on first touch. */
	const updateTests = (patch: Partial<TestsSettings>) =>
		update({ tests: { ...settings.tests, ...patch } });

	const services: TestService[] = settings.tests?.services ?? [];
	/** Rewrites the whole list; an empty one collapses to absent. */
	const updateServices = (rows: TestService[]) =>
		updateTests({ services: rows.length > 0 ? rows : undefined });
	const updateService = (index: number, patch: Partial<TestService>) =>
		updateServices(services.map((row, at) => (at === index ? { ...row, ...patch } : row)));
	const addService = () => updateServices([...services, { id: '', folder: '' }]);
	const removeService = (index: number) =>
		updateServices(services.filter((_, at) => at !== index));
	/** Asks the host what the compose chain declares — the form's unsaved one. */
	const refreshComposeServices = () =>
		postMessage({ type: 'listComposeServices', environments: settings.environments });
	const strayServicePlaceholders = (command: string | undefined) =>
		unknownServicePlaceholders(command ?? '');

	/** Edits the `scan` block, creating it on first touch. */
	const updateScan = (patch: Partial<ScanSettings>) =>
		update({ scan: { ...settings.scan, ...patch } });

	/** Edits the `implement` block, creating it on first touch. */
	const updateImplement = (patch: Partial<ImplementSettings>) =>
		update({ implement: { ...settings.implement, ...patch } });

	/** Edits the `git` block, creating it on first touch. */
	const updateGit = (patch: Partial<GitSettings>) => update({ git: { ...settings.git, ...patch } });

	/** Edits the `mcp` block, creating it on first touch. */
	const updateMcp = (patch: Partial<McpSettings>) => update({ mcp: { ...settings.mcp, ...patch } });

	const mcpOn = mcpEnabled(settings.mcp);
	const mcpOffered = mcpFunctions(settings.mcp);
	/** Switches one function on or off. The list is always written whole. */
	const toggleMcpFunction = (id: McpFunctionId, on: boolean) =>
		updateMcp({
			functions: MCP_FUNCTION_IDS.filter((candidate) =>
				candidate === id ? on : mcpOffered.includes(candidate)
			)
		});
	const currentCodingAgent = codingAgentOption(implementAgentId(settings.implement));

	/** Rewrites one analysis-property row; an all-empty list collapses to absent. */
	const updateScanProperties = (rows: ScanProperty[]) =>
		updateScan({
			properties: rows.some((row) => row.key.trim() || row.value.trim()) ? rows : undefined
		});

	const portVariables = environmentPortVariables(settings.environments);
	// Which half of the Scan tab applies. The fields of the other half stay
	// mounted and are only `hidden`, the same reason the tabs themselves are:
	// Save writes the whole object, so switching mode must not look like it
	// discarded what was typed.
	const currentScanMode = resolveScanMode(settings.scan);
	const currentScannerMode = resolveScannerMode(settings.scan);
	const scanProperties = settings.scan?.properties ?? [];

	const save = () => {
		if (canSave) {
			postMessage({ type: 'saveSettings', settings });
		}
	};

	return {
		settings,
		setSettings,
		loaded,
		setLoaded,
		configured,
		setConfigured,
		error,
		setError,
		tab,
		setTab,
		agents,
		setAgents,
		implementPrompts,
		setImplementPrompts,
		worktreesDefault,
		setWorktreesDefault,
		version,
		portVariablesText,
		setPortVariablesText,
		mcpPortText,
		setMcpPortText,
		mcpStatus,
		setMcpStatus,
		saved,
		setSaved,
		folderError,
		nameError,
		aiError,
		envError,
		portTextError,
		worktreesError,
		testsError,
		scanError,
		implementError,
		mcpError,
		gitError,
		mcpPortTextError,
		strayPlaceholders,
		strayEvidencePlaceholders,
		strayEvidenceCommandPlaceholders,
		strayScanPlaceholders,
		strayCommitPlaceholders,
		canSave,
		update,
		updateAi,
		updateEnvironments,
		updateTests,
		updateScan,
		updateImplement,
		updateMcp,
		updateGit,
		mcpOn,
		mcpOffered,
		toggleMcpFunction,
		currentCodingAgent,
		updateScanProperties,
		portVariables,
		currentScanMode,
		currentScannerMode,
		scanProperties,
		services,
		updateService,
		addService,
		removeService,
		composeList,
		refreshComposeServices,
		strayServicePlaceholders,
		save,
	};
}

/** Everything a tab reads and edits — the hook's own answer, so a tab cannot drift from it. */
export type SettingsFormState = ReturnType<typeof useSettingsForm>;
