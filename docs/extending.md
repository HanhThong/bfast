# Extending BFAST

What to touch for the common kinds of change. If a change needs a file that is not on its list,
either the list is out of date or the change is crossing a boundary — check
[architecture.md](architecture.md) first.

## A settings block

1. `src/settings/<name>Settings.ts` — the type, `parse…` (never throws; `undefined` when nothing
   survived), `normalize…`, `validate…`.
2. `src/settings/bfastSettings.ts` — the field on `BfastSettings` and a row in `SETTINGS_BLOCKS`.
   Forgetting the row does not compile.
3. `src/webview/components/settings/<Name>Tab.tsx` and a row in `SETTINGS_TABS`
   (`settingsForm.tsx`); an `update<Name>` helper in `useSettingsForm.ts`.

A new *field inside* an existing block is step 1 only — but name it in both that block's parse and
its normalize, which rebuild from a literal.

## An implementation of a seam

AI provider, environment provider, scan tool, coding agent:

1. A class implementing the seam's interface, in the feature's folder.
2. Its id in the settings block's id list.
3. A row in the feature's registry (`ai/providerRegistry.ts`, `environments/environmentRegistry.ts`,
   `scan/scanRegistry.ts`, `implement/codingAgentRegistry.ts`). The table is a `Record` over the ids,
   so a missing row does not compile, and no forwarding code is needed.

## An MCP tool

One object in `TOOLS` in `src/mcp/mcpTools.ts`: `name`, `group`, `description`, `inputSchema` and
`run`. Add the method it calls to `McpToolContext`, implement it in `mcpContext.ts` and in
`src/test/fakeMcpContext.ts`. A new *function* (a switch in the settings tab) is also an id in
`mcpSettings.ts` and a row in `MCP_FUNCTION_DESCRIPTIONS`.

## A host ↔ webview message

1. The member, in the right module under `src/shared/protocol/`.
2. A `case` in that document's panel or controller. Without it the `unhandled(message)` default
   does not compile.
3. The webview side, through the document's `channel<…>()`.

Send names and ids across the bridge, never text the host should have resolved itself — an agent's
slug, a client id, a boolean for "continue the session".

## A tab on the board

1. A protocol module for its messages; add it to `BoardToHost` / `HostToBoard` in `protocol/index.ts`.
2. A controller in `src/board/` taking `BoardHost` and its own services object.
3. Its services on `BoardServices` (`boardServices.ts`), filled in `modules/boardModule.ts`.
4. Its cases in `BfastPanel.handleMessage`, and the React side under `src/webview/`.

## A feature

1. A folder under `src/` with the `vscode`-free rules, the store and the commands.
2. `src/modules/<name>Module.ts` exporting `activate<Name>(core, deps)` that returns a
   `FeatureModule` (its `disposables`, and `onSettingsApplied` if it reacts to settings).
3. One call and one entry in the `modules` list in `src/extension.ts`. What it needs from another
   feature is a parameter there.
4. `contributes` in `package.json`; command ids must match exactly.
5. `docs/<name>/README.md` — the spec, written first.

## Tests

- No `vscode` reachable from the test → it runs in `npm run test:unit` as well as `npm test`.
- A new seam ships with a fake under `src/test/`. If the fake needs a cast, a `vscode` import or
  knowledge of an implementation, the interface is in the wrong place.
- No test calls a real API or spawns a real `claude`, `docker` or `git` it did not set up itself.
