// What the MCP server offers, and what calling one of them means.
//
// The Node-free half, the `testReport.ts` / `scanReport.ts` rule: the tool
// table is imported by the settings webview (the MCP tab lists every function
// with the tools it carries, so "which functions it offers" is a list of real
// names rather than six adjectives) and by the server, and `callMcpTool` is
// pure dispatch against an injected `McpToolContext` — which is what lets
// `mcpTools.test.ts` exercise every tool without a port, a tracker or a
// `vscode` import.
//
// A tool belongs to exactly one function (`McpFunctionId`). That membership is
// declared here and nowhere else: the settings block stores the function ids,
// the server filters `tools/list` through them, and `callMcpTool` checks the
// same set again at call time — because a client that listed a tool a moment
// before the user switched its function off must not be able to call it.

import type { TicketStatus, TicketSummary, TicketType } from '../data/types';
import { TICKET_STATUSES, TICKET_TYPES } from '../data/types';
import { LINK_RELATIONS, type LinkRelation } from '../data/ticketLinks';
import type { McpFunctionId } from '../settings/mcpSettings';
import { errorMessage } from '../platform/errors';

/** A JSON Schema object, only as deep as a tool's arguments actually go. */
export interface McpInputSchema {
	type: 'object';
	properties: Record<string, { type: string; description: string; enum?: readonly string[] }>;
	required?: string[];
	additionalProperties: false;
}

export interface McpToolDefinition {
	name: string;
	/** The function that has to be switched on for this tool to exist. */
	group: McpFunctionId;
	/** What a client shows its model; it is the only documentation a client gets. */
	description: string;
	inputSchema: McpInputSchema;
}

/** What one function is called and why someone would switch it on. */
export interface McpFunctionDescription {
	id: McpFunctionId;
	label: string;
	hint: string;
}

export const MCP_FUNCTION_DESCRIPTIONS: readonly McpFunctionDescription[] = [
	{
		id: 'read',
		label: 'Read tickets and their descriptions',
		hint: 'The tree, and one ticket’s description, metadata and history.'
	},
	{
		id: 'write',
		label: 'Create, rename and link tickets',
		hint: 'Writes into the tracker under your name, exactly as the board does — links included. Deleting is never offered.'
	},
	{
		id: 'designs',
		label: 'Read and edit technical design documents',
		hint: 'The ERDs, sequence diagrams and low level designs on an epic or a story: list, read, add and rewrite them. Deleting is never offered.'
	},
	{
		id: 'status',
		label: 'Change a ticket’s status',
		hint: 'Moves a ticket between To do, In progress, In review, Done and Blocked.'
	},
	{
		id: 'tests',
		label: 'Run tests',
		hint: 'Starts a Run Tests batch for a ticket’s subtree and answers at once — it never waits for the run — and assigns a test case to the service it runs as.'
	},
	{
		id: 'scan',
		label: 'Run a code scan',
		hint: 'Opens the scan tab for a ticket’s environment, or the workspace, and starts the analysis there.'
	},
	{
		id: 'environments',
		label: 'Start and stop environments',
		hint: 'Lists the dev environments and starts or stops one. Creating and deleting are never offered.'
	},
	{
		id: 'settings',
		label: 'Read and change test and environment settings',
		hint: 'The environments and tests blocks of bfast.json, services included. Every command written here is a shell line Run Tests and Environments run on this machine — so changes are refused while the server is open to the network.'
	}
];

const TICKET_ID: McpInputSchema['properties'][string] = {
	type: 'string',
	description: 'The full ticket id, as BFAST writes it — EP-1, ST-1.2, AC-1.2.1, TC-1.2.1.1.'
};

const DESIGN_TICKET_ID: McpInputSchema['properties'][string] = {
	type: 'string',
	description: 'The epic or story the design documents belong to — EP-1, ST-1.2.'
};

const DESIGN_ID: McpInputSchema['properties'][string] = {
	type: 'string',
	description: 'The design document’s id within its ticket, as list_designs answers it — ERD-1, LLD-2.'
};

/**
 * A tool in full: what a client is told about it, and what calling it does.
 *
 * The two used to be a table here and a `switch` four hundred lines further
 * down, joined only by the name. One object means a tool cannot be listed
 * without being callable, or callable without being listed.
 */
interface McpTool extends McpToolDefinition {
	/**
	 * Reads its own arguments and does the work. A `McpToolCallError` thrown from
	 * here is a fault in the request; any other failure is the work's, and comes
	 * back to the client as `isError` content.
	 */
	run(
		context: McpToolContext,
		args: Record<string, unknown>,
		functions: readonly McpFunctionId[]
	): Promise<unknown>;
}

const TOOLS: readonly McpTool[] = [
	{
		name: 'list_tickets',
		group: 'read',
		description:
			'List tickets one level at a time. With no parent, the epics; with a parent, that ticket’s direct children. Each entry carries its id, type, title, status and whether it has children of its own.',
		inputSchema: {
			type: 'object',
			properties: {
				parentId: {
					type: 'string',
					description: 'List this ticket’s direct children. Omit for the top-level epics.'
				}
			},
			additionalProperties: false
		},
		run: async (context, args) => {
			return { tickets: await context.listTickets(optionalString(args, 'parentId')) };
		}
	},
	{
		name: 'get_ticket',
		group: 'read',
		description:
			'Read one ticket in full: its description (markdown), status, assignee, timestamps, history, and its links to other tickets (`links`: each a relation — blocks, is-blocked-by, relates-to, duplicates, is-duplicated-by, clones, is-cloned-by — and the other ticket’s id, with its title and status when it is still in the tracker).',
		inputSchema: {
			type: 'object',
			properties: { id: TICKET_ID },
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args) => {
			const id = requiredString(args, 'id');
			const ticket = await context.getTicket(id);
			if (ticket === undefined) {
				throw new Error(`No ticket “${id}” in this workspace’s tracker.`);
			}
			return ticket;
		}
	},
	{
		name: 'create_ticket',
		group: 'write',
		description:
			'Create a ticket under a parent — a sub-epic or a story under an epic, an acceptance criterion under a story, a test case under an epic, a story or an acceptance criterion. Omit the parent to create a top-level epic. BFAST assigns the id.',
		inputSchema: {
			type: 'object',
			properties: {
				parentId: {
					type: 'string',
					description: 'The parent ticket’s id. Omit to create a top-level epic.'
				},
				type: {
					type: 'string',
					description: 'What to create.',
					enum: TICKET_TYPES
				},
				title: { type: 'string', description: 'The ticket’s title.' },
				description: {
					type: 'string',
					description: 'The ticket’s description, in markdown. Optional; it can be written later.'
				}
			},
			required: ['type', 'title'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.createTicket({
				...withKey('parentId', optionalString(args, 'parentId')),
				type: requiredEnum(args, 'type', TICKET_TYPES),
				title: requiredString(args, 'title'),
				...withKey('description', optionalString(args, 'description'))
			});
		}
	},
	{
		name: 'rename_ticket',
		group: 'write',
		description:
			'Change a ticket’s title. Its id and its children are untouched — only the folder’s slug is rewritten.',
		inputSchema: {
			type: 'object',
			properties: { id: TICKET_ID, title: { type: 'string', description: 'The new title.' } },
			required: ['id', 'title'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.renameTicket(requiredString(args, 'id'), requiredString(args, 'title'));
		}
	},
	{
		name: 'link_tickets',
		group: 'write',
		description:
			'Link two tickets: “id <relation> targetId”, e.g. ST-1.1 blocks ST-1.2. The other ticket records the inverse (is blocked by) on its own, so link once from either side. Linking what is already linked changes nothing. get_ticket answers a ticket’s links.',
		inputSchema: {
			type: 'object',
			properties: {
				id: TICKET_ID,
				relation: {
					type: 'string',
					description: 'How `id` relates to `targetId`, read from `id`’s side.',
					enum: LINK_RELATIONS
				},
				targetId: { ...TICKET_ID, description: 'The other ticket’s full id.' }
			},
			required: ['id', 'relation', 'targetId'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.linkTickets(
				requiredString(args, 'id'),
				requiredEnum(args, 'relation', LINK_RELATIONS),
				requiredString(args, 'targetId')
			);
		}
	},
	{
		name: 'unlink_tickets',
		group: 'write',
		description:
			'Remove a link between two tickets, from both of them. Name it as get_ticket answers it: the ticket, the relation and the other ticket’s id. A link that is not there changes nothing.',
		inputSchema: {
			type: 'object',
			properties: {
				id: TICKET_ID,
				relation: {
					type: 'string',
					description: 'The relation as `id` records it.',
					enum: LINK_RELATIONS
				},
				targetId: { ...TICKET_ID, description: 'The other ticket’s full id.' }
			},
			required: ['id', 'relation', 'targetId'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.unlinkTickets(
				requiredString(args, 'id'),
				requiredEnum(args, 'relation', LINK_RELATIONS),
				requiredString(args, 'targetId')
			);
		}
	},
	{
		name: 'list_designs',
		group: 'designs',
		description:
			'List the technical design documents on an epic or a story — entity-relationship diagrams (ERD), sequence diagrams (SEQ), low level designs (LLD) and any style the workspace adds — and the styles a new one can be created in. Each document carries its id (ERD-1, LLD-2), style, title and updatedAt.',
		inputSchema: {
			type: 'object',
			properties: { ticketId: DESIGN_TICKET_ID },
			required: ['ticketId'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.listDesigns(requiredString(args, 'ticketId'));
		}
	},
	{
		name: 'get_design',
		group: 'designs',
		description:
			'Read one design document in full: its body (markdown, diagrams as ```mermaid fences), style, title and updatedAt. Pass updatedAt back to update_design to refuse overwriting a change made since.',
		inputSchema: {
			type: 'object',
			properties: { ticketId: DESIGN_TICKET_ID, designId: DESIGN_ID },
			required: ['ticketId', 'designId'],
			additionalProperties: false
		},
		run: async (context, args) => {
			const ticketId = requiredString(args, 'ticketId');
			const designId = requiredString(args, 'designId');
			const design = await context.getDesign(ticketId, designId);
			if (design === undefined) {
				throw new Error(
					`No design document “${designId}” on ${ticketId}. Call list_designs to see which ones exist.`
				);
			}
			return design;
		}
	},
	{
		name: 'create_design',
		group: 'designs',
		description:
			'Add a design document to an epic or a story. BFAST assigns the id (the style’s prefix and the next free number). Write each diagram as its own ```mermaid fence — an ERD as one erDiagram, a sequence diagram as one sequenceDiagram; a low level design is free-form markdown with any number of diagrams, or none.',
		inputSchema: {
			type: 'object',
			properties: {
				ticketId: DESIGN_TICKET_ID,
				style: {
					type: 'string',
					description:
						'The style: its id (entity-relationship-diagram, sequence-diagram, low-level-design) or its prefix (ERD, SEQ, LLD). list_designs names every style the workspace offers.'
				},
				title: { type: 'string', description: 'The document’s title.' },
				body: {
					type: 'string',
					description: 'The document, in markdown. Optional; it can be written later with update_design.'
				}
			},
			required: ['ticketId', 'style', 'title'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.createDesign({
				ticketId: requiredString(args, 'ticketId'),
				style: requiredString(args, 'style'),
				title: requiredString(args, 'title'),
				...withKey('body', optionalBody(args, 'body'))
			});
		}
	},
	{
		name: 'update_design',
		group: 'designs',
		description:
			'Replace a design document’s body with a new one, in full — send the whole document, not a fragment. Its id, title and style are kept. The ticket’s history records the change.',
		inputSchema: {
			type: 'object',
			properties: {
				ticketId: DESIGN_TICKET_ID,
				designId: DESIGN_ID,
				body: { type: 'string', description: 'The complete new document, in markdown.' },
				baseUpdatedAt: {
					type: 'string',
					description:
						'The updatedAt get_design answered. When given, the write is refused if the document changed since — someone else saved it. Omit to overwrite whatever is there.'
				}
			},
			required: ['ticketId', 'designId', 'body'],
			additionalProperties: false
		},
		run: async (context, args) => {
			const body = optionalBody(args, 'body');
			if (body === undefined) {
				throw new McpToolCallError('“body” is required.');
			}
			return context.updateDesign({
				ticketId: requiredString(args, 'ticketId'),
				designId: requiredString(args, 'designId'),
				body,
				...withKey('baseUpdatedAt', optionalString(args, 'baseUpdatedAt'))
			});
		}
	},
	{
		name: 'set_ticket_status',
		group: 'status',
		description: 'Move a ticket to a status. The change is recorded in the ticket’s history.',
		inputSchema: {
			type: 'object',
			properties: {
				id: TICKET_ID,
				status: { type: 'string', description: 'The status to move to.', enum: TICKET_STATUSES }
			},
			required: ['id', 'status'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.setStatus(
				requiredString(args, 'id'),
				requiredEnum(args, 'status', TICKET_STATUSES)
			);
		}
	},
	{
		name: 'run_tests',
		group: 'tests',
		description:
			'Start a test run for every test case in a ticket’s subtree. Returns as soon as the batch has started — it does not wait for the tests. Read the test cases back with get_ticket to see the statuses the run set. Asking again while the batch is running starts nothing.',
		inputSchema: {
			type: 'object',
			properties: { id: TICKET_ID },
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args, functions) => {
			const report = await context.runTests(requiredString(args, 'id'));
			// A run's verdicts are read back through `get_ticket`. A client whose
			// `read` is off could start runs it can never see the outcome of, and
			// is told so plainly rather than left guessing — the switch is not
			// flipped for it, it is only named.
			return report.started && !functions.includes('read')
				? { ...report, message: `${report.message} ${READ_OFF_NOTE}` }
				: report;
		}
	},
	{
		name: 'set_test_case_service',
		group: 'tests',
		description:
			'Assign a test case to one of the services in the tests settings, or clear it. A test case with a service runs with that service’s test case command, in its folder, after its compose services are up; one without runs with the project test command. Call get_settings (the "settings" function) or read the board to see which services exist.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'The test case’s id — TC-1.2.1.1.' },
				service: {
					type: 'string',
					description: 'The service id, as the tests settings declare it. Omit, or send an empty string, to clear it.'
				}
			},
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.setTestCaseService(requiredString(args, 'id'), optionalString(args, 'service'));
		}
	},
	{
		name: 'run_scan',
		group: 'scan',
		description:
			'Start a code scan. With a ticket id, its environment’s worktree is analysed; with none, the workspace is. The results open in a BFAST tab in the editor. Returns as soon as the scan has started, and asking again for the same target starts nothing.',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description:
						'The ticket whose environment should be scanned. Omit to scan the workspace itself.'
				}
			},
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.runScan(optionalString(args, 'id'));
		}
	},
	{
		name: 'list_environments',
		group: 'environments',
		description:
			'List the dev environments: which ticket each belongs to, its branch, its status and the ports it was allocated.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		run: async (context) => {
			return { environments: await context.listEnvironments() };
		}
	},
	{
		name: 'start_environment',
		group: 'environments',
		description:
			'Start an environment’s stack. Returns as soon as it has started starting — a stack takes minutes to come up. Read list_environments back to see when it is running.',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: 'The environment’s id: the ticket it belongs to, or "master".'
				}
			},
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.startEnvironment(requiredString(args, 'id'));
		}
	},
	{
		name: 'stop_environment',
		group: 'environments',
		description:
			'Stop an environment’s stack. Returns as soon as it has started stopping. Its worktree and its data are kept.',
		inputSchema: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: 'The environment’s id: the ticket it belongs to, or "master".'
				}
			},
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.stopEnvironment(requiredString(args, 'id'));
		}
	},
	{
		name: 'get_settings',
		group: 'settings',
		description:
			'Read the environments and tests blocks of this workspace’s BFAST settings (.vscode/bfast.json): the compose files and port variables environments use, the project test command, and every service with its folder, unit suite, e2e suite and the compose services that suite needs. Also says whether the settings can be changed over this connection.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		run: async (context) => {
			return context.getSettings();
		}
	},
	{
		name: 'list_compose_services',
		group: 'settings',
		description:
			'List the services the environments’ compose files declare (docker compose config --services) — the names a service’s e2e "compose" list may name.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		run: async (context) => {
			return context.listComposeServices();
		}
	},
	{
		name: 'update_environment_settings',
		group: 'settings',
		description:
			'Change fields of the environments settings: provider, worktreesFolder, portRangeStart, portRangeEnd, portVariables, mainPort, composeFile, composeOverrides, logTail. Only the fields sent change; null clears one. The whole block is validated as the settings form validates it, and nothing is written when any of it is refused.',
		inputSchema: {
			type: 'object',
			properties: {
				changes: {
					type: 'object',
					description: 'The fields to set, e.g. { "composeOverrides": ["docker-compose.e2e.yml"] }. null clears a field.'
				}
			},
			required: ['changes'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.updateSettings('environments', requiredObject(args, 'changes'));
		}
	},
	{
		name: 'update_test_settings',
		group: 'settings',
		description:
			'Change fields of the tests settings: command, cwd, resultsFolder, evidence, evidenceCommand, traceFrames, concurrency, idleTimeout, coverage, services. Only the fields sent change; null clears one. "services" replaces the whole list — set_test_service changes one. Commands take {{id}}, {{key}} and {{folder}}. Nothing is written when any of it is refused.',
		inputSchema: {
			type: 'object',
			properties: {
				changes: {
					type: 'object',
					description: 'The fields to set, e.g. { "command": "npx playwright test --grep {{id}}" }. null clears a field.'
				}
			},
			required: ['changes'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.updateSettings('tests', requiredObject(args, 'changes'));
		}
	},
	{
		name: 'set_test_service',
		group: 'settings',
		description:
			'Add a service to the tests settings, or replace the one with the same id. A service is { id, name?, folder, unit?: { command?, coverage? }, e2e?: { command?, testCommand?, coverage?, compose?: string[] } }: id is lower-case letters, digits and hyphens; folder is relative to the workspace; e2e.testCommand runs one test case assigned to it ({{id}}, {{key}}, {{folder}}); e2e.compose names compose services brought up in the Master environment first.',
		inputSchema: {
			type: 'object',
			properties: {
				service: { type: 'object', description: 'The service in full — it replaces any service with the same id.' }
			},
			required: ['service'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.setTestService(requiredObject(args, 'service'));
		}
	},
	{
		name: 'remove_test_service',
		group: 'settings',
		description:
			'Remove a service from the tests settings. Test cases still assigned to it keep the assignment and are reported as unrunnable until they are reassigned or it is added back.',
		inputSchema: {
			type: 'object',
			properties: { id: { type: 'string', description: 'The service id.' } },
			required: ['id'],
			additionalProperties: false
		},
		run: async (context, args) => {
			return context.removeTestService(requiredString(args, 'id'));
		}
	}
];

/**
 * What `tools/list` answers and the settings tab lists: every tool's definition,
 * without the function that runs it.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = TOOLS.map(
	({ name, group, description, inputSchema }) => ({ name, group, description, inputSchema })
);

/** The tools of the functions that are switched on, in `MCP_TOOLS` order. */
export function enabledTools(functions: readonly McpFunctionId[]): McpToolDefinition[] {
	return MCP_TOOLS.filter((tool) => functions.includes(tool.group));
}

/** The tools one function carries — what the settings tab lists under it. */
export function toolsOf(group: McpFunctionId): McpToolDefinition[] {
	return MCP_TOOLS.filter((tool) => tool.group === group);
}

/** An environment, flattened to what a client can actually use. */
export interface McpEnvironmentInfo {
	id: string;
	ticketId?: string;
	title?: string;
	branch?: string;
	status: string;
	/** Why the last operation failed, while `status` is `error`. */
	error?: string;
	ports?: Record<string, number>;
	worktreePath?: string;
}

/** A design document as a client sees it: the file's frontmatter flattened, and its body. */
export interface McpDesignSummary {
	id: string;
	ticketId: string;
	style: string;
	title: string;
	fileName: string;
	updatedAt?: string;
}

export interface McpDesignDocument extends McpDesignSummary {
	body: string;
	createdBy?: string;
	createdAt?: string;
}

/** A style a document can be created in. */
export interface McpDesignStyle {
	id: string;
	label: string;
	prefix: string;
}

/**
 * What a tool that only *starts* something answers.
 *
 * `started` is false when the work was already running, which is not a failure:
 * it is the answer a client that gave up waiting and retried should get.
 */
export interface McpActionReport {
	started: boolean;
	message: string;
}

/**
 * Everything the tools need from the window, and nothing else.
 *
 * No `vscode` import here on purpose — the implementation in `mcpContext.ts`
 * is the `vscode` half, and `FakeMcpContext` in the tests is the seam's proof.
 */
export interface McpToolContext {
	listTickets(parentId: string | undefined): Promise<TicketSummary[]>;
	getTicket(id: string): Promise<unknown>;
	createTicket(request: {
		parentId?: string;
		type: TicketType;
		title: string;
		description?: string;
	}): Promise<TicketSummary>;
	renameTicket(id: string, title: string): Promise<TicketSummary>;
	/** Answers the ticket as it now stands, its links included. */
	linkTickets(id: string, relation: LinkRelation, targetId: string): Promise<unknown>;
	unlinkTickets(id: string, relation: LinkRelation, targetId: string): Promise<unknown>;
	setStatus(id: string, status: TicketStatus): Promise<TicketSummary>;
	listDesigns(
		ticketId: string
	): Promise<{ designs: McpDesignSummary[]; styles: McpDesignStyle[] }>;
	getDesign(ticketId: string, designId: string): Promise<McpDesignDocument | undefined>;
	createDesign(request: {
		ticketId: string;
		style: string;
		title: string;
		body?: string;
	}): Promise<McpDesignDocument>;
	updateDesign(request: {
		ticketId: string;
		designId: string;
		body: string;
		baseUpdatedAt?: string;
	}): Promise<McpDesignDocument>;
	runTests(id: string): Promise<McpActionReport>;
	runScan(id: string | undefined): Promise<McpActionReport>;
	listEnvironments(): Promise<McpEnvironmentInfo[]>;
	startEnvironment(id: string): Promise<McpActionReport>;
	stopEnvironment(id: string): Promise<McpActionReport>;
	/** `service` undefined clears the assignment. */
	setTestCaseService(id: string, service: string | undefined): Promise<TicketSummary>;
	getSettings(): Promise<unknown>;
	listComposeServices(): Promise<unknown>;
	/** Only the keys in `changes` move; a `null` clears one. */
	updateSettings(block: McpSettingsBlock, changes: Record<string, unknown>): Promise<unknown>;
	setTestService(service: Record<string, unknown>): Promise<unknown>;
	removeTestService(id: string): Promise<unknown>;
}

/** The two blocks of `bfast.json` the settings tools may change. */
export type McpSettingsBlock = 'environments' | 'tests';

/** One `tools/call` result: content plus whether it is a failure the model should read. */
export interface McpToolResult {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
}

/**
 * Thrown when the call is not one the server can dispatch at all — an unknown
 * name, a tool whose function is switched off, or arguments that do not fit the
 * schema. It becomes a JSON-RPC error rather than an `isError` result, because
 * it is a fault in the request, not in the work.
 */
export class McpToolCallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'McpToolCallError';
	}
}

/**
 * Runs one tool.
 *
 * `functions` is re-checked here rather than trusted from `tools/list`: the
 * user may have switched a function off between the two calls, and "a function
 * that is switched off cannot be called, even by a client that knew about it a
 * moment ago" is the rule that makes the switches mean anything.
 *
 * Work that fails comes back as `isError` content, which is what an MCP client
 * shows its model; only a malformed call throws.
 */
export async function callMcpTool(
	context: McpToolContext,
	functions: readonly McpFunctionId[],
	name: string,
	rawArguments: unknown
): Promise<McpToolResult> {
	const tool = TOOLS.find((candidate) => candidate.name === name);
	if (!tool) {
		throw new McpToolCallError(`Unknown tool “${name}”.`);
	}
	if (!functions.includes(tool.group)) {
		throw new McpToolCallError(
			`The “${name}” tool is not available: the “${tool.group}” function is switched off in this workspace’s BFAST settings.`
		);
	}

	const args = readArguments(rawArguments);

	try {
		return json(await tool.run(context, args, functions));
	} catch (failure) {
		if (failure instanceof McpToolCallError) {
			throw failure;
		}
		return {
			content: [
				{ type: 'text', text: errorMessage(failure) }
			],
			isError: true
		};
	}
}

/** Appended to a started run's answer when the client cannot read the verdicts back. */
export const READ_OFF_NOTE =
	'Note: the “read” function is switched off in this workspace’s BFAST settings, so this client cannot read the verdicts back; a person has to switch it on.';

/** `{ key: value }` when the value is there, `{}` when it is not, so it spreads. */
function withKey<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** JSON in a text block — the shape every MCP client can render and every model can read. */
function json(value: unknown): McpToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, undefined, 2) }] };
}

function readArguments(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new McpToolCallError('Tool arguments must be an object.');
	}
	return raw as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
	const value = optionalString(args, key);
	if (value === undefined) {
		throw new McpToolCallError(`“${key}” is required.`);
	}
	return value;
}

function requiredObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = args[key];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new McpToolCallError(`“${key}” must be an object.`);
	}
	return value as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new McpToolCallError(`“${key}” must be a string.`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A document body: a string, kept **verbatim** — `optionalString` trims, and a
 * body's leading indentation or trailing newline is the author's. An empty
 * string is a real answer for `update_design` (clear the document), so only a
 * missing key is `undefined`.
 */
function optionalBody(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new McpToolCallError(`“${key}” must be a string.`);
	}
	return value;
}

function requiredEnum<T extends string>(
	args: Record<string, unknown>,
	key: string,
	allowed: readonly T[]
): T {
	const value = requiredString(args, key);
	if (!allowed.includes(value as T)) {
		throw new McpToolCallError(`“${key}” must be one of: ${allowed.join(', ')}.`);
	}
	return value as T;
}
