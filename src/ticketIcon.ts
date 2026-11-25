// How a ticket looks, wherever it is shown: the shape says what kind of ticket
// it is, the colour says how far along it is. Both the sidebar tree and the
// board tabs read from here, so a ticket cannot wear one icon in the tree and a
// different one on its own tab.
//
// They get there by different routes, though, and that is not a choice:
//
// A `TreeItem` renders a `ThemeIcon` as a real glyph and tints it with the
// `ThemeColor`, so the tree follows whatever the user's theme calls
// `charts.blue`. A webview tab draws its icon as a picture and ignores the
// colour, so a tab needs an actual file with the fill baked in — which is also
// why those files use fixed mid-tone hexes rather than theme colours: the
// extension host cannot read a theme's palette, and one file has to sit
// legibly on both a light and a dark tab bar.

import * as vscode from 'vscode';
import { TicketStatus, TicketType } from './data/types';

/** The shape says what kind of ticket it is. */
const TYPE_ICON: Record<TicketType, string> = {
	epic: 'rocket',
	story: 'book',
	ac: 'checklist',
	testcase: 'beaker'
};

/** The colour says how far along it is. */
const STATUS_COLOR: Record<TicketStatus, string> = {
	'todo': 'descriptionForeground',
	'in-progress': 'charts.blue',
	'in-review': 'charts.yellow',
	'done': 'charts.green',
	'blocked': 'charts.red'
};

/** For the sidebar tree, which tints a `ThemeIcon` properly. */
export function ticketIcon(type: TicketType, status: TicketStatus): vscode.ThemeIcon {
	return new vscode.ThemeIcon(TYPE_ICON[type], new vscode.ThemeColor(STATUS_COLOR[status]));
}

/**
 * For a board tab, which does not. `media/ticket/` holds one file per type and
 * status, generated from the same codicons the tree uses so the two match; see
 * the note at the top of this file.
 */
export function ticketTabIcon(
	extensionUri: vscode.Uri,
	type: TicketType,
	status: TicketStatus
): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, 'media', 'ticket', `${type}-${status}.svg`);
}

/** A board tab with no ticket in it yet, matching the Open Board button. */
export const EMPTY_BOARD_ICON = new vscode.ThemeIcon('window');

/** A board whose ticket is no longer in the tracker folder. */
export const MISSING_TICKET_ICON = new vscode.ThemeIcon('warning');
