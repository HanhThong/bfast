// The generate tab: breaking a ticket into its children, start to finish.
//
// A webview editor tab rather than a quick pick and a progress notification,
// because the flow has three moments a modal cannot hold at once — a form, the
// minutes of log that say the run has not hung, and a list to tick through. A
// notification cannot be live while a quick pick has focus, so the two would
// have fought; and neither survives a click on the editor behind, which is a
// harsh way to lose a two-minute run.
//
// It is a `GeneratePrompts` implementation and nothing more: every decision the
// flow makes still lives in `generateChildrenCommand.ts`, and this only turns
// each ask into a message and each reply back into a promise. That is what lets
// the same flow be driven by a test with no UI at all.

import * as vscode from 'vscode';
import { agentsForType } from './agent';
import type { TicketType } from '../data/types';
import {
	generateChildren,
	type ChildrenChoice,
	type GeneratePrompts,
	type GenerateReport,
	type GenerateServices,
	type GenerateStep
} from './generateChildrenCommand';
import { HostToGenerate, GenerateToHost } from '../shared/protocol';
import { ticketTabIcon } from '../ticketIcon';
import { renderWebviewHtml } from '../host/webviewHtml';
import { unhandled } from '../platform/exhaustive';

const TYPE_PLURAL: Record<TicketType, string> = {
	epic: 'epics',
	story: 'stories',
	ac: 'acceptance criteria',
	testcase: 'test cases'
};

/** What the tab is waiting for the user to answer, if anything. */
interface Pending<T> {
	resolve: (value: T) => void;
}

export class GeneratePanel {
	public static readonly viewType = 'bfast.generate';

	/**
	 * One tab per (parent, child type).
	 *
	 * A `Set` scanned by key rather than a `Map`, for the reason `BfastPanel`
	 * gives — except here the key genuinely cannot change, since a tab is created
	 * for one ticket and never retargeted. Asking again reveals the open tab, so
	 * a second right-click can never start a second run against the same ticket.
	 */
	private static readonly panels = new Set<GeneratePanel>();

	private readonly disposables: vscode.Disposable[] = [];

	private disposed = false;

	/** Cancels the live run. Replaced per run; `undefined` between them. */
	private cancellation: vscode.CancellationTokenSource | undefined;

	/**
	 * Stop was pressed while nothing was cancellable yet.
	 *
	 * A batch spends its first moments reading the ticket, the agents and the
	 * provider's availability, and only then reaches the first `withProgress` —
	 * so there is a window with no token source to cancel. The tab shows a Stop
	 * button through it (it flips the instant Generate is pressed, which is the
	 * moment the user is looking at it), so the press has to be remembered and
	 * spent on the first source there is, not dropped.
	 */
	private stopRequested = false;

	/** What `generateStart` supplied, read back by the asks that never wait. */
	private submitted:
		| { agent?: string; instruction: string; continueSession: boolean; model?: string }
		| undefined;

	/** Resolved by `generateChoose`, `generateRefine` or `generateCancel`. */
	private choice: Pending<ChildrenChoice | undefined> | undefined;

	public static show(
		extensionUri: vscode.Uri,
		services: GenerateServices,
		parentId: string,
		childType: TicketType
	): GeneratePanel {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		for (const open of GeneratePanel.panels) {
			if (open.parentId === parentId && open.childType === childType) {
				open.panel.reveal(column);
				return open;
			}
		}

		const panel = vscode.window.createWebviewPanel(
			GeneratePanel.viewType,
			`Generate ${TYPE_PLURAL[childType]} — ${parentId}`,
			column,
			GeneratePanel.webviewOptions(extensionUri)
		);

		return new GeneratePanel(panel, extensionUri, services, parentId, childType);
	}

	/**
	 * Called by the serializer after a window reload.
	 *
	 * A restored tab comes back on the form: a run is a child process this
	 * session owned, so there is nothing to resume, and pretending otherwise
	 * would leave a log that never advances. The webview's own `setState` carries
	 * which ticket it was for, which reaches us on `generateReady`.
	 */
	public static revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		services: GenerateServices,
		parentId: string,
		childType: TicketType
	): void {
		panel.webview.options = GeneratePanel.webviewOptions(extensionUri);
		new GeneratePanel(panel, extensionUri, services, parentId, childType);
	}

	private static webviewOptions(
		extensionUri: vscode.Uri
	): vscode.WebviewOptions & vscode.WebviewPanelOptions {
		return {
			enableScripts: true,
			// A run takes minutes and the log is the only proof it is alive;
			// rebuilding the webview on every tab switch would throw it away.
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly services: GenerateServices,
		private parentId: string,
		private childType: TicketType
	) {
		GeneratePanel.panels.add(this);

		this.panel.webview.html = renderWebviewHtml(
			this.panel.webview,
			extensionUri,
			'generate',
			`Generate ${TYPE_PLURAL[childType]}`
		);

		this.panel.webview.onDidReceiveMessage(
			(message: GenerateToHost) => this.handleMessage(message),
			undefined,
			this.disposables
		);

		this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
	}

	public dispose(): void {
		this.disposed = true;
		GeneratePanel.panels.delete(this);

		// Closing the tab is as clear a "stop" as pressing Cancel, and the log it
		// was reporting into is gone either way.
		this.cancellation?.cancel();
		this.choice?.resolve(undefined);
		this.choice = undefined;

		this.panel.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleMessage(message: GenerateToHost): Promise<void> {
		switch (message.type) {
			case 'generateReady':
				// A revived tab knows its own ticket before we do; trust it only to
				// name one, never for anything the flow reads.
				if (message.parentId && message.childType) {
					this.parentId = message.parentId;
					this.childType = message.childType;
				}
				await this.sendContext();
				break;

			case 'generateStart':
				this.stopRequested = false;
				this.submitted = {
					agent: message.agent,
					instruction: message.instruction,
					continueSession: message.continueSession,
					model: message.model
				};
				await this.run();
				break;

			case 'generateChoose':
				this.choice?.resolve({ kind: 'create', titles: message.titles });
				this.choice = undefined;
				break;

			case 'generateRefine': {
				const instruction = message.instruction.trim();
				if (instruction.length > 0) {
					this.choice?.resolve({ kind: 'refine', instruction });
					this.choice = undefined;
				}
				break;
			}

			case 'generateCancel':
				if (this.cancellation) {
					// A step is live — planning, refining or writing — and only that
					// step stops: a stopped refine returns the flow to the review
					// screen with the list it had, which is what the user asked for.
					this.cancellation.cancel();
				} else if (this.choice) {
					// Parked on the review screen: Discard.
					this.choice.resolve(undefined);
					this.choice = undefined;
				} else {
					// Nothing to press it on yet — the gap before the first step.
					this.stopRequested = true;
				}
				break;

			case 'generateReset':
				this.post({ type: 'generatePhase', phase: 'setup' });
				break;
			default:
				unhandled(message);
		}
	}

	/** The form's data: the parent, the agents that fit, and whether AI can run. */
	private async sendContext(): Promise<void> {
		const parent = await this.services.store.getDetail(this.parentId);
		if (!parent) {
			this.post({
				type: 'generateError',
				message: `Ticket ${this.parentId} is no longer in the tracker folder.`
			});
			return;
		}

		this.panel.title = `Generate ${TYPE_PLURAL[this.childType]} — ${parent.key}`;
		this.panel.iconPath = ticketTabIcon(this.extensionUri, parent.type, parent.status);

		const availability = (await this.services.ai?.availability()) ?? {
			ok: false,
			message: 'The AI assistant is not available.'
		};

		this.post({
			type: 'generateContext',
			parent: { id: parent.id, key: parent.key, title: parent.title, type: parent.type },
			childType: this.childType,
			// Filtered here rather than in the webview, so the picker offers exactly
			// what `generateChildren` will consider.
			agents: agentsForType((await this.services.aiAgents?.()) ?? [], this.childType),
			available: availability.ok,
			unavailable: availability.message,
			providerLabel: this.services.ai?.label,
			// What "Default" in the picker means.
			model: this.services.aiSettings?.()?.model
		});
		this.postSession();
	}

	/**
	 * Whether there is a conversation this tab can continue. After the context,
	 * and again after every run — a run may just have started one, and "Run
	 * again" has to offer it. Only the fact, never the id: the webview asks with
	 * a boolean and the host resolves what to resume.
	 */
	private postSession(): void {
		const session = this.services.sessions?.get(this.parentId, this.childType);
		this.post({
			type: 'generateSession',
			previous:
				session && session.provider === this.services.ai?.id ? { at: session.at } : undefined
		});
	}

	private async run(): Promise<void> {
		try {
			await generateChildren(
				{ ...this.services, prompts: this.prompts() },
				this.parentId,
				this.childType
			);
		} finally {
			// Whatever happened — done, cancelled, refused, thrown — the run is over,
			// so the tab must stop showing a Stop button. In a `finally` because the
			// tab shows Stop optimistically from the moment Generate is pressed: a
			// rejection here would otherwise leave it there for a run that is not
			// happening, and leave the flow with no way back to the form.
			this.cancellation = undefined;
			this.post({ type: 'generatePhase', phase: 'done' });
			this.postSession();
		}
	}

	/**
	 * The seam, wired to the tab.
	 *
	 * `pickAgent` and `askInstruction` do not wait for anything: the form asks
	 * for both in one submit, so by the time the flow asks, the answers are
	 * already in `submitted`. The agent is matched back **by slug**, never taken
	 * as an object — the host resolves what actually runs.
	 */
	private prompts(): GeneratePrompts {
		return {
			pickAgent: async (agents) =>
				agents.find((agent) => agent.slug === this.submitted?.agent) ?? agents[0],

			askInstruction: async () => this.submitted?.instruction ?? '',

			continueSession: async () => this.submitted?.continueSession ?? false,

			// A name only; the flow sanitises it before it becomes an argv element.
			pickModel: async () => this.submitted?.model,

			pickChildren: async (titles, _parent, followUps) => {
				if (this.disposed) {
					return undefined;
				}
				this.post({
					type: 'generateProposed',
					titles: [...titles],
					followUps: [...followUps]
				});
				this.post({ type: 'generatePhase', phase: 'review' });
				return new Promise<ChildrenChoice | undefined>((resolve) => {
					this.choice = { resolve };
				});
			},

			withProgress: async <T>(
				step: GenerateStep,
				title: string,
				task: (report: GenerateReport, token: vscode.CancellationToken) => Promise<T>
			): Promise<T> => {
				this.cancellation?.dispose();
				this.cancellation = new vscode.CancellationTokenSource();
				if (this.stopRequested) {
					// Pressed before there was anything to press it on. The flow checks
					// `isCancellationRequested` before it starts a run, so spending it here
					// stops the batch rather than merely stopping it one step later. Spent
					// once: a press stops one step, never the one after it — a Stop that
					// ended a refine would otherwise cancel the writing the user then starts.
					this.stopRequested = false;
					this.cancellation.cancel();
				}

				this.post({ type: 'generatePhase', phase: step });
				this.post({ type: 'generateLog', line: title });

				try {
					return await task(
						{
							log: (line, lane) => this.post({ type: 'generateLog', line, lane }),
							lane: (lane, laneTitle, status, note) =>
								this.post({ type: 'generateLane', lane, title: laneTitle, status, note })
						},
						this.cancellation.token
					);
				} finally {
					this.cancellation.dispose();
					this.cancellation = undefined;
				}
			},

			created: (ticket, described) =>
				this.post({
					type: 'generateCreated',
					id: ticket.id,
					key: ticket.key,
					title: ticket.title,
					described
				}),

			info: (message) => this.post({ type: 'generateDone', message }),

			error: (message) => this.post({ type: 'generateError', message })
		};
	}

	private post(message: HostToGenerate): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}
