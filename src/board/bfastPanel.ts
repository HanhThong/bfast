import * as vscode from 'vscode';
import { isLinkRelation } from '../data/ticketLinks';
import { parseTicketUri, ticketUri } from '../data/ticketUri';
import { errorMessage } from '../platform/errors';
import { unhandled } from '../platform/exhaustive';
import type { BoardToHost, HostToBoard } from '../shared/protocol';
import { EMPTY_BOARD_ICON, MISSING_TICKET_ICON, ticketTabIcon } from '../ticketIcon';
import { AiController } from './aiController';
import { AttachmentController } from './attachmentController';
import type { BoardHost } from './boardHost';
import type { BoardServices } from './boardServices';
import { DesignController } from './designController';
import { TestsController } from './testsController';
import { renderWebviewHtml } from '../host/webviewHtml';

export type {
	AiBoardServices,
	BoardServices,
	DesignBoardServices,
	TestBoardServices
} from './boardServices';

/**
 * The BFAST board, shown as a webview editor tab — one per ticket, the way an
 * editor gives one tab per file. Opening a ticket that is already open reveals
 * its tab instead of adding a second.
 *
 * Panels are tracked in an insertion-ordered `Set`: `reveal()` re-inserts, so
 * the last entry is the board the user was last on, which is what the Open
 * Board button lands on. Which ticket a panel shows is its resource's to say —
 * a board is a custom editor of `bfast-ticket:/<id>` (see `ticketUri.ts`), so
 * VS Code owns the tab: preview on a single click, pinned on a double-click,
 * one editor per ticket, restored after a reload.
 *
 * This class is the tab: its lifecycle, its title and icon, which ticket it
 * shows, and the ticket's own description. Everything else a board does is a
 * controller in `board/` — images, the Tests tab, the design tabs, the
 * assistant — each handed the narrow `BoardHost` and the messages of its own
 * protocol module.
 */
export class BfastPanel {
	public static readonly viewType = 'bfast.board';

	private static readonly panels = new Set<BfastPanel>();

	private readonly disposables: vscode.Disposable[] = [];

	/** The ticket this board is showing, replayed when the webview reloads. */
	private currentTicketId: string | undefined;

	/** Set before the webview goes away, so a reply that lands late is dropped. */
	private disposed = false;

	private readonly attachments: AttachmentController;
	private readonly tests: TestsController;
	private readonly design: DesignController;
	private readonly ai: AiController;

	/**
	 * Makes the board VS Code's editor for `bfast-ticket:/<id>` resources. From
	 * here VS Code owns the tab: a single click in the tree (`vscode.open` with
	 * the tree's own open event) opens a preview tab the next click reuses, a
	 * double-click pins it, `workbench.editor.enablePreview` and
	 * `workbench.list.openMode` apply with no code here, there is one editor per
	 * resource ("open to the side" *moves* the tab), and every board comes back
	 * after a reload, title included — so there is no serializer and no revive.
	 */
	public static register(extensionUri: vscode.Uri, services: BoardServices): vscode.Disposable {
		const provider: vscode.CustomReadonlyEditorProvider = {
			// Never throws, a ticket that does not resolve included: the board says
			// so itself, as it always has.
			openCustomDocument: (uri) => ({ uri, dispose: () => {} }),
			resolveCustomEditor: async (document, panel) => {
				// The resource is the authority for which ticket this board shows.
				const id = parseTicketUri(document.uri) ?? document.uri.path.slice(1);
				// The workspace folders as roots, not the tracker: a restore runs
				// before settings have been read — see `webviewOptions`.
				panel.webview.options = BfastPanel.webviewOptions(extensionUri);
				const board = new BfastPanel(panel, extensionUri, services);
				// Title and icon before the tab is first painted.
				await board.showTicket(id);
				// A tab opened by a click, or the one VS Code restored as the active
				// one, fires no view-state event of its own: the sidebar follows
				// from here. On startup this runs before the tree is configured, so
				// the sidebar parks the id until its root loads.
				if (panel.active) {
					services.onDidShowTicket?.(id);
				}
			}
		};
		return vscode.window.registerCustomEditorProvider(BfastPanel.viewType, provider, {
			webviewOptions: {
				// The React state (selection, expanded nodes, pane width) survives
				// the user switching to another tab and back.
				retainContextWhenHidden: true
			},
			supportsMultipleEditorsPerDocument: false
		});
	}

	/**
	 * Opens a ticket's board **pinned** — the programmatic route (a create, a
	 * worktree window's marker, a link on another board, MCP), where nobody
	 * clicked and a preview tab would be taken away by the next click. A click
	 * reaches `vscode.open` from the tree item itself, with its own options.
	 */
	public static async open(services: BoardServices, id: string): Promise<void> {
		await vscode.commands.executeCommand('vscode.open', ticketUri(id), { preview: false });
		// A tab that was already open and active fires no view-state event.
		services.onDidShowTicket?.(id);
	}

	/**
	 * The toolbar's Open Board button: reveals the board the user was last on.
	 * `false` when no board is open — a board is always some ticket's, so the
	 * caller then opens the selected ticket instead.
	 */
	public static revealLast(): boolean {
		const existing = [...BfastPanel.panels].pop();
		if (!existing) {
			return false;
		}
		existing.reveal();
		return true;
	}

	/** Brings this tab forward, and marks it as the most recently used one. */
	private reveal(): void {
		this.panel.reveal(this.panel.viewColumn);
		// Re-inserting moves it to the end of the insertion-ordered set, which is
		// what makes `revealLast` land on the board the user was last on.
		BfastPanel.panels.delete(this);
		BfastPanel.panels.add(this);
	}

	private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
		return {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
				// So a ticket's `assets/` images load. The workspace folders are a
				// provable superset of the tracker — `validateTrackerFolder` refuses
				// absolute paths and `..`, and the tracker is joined onto a workspace
				// folder — which is what lets this work on a restore too: that runs
				// before settings have been read, so a root that followed
				// `trackerFolder` would come back empty and 404 every image.
				...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
			]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly services: BoardServices
	) {
		this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'main', 'BFAST');
		// Replaced by the ticket's own icon as soon as `showTicket` has read it.
		this.panel.iconPath = EMPTY_BOARD_ICON;

		this.panel.webview.onDidReceiveMessage(
			(message: BoardToHost) => this.handleMessage(message),
			undefined,
			this.disposables
		);

		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

		// Switching to an open board's tab: the sidebar follows the tab, the way
		// the Explorer follows the active editor.
		this.panel.onDidChangeViewState(
			(event) => {
				if (event.webviewPanel.active && this.currentTicketId) {
					// The board the user is on is the most recently used one — what
					// the Open Board button lands on — however it became active.
					BfastPanel.panels.delete(this);
					BfastPanel.panels.add(this);
					services.onDidShowTicket?.(this.currentTicketId);
				}
			},
			undefined,
			this.disposables
		);

		const host: BoardHost = {
			store: services.store,
			post: (message) => this.post(message),
			ticketId: () => this.currentTicketId,
			isDisposed: () => this.disposed,
			pin: () => this.pin(),
			asWebviewUri: (uri) => this.panel.webview.asWebviewUri(uri),
			onChanged: () => services.onChanged()
		};
		this.attachments = new AttachmentController(host);
		this.tests = new TestsController(host, services.tests);
		this.ai = new AiController(host, services.ai, services.designs);
		this.design = new DesignController(host, services.designs, (ticketId, designId) =>
			this.ai.postAiSession(ticketId, designId)
		);
		this.disposables.push(this.tests);

		BfastPanel.panels.add(this);
	}

	public dispose(): void {
		BfastPanel.panels.delete(this);

		// Before the tab goes, so a reply that lands late is dropped and the
		// assistant's child process does not outlive the board that asked for it.
		this.disposed = true;
		this.ai.dispose();

		this.panel.dispose();

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	/**
	 * Re-sends what every open board is showing, after the tracker changed on
	 * disk. The webviews decide what to do with it — in particular they will not
	 * throw away an edit in progress. This is also where a ticket renamed in
	 * another tab, or by a `git pull`, reaches the tab titles.
	 */
	public static async reloadAll(): Promise<void> {
		await Promise.all(
			[...BfastPanel.panels].map((panel) =>
				panel.currentTicketId ? panel.showTicket(panel.currentTicketId) : undefined
			)
		);
	}

	public async showTicket(id: string): Promise<void> {
		this.ai.onTicketShown(id);
		if (this.currentTicketId !== id) {
			this.tests.onTicketChanged();
		}
		this.currentTicketId = id;
		const ticket = await this.services.store.getDetail(id);
		if (this.disposed) {
			// The tab closed during the read; a title set on a disposed panel throws.
			return;
		}

		if (ticket) {
			// `EP-1 Authentication` — the id alone is too terse to tell two tabs
			// apart, and the title alone loses the position in the tree.
			this.panel.title = `${ticket.id} ${ticket.title}`;
			// The same icon the sidebar gives it: type picks the shape, status the
			// colour, so a tab and its tree row read as the same ticket. A tab needs
			// it as a file — see the note in `ticketIcon.ts`.
			this.panel.iconPath = ticketTabIcon(this.extensionUri, ticket.type, ticket.status);
			this.post({
				type: 'ticketDetail',
				ticket,
				assetBase: await this.assetBase(id),
				...(await this.design.state(ticket.id, ticket.type))
			});
		} else {
			// The id is still the most useful label for a tab whose ticket has gone.
			this.panel.title = id;
			this.panel.iconPath = MISSING_TICKET_ICON;
			this.post({
				type: 'ticketError',
				id,
				message: `Ticket ${id} is no longer in the tracker folder.`
			});
		}
	}

	/**
	 * Routes a message to the concern it belongs to. The cases are listed rather
	 * than matched by prefix so the compiler narrows each group to its own
	 * protocol union — and `unhandled` fails the build when a message is added to
	 * the protocol and to no group here.
	 */
	private async handleMessage(message: BoardToHost): Promise<void> {
		switch (message.type) {
			case 'ready': {
				// A fresh or revived tab has no idea whether the assistant is usable,
				// so tell it before it paints the button.
				void this.ai.postAiAvailability();

				// The resource says which ticket this is; the webview's own
				// `selectedId` is only its React state and is not consulted.
				if (this.currentTicketId) {
					await this.showTicket(this.currentTicketId);
				}
				break;
			}

			case 'editStarted':
				void this.pin();
				break;

			case 'saveDescription': {
				void this.pin();
				try {
					const ticket = await this.services.store.updateDescription(
						message.id,
						message.description,
						message.baseUpdatedAt,
						message.aiNote ? { comment: message.aiNote } : undefined
					);
					this.post({
						type: 'ticketSaved',
						ticket,
						assetBase: await this.assetBase(message.id),
						...(await this.design.state(ticket.id, ticket.type))
					});
					// The title bar and any status change belong to the sidebar too.
					this.services.onChanged();
				} catch (error) {
					this.post({
						type: 'ticketError',
						id: message.id,
						message: errorMessage(error, 'The ticket could not be saved.')
					});
				}
				break;
			}

			case 'openTicket':
				await vscode.commands.executeCommand('bfast.openTicket', message.id);
				break;

			case 'linkTicket':
				// The command refreshes the tracker, which repaints every open board —
				// the other end of the link included.
				await vscode.commands.executeCommand('bfast.linkTicket', message.id);
				break;

			case 'unlinkTicket': {
				// The webview is the untrusted half: the relation is checked, never
				// passed through.
				if (!isLinkRelation(message.relation)) {
					break;
				}
				try {
					await this.services.store.unlinkTickets(message.id, message.relation, message.targetId);
					this.services.onChanged();
				} catch (error) {
					this.post({
						type: 'ticketError',
						id: message.id,
						message: errorMessage(error, 'The link could not be removed.')
					});
				}
				break;
			}

			case 'openSettings':
				await vscode.commands.executeCommand('bfast.openSettings');
				break;

			case 'pickImage':
			case 'insertImage':
			case 'insertImageFromUri':
				await this.attachments.handle(message);
				break;

			case 'aiGenerate':
			case 'aiCancel':
				await this.ai.handle(message);
				break;

			case 'testsReport':
			case 'testsRuns':
			case 'testsOutput':
			case 'testsRun':
			case 'testsCancel':
			case 'openEvidence':
			case 'testsMedia':
			case 'testsTrace':
			case 'testsTraceFrame':
			case 'openTraceViewer':
			case 'openTraceSource':
			case 'testsSetService':
				await this.tests.handle(message);
				break;

			case 'designOpen':
			case 'designSave':
			case 'designCreate':
			case 'designRename':
			case 'designDelete':
				await this.design.handle(message);
				break;

			default:
				unhandled(message);
		}
	}

	/**
	 * Pins this board's tab when it is a preview one — the moment work starts in
	 * it (Edit, Save, an AI run, a test run), the way VS Code pins a file the
	 * moment it is dirtied, so the next single click in the tree cannot take the
	 * tab away from under an edit. `Tab.isPreview` is the only state consulted,
	 * and the webview knows nothing of it: it only says that work began.
	 * `keepEditor` acts on the active editor, hence the reveal first — the user
	 * just pressed something in this board, so that is where they already are.
	 */
	private async pin(): Promise<void> {
		const tab = vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.find(
				(candidate) =>
					candidate.input instanceof vscode.TabInputCustom &&
					candidate.input.viewType === BfastPanel.viewType &&
					parseTicketUri(candidate.input.uri) === this.currentTicketId
			);
		if (!tab?.isPreview) {
			return;
		}
		this.panel.reveal(this.panel.viewColumn);
		await vscode.commands.executeCommand('workbench.action.keepEditor');
	}

	/** Pushes fresh availability to every open board, after a credential or an agent changed. */
	public static async refreshAiAvailability(): Promise<void> {
		await Promise.all([...BfastPanel.panels].map((panel) => panel.ai.postAiAvailability()));
	}

	/** The ticket's folder as a uri the webview may load images from. */
	private async assetBase(id: string): Promise<string | undefined> {
		const folder = await this.services.store.folderUri?.(id);
		// The trailing slash matters: the webview resolves `assets/x.png` against
		// this, and without it the last segment would be replaced instead.
		return folder ? `${this.panel.webview.asWebviewUri(folder)}/` : undefined;
	}

	private post(message: HostToBoard): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}
