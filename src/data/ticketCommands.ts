import * as vscode from 'vscode';
import { LINK_RELATION_INFO, LINK_RELATIONS, type LinkRelation } from './ticketLinks';
import { TicketNode } from './ticketTree';
import { WritableTicketStore } from './ticketStore';
import { allowedChildTypes, convertibleTypes, MAX_FOLDER_NAME } from './trackerPaths';
import { parseTicketUri } from './ticketUri';
import { TicketStatus, TicketSummary, TicketType, TICKET_STATUSES } from './types';
import { errorMessage } from '../platform/errors';
import type { TestService } from '../settings/testServices';

const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'epic',
	story: 'story',
	ac: 'acceptance criterion',
	testcase: 'test case'
};

/** Opening the board on the new ticket is the natural next step after creating one. */
const OPEN_TICKET = 'bfast.openTicket';

const STATUS_LABEL: Record<TicketStatus, string> = {
	'todo': 'To do',
	'in-progress': 'In progress',
	'in-review': 'In review',
	'done': 'Done',
	'blocked': 'Blocked'
};

export interface TicketCommandDeps {
	store: WritableTicketStore;
	/** Re-reads the tracker and repaints the tree. */
	refresh: () => void;
	/**
	 * True when the ticket has a dev environment. A type change renames the
	 * id, and an environment's worktree, branch and project name are all
	 * named after it, so the change is refused while one exists. Optional so
	 * a caller with no environments section needs nothing.
	 */
	hasEnvironment?: (id: string) => Promise<boolean>;
	/**
	 * The services `tests.services` declares, read at call time — what Set
	 * Service offers. Optional: without it the command says there are none.
	 */
	services?: () => readonly TestService[];
}

/**
 * The write half of the sidebar. There is one command per type rather than a
 * single "add child", because that is what lets the menu `when` clauses state
 * the hierarchy declaratively — they mirror `allowedChildTypes`.
 */
export function registerTicketCommands(deps: TicketCommandDeps): vscode.Disposable[] {
	const { store, refresh } = deps;

	const changeType = async (node: TicketNode | undefined, target: TicketType): Promise<void> => {
		const ticket = node?.ticket;
		if (!ticket || !convertibleTypes(ticket.type).includes(target)) {
			void vscode.window.showWarningMessage(
				`Pick ${target === 'story' ? 'an epic' : 'a story'} to turn into ${article(target)}.`
			);
			return;
		}

		await run(async () => {
			if (await deps.hasEnvironment?.(ticket.id)) {
				throw new Error(
					`${ticket.id} has an environment, and its worktree, branch and stack are named ` +
						'after the id. Delete the environment first, then change the type.'
				);
			}
			// Refuses here — before the question — when the hierarchy forbids it.
			const plan = await store.planTypeChange(ticket.id, target);

			const confirmed = await vscode.window.showWarningMessage(
				`Turn ${ticket.id} — ${ticket.title} into ${article(target)}?`,
				{
					modal: true,
					detail:
						`Its id becomes ${plan.newId}. The title, description, status, history and ` +
						'design documents stay; the folder and the description file are renamed. ' +
						`Anything that refers to ${ticket.id} by id has to be updated by hand, and ` +
						'an open board for it is reopened — an edit not yet saved there is lost.'
				},
				'Change Type'
			);
			if (confirmed !== 'Change Type') {
				return;
			}

			const changed = await store.changeType(ticket.id, target);
			refresh();
			await reopenBoard(ticket.id, changed.id);
			void vscode.window.showInformationMessage(
				`${ticket.id} is now ${article(target)}: ${changed.id}.`
			);
		});
	};

	const create = async (parent: TicketSummary | undefined, type: TicketType): Promise<void> => {
		if (!allowedChildTypes(parent?.type).includes(type)) {
			void vscode.window.showWarningMessage(
				parent
					? `A ${TYPE_LABEL[parent.type]} cannot contain ${article(type)}.`
					: `${capitalize(TYPE_LABEL[type])}s cannot sit at the top level.`
			);
			return;
		}

		const title = await promptForTitle(`Title of the new ${TYPE_LABEL[type]}`);
		if (title === undefined) {
			return;
		}

		await run(async () => {
			const created = await store.createTicket({ parentId: parent?.id, type, title });
			refresh();
			void vscode.commands.executeCommand(OPEN_TICKET, created.id);
		});
	};

	return [
		vscode.commands.registerCommand('bfast.newEpic', () => create(undefined, 'epic')),

		// A separate command rather than `newEpic` taking a node: the title bar
		// button must always make a top-level epic, and the menu needs its own
		// label to say this one nests.
		vscode.commands.registerCommand('bfast.newSubEpic', (node?: TicketNode) => {
			if (node?.ticket.type !== 'epic') {
				void vscode.window.showWarningMessage('Pick an epic to add a sub-epic to.');
				return;
			}
			return create(node.ticket, 'epic');
		}),

		// Two commands rather than one with a pick, for the reason there is one
		// "New …" per type: each menu `when` states which type it applies to.
		vscode.commands.registerCommand('bfast.convertToStory', (node?: TicketNode) =>
			changeType(node, 'story')
		),
		vscode.commands.registerCommand('bfast.convertToEpic', (node?: TicketNode) =>
			changeType(node, 'epic')
		),

		vscode.commands.registerCommand('bfast.newStory', (node?: TicketNode) =>
			create(node?.ticket, 'story')
		),

		vscode.commands.registerCommand('bfast.newAc', async (node?: TicketNode) => {
			const story = node?.ticket;
			if (story?.type !== 'story') {
				void vscode.window.showWarningMessage('Pick a story to add an acceptance criterion to.');
				return;
			}

			const acTitle = await promptForTitle('Title of the new acceptance criterion');
			if (acTitle === undefined) {
				return;
			}

			// An acceptance criterion needs at least one test case, so it is asked
			// for up front — backing out here creates neither.
			const testCaseTitle = await promptForTitle(
				'Title of its first test case',
				'An acceptance criterion needs at least one test case'
			);
			if (testCaseTitle === undefined) {
				return;
			}

			await run(async () => {
				const created = await store.createAcceptanceCriterion(story.id, acTitle, testCaseTitle);
				refresh();
				void vscode.commands.executeCommand(OPEN_TICKET, created.id);
			});
		}),

		vscode.commands.registerCommand('bfast.newTestCase', (node?: TicketNode) =>
			create(node?.ticket, 'testcase')
		),

		vscode.commands.registerCommand('bfast.setStatus', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			if (!ticket) {
				return;
			}

			const status = await promptForStatus(ticket.status);
			if (status === undefined || status === ticket.status) {
				return;
			}

			await run(async () => {
				await store.updateStatus(ticket.id, status);
				refresh();
			});
		}),

		// From the sidebar a node, from a test case board's service picker an id
		// and the pick itself. docs/tests/services.md is the specification.
		vscode.commands.registerCommand(
			'bfast.setTestCaseService',
			async (node?: TicketNode | string, picked?: string | null) => {
				const id = typeof node === 'string' ? node : node?.ticket.id;
				const ticket = id ? await store.getSummary(id) : undefined;
				if (!ticket || ticket.type !== 'testcase') {
					return;
				}
				const services = deps.services?.() ?? [];
				let service: string | undefined;
				if (picked !== undefined) {
					// The board's picker: `null` clears, a string names a service.
					service = picked ?? undefined;
					if (service !== undefined && !services.some((candidate) => candidate.id === service)) {
						void vscode.window.showErrorMessage(`No service “${service}” in the Tests settings.`);
						return;
					}
				} else {
					const choice = await promptForService(ticket, services);
					if (choice === undefined) {
						return;
					}
					service = choice.id;
				}
				if (service === ticket.service) {
					return;
				}
				await run(async () => {
					await store.setService(ticket.id, service);
					refresh();
				});
			}
		),

		vscode.commands.registerCommand('bfast.renameTicket', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			if (!ticket) {
				return;
			}

			const title = await promptForTitle(`Rename ${ticket.key}`, undefined, ticket.title);
			if (title === undefined || title === ticket.title) {
				return;
			}

			await run(async () => {
				await store.renameTicket(ticket.id, title);
				refresh();
			});
		}),

		// From the sidebar a node, from a board's "Link ticket" button an id.
		// docs/tracker/ §Links is the specification.
		vscode.commands.registerCommand('bfast.linkTicket', async (node?: TicketNode | string) => {
			const id = typeof node === 'string' ? node : node?.ticket.id;
			if (!id) {
				return;
			}

			await run(async () => {
				const ticket = await store.getDetail(id);
				if (!ticket) {
					throw new Error(`Ticket ${id} is no longer in the tracker folder.`);
				}

				const relation = await promptForRelation(ticket);
				if (!relation) {
					return;
				}

				const already = new Set(
					(ticket.links ?? [])
						.filter((link) => link.relation === relation)
						.map((link) => link.id)
				);
				const candidates = (await store.listSummaries()).filter(
					(candidate) => candidate.id !== ticket.id && !already.has(candidate.id)
				);
				if (candidates.length === 0) {
					void vscode.window.showInformationMessage(
						`No other ticket to link ${ticket.id} to with “${LINK_RELATION_INFO[relation].label}”.`
					);
					return;
				}

				const picked = await vscode.window.showQuickPick(
					candidates.map((candidate) => ({
						label: `${candidate.id}  ${candidate.title}`,
						description: `${capitalize(TYPE_LABEL[candidate.type])} · ${STATUS_LABEL[candidate.status]}`,
						id: candidate.id
					})),
					{
						title: `${ticket.id} ${LINK_RELATION_INFO[relation].label}…`,
						placeHolder: 'Type an id or part of a title',
						matchOnDescription: true
					}
				);
				if (!picked) {
					return;
				}

				await store.linkTickets(ticket.id, relation, picked.id);
				refresh();
			});
		}),

		vscode.commands.registerCommand('bfast.deleteTicket', async (node?: TicketNode) => {
			const ticket = node?.ticket;
			if (!ticket) {
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				`Delete ${ticket.key} — ${ticket.title}?`,
				{
					modal: true,
					detail:
						'Everything inside it goes too. The folder moves to the trash, ' +
						'or is deleted for good where the file system has none (a remote workspace).'
				},
				'Delete'
			);
			if (confirmed !== 'Delete') {
				return;
			}

			await run(async () => {
				await store.deleteTicket(ticket.id);
				refresh();
			});
		}),

		// docs/tracker/ is the specification.
		vscode.commands.registerCommand('bfast.shortenTicketFolders', () =>
			run(async () => {
				const shorten = store.shortenFolderNames?.bind(store);
				const long = (await store.longFolderNames?.()) ?? [];
				if (!shorten || long.length === 0) {
					void vscode.window.showInformationMessage(
						`Every ticket folder name is already within ${MAX_FOLDER_NAME} characters.`
					);
					return;
				}

				const count = plural(long.length, 'ticket folder name');
				const confirmed = await vscode.window.showWarningMessage(
					`Shorten ${count}?`,
					{
						modal: true,
						detail:
							`Each becomes its ticket's id and title in ${MAX_FOLDER_NAME} characters ` +
							'or fewer. Only folder names change — ids, titles, descriptions and history ' +
							'stay as they are. Commit your other changes first, so git shows these as ' +
							'renames and nothing else.'
					},
					'Shorten'
				);
				if (confirmed !== 'Shorten') {
					return;
				}

				const outcome = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `BFAST: shortening ${count}…`
					},
					shorten
				);
				refresh();

				const done = `Shortened ${plural(outcome.renamed.length, 'ticket folder name')}.`;
				if (outcome.skipped.length === 0) {
					void vscode.window.showInformationMessage(done);
					return;
				}
				const listed = outcome.skipped
					.slice(0, 3)
					.map((skip) => `${skip.id} (${skip.reason})`)
					.join('; ');
				const more = outcome.skipped.length > 3 ? `; and ${outcome.skipped.length - 3} more` : '';
				void vscode.window.showWarningMessage(
					`${done} Left as ${outcome.skipped.length === 1 ? 'it was' : 'they were'}: ` +
						`${listed}${more}.`
				);
			})
		)
	];
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** `undefined` when the user backs out; never a blank title. */
async function promptForTitle(
	prompt: string,
	placeHolder?: string,
	value?: string
): Promise<string | undefined> {
	const title = await vscode.window.showInputBox({
		prompt,
		placeHolder,
		value,
		validateInput: (input) => (input.trim() === '' ? 'A title is required.' : undefined)
	});
	return title?.trim() || undefined;
}

async function promptForRelation(ticket: TicketSummary): Promise<LinkRelation | undefined> {
	const picked = await vscode.window.showQuickPick(
		LINK_RELATIONS.map((relation) => ({
			label: LINK_RELATION_INFO[relation].label,
			description: `${ticket.id} ${LINK_RELATION_INFO[relation].label} …`,
			relation
		})),
		{ title: `Link ${ticket.id} — ${ticket.title}`, placeHolder: 'How is it related?' }
	);
	return picked?.relation;
}

async function promptForStatus(current: TicketStatus): Promise<TicketStatus | undefined> {
	const picked = await vscode.window.showQuickPick(
		TICKET_STATUSES.map((status) => ({
			label: STATUS_LABEL[status],
			description: status === current ? 'current' : undefined,
			status
		})),
		{ placeHolder: 'Set status' }
	);
	return picked?.status;
}

/** Turns a store failure into a message instead of an unhandled rejection. */
/**
 * A board is keyed by its ticket's id, which a type change moves, so the tab
 * on the old id would resolve to nothing. Closed and opened on the new id —
 * only when one was open, since opening a board nobody asked for is noise.
 */
async function reopenBoard(oldId: string, newId: string): Promise<void> {
	const tabs = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter(
			(tab) => tab.input instanceof vscode.TabInputCustom && parseTicketUri(tab.input.uri) === oldId
		);
	if (tabs.length === 0) {
		return;
	}
	await vscode.window.tabGroups.close(tabs);
	await vscode.commands.executeCommand(OPEN_TICKET, newId);
}

async function run(operation: () => Promise<void>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		void vscode.window.showErrorMessage(
			errorMessage(error, 'The tracker folder could not be updated.')
		);
	}
}

function article(type: TicketType): string {
	const label = TYPE_LABEL[type];
	return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The quick pick behind Set Service…: "none" first, then every service, the
 * current one marked. A service with no test case command is offered but
 * says so — the run would refuse it, and hiding it would read as missing.
 */
async function promptForService(
	ticket: TicketSummary,
	services: readonly TestService[]
): Promise<{ id: string | undefined } | undefined> {
	if (services.length === 0) {
		const open = 'Open Settings';
		const answer = await vscode.window.showInformationMessage(
			'No services are configured. Add them on the Tests tab of the BFAST settings.',
			open
		);
		if (answer === open) {
			await vscode.commands.executeCommand('bfast.openSettings');
		}
		return undefined;
	}
	type Item = vscode.QuickPickItem & { id: string | undefined };
	const items: Item[] = [
		{
			id: undefined,
			label: 'None',
			description: ticket.service === undefined ? 'current' : undefined,
			detail: 'Run with the project test command'
		},
		...services.map((service) => ({
			id: service.id,
			label: service.name ?? service.id,
			description: [service.folder, ticket.service === service.id ? 'current' : undefined]
				.filter(Boolean)
				.join(' · '),
			...(service.e2e?.testCommand
				? {}
				: { detail: '⚠ No e2e test case command — a run of this test case would be refused' })
		}))
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: `Set service for ${ticket.id}`,
		placeHolder: 'Which service runs this test case?'
	});
	return picked ? { id: picked.id } : undefined;
}
