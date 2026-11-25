// The words the board puts on a ticket's type and status, shared by the header
// and the Tests tab so a test case cannot read "To do" in one place and "todo"
// in another. A module of its own rather than an export of `ticketDetail.tsx`,
// which imports the Tests tab: the two would otherwise import each other.

import type { TicketStatus, TicketType } from '../../data/types';

export const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'Epic',
	story: 'Story',
	ac: 'Acceptance criterion',
	testcase: 'Test case'
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
	'todo': 'To do',
	'in-progress': 'In progress',
	'in-review': 'In review',
	'done': 'Done',
	'blocked': 'Blocked'
};

/** Same abbreviations the ticket ids use, so the badge reads as the id prefix. */
export const TYPE_BADGE: Record<TicketType, string> = {
	epic: 'EP',
	story: 'ST',
	ac: 'AC',
	testcase: 'TC'
};

/**
 * "just now", "5 minutes ago", "yesterday" — enough to place a conversation.
 *
 * Here rather than in `generateApp.tsx`, where it started: the board's design
 * tabs offer to continue a conversation too, and two copies of this are two
 * places for "yesterday" to start meaning different things.
 */
export function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return 'earlier';
	}
	const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	}
	const days = Math.round(hours / 24);
	return days === 1 ? 'yesterday' : `${days} days ago`;
}
