// The MCP tool seam's proof: if satisfying `McpToolContext` ever needs a cast,
// a `vscode` import or knowledge of the tracker's folders, the interface is in
// the wrong place.
//
// It records what it was asked for, because most of what the tools promise is
// about *when* work starts rather than what it returns — "started once, not
// twice" is a count, not a value.

import type { TicketStatus, TicketSummary, TicketType } from '../data/types';
import type {
	McpActionReport,
	McpDesignDocument,
	McpDesignStyle,
	McpDesignSummary,
	McpEnvironmentInfo,
	McpSettingsBlock,
	McpToolContext
} from '../mcp/mcpTools';

export interface FakeCall {
	tool: string;
	args: unknown;
}

export class FakeMcpContext implements McpToolContext {
	readonly calls: FakeCall[] = [];
	/** Ticket ids `getTicket` knows about; anything else answers `undefined`. */
	tickets = new Map<string, TicketSummary>();
	environments: McpEnvironmentInfo[] = [];
	/** Set to make the next call of that tool throw — a store refusing a write. */
	failWith: Map<string, Error> = new Map();
	/** What `runTests` / `runScan` report. Defaults to "started". */
	report: McpActionReport = { started: true, message: 'started' };

	async listTickets(parentId: string | undefined): Promise<TicketSummary[]> {
		this.record('list_tickets', { parentId });
		return [...this.tickets.values()].filter((ticket) => ticket.parentId === parentId);
	}

	async getTicket(id: string): Promise<unknown> {
		this.record('get_ticket', { id });
		return this.tickets.get(id);
	}

	async createTicket(request: {
		parentId?: string;
		type: TicketType;
		title: string;
		description?: string;
	}): Promise<TicketSummary> {
		this.record('create_ticket', request);
		return {
			id: 'ST-9.9',
			key: 'ST-9',
			type: request.type,
			title: request.title,
			status: 'todo',
			...(request.parentId === undefined ? {} : { parentId: request.parentId })
		};
	}

	async renameTicket(id: string, title: string): Promise<TicketSummary> {
		this.record('rename_ticket', { id, title });
		return { id, key: id, type: 'story', title, status: 'todo' };
	}

	async linkTickets(id: string, relation: string, targetId: string): Promise<unknown> {
		this.record('link_tickets', { id, relation, targetId });
		return { id, links: [{ relation, id: targetId }] };
	}

	async unlinkTickets(id: string, relation: string, targetId: string): Promise<unknown> {
		this.record('unlink_tickets', { id, relation, targetId });
		return { id, links: [] };
	}

	async setStatus(id: string, status: TicketStatus): Promise<TicketSummary> {
		this.record('set_ticket_status', { id, status });
		return { id, key: id, type: 'story', title: 'Something', status };
	}

	async listDesigns(
		ticketId: string
	): Promise<{ designs: McpDesignSummary[]; styles: McpDesignStyle[] }> {
		this.record('list_designs', { ticketId });
		return { designs: [], styles: [{ id: 'low-level-design', label: 'Low Level Design', prefix: 'LLD' }] };
	}

	async getDesign(ticketId: string, designId: string): Promise<McpDesignDocument | undefined> {
		this.record('get_design', { ticketId, designId });
		return designId === 'LLD-1'
			? { id: 'LLD-1', ticketId, style: 'low-level-design', title: 'Design', fileName: 'LLD-1-Design.mdx', body: '' }
			: undefined;
	}

	async createDesign(request: {
		ticketId: string;
		style: string;
		title: string;
		body?: string;
	}): Promise<McpDesignDocument> {
		this.record('create_design', request);
		return {
			id: 'LLD-1',
			ticketId: request.ticketId,
			style: request.style,
			title: request.title,
			fileName: 'LLD-1-Design.mdx',
			body: request.body ?? ''
		};
	}

	async updateDesign(request: {
		ticketId: string;
		designId: string;
		body: string;
		baseUpdatedAt?: string;
	}): Promise<McpDesignDocument> {
		this.record('update_design', request);
		return {
			id: request.designId,
			ticketId: request.ticketId,
			style: 'low-level-design',
			title: 'Design',
			fileName: `${request.designId}-Design.mdx`,
			body: request.body
		};
	}

	async runTests(id: string): Promise<McpActionReport> {
		this.record('run_tests', { id });
		return this.report;
	}

	async runScan(id: string | undefined): Promise<McpActionReport> {
		this.record('run_scan', { id });
		return this.report;
	}

	async listEnvironments(): Promise<McpEnvironmentInfo[]> {
		this.record('list_environments', {});
		return this.environments;
	}

	async startEnvironment(id: string): Promise<McpActionReport> {
		this.record('start_environment', { id });
		return this.report;
	}

	async stopEnvironment(id: string): Promise<McpActionReport> {
		this.record('stop_environment', { id });
		return this.report;
	}

	async setTestCaseService(id: string, service: string | undefined): Promise<TicketSummary> {
		this.record('set_test_case_service', { id, service });
		return { id, key: id, type: 'testcase', title: 'A test', status: 'todo', ...(service ? { service } : {}) };
	}

	async getSettings(): Promise<unknown> {
		this.record('get_settings', {});
		return { writable: true, environments: {}, tests: {} };
	}

	async listComposeServices(): Promise<unknown> {
		this.record('list_compose_services', {});
		return { services: ['orders'], files: ['docker-compose.yml'] };
	}

	async updateSettings(block: McpSettingsBlock, changes: Record<string, unknown>): Promise<unknown> {
		this.record(block === 'tests' ? 'update_test_settings' : 'update_environment_settings', { block, changes });
		return { saved: true };
	}

	async setTestService(service: Record<string, unknown>): Promise<unknown> {
		this.record('set_test_service', { service });
		return { saved: true };
	}

	async removeTestService(id: string): Promise<unknown> {
		this.record('remove_test_service', { id });
		return { saved: true };
	}

	/** How many times one tool reached the context. */
	countOf(tool: string): number {
		return this.calls.filter((call) => call.tool === tool).length;
	}

	private record(tool: string, args: unknown): void {
		this.calls.push({ tool, args });
		const failure = this.failWith.get(tool);
		if (failure) {
			throw failure;
		}
	}
}
