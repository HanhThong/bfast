import { TicketStore } from '../data/ticketStore';
import { TicketDetail, TicketSummary } from '../data/types';

/**
 * A hand-written backlog in the shape `FileTicketStore` produces, so the tree
 * tests have a fixture without touching disk. Test-only: production reads the
 * tracker folder.
 *
 * Ids follow the on-disk scheme — the type prefix followed by the ordinals of
 * every ancestor and then its own, so `TC-1.1.2.1` is the first test case of the
 * second acceptance criterion of the first story of the first epic. Ordinals are
 * per type within a parent, which is why the standalone `TC-1.1.1` under a story
 * and the `TC-1.1.1.1` under that story's first AC coexist without clashing.
 */
const TICKETS: TicketDetail[] = [
	{
		id: 'EP-1',
		key: 'EP-1',
		type: 'epic',
		title: 'Authentication & access control',
		status: 'in-progress',
		assignee: 'Hanh Thong',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-02T09:15:00.000Z',
		updatedAt: '2026-07-11T08:40:00.000Z',
		description: [
			'Everything around signing in, signing out and permissions in BFAST.',
			'',
			'In scope:',
			'- Sign in with email and password',
			'- Forgot password / reset password',
			'- Remember the session for 30 days',
			'',
			'Out of scope: SSO and Google sign-in, both moved to a later epic.'
		].join('\n'),
		history: [
			{ id: 'EP-1#0', timestamp: '2026-07-02T09:15:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ id: 'EP-1#1', timestamp: '2026-07-04T14:02:00.000Z', author: 'Hanh Thong', action: 'changed', field: 'status', from: 'todo', to: 'in-progress' },
			{ id: 'EP-1#2', timestamp: '2026-07-11T08:40:00.000Z', author: 'Minh Anh', action: 'commented', comment: 'Agreed to drop SSO from this epic and track it separately so the sprint does not stretch.' }
		]
	},
	{
		id: 'ST-1.1',
		key: 'ST-1',
		type: 'story',
		parentId: 'EP-1',
		title: 'Sign in with email and password',
		status: 'in-progress',
		assignee: 'Minh Anh',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-05T10:00:00.000Z',
		updatedAt: '2026-07-09T16:20:00.000Z',
		description: [
			'As a user, I want to sign in with my email and password so that I can reach my workspace.'
		].join('\n'),
		history: [
			{ id: 'ST-1.1#0', timestamp: '2026-07-05T10:00:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ id: 'ST-1.1#1', timestamp: '2026-07-05T10:03:00.000Z', author: 'Hanh Thong', action: 'changed', field: 'assignee', from: '—', to: 'Minh Anh' },
			{ id: 'ST-1.1#2', timestamp: '2026-07-09T16:20:00.000Z', author: 'Minh Anh', action: 'changed', field: 'status', from: 'todo', to: 'in-progress' }
		]
	},
	{
		id: 'AC-1.1.1',
		key: 'AC-1',
		type: 'ac',
		parentId: 'ST-1.1',
		title: 'Wrong credentials show a generic error',
		status: 'done',
		assignee: 'Minh Anh',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-05T10:05:00.000Z',
		updatedAt: '2026-07-08T15:45:00.000Z',
		description: 'The error must not reveal whether an account with that email exists.',
		history: [
			{ id: 'AC-1.1.1#0', timestamp: '2026-07-05T10:05:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ id: 'AC-1.1.1#1', timestamp: '2026-07-08T15:45:00.000Z', author: 'Hanh Thong', action: 'changed', field: 'status', from: 'in-review', to: 'done' }
		]
	},
	{
		id: 'TC-1.1.1.1',
		key: 'TC-1',
		type: 'testcase',
		parentId: 'AC-1.1.1',
		title: 'An unknown email and a wrong password read the same',
		status: 'done',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-06T09:00:00.000Z',
		updatedAt: '2026-07-08T11:30:00.000Z',
		description: [
			'Steps:',
			'1. Sign in with an email that has no account.',
			'2. Sign in with a real email and the wrong password.',
			'',
			'Expected: both attempts return the identical message and the identical response time.'
		].join('\n'),
		history: [
			{ id: 'TC-1.1.1.1#0', timestamp: '2026-07-06T09:00:00.000Z', author: 'Thu Ha', action: 'created' },
			{ id: 'TC-1.1.1.1#1', timestamp: '2026-07-08T11:30:00.000Z', author: 'Thu Ha', action: 'changed', field: 'status', from: 'in-progress', to: 'done' }
		]
	},
	{
		id: 'AC-1.1.2',
		key: 'AC-2',
		type: 'ac',
		parentId: 'ST-1.1',
		title: 'Five consecutive failures lock the account for 15 minutes',
		status: 'in-progress',
		assignee: 'Duy Khang',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-05T10:06:00.000Z',
		updatedAt: '2026-07-09T08:00:00.000Z',
		description: 'The lock is per account, not per IP, and lifts on its own after 15 minutes.',
		history: [
			{ id: 'AC-1.1.2#0', timestamp: '2026-07-05T10:06:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ id: 'AC-1.1.2#1', timestamp: '2026-07-09T08:00:00.000Z', author: 'Duy Khang', action: 'changed', field: 'status', from: 'todo', to: 'in-progress' }
		]
	},
	{
		id: 'TC-1.1.2.1',
		key: 'TC-1',
		type: 'testcase',
		parentId: 'AC-1.1.2',
		title: 'Five consecutive wrong passwords lock the account',
		status: 'todo',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-07T11:00:00.000Z',
		updatedAt: '2026-07-07T11:02:00.000Z',
		description: [
			'Precondition: the account qa+lock@bfast.dev is active and unlocked.',
			'',
			'Steps:',
			'1. Sign in with the wrong password five times in a row.',
			'2. On the sixth attempt, enter the CORRECT password.',
			'',
			'Expected: the sixth attempt is still rejected with a 15 minute lockout message.'
		].join('\n'),
		history: [
			{ id: 'TC-1.1.2.1#0', timestamp: '2026-07-07T11:00:00.000Z', author: 'Thu Ha', action: 'created' },
			{ id: 'TC-1.1.2.1#1', timestamp: '2026-07-07T11:02:00.000Z', author: 'Thu Ha', action: 'changed', field: 'assignee', from: '—', to: 'Thu Ha' }
		]
	},
	{
		id: 'TC-1.1.2.2',
		key: 'TC-2',
		type: 'testcase',
		parentId: 'AC-1.1.2',
		title: 'The lock lifts on its own after 15 minutes',
		status: 'todo',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-07T11:05:00.000Z',
		updatedAt: '2026-07-07T11:05:00.000Z',
		description: 'Lock the account, wait 16 minutes, then sign in with the correct password and expect success.',
		history: [
			{ id: 'TC-1.1.2.2#0', timestamp: '2026-07-07T11:05:00.000Z', author: 'Thu Ha', action: 'created' }
		]
	},
	{
		id: 'TC-1.1.1',
		key: 'TC-1',
		type: 'testcase',
		parentId: 'ST-1.1',
		title: 'Smoke: sign in and land back on the last screen',
		status: 'todo',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-07T11:20:00.000Z',
		updatedAt: '2026-07-07T11:20:00.000Z',
		description: 'A standalone test case that covers the whole story rather than one acceptance criterion.',
		history: [
			{ id: 'TC-1.1.1#0', timestamp: '2026-07-07T11:20:00.000Z', author: 'Thu Ha', action: 'created' }
		]
	},
	{
		id: 'ST-1.2',
		key: 'ST-2',
		type: 'story',
		parentId: 'EP-1',
		title: 'Forgot password',
		status: 'todo',
		assignee: 'Duy Khang',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-05T10:05:00.000Z',
		updatedAt: '2026-07-05T10:05:00.000Z',
		description: [
			'As a user who forgot their password, I want a reset link by email so that I can regain access.'
		].join('\n'),
		history: [
			{ id: 'ST-1.2#0', timestamp: '2026-07-05T10:05:00.000Z', author: 'Hanh Thong', action: 'created' }
		]
	},
	{
		id: 'AC-1.2.1',
		key: 'AC-1',
		type: 'ac',
		parentId: 'ST-1.2',
		title: 'The reset link is single use and expires after 15 minutes',
		status: 'todo',
		assignee: 'Duy Khang',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-05T10:07:00.000Z',
		updatedAt: '2026-07-05T10:07:00.000Z',
		description: 'Following the link a second time, or after the deadline, lands on an "expired" page.',
		history: [
			{ id: 'AC-1.2.1#0', timestamp: '2026-07-05T10:07:00.000Z', author: 'Hanh Thong', action: 'created' }
		]
	},
	{
		id: 'TC-1.2.1.1',
		key: 'TC-1',
		type: 'testcase',
		parentId: 'AC-1.2.1',
		title: 'The reset link expires after 15 minutes',
		status: 'todo',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-07T11:10:00.000Z',
		updatedAt: '2026-07-07T11:10:00.000Z',
		description: [
			'Steps:',
			'1. Request a password reset and take the link from the email.',
			'2. Wait 16 minutes, then open the link.',
			'',
			'Expected: an "This link has expired" page with a button to request a new one.'
		].join('\n'),
		history: [
			{ id: 'TC-1.2.1.1#0', timestamp: '2026-07-07T11:10:00.000Z', author: 'Thu Ha', action: 'created' }
		]
	},
	{
		id: 'EP-2',
		key: 'EP-2',
		type: 'epic',
		title: 'Billing',
		status: 'todo',
		assignee: 'Hanh Thong',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-14T09:00:00.000Z',
		updatedAt: '2026-07-14T09:00:00.000Z',
		description: [
			'Let customers upgrade their plan and pay online.',
			'',
			'International cards come first; local e-wallets are a later phase.'
		].join('\n'),
		history: [
			{ id: 'EP-2#0', timestamp: '2026-07-14T09:00:00.000Z', author: 'Hanh Thong', action: 'created' }
		]
	},
	{
		id: 'ST-2.1',
		key: 'ST-1',
		type: 'story',
		parentId: 'EP-2',
		title: 'Pay by credit card',
		status: 'blocked',
		assignee: 'Minh Anh',
		createdBy: 'Hanh Thong',
		createdAt: '2026-07-14T09:05:00.000Z',
		updatedAt: '2026-07-18T10:21:00.000Z',
		description: [
			'As a customer, I want to pay by card so that my plan upgrades immediately.',
			'',
			'Currently blocked: the company Stripe account does not exist yet.'
		].join('\n'),
		history: [
			{ id: 'ST-2.1#0', timestamp: '2026-07-14T09:05:00.000Z', author: 'Hanh Thong', action: 'created' },
			{ id: 'ST-2.1#1', timestamp: '2026-07-18T10:20:00.000Z', author: 'Minh Anh', action: 'changed', field: 'status', from: 'todo', to: 'blocked' },
			{ id: 'ST-2.1#2', timestamp: '2026-07-18T10:21:00.000Z', author: 'Minh Anh', action: 'commented', comment: 'Finance still has to finish the business paperwork for Stripe.' }
		]
	},
	{
		id: 'AC-2.1.1',
		key: 'AC-1',
		type: 'ac',
		parentId: 'ST-2.1',
		title: 'A declined card leaves the plan unchanged',
		status: 'todo',
		assignee: 'Minh Anh',
		createdBy: 'Minh Anh',
		createdAt: '2026-07-14T09:10:00.000Z',
		updatedAt: '2026-07-14T09:10:00.000Z',
		description: 'No invoice is created and the workspace stays on its old plan.',
		history: [
			{ id: 'AC-2.1.1#0', timestamp: '2026-07-14T09:10:00.000Z', author: 'Minh Anh', action: 'created' }
		]
	},
	{
		id: 'TC-2.1.1.1',
		key: 'TC-1',
		type: 'testcase',
		parentId: 'AC-2.1.1',
		title: 'The bank declines the card',
		status: 'todo',
		assignee: 'Thu Ha',
		createdBy: 'Thu Ha',
		createdAt: '2026-07-15T14:00:00.000Z',
		updatedAt: '2026-07-15T14:00:00.000Z',
		description: [
			'Use the test card 4000 0000 0000 0002, which is always declined.',
			'',
			'Expected: an error message is shown, the plan is unchanged and no invoice is created.'
		].join('\n'),
		history: [
			{ id: 'TC-2.1.1.1#0', timestamp: '2026-07-15T14:00:00.000Z', author: 'Thu Ha', action: 'created' }
		]
	},
	{
		// Deliberately childless, so the tree tests cover how a warning renders.
		id: 'AC-2.1.2',
		key: 'AC-2',
		type: 'ac',
		parentId: 'ST-2.1',
		title: 'A successful Stripe payment upgrades the workspace immediately',
		status: 'todo',
		assignee: 'Duy Khang',
		warning: 'No test case yet',
		createdBy: 'Minh Anh',
		createdAt: '2026-07-14T09:12:00.000Z',
		updatedAt: '2026-07-14T09:12:00.000Z',
		description: 'The upgrade lands on the checkout.session.completed webhook, not on the redirect back.',
		history: [
			{ id: 'AC-2.1.2#0', timestamp: '2026-07-14T09:12:00.000Z', author: 'Minh Anh', action: 'created' }
		]
	}
];

export class MockTicketStore implements TicketStore {
	async listSummaries(): Promise<TicketSummary[]> {
		return TICKETS.map(summaryOf);
	}

	async listChildren(parentId?: string): Promise<TicketSummary[]> {
		return TICKETS.filter((ticket) => ticket.parentId === parentId).map(summaryOf);
	}

	async getSummary(id: string): Promise<TicketSummary | undefined> {
		const ticket = TICKETS.find((candidate) => candidate.id === id);
		return ticket ? summaryOf(ticket) : undefined;
	}

	async getDetail(id: string): Promise<TicketDetail | undefined> {
		return TICKETS.find((ticket) => ticket.id === id);
	}
}

/** The summary half, with `hasChildren` derived the way the file store derives it from a listing. */
function summaryOf(ticket: TicketDetail): TicketSummary {
	const { description, history, createdBy, createdAt, updatedAt, ...summary } = ticket;
	return { ...summary, hasChildren: TICKETS.some((other) => other.parentId === ticket.id) };
}
