// The Tests tab's first paint for one ticket, built on the host.
//
// Kept apart from `testReport.ts` because it reads the two stores, and both
// import `vscode` — the report types are bundled into the webview and
// must never be. The scope rule is the runner's, from the same two functions:
// the tab lists exactly what Run Tests would run, in the order it would run it
// — and, beside that flat list, the structure around it (`tree`), so a parent's
// tab can draw a story's criteria and the test cases under each. Run data goes
// on the flat list only, and `bfastPanel.ts` keeps reading `report.testCases`
// for the batches a board follows and the asset roots it hands the webview.

import type { TicketStore } from '../data/ticketStore';
import { buildTree, collectTestCases, findNode, type TicketNode } from '../data/ticketTree';
import type { TestReport, TestReportCase, TestReportNode } from './testReport';
import type { TestResultsStore } from './testResultsStore';

/** `undefined` when the ticket is no longer in the tracker. */
export async function buildTestReport(
	store: TicketStore,
	results: TestResultsStore,
	ticketId: string
): Promise<TestReport | undefined> {
	const summaries = await store.listSummaries();
	const node = findNode(buildTree(summaries), ticketId);
	if (!node) {
		return undefined;
	}

	const testCases: TestReportCase[] = [];
	for (const ticket of collectTestCases(node)) {
		// Only the latest run per test case: an epic lists dozens, and the tab
		// reads the earlier runs of one on demand.
		const listed = await results.listRuns(ticket.id, 1);
		testCases.push({
			id: ticket.id,
			key: ticket.key,
			title: ticket.title,
			status: ticket.status,
			...(ticket.warning ? { warning: ticket.warning } : {}),
			...(listed.runs[0] ? { latest: listed.runs[0] } : {}),
			runCount: listed.total
		});
	}

	return {
		ticket: {
			id: node.ticket.id,
			key: node.ticket.key,
			title: node.ticket.title,
			type: node.ticket.type
		},
		testCases,
		// The board's children, not the board: it is the tab's header. A test
		// case has none, so its tree is `[]` with no special case.
		tree: node.children.map(toReportNode),
		acsWithoutTestCase: countChildlessCriteria(node)
	};
}

/** The hierarchy, structure only — see `TestReportNode` for why no runs ride here. */
function toReportNode(node: TicketNode): TestReportNode {
	return {
		id: node.ticket.id,
		key: node.ticket.key,
		title: node.ticket.title,
		type: node.ticket.type,
		status: node.ticket.status,
		...(node.ticket.warning ? { warning: node.ticket.warning } : {}),
		children: node.children.map(toReportNode)
	};
}

/** Criteria in the subtree with no test case — why an empty tab is empty. */
function countChildlessCriteria(node: TicketNode): number {
	let count = 0;
	const walk = (current: TicketNode): void => {
		if (
			current.ticket.type === 'ac' &&
			!current.children.some((child) => child.ticket.type === 'testcase')
		) {
			count++;
		}
		for (const child of current.children) {
			walk(child);
		}
	};
	walk(node);
	return count;
}
