// The settings function's half of the MCP context: reading and changing the
// `environments` and `tests` blocks of `bfast.json` — services included — on
// behalf of a client. docs/mcp/README.md §Settings is the spec.
//
// `vscode`-free, everything injected (`McpSettingsAccess`), so
// `mcpContext.test.ts` drives it against a literal.
//
// Three rules shape it:
//
// - **A change goes through the form's own checks.** The block is merged,
//   parsed, then the whole candidate is validated by `settingsRefusal` — the
//   function the settings form's Save calls — and written through the same
//   `SettingsService.write`. Two writers, one rule.
// - **Nothing a client sent is dropped in silence.** The parse is forgiving on
//   purpose (a pulled file must load), which over a port would read as "saved"
//   for a value that was thrown away. So a sent field that did not survive the
//   parse — or a list that came back shorter — refuses the whole change, and
//   the answer is the block as it was actually written.
// - **Changes are refused while the server is open to the network.** A command
//   written here is a shell line Run Tests and Environments run on this
//   machine, and the server has no accounts: on `reach: network` that would be
//   code execution for anyone who can reach the port. Reading stays allowed.

import type { BfastSettings } from '../settings/bfastSettings';
import {
	environmentComposeFiles,
	environmentProviderId,
	parseEnvironmentsSettings,
	validateEnvironmentsSettings,
	type EnvironmentsSettings
} from '../settings/environmentSettings';
import { mcpReach } from '../settings/mcpSettings';
import { isServiceId, testServices, validateTestServices, type TestService } from '../settings/testServices';
import {
	parseTestsSettings,
	testsConfigured,
	validateTestsSettings,
	type TestsSettings
} from '../settings/testsSettings';
import type { McpSettingsBlock } from './mcpTools';

/** What the settings tools need of the window — the settings service, narrowed. */
export interface McpSettingsAccess {
	/** The settings on disk, or `undefined` when there is no `bfast.json` yet. */
	current(): BfastSettings | undefined;
	/** Normalises and writes the whole file; answers what was written. */
	write(settings: BfastSettings): Promise<BfastSettings>;
	/** Every rule the settings form's Save applies, the host-side ones included. */
	refusal(candidate: BfastSettings): string | undefined;
	composeServices(
		environments: EnvironmentsSettings | undefined
	): Promise<{ services: string[]; files: string[]; error?: string }>;
	/** Says in the window that a client changed the settings. */
	notify?(message: string): void;
}

/** The provenance a client sees, and the window's notification carries. */
const OVER_MCP = 'over the BFAST MCP server';

/**
 * Every key each block has. `satisfies` holds the lists to the interfaces: a
 * field added to `TestsSettings` without a row here is a compile error, rather
 * than a key a client is told does not exist.
 */
const ENVIRONMENT_KEYS = {
	provider: true,
	worktreesFolder: true,
	portRangeStart: true,
	portRangeEnd: true,
	portVariables: true,
	mainPort: true,
	composeFile: true,
	composeOverrides: true,
	logTail: true
} satisfies Record<keyof EnvironmentsSettings, true>;

const TEST_KEYS = {
	command: true,
	cwd: true,
	resultsFolder: true,
	evidence: true,
	evidenceCommand: true,
	traceFrames: true,
	concurrency: true,
	idleTimeout: true,
	coverage: true,
	services: true
} satisfies Record<keyof TestsSettings, true>;

const KEYS: Record<McpSettingsBlock, readonly string[]> = {
	environments: Object.keys(ENVIRONMENT_KEYS),
	tests: Object.keys(TEST_KEYS)
};

export function mcpSettingsTools(access: McpSettingsAccess | undefined, log?: (line: string) => void) {
	const settings = (): BfastSettings => {
		const current = access?.current();
		if (!access || current === undefined) {
			throw new Error(
				'This workspace has no BFAST settings yet. Open BFAST Settings in the window and save once, then try again.'
			);
		}
		return current;
	};

	/** Why a change cannot be made over this connection, or `undefined`. */
	const writeRefusal = (current: BfastSettings): string | undefined =>
		mcpReach(current.mcp) === 'network'
			? 'Settings cannot be changed over MCP while the server is open to the network: a command written here would run on this machine for anyone who can reach the port. Switch the MCP server’s reach back to “This machine only”, or change the settings in the window.'
			: undefined;

	/**
	 * Merges `changes` into one block, checks it, writes the file. Throws with
	 * a sentence, and writes nothing, on any refusal.
	 */
	const update = async (
		block: McpSettingsBlock,
		changes: Record<string, unknown>
	): Promise<{ saved: true; changed: string[] } & Partial<Record<McpSettingsBlock, unknown>>> => {
		const current = settings();
		const refused = writeRefusal(current);
		if (refused) {
			throw new Error(refused);
		}

		const keys = Object.keys(changes);
		if (keys.length === 0) {
			throw new Error('Nothing to change: send at least one field.');
		}
		const unknown = keys.filter((key) => !KEYS[block].includes(key));
		if (unknown.length > 0) {
			throw new Error(
				`${quoteList(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not ${block} settings. The ${block} block takes: ${KEYS[block].join(', ')}.`
			);
		}

		const merged: Record<string, unknown> = { ...(current[block] ?? {}) };
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) {
				delete merged[key];
			} else {
				merged[key] = value;
			}
		}
		const parsed = (block === 'tests' ? parseTestsSettings(merged) : parseEnvironmentsSettings(merged)) as
			| Record<string, unknown>
			| undefined;

		for (const [key, value] of Object.entries(changes)) {
			if (value === null || isBlank(value)) {
				continue;
			}
			const kept = parsed?.[key];
			const shortened = Array.isArray(value) && Array.isArray(kept) && kept.length < value.length;
			if (kept === undefined || shortened) {
				throw new Error(
					`${unusable(block, key, value) ?? `“${key}” has a value BFAST cannot use${shortened ? ' — part of the list was refused (a bad or repeated entry)' : ''}.`} Nothing was written.`
				);
			}
		}

		const candidate: BfastSettings = { ...current };
		if (parsed === undefined) {
			delete candidate[block];
		} else {
			(candidate as unknown as Record<string, unknown>)[block] = parsed;
		}
		const error = access!.refusal(candidate);
		if (error) {
			throw new Error(`${error} Nothing was written.`);
		}

		const written = await access!.write(candidate);
		const changed = keys.map((key) => `${block}.${key}`);
		log?.(`— Settings changed ${OVER_MCP}: ${changed.join(', ')}`);
		access!.notify?.(`BFAST settings changed ${OVER_MCP}: ${changed.join(', ')}.`);
		return { saved: true, changed, [block]: written[block] ?? {} };
	};

	return {
		getSettings: async () => {
			const current = settings();
			const refused = writeRefusal(current);
			return {
				writable: refused === undefined,
				...(refused === undefined ? {} : { readOnlyReason: refused }),
				environments: current.environments ?? {},
				tests: current.tests ?? {},
				effective: {
					environmentProvider: environmentProviderId(current.environments),
					composeFiles: environmentComposeFiles(current.environments),
					// The gate on Run Tests: a project command, or one service
					// that can run a test case.
					testsConfigured: testsConfigured(current.tests)
				}
			};
		},

		listComposeServices: async () => {
			const current = settings();
			return access!.composeServices(current.environments);
		},

		updateSettings: update,

		setTestService: async (raw: Record<string, unknown>) => {
			const id = typeof raw.id === 'string' ? raw.id.trim() : '';
			if (!isServiceId(id)) {
				throw new Error(
					'A service needs an "id": lower-case letters, digits and hyphens, starting with a letter or digit — "orders", "billing-api".'
				);
			}
			const services: unknown[] = [...testServices(settings().tests)];
			const index = services.findIndex((service) => (service as TestService).id === id);
			const replaced = index >= 0;
			if (replaced) {
				services[index] = { ...raw, id };
			} else {
				services.push({ ...raw, id });
			}
			const result = await update('tests', { services });
			const tests = result.tests as TestsSettings | undefined;
			return {
				saved: true,
				[replaced ? 'replaced' : 'added']: id,
				service: testServices(tests).find((service) => service.id === id)
			};
		},

		removeTestService: async (id: string) => {
			const services = testServices(settings().tests);
			if (!services.some((service) => service.id === id)) {
				throw new Error(
					`No service “${id}” in the tests settings${services.length > 0 ? ` — it has ${quoteList(services.map((service) => service.id))}` : ''}.`
				);
			}
			const rest = services.filter((service) => service.id !== id);
			await update('tests', { services: rest.length > 0 ? rest : null });
			return { saved: true, removed: id, services: rest.map((service) => service.id) };
		},

		/** The service ids a test case may be assigned to — `undefined` when settings cannot be read. */
		serviceIds: (): string[] | undefined => {
			const current = access?.current();
			return current === undefined ? undefined : testServices(current.tests).map((service) => service.id);
		}
	};
}

/**
 * The validator's own sentence for one field, when it has one — asked of the
 * field alone, and guarded, since a wrongly typed value is exactly what the
 * typed validators were never written for.
 */
function unusable(block: McpSettingsBlock, key: string, value: unknown): string | undefined {
	try {
		if (block === 'tests') {
			return key === 'services'
				? validateTestServices(value as TestService[])
				: validateTestsSettings({ [key]: value } as TestsSettings);
		}
		return validateEnvironmentsSettings({ [key]: value } as EnvironmentsSettings);
	} catch {
		return undefined;
	}
}

function isBlank(value: unknown): boolean {
	return (typeof value === 'string' && value.trim().length === 0) || (Array.isArray(value) && value.length === 0);
}

function quoteList(items: readonly string[]): string {
	return items.map((item) => `“${item}”`).join(', ');
}
