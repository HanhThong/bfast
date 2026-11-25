// What the MCP tools actually do, in terms of the stores the window already has.
//
// The `bfastAiContext` / `bfastScanContext` idiom: a factory that closes over
// the window's stores and answers the seam's interface, so `extension.ts` gains
// one object rather than ten closures, and `McpToolContext` never learns that a
// tracker is folders or that an environment is a worktree.
//
// The one rule that shapes every method here: **nothing waits for long work.**
// A test run, a scan and a stack start all take minutes, and an HTTP request
// that hangs that long is one the client times out — after which it retries. So
// each of those four starts the work, answers at once, and leans on the guard
// the sidebar already uses so that the retry starts nothing a second time. See
// docs/mcp/README.md §Long-running work.

import type { TicketStatus, TicketSummary, TicketType } from '../data/types';
import { TicketConflictError, type WritableTicketStore } from '../data/ticketStore';
import {
	allowsDesigns,
	ensureMermaidFence,
	type DesignDocument,
	type DesignStyle,
	type DesignSummary
} from '../design/designDocument';
import type { DesignStore } from '../design/designStore';
import type { EnvironmentStore } from '../environments/environmentStore';
import type { TestBatches } from '../testing/testBatches';
import type {
	McpActionReport,
	McpDesignDocument,
	McpDesignStyle,
	McpDesignSummary,
	McpEnvironmentInfo,
	McpToolContext
} from './mcpTools';
import { errorMessage } from '../platform/errors';
import { mcpSettingsTools, type McpSettingsAccess } from './mcpSettingsContext';

/** Every write this server makes says so, so a reader can tell where a change came from. */
export const MCP_PROVENANCE = 'over the BFAST MCP server';

/** What the tools need of the environment store — a `Pick`, so a test can hand in a literal. */
export type McpEnvironments = Pick<
	EnvironmentStore,
	'list' | 'find' | 'start' | 'stop' | 'availability'
>;

/** What the design tools need of the design store — a `Pick`, the `McpEnvironments` idiom. */
export type McpDesigns = Pick<DesignStore, 'styles' | 'list' | 'get' | 'create' | 'update'>;

export interface McpContextDeps {
	store: WritableTicketStore;
	/**
	 * The technical design documents. Optional so a context built without them
	 * — a test that only drives tickets — refuses the design tools in words
	 * rather than failing to construct.
	 */
	designs?: McpDesigns;
	batches: TestBatches;
	environments: McpEnvironments;
	/**
	 * Called after every write that landed. The sidebar's own commands refresh
	 * the tree themselves, and the tracker watcher drops events that land while
	 * the store is writing — so a write nobody in the window asked for has to
	 * announce itself, or the sidebar and the open boards stay behind.
	 */
	onDidWrite?(): void;
	/**
	 * Starts a scan of a ticket's environment, or of the workspace when no
	 * ticket is named. A closure rather than the scan services: the scan runs in
	 * a `ScanPanel`, which is a `vscode` webview, and this module must stay the
	 * only place the tools' *meaning* lives.
	 */
	startScan(ticketId: string | undefined): Promise<McpActionReport>;
	/** Diagnostics, into the "BFAST MCP" channel. */
	log?(line: string): void;
	/**
	 * `bfast.json`, for the settings tools and for checking a service exists.
	 * Optional so a context built without it refuses those tools in words.
	 */
	settings?: McpSettingsAccess;
}

export function bfastMcpContext(deps: McpContextDeps): McpToolContext {
	const settingsTools = mcpSettingsTools(deps.settings, (line) => deps.log?.(line));
	return {
		getSettings: settingsTools.getSettings,
		listComposeServices: settingsTools.listComposeServices,
		updateSettings: settingsTools.updateSettings,
		setTestService: settingsTools.setTestService,
		removeTestService: settingsTools.removeTestService,

		/**
		 * The store refuses anything but a test case and a malformed id; the
		 * service has to exist as well, which only the settings can say — the
		 * sidebar's pick offers only the declared ones, and a client gets the
		 * same rule in words. The same service again is a non-event.
		 */
		setTestCaseService: async (id, service) => {
			const current = await deps.store.getSummary(id);
			if (!current) {
				throw new Error(`No ticket “${id}” in this workspace’s tracker.`);
			}
			if (current.type !== 'testcase') {
				throw new Error(`Only a test case runs as a service; ${id} is not one.`);
			}
			const known = settingsTools.serviceIds();
			if (service !== undefined && known !== undefined && !known.includes(service)) {
				throw new Error(
					known.length > 0
						? `No service “${service}” in the tests settings. It declares: ${known.join(', ')}.`
						: `No service “${service}”: the tests settings declare no services yet.`
				);
			}
			if (current.service === service) {
				return summaryOf(current);
			}
			const detail = await deps.store.setService(id, service, {
				comment: `Set ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return summaryOf(detail);
		},

		listTickets: (parentId) => deps.store.listChildren(parentId),

		getTicket: (id) => deps.store.getDetail(id),

		createTicket: async (request) => {
			const created = await deps.store.createTicket({
				...(request.parentId === undefined ? {} : { parentId: request.parentId }),
				type: request.type as TicketType,
				title: request.title,
				...(request.description === undefined ? {} : { description: request.description }),
				comment: `Created ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return created;
		},

		renameTicket: async (id, title) => {
			const renamed = await deps.store.renameTicket(id, title, {
				comment: `Renamed ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return renamed;
		},

		linkTickets: async (id, relation, targetId) => {
			const ticket = await deps.store.linkTickets(id, relation, targetId, {
				comment: `Linked ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return ticket;
		},

		unlinkTickets: async (id, relation, targetId) => {
			const ticket = await deps.store.unlinkTickets(id, relation, targetId, {
				comment: `Unlinked ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return ticket;
		},

		/**
		 * A ticket already in the requested status is left alone — no entry, no
		 * `updatedAt` bump — the way the sidebar's Set status treats picking the
		 * current one. A tool that retries, or sets the same status on every
		 * loop, must not bury the ticket's real history under non-events.
		 */
		setStatus: async (id, status) => {
			const current = await deps.store.getSummary(id);
			if (!current) {
				throw new Error(`No ticket “${id}” in this workspace’s tracker.`);
			}
			if (current.status === status) {
				return summaryOf(current);
			}
			const detail = await deps.store.updateStatus(id, status as TicketStatus, {
				comment: `Set ${MCP_PROVENANCE}.`
			});
			deps.onDidWrite?.();
			return summaryOf(detail);
		},

		/**
		 * `testBatches.start` already refuses a root that is running and one whose
		 * test cases overlap a running batch, which is exactly the "do not start it
		 * twice when the client retries" rule — so a refusal is reported as a
		 * non-failure, not thrown.
		 */
		listDesigns: async (ticketId) => {
			const { designs } = await designTicket(deps, ticketId);
			const [documents, styles] = await Promise.all([designs.list(ticketId), designs.styles()]);
			return { designs: documents.map(designSummaryOf), styles: styles.map(styleOf) };
		},

		getDesign: async (ticketId, designId) => {
			const { designs } = await designTicket(deps, ticketId);
			const document = await designs.get(ticketId, designId.toUpperCase());
			return document ? designDocumentOf(document) : undefined;
		},

		/**
		 * The style may be named by id, label or prefix, in any case — a model
		 * asked for "an ERD" will say `ERD`, and refusing that over a spelling
		 * helps nobody. An unknown one is refused with the list it could have
		 * picked from.
		 */
		createDesign: async (request) => {
			const { designs } = await designTicket(deps, request.ticketId);
			const styles = await designs.styles();
			const wanted = request.style.trim().toLowerCase();
			const style = styles.find(
				(candidate) =>
					candidate.id.toLowerCase() === wanted ||
					candidate.prefix.toLowerCase() === wanted ||
					candidate.label.toLowerCase() === wanted
			);
			if (!style) {
				throw new Error(
					`No design style “${request.style}”. This workspace offers: ${styles
						.map((candidate) => `${candidate.prefix} (${candidate.id})`)
						.join(', ')}.`
				);
			}
			const created = await designs.create(
				request.ticketId,
				style.id,
				request.title,
				request.body === undefined ? '' : ensureMermaidFence(request.body),
				`Added ${MCP_PROVENANCE}.`
			);
			deps.onDidWrite?.();
			return designDocumentOf(created);
		},

		/**
		 * The same body again is a non-event — no history entry, no `updatedAt`
		 * bump — the `setStatus` rule: an agent that saves on every loop must not
		 * bury the ticket's history under designs that did not change.
		 */
		updateDesign: async (request) => {
			const { designs } = await designTicket(deps, request.ticketId);
			const designId = request.designId.toUpperCase();
			const current = await designs.get(request.ticketId, designId);
			if (!current) {
				throw new Error(
					`No design document “${request.designId}” on ${request.ticketId}. Call list_designs to see which ones exist.`
				);
			}
			if (request.baseUpdatedAt !== undefined && current.updatedAt !== request.baseUpdatedAt) {
				throw staleDesign(designId, current.updatedAt);
			}
			const body = ensureMermaidFence(request.body);
			if (body === current.body) {
				return designDocumentOf(current);
			}
			try {
				const updated = await designs.update(
					request.ticketId,
					designId,
					body,
					request.baseUpdatedAt ?? current.updatedAt,
					`Updated ${MCP_PROVENANCE}.`
				);
				deps.onDidWrite?.();
				return designDocumentOf(updated);
			} catch (failure) {
				// Someone saved between the read above and the write: the board's
				// own conflict, said in the client's terms.
				if (failure instanceof TicketConflictError) {
					throw staleDesign(designId, (await designs.get(request.ticketId, designId))?.updatedAt);
				}
				throw failure;
			}
		},

		runTests: async (id) => {
			const started = await deps.batches.start(id);
			if (started.kind === 'refused') {
				if (started.reason === 'running' || started.reason === 'overlap') {
					return { started: false, message: started.message };
				}
				throw new Error(started.message);
			}
			// Deliberately not awaited: the batch belongs to the window, and a
			// client that gives up waiting must not leave it half-done.
			void started.completed.catch(() => undefined);
			return {
				started: true,
				message: `Started a test run for every test case under ${id}. It runs in the background — read the test cases back with get_ticket to see the statuses it sets.`
			};
		},

		runScan: (id) => deps.startScan(id),

		listEnvironments: async () => {
			const handles = await deps.environments.list();
			const titles = new Map<string, string>();
			for (const handle of handles) {
				if (handle.ticketId !== undefined) {
					const summary = await deps.store.getSummary(handle.ticketId);
					if (summary) {
						titles.set(handle.ticketId, summary.title);
					}
				}
			}
			return handles.map(
				(handle): McpEnvironmentInfo => ({
					id: handle.id,
					...(handle.ticketId === undefined ? {} : { ticketId: handle.ticketId }),
					...(handle.ticketId !== undefined && titles.has(handle.ticketId)
						? { title: titles.get(handle.ticketId) as string }
						: {}),
					...(handle.branch.length > 0 ? { branch: handle.branch } : {}),
					status: handle.status,
					...(handle.statusDetail === undefined ? {} : { error: handle.statusDetail }),
					ports: handle.ports,
					worktreePath: handle.worktreePath
				})
			);
		},

		startEnvironment: (id) =>
			operate(deps, id, 'start', (environmentId) => deps.environments.start(environmentId)),

		stopEnvironment: (id) =>
			operate(deps, id, 'stop', (environmentId) => deps.environments.stop(environmentId))
	};
}

/**
 * Starts a stack operation and answers at once.
 *
 * The store's per-environment queue is what makes a retry safe: a second Start
 * lands behind the first rather than beside it, so the client that gave up
 * waiting cannot produce two. The backend is asked first, so a Docker that is
 * not installed refuses up front rather than appearing to begin and then
 * failing; the environment is looked up next so that a bad id is a plain error
 * instead of a promise nobody is waiting on; and the failure of the operation
 * itself goes to the log — a client learns the outcome from
 * `list_environments`, which is where an environment's status lives.
 */
async function operate(
	deps: McpContextDeps,
	id: string,
	verb: 'start' | 'stop',
	run: (id: string) => Promise<void>
): Promise<McpActionReport> {
	const availability = await deps.environments.availability();
	if (!availability.ok) {
		throw new Error(
			availability.message ??
				'The environments backend is not available in this workspace, so nothing can be started or stopped.'
		);
	}

	const handle = await deps.environments.find(id);
	if (!handle) {
		throw new Error(
			`No environment “${id}”. Call list_environments to see which ones exist; BFAST does not create one over MCP.`
		);
	}

	void run(id).catch((failure: unknown) => {
		deps.log?.(
			`— ${verb === 'start' ? 'Start' : 'Stop'} of ${id} failed: ${errorMessage(failure)}`
		);
	});

	return {
		started: true,
		message: `${verb === 'start' ? 'Starting' : 'Stopping'} the ${id} environment. It takes a while — call list_environments to see when it has finished.`
	};
}

/**
 * The design store, and a ticket that may carry designs — refused in words
 * otherwise. `DesignStore.list` answers `[]` for a ticket that does not exist,
 * which over a port would read as "no documents yet" rather than a typo.
 */
async function designTicket(
	deps: McpContextDeps,
	ticketId: string
): Promise<{ designs: McpDesigns; ticket: TicketSummary }> {
	if (!deps.designs) {
		throw new Error('Technical design documents are not available in this window.');
	}
	const ticket = await deps.store.getSummary(ticketId);
	if (!ticket) {
		throw new Error(`No ticket “${ticketId}” in this workspace’s tracker.`);
	}
	if (!allowsDesigns(ticket.type)) {
		throw new Error(
			`${ticketId} is ${ticket.type === 'ac' ? 'an acceptance criterion' : 'a test case'}; technical design documents belong to an epic or a story.`
		);
	}
	return { designs: deps.designs, ticket };
}

function staleDesign(designId: string, updatedAt: string | undefined): Error {
	return new Error(
		`${designId} changed since it was read${updatedAt ? ` (it is now at ${updatedAt})` : ''}, so nothing was written. Read it again with get_design, apply the change to what is there now, and send that.`
	);
}

function designSummaryOf(design: DesignSummary): McpDesignSummary {
	return {
		id: design.id,
		ticketId: design.ticketId,
		style: design.style,
		title: design.title,
		fileName: design.fileName,
		...(design.updatedAt === undefined ? {} : { updatedAt: design.updatedAt })
	};
}

function designDocumentOf(document: DesignDocument): McpDesignDocument {
	return {
		...designSummaryOf(document),
		...(document.createdBy === undefined ? {} : { createdBy: document.createdBy }),
		...(document.createdAt === undefined ? {} : { createdAt: document.createdAt }),
		body: document.body
	};
}

function styleOf(style: DesignStyle): McpDesignStyle {
	return { id: style.id, label: style.label, prefix: style.prefix };
}

/** A `TicketDetail` is a `TicketSummary` already; this is only what to answer with. */
function summaryOf(detail: TicketSummary): TicketSummary {
	return {
		id: detail.id,
		key: detail.key,
		type: detail.type,
		title: detail.title,
		status: detail.status,
		...(detail.assignee === undefined ? {} : { assignee: detail.assignee }),
		...(detail.parentId === undefined ? {} : { parentId: detail.parentId }),
		...(detail.service === undefined ? {} : { service: detail.service })
	};
}
