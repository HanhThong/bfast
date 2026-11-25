# The MCP server

BFAST can listen on an HTTP port and speak the **Model Context Protocol** over the
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
so a coding agent or any other MCP client — one that lives outside this editor window — can read
and change the workspace's tickets and trigger BFAST's own actions, instead of a person carrying
information between windows by hand.

It is **off until someone switches it on**. Nothing listens for a workspace that does not want it.

- [Configuration — the `mcp` block](configuration.md)

## What it is

One HTTP endpoint, `POST http://<host>:<port>/mcp`, carrying JSON-RPC 2.0. That is the whole
surface: there is no stdio transport and no legacy HTTP+SSE transport, and there is no plan to
add one — a client that cannot speak Streamable HTTP simply cannot connect, and the failure it
reports is not a symptom of the port or the reach settings.

The server is hand-rolled on Node's `http` module. BFAST's extension host has exactly one
dependency (the optional Agent SDK) and `vsix` packages with `--no-dependencies`, so an MCP SDK
would not reach a user's machine even if it were added — the same reasoning that makes
`yaml.ts`, `zipFile.ts` and `sonarProjectProperties.ts` hand-rolled readers.

## Lifecycle

The server's whole lifecycle is the settings file:

| What the user does | What happens |
|---|---|
| Saves settings with the server switched on | It starts, or **restarts** on the new settings if it was already running |
| Saves settings with the server switched off | It stops, and the address goes away |
| Saves a change to the `mcp` block while it is running | It restarts, because a save may have changed which functions are offered |
| Saves a change to anything else while it is running | Nothing: the server, and every connected client, carry on |
| Closes the window | It stops |

There is no separate Start or Stop button. Saving *is* the gesture, so the settings a client is
being served under are always the settings on disk. A change to `bfast.json` that arrives another
way — a `git pull`, a hand edit — is picked up by **Refresh** on the sidebar (which re-reads the
file and applies it the way the initial read does), not followed live; whether it should be is an
open question the stories leave to a later decision.

Only a change to the `mcp` block itself restarts a running server (`mcpModule` compares the block
with the one it last applied; a stopped or failed server is tried again on every save). That rule
earned its place with the `settings` function: a client's own `update_test_settings` saves the
file, and a restart there would drop the very session that asked, mid-answer.

A restart **drops every connected client**. That is deliberate: a client that had already called
`tools/list` would otherwise go on believing a function is available after it was switched off.
Its next call answers `404` with an `mcp/session-not-found` error, which every conforming client
handles by re-initializing — and the tool list it gets back is the new one.

## Reach

| Reach | Binds | Who can connect |
|---|---|---|
| `local` (default) | `127.0.0.1` | Only this machine |
| `network` | `0.0.0.0` | Any machine that can reach this one on that port |

Switching to `network` is **warned before it takes effect** and takes effect only on confirmation.
There is no password, no token and no per-client permission: anyone who can reach the port can
read and change this workspace's tickets and trigger whatever else is switched on. Protecting the
server is deliberately a separate story, and nobody should be encouraged to open the port on a
shared network until it exists.

The one thing the server does refuse is a browser-driven request: a POST carrying an `Origin`
header that is not a loopback origin is answered `403`. That is the DNS-rebinding defence the
transport specification requires, and it is not an authentication scheme — a non-browser client
sends no `Origin` at all and is never affected.

## The functions

What the server offers is a set of **functions**, switched on one at a time. Only `read` is on by
default. A client sees exactly the tools of the functions that are switched on, and nothing else;
a tool whose function is off cannot be called even by a client that listed it a moment earlier.

| Function | Tools | What it can do |
|---|---|---|
| `read` | `list_tickets`, `get_ticket` | Read the tree, and one ticket's description, history and metadata |
| `write` | `create_ticket`, `rename_ticket`, `link_tickets`, `unlink_tickets` | Create a ticket under a parent, rename one, and link two tickets (blocks, relates to, duplicates, clones and their inverses) or remove a link |
| `designs` | `list_designs`, `get_design`, `create_design`, `update_design` | List, read, add and rewrite the technical design documents (ERD, sequence diagram, low level design, any style the workspace adds) on an epic or a story |
| `status` | `set_ticket_status` | Move a ticket between `todo`, `in-progress`, `in-review`, `done`, `blocked` |
| `tests` | `run_tests`, `set_test_case_service` | Start a Run Tests batch for a ticket's subtree; assign a test case to the [service](../tests/services.md) it runs as, or clear it |
| `scan` | `run_scan` | Start a code scan of a ticket's environment, or of the workspace |
| `environments` | `list_environments`, `start_environment`, `stop_environment` | List the dev environments and start or stop one |
| `settings` | `get_settings`, `list_compose_services`, `update_environment_settings`, `update_test_settings`, `set_test_service`, `remove_test_service` | Read and change the `environments` and `tests` blocks of `bfast.json` — compose files, port variables, the project test command, and the [services](../tests/services.md) with their suites and compose services |

Every write is recorded in the ticket's `history.md` under the workspace's configured `userName`,
exactly as a change made in the board is — the MCP server is another way to reach the same store,
not a second one. The entry's comment says it arrived *over the BFAST MCP server*, so a reader can
tell where the change came from without it being a different kind of change. The sidebar and
every open board repaint after each write, as they do after one made in the window.

Two things a client may ask for are **non-events**, and write nothing — no history entry and no
`updatedAt` bump — so a tool that retries, or sets the same value on every loop, cannot bury a
ticket's real history: a rename to the title the ticket already carries, and a move to the status
it is already in. Both still answer with the ticket as it stands, so the client sees the state it
asked for without having to check first. That is the sidebar's own rule (Set status treats picking
the current one as nothing to do), reached over the port.

A ticket the editor flags — no `metadata.yaml`, a missing description file, an id that disagrees
with its folder — is listed and readable like any other, and its `warning` travels with it, so the
tool sees why the fields are blank rather than a ticket that silently vanished.

### Settings

`settings` is the one function that writes `bfast.json` rather than the tracker, and it is off
by default like every function but `read`. Its code is
[mcpSettingsContext.ts](../../src/mcp/mcpSettingsContext.ts), `vscode`-free; the window hands it
the settings service through `McpSettingsAccess`.

- **The form's own rules.** An update merges the fields sent into the block (`null` clears one),
  parses it, and validates the whole candidate with `settingsRefusal` — the function the settings
  form's **Save** calls, the worktrees-folder-outside-the-workspace rule included — then writes
  through the same `SettingsService.write`. An unknown key is refused with the list of known ones.
- **Nothing is dropped in silence.** The parse is forgiving so a pulled file loads; over a port
  that would read as "saved" for a value that was thrown away. So a field that does not survive
  the parse, or a list that comes back shorter (a bad or repeated entry), refuses the **whole**
  change with the validator's sentence, and nothing is written. The answer is the block as it was
  written, normalised.
- **Refused while the server is open to the network.** A command written here is a shell line
  Run Tests and Environments run on this machine, and the server has no accounts — on
  `reach: network` that is code execution for anyone who can reach the port. `get_settings` still
  answers, with `writable: false` and the reason.
- **Said in the window.** Every change is a notification ("BFAST settings changed over the BFAST
  MCP server: tests.services.") and a line in the "BFAST MCP" channel; the file itself is in git.
- **Services one at a time.** `set_test_service` adds a service or replaces the one with the same
  id; `remove_test_service` takes one out (test cases assigned to it keep the assignment and are
  reported unrunnable, docs/tests/services.md). `update_test_settings` with `services` replaces
  the whole list. `list_compose_services` is the Services checklist's
  `docker compose config --services` over the saved environments block.
- **`set_test_case_service`** is in `tests`, not here: it writes the test case's
  `metadata.yaml` (`service:`), through the store's `setService`, with the MCP provenance in the
  history entry. It refuses a ticket that is not a test case and a service the settings do not
  declare, and the same service again is a non-event.

### Design documents

`designs` is a function of its own rather than more of `read` and `write`, so a workspace that
lets a client file tickets has not thereby let it redraw the architecture, and so it can be
switched on alone — `list_designs` and `get_design` are in it for that reason. It goes through
the same `DesignStore` the board's design tabs use:

- **A ticket that cannot carry a design is refused in words** — an acceptance criterion, a test
  case, an id that names nothing — rather than answering an empty list, which over a port reads as
  "no documents yet".
- **`create_design` takes the style by id, prefix or label, in any case** (`ERD`,
  `low-level-design`); an unknown one is refused with the list the workspace offers. BFAST assigns
  the id, exactly as the board's **+** does.
- **`update_design` replaces the whole body.** `baseUpdatedAt` — the value `get_design` answered —
  makes the write refuse when the document changed since, the board's own conflict check; without
  it the write overwrites. A board open **mid-edit** on that document still has its own check, so
  its next Save is refused rather than clobbering the client's text.
- **A body is passed through `ensureMermaidFence`**, the AI path's forgiveness: a bare
  `erDiagram` is fenced and a whole-answer ```` ```markdown ```` wrapper is removed, so a client
  that sends either still lands a document that renders. Nothing else about the body is touched.
- **The same body again is a non-event** — the rename and status rule above.
- Each write files one `designed` entry in the ticket's `history.md`, with the MCP provenance, and
  bumps only the **document's** `updatedAt`, never the ticket's (docs/designs/ says why). An open
  board's design tab follows the document's own `updatedAt`, so it repaints with the new body.

There is no delete and no rename of a design over MCP.

`write` deliberately has no delete. (`remove_test_service` is the one removal on offer: a service
is a row in `bfast.json`, and git has it.) Removing a ticket takes its descendants with it and there is
no undo; that is a gesture for a person in the sidebar, not for a client over a port.

## Long-running work

`run_tests`, `run_scan`, `start_environment` and `stop_environment` all **start** the work and
answer immediately. None of them waits for it to finish.

Two reasons, and both come from the same edge case: a test run or a scan takes minutes, and a
client that gives up waiting must not leave the work half-done, nor start it twice when it
retries. So the work belongs to the window, not to the HTTP request — cancelling the request
cancels nothing — and each of the four is guarded against a second start by the same machinery
the sidebar uses:

- `run_tests` goes through `testBatches.start()`, which already refuses a root that is running
  and one whose test cases overlap a running batch. A workspace with no `tests.command`, or an id
  that names no ticket, is refused in words — a settings or tracker problem, not a run that found
  nothing to do. When the `read` function is off, the answer says so: the client can start runs
  but has no way to read a verdict back, and is told rather than left guessing.
- `run_scan` opens (or reveals) the scan tab for that target and starts it there, so two calls
  against one project key cannot produce two server-side analyses whose measures overwrite each
  other. A ticket with no environment has nothing of its own to scan and is **refused in the
  answer**, not only in a tab the client cannot see. A workspace scan belongs to no ticket, so its
  verdict is shown in the tab only and never lands in a history — the answer says so up front.
- `start_environment` / `stop_environment` go through the environment store's per-environment
  queue, so a Start can never race a Stop on one environment. A backend that is not installed,
  not running or not implemented refuses **up front**, with that reason, rather than appearing to
  begin and then failing; listing still answers, with every status `unknown`.

A client learns the outcome by asking again: `get_ticket` shows the status a test run set and the
history entry a scan wrote, and `list_environments` shows an environment's live status — and, while
that status is `error`, the reason the last operation failed, as `error`.

## Protocol details

| | |
|---|---|
| Transport | Streamable HTTP, single endpoint `/mcp` |
| Protocol version | `2025-06-18`; the client's requested version is echoed when BFAST knows it |
| Capabilities | `tools` only — no resources, no prompts, no sampling |
| Sessions | `initialize` mints an `Mcp-Session-Id`; every later request must carry it |
| Responses | `application/json`. BFAST never opens an SSE stream: nothing it serves is a server-initiated message, so a stream would only be a connection to keep alive |
| `DELETE /mcp` | Ends the session |
| `GET /mcp` | `405` — there is no stream to listen to |

## Connecting

The **MCP server** tab shows the exact address to paste, with a button that copies it — and,
under it, **Connect a tool**: pick the AI coding tool you use and BFAST builds that tool's own
connection snippet from the running server's address, in the shape the tool expects rather than
the bare address. **Claude Code is picked when the tab opens** — the coding agent BFAST's own
Implement hands work to by default. **Copy** puts the snippet on the clipboard. For a tool that
reads its servers from a file committed to the project, **Save for the team** writes the `bfast`
entry into that file, merged with whatever is already there, so a teammate who pulls and opens
the same tool finds BFAST already offered with nothing to configure.

| Tool | Copy gives | Save for the team writes |
|---|---|---|
| Claude Code (default) | `claude mcp add --transport http bfast <address>` | `.mcp.json` (`mcpServers`) |
| VS Code | the `servers` block below | `.vscode/mcp.json` |
| Codex | a `[mcp_servers.bfast]` block for `~/.codex/config.toml` | nothing — that file is personal, so only Copy is offered |

The list is only the tools BFAST maintains a shape for; a tool not on it is not offered.

Claude Code:

```
claude mcp add --transport http bfast http://127.0.0.1:7711/mcp
```

VS Code's own MCP client, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "bfast": { "type": "http", "url": "http://127.0.0.1:7711/mcp" }
  }
}
```

Saving follows three rules:

- **It merges, never overwrites.** Every other server and every other key in the file survives;
  only the `bfast` entry is replaced. A file that cannot be read as a JSON object — a syntax
  error, a comment, an array — is left byte-identical and the tab says which file and why.
- **It needs a running server.** With the server off, not yet started or failed, there is no
  address to build from, so the picker and both buttons are disabled with the reason shown.
- **It writes the address of that moment.** A later change of port or reach leaves the file
  as it was until someone saves again — nothing refreshes it. With reach `network` the saved
  address is this machine's, and a teammate on another machine may not be able to reach it.

### In an environment's window

A ticket's [environment](../environments/README.md) is a second checkout of the repository,
opened in a window of its own, and that window runs a server of its own over the worktree's
tracker. Creating the environment gives it **its own port** — the first free one above the
workspace's — and rewrites the worktree's `bfast.json` and the `bfast` entry in its
`.mcp.json` / `.vscode/mcp.json` to match, hidden from git so the port never travels back
with the branch. A coding agent opened in that window therefore talks to that window's
server, and the workspace's own files are never touched. [The MCP server in an
environment](../environments/README.md#the-mcp-server-in-an-environment) is the full rule.
