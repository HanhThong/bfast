# BFAST Board tabs

A ticket's **board** — the tab that shows and edits its description, history, tests and design
documents — opens the way a file does. A **single click** on a ticket in the **Tickets** view opens
it in a *preview* tab, title in italics; a single click on another ticket shows that ticket in the
same tab. A **double-click** opens it as an ordinary, pinned tab — upright title — that later single
clicks leave alone. Starting to work in a preview board pins it, the way a file is pinned the moment
it is dirtied. The editor's own settings rule all of it, and BFAST adds none of its own.

This folder is the feature's specification. The evidence behind the design is the **LLD-1 Spike**
design document on epic EP-2 in the tracker: twelve measurements in a real VS Code and a reading of
its workbench bundle.

## What each gesture does

| Gesture | Tab | Why |
|---|---|---|
| single click on a ticket | a **preview** tab (italic title); the next single click on another ticket reuses it | the tree item's command is `vscode.open` on the ticket's resource, and the tree hands that command its own open event, `preview: true` |
| single click on a ticket that already has a pinned tab | reveals that tab; the preview tab is left on whatever it showed | one editor per resource |
| double-click on a ticket | a **pinned** tab; on the ticket in the preview tab, pins that same tab in place | the same open event, `pinned: true` |
| Enter on a tree row | as a single click | VS Code's tree |
| Edit, Save, **AI Assistant**, **Run tests** in a preview board | pins it | the board sends `editStarted` / `saveDescription` / `aiGenerate` / `testsRun`; the host runs `workbench.action.keepEditor` when the tab `isPreview` |
| `bfast.openTicket` — after a create, from a worktree window's marker, a link on another board, MCP | a **pinned** tab | nobody clicked, and a preview tab would be taken away by the next click |
| **Open Board** on the title bar | reveals the board you were last on; else opens the ticket selected in the tree, pinned; else says so | there is no blank board: a custom editor always has a resource |
| drag a board to another group, or open it to the side | **moves** the tab | `supportsMultipleEditorsPerDocument: false` — one editor per ticket |
| window reload | every board comes back on its ticket, preview or pinned as it was | VS Code restores custom editors itself, title included |

Two VS Code settings decide the rest, and there is deliberately no BFAST setting beside them:

- `workbench.editor.enablePreview` — off, and every click opens pinned.
- `workbench.list.openMode` — `doubleClick`, and a single click only selects.

## Why a custom editor

A board used to be a `WebviewPanel`, and VS Code gives a webview panel no preview mode at all:
`WebviewPanelOptions` has no `preview` flag and `Tab.isPreview` is read-only. Preview is a property
of *editor inputs* — files, notebooks, custom editors — so the board became a
`CustomReadonlyEditorProvider` (view type `bfast.board`) on a virtual resource, `bfast-ticket:/<id>`,
contributed with `filenamePattern: "bfast-ticket:/**"` (a pattern containing `/` is matched against
`scheme:path`). `src/data/ticketUri.ts` is the grammar; `BfastPanel.register` the provider.

The facts the design rests on, each measured in the spike:

- The tree's `onDidOpen` appends the open event — `editorOptions.preview` / `pinned` — to the
  arguments of **`vscode.open` and `vscode.diff` only**. Any other command runs once per open event
  with no way to tell a click from a double-click. That is why the tree item's command had to
  change, and why `bfast.openTicket` is the pinned, programmatic route rather than the click's.
- A custom editor's tab label is the **webview title when set** (`CustomEditorInput.getName()`
  prefers `getWebviewTitle()`), else the resource's basename. So `panel.title = "<id> <title>"`
  keeps working, the resource carries the **id alone**, and a rename changes nothing but the title.
  A title in the path was tried and is wrong: `/EP-3 Sign in/out` labels the tab `out`.
- The tab icon is the panel's `iconPath` — `CustomEditorInput` inherits `WebviewInput.getIcon()` —
  so the status-coloured `media/ticket/*.svg` files are unchanged.
- A rank's `#` (`EP-1#2`) survives the resource when built with `Uri.from`; `Uri.parse` would read
  it as a fragment.

Rejected on the way: Unicode italics in the title (ASCII only, unreadable to a screen reader), a
`(preview)` suffix, a `FileDecorationProvider` for the icon, and guessing a double-click from two
rapid `bfast.openTicket` calls — the emulated fallback the plan carried until the spike made it
unnecessary.

## What did not change

The webview protocol, the React app, `showTicket`, the sidebar following the active board
(`onDidShowTicket`, now also fired from `resolveCustomEditor` for a tab opened by a click or restored
as the active one), the `<id> <title>` label, the icon, one board per ticket, and the ticket that no
longer resolves (titled by its bare id, warning icon). `BfastPanel.revive` and the board's
`registerWebviewPanelSerializer` are gone: a restore is `openCustomDocument` + `resolveCustomEditor`
again.

## Tests

`src/test/board.test.ts` drives `vscode.open` with `preview: true` (a click) and `preview: false`
(a double-click) and asserts through `window.tabGroups`: one preview tab reused, pinned in place,
left alone, one editor per ticket, moved to the side, pinned when `enablePreview` is off. It sets
`workbench.editor.enablePreview` in `suiteSetup` and restores the previous value in
`suiteTeardown`. The headless runner cannot send a double-click, so none is synthesised. The one
thing neither the suite nor the spike can measure is a window reload — the test host dies with it —
so that is checked by hand after a change to the provider; the mechanism itself is VS Code's.
