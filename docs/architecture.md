# Architecture

The short map. The reasons behind individual decisions are in [CLAUDE.md](../CLAUDE.md) and in each
feature's own `docs/<feature>/`; this page is where to start.

## Two programs

| | Source | Built by | Runs in |
|---|---|---|---|
| Extension host | `src/**` except `src/webview` | `tsc` → `out/` | Node, with the `vscode` API |
| Webview UI | `src/webview/**` | esbuild → `out/webview/` | a browser sandbox, one bundle per tab kind |

They talk only through typed messages in [`src/shared/protocol/`](../src/shared/protocol/index.ts).

## Layers

```
extension.ts            which features exist, and what each is handed
   │
modules/                one activate<Feature>(core, deps) per feature
   │
<feature folders>       data  ai  board  commit  design  environments  implement  mcp  scan  settings  testing
   │
host/                   vscode glue with no feature of its own
platform/               vscode-free helpers every feature shares
shared/                 the host ↔ webview seam (Node-free)
```

Imports point downwards. ESLint enforces the parts that matter:

- nothing outside `extension.ts` and `modules/` imports a module;
- `platform/`, `shared/` and `webview/` never import `vscode`;
- `shared/` and `webview/` never import a Node built-in.

One feature's live objects — a store, a provider, a running batch — reach another only as an
argument in `extension.ts`. Today those are:

| Needs | From | As |
|---|---|---|
| tracker (type change) | environments | `hasEnvironment(id)` |
| scan | environments | `resolveDirectory(ticketId)` — the worktree to analyse |
| mcp | tracker, tests, environments, scan | stores, `batches`, `startScan` |
| board | tracker, ai, tests, implement, mcp | their module objects |

That rule is about instances, not imports. A feature folder still imports another's types and pure
helpers directly — `mcp/mcpContext.ts` takes `EnvironmentStore` as a type, `scan/scanServerStore.ts`
uses `environments/portAllocator`, `environments/environmentMcp.ts` uses `mcp/mcpClients` — and no
lint rule covers those.

## Inside a feature

Each feature is split the same way:

- a **`vscode`-free half** holding the rules (`ticketTree.ts`, `testRunner.ts`, `generateChildren.ts`,
  `mcpTools.ts`…), unit-testable in plain Node (`npm run test:unit`);
- a **`vscode` half** — a store, a tree provider, commands, a panel;
- a **seam** when there is more than one implementation, with a fake in `src/test/` that proves the
  seam can be satisfied without a cast.

| Seam | Implementations | Picked by | Fake |
|---|---|---|---|
| `AiProvider` | Claude CLI, Claude Agent SDK | `ai.provider` | `FakeAiProvider` |
| `EnvironmentProvider` | Docker Compose, k8s (stub) | `environments.provider` | `FakeEnvironmentProvider` |
| `ScanProvider` | SonarQube | `scan.tool` | `FakeScanProvider` |
| `CodingAgent` | Claude Code, Claude Code CLI, six coming-soon | `implement.agent` | `FakeCodingAgent` |
| `TicketStore` / `TicketWriter` | `FileTicketStore` | — | `MockTicketStore` |
| `McpToolContext` | `bfastMcpContext` | — | `FakeMcpContext` |

The four provider seams are chosen through one helper,
[`configuredProvider`](../src/platform/providerRegistry.ts): a table of implementations and a getter
for the setting, read on every call.

## Settings

`.vscode/bfast.json` is one object: two top-level fields and one optional block per feature. Each
block is a row of `SETTINGS_BLOCKS` in [`bfastSettings.ts`](../src/settings/bfastSettings.ts) —
`parse` (forgiving), `normalize` (omits an empty block), `validate` (strict). The host and the
settings form share those functions.

Everything reads settings **at call time**, through
[`WorkspaceContext`](../src/host/workspaceContext.ts) or a feature's own context built from it, so
nothing depends on the order things are constructed in.

## The board

A board is a custom editor on `bfast-ticket:/<id>`. [`bfastPanel.ts`](../src/board/bfastPanel.ts) owns
the tab and routes each message to a controller:

| Controller | Messages | Owns |
|---|---|---|
| (the panel itself) | `ready`, `editStarted`, `saveDescription`, `openTicket`, `openSettings` | title, icon, the description |
| `AttachmentController` | `pickImage`, `insertImage`, `insertImageFromUri` | images into `assets/` |
| `TestsController` | `tests*`, `openEvidence`, `openTrace*` | the report, the batches this board follows |
| `DesignController` | `design*` | design documents |
| `AiController` | `aiGenerate`, `aiCancel` | the one run in flight, adoption, sessions |
