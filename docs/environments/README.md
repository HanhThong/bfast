# BFAST Environments

One isolated, disposable dev environment per **story or epic**: its own checkout of the
repo, its own full stack (every service plus its database), its own ports. Work on three
tickets at once and their stacks run side by side without touching each other — or your
main working copy. And when the main working copy is what you want running, the
**master environment** runs the same stack in the workspace folder itself, no ticket
needed — see [The master environment](#the-master-environment).

This folder is the feature's specification and user guide:

- [configuration.md](configuration.md) — the `environments` block in `.vscode/bfast.json`
- [docker-compose.md](docker-compose.md) — the contract your `docker-compose.yml` must satisfy
- [container-logs.md](container-logs.md) — the container rows under an environment, and the log tab
- [kubernetes.md](kubernetes.md) — the future Kubernetes provider and how to author manifests today
- [provider-interface.md](provider-interface.md) — the `EnvironmentProvider` seam, for contributors

## The shape: one ticket ↔ one worktree ↔ one stack

| Piece | What it is | Example |
|---|---|---|
| **Ticket** | The story or epic the work is for | `ST-1.2`, `EP-1` |
| **Worktree** | A `git worktree` checkout of the repo on its own branch — `story/<id>` for a story, `epic/<id>` for an epic — under the [worktrees folder](configuration.md#where-worktrees-live) | branch `story/ST-1.2`, folder `<os temp>/bfast-worktrees/<workspace>/ST-1.2/` |
| **Stack** | The services the repo's compose file defines (later: k8s manifests), running isolated under a per-ticket project name | compose project `bfast-st-1-2` |

An environment is the trio. There is at most one per ticket, and everything about it is
derived from the ticket id. The one exception is the **master environment**: no ticket and
no worktree — its folder is the workspace, its project is `bfast-master-<workspace-slug>`,
and there is at most one per workspace.

## Your first environment

1. Open BFAST settings (gear icon) → **Environments** tab: set `portVariables` to match
   your topology and check the port range — see [configuration.md](configuration.md).
   The default list is empty, so do this before creating anything.
2. Make the repo's `docker-compose.yml` satisfy the contract — variables for every host
   port, no fixed names — and verify it by hand: [docker-compose.md](docker-compose.md).
3. Right-click a story or an epic in the **Tickets** section → **Create Environment**
   (allocates ports and clones the worktree; nothing starts yet) — or, for the workspace
   itself, **Create Master Environment** (see below).
4. Press **Start** on the environment and watch the "BFAST Environments" output channel
   until it settles on `running`.
5. Right-click the environment → **Open in New Window** to get its worktree in a new
   window and start working on the ticket.

## The master environment

Sometimes the code you want running is the code you have open — `master` after a pull, or
the change you are about to commit — and making a ticket for that is ceremony. The
**master environment** is the same stack, started for the **workspace folder itself**:

- **No worktree, no branch, no git.** The stack builds from the live working copy —
  uncommitted changes and gitignored files (`.env`, local certs) included, which a ticket's
  worktree, being a checkout of committed files only, never has. What it runs is whatever
  branch you have checked out; the sidebar row shows which.
- **Ports from the same range**, reserved against every ticket environment and vice versa,
  so the master stack and three ticket stacks run side by side.
- **Its own compose project**, `bfast-master-<workspace-slug>` — the slug is there so two
  repos on one machine can never share a stack.
- **Create** — the **+** button (*Master* is the first item while there is none), **Create
  Master Environment** from the command palette, or the link in the empty section. It
  allocates ports and writes a marker file **beside** the worktrees, never in the repo:
  `<worktrees folder>/<workspace>/master.json`. Nothing is written into the
  workspace, and nothing starts.
- **Start / Stop / Forward Ports / Run Scan** work exactly as for a ticket environment.
  Run Scan on it is **Scan Workspace** — same folder, default project key, and no ticket to
  record the verdict on.
- **Delete** removes the stack and its volumes and the marker file — and **never touches
  the workspace folder**: no removal, no ownership reclaim. Your checkout is yours.
- There is no **Open in New Window** and no **Reveal**: the workspace is the window you
  are in.
- At most one per workspace. Two same-named workspaces share a worktrees folder and would
  share a `master.json`; the second to try is refused, exactly as a ticket create is
  refused a folder carrying another workspace's marker.

The stack receives the same variables as any environment, with one difference:
`BFAST_TICKET_ID` is **set but empty** — there is no ticket — so anything keyed per stack
should use `BFAST_PROJECT_NAME`, which is unique. See [configuration.md](configuration.md).

## Lifecycle

```
            Create                     Start                      Stop
 (no env) ─────────▶  stopped  ─────────────────────▶  running  ─────────▶  stopped
                         ▲       whole stack, from        │                    │
                         │       scratch: build +         │                    │  Delete
                         └────────────────────────────────┘                    ▼
                                       Stop                          gone — stack, volumes
                                                                     and worktree removed;
                                                                     the branch stays
```

Action availability: **Start** is offered from `stopped` and `error`, **Stop** from
`running`, and **Delete from any settled state** (`stopped`, `running`, `error`) — deleting
a running environment tears the stack down as part of it.

- **Create** is an explicit action — right-click a story or an epic in the Tickets section
  and choose **Create Environment**, or use the **+** button in the Environments section.
  It allocates one free port per configured port variable, adds the worktree on branch
  `story/<id>` / `epic/<id>` (created from the current `HEAD`; reused if it already
  exists), and writes the marker file. It does **not** start the stack. A markerless
  leftover folder from an interrupted delete is cleared automatically first — only a
  folder carrying **another workspace's** marker is refused. On Windows it may also turn
  on git's `core.longpaths` for the repository, and says so when it does — see [Long
  paths on Windows](#long-paths-on-windows). When the checkout's settings switch the MCP
  server on, it also gives the worktree **its own MCP port** — see [The MCP server in an
  environment](#the-mcp-server-in-an-environment). The master environment's Create
  allocates ports and writes its marker, and nothing else.
- **Start** always brings the whole stack up **from scratch** — images rebuilt, containers
  recreated (`--build --force-recreate` for the compose provider). Treat containers as
  disposable; see [docker-compose.md](docker-compose.md) for what that requires of the
  stack definition.
- **Stop** shuts the stack down but keeps its volumes, so a later Start finds the data
  volumes as they were (the containers themselves are still recreated).
- **Delete** removes the stack — containers, networks and **volumes** — then the worktree.
  (Images built for the environment stay in Docker's image store; prune them with
  `docker image prune -a` when they pile up.) The **branch is kept** — it may hold
  commits, and deleting work is worse than leaving a branch. Delete asks for confirmation.
  For the master environment it removes the stack, its volumes and the marker file; the
  workspace folder is untouched.

A cancelled or failed operation rolls nothing back: what was already done stays done, the
environment shows `error` with the reason, and the "BFAST Environments" output channel
holds the full log. In particular a failed Delete may already have removed the stack and
its volumes — close any window holding the worktree open and run Delete again to finish.

## The sidebar section

The BFAST activity-bar container gains a second section, **Environments**, under Tickets.
Each item shows the ticket id and title — the master environment shows **Master** and the
branch the workspace has checked out, and is always the first row — the current status,
and its allocated ports (expand the item to see each port variable with its value, and
below them the containers its stack is made of). **Clicking a port row opens
`http://localhost:<port>` in VS Code's integrated Simple Browser** — an editor tab, beside
the code (the globe button does the same). Right-click offers the two routes by name:
**Open Port in VS Code** — that same editor tab — and **Open Port in Browser**, which
hands the address to the operating system's default browser instead, where the real
DevTools, the signed-in accounts and the extensions are. The address is the same either
way, and opening in VS Code twice reuses the one Simple Browser tab rather than stacking
them up. The **main port** — the first configured port
variable, or the one `mainPort` names — is listed first: it is the environment's front
door.

Under the ports come the environment's **containers**, one row per service, exited ones
included — which is how you find the service that broke an `error` environment without
leaving the sidebar. Clicking one opens its log in an editor tab, following live.
[container-logs.md](container-logs.md) is the specification for both.

If Simple Browser has been disabled, **Open Port in VS Code** says so and offers the
browser instead of quietly becoming it — the two entries mean different things, and one
silently turning into the other is worse than being told. If no browser answers **Open
Port in Browser**, the error names the address so it can be copied by hand.

In a **remote window** (SSH, WSL, containers), Start automatically forwards every
allocated port once the stack is up — only ports not already forwarded; an existing
forward is reused — so the localhost links work immediately. Right-click →
**Forward Ports** does the same on demand, and the Ports view shows what is live.
**Open Port in Browser** needs no forward of its own: the port lives on the remote and
the browser is on the machine in front of you, and VS Code resolves a `localhost` address
handed to the default browser by establishing the tunnel itself.

| Status | Meaning |
|---|---|
| `stopped` | The environment exists; the stack is not running |
| `running` | Every service in the stack is up |
| `creating` / `starting` / `stopping` / `deleting` | An operation is in flight (spinner); the output channel shows its progress |
| `error` | The last operation failed, or only part of the stack is running — the detail says which |
| `unknown` | The backend cannot be queried (e.g. Docker is not running) |

Actions, by right-click or the inline buttons:

- **Start** (from `stopped` or `error`) / **Stop** (from `running`)
- **Open in New Window** — the only way a window opens; a plain click just
  selects/expands, so browsing the list cannot spawn windows. See below. Not offered for
  the master environment, whose folder is the window you are in.
- **Forward Ports** — creates VS Code port forwards for every allocated port (a single
  port row offers **Forward Port** for just that one). Start already does this
  automatically after the stack comes up; existing forwards are reused, never
  duplicated. In a non-remote window the action simply reports that localhost is
  reachable directly.
- **Open Port in VS Code** / **Open Port in Browser** — on a single port row: the same
  `http://localhost:<port>`, in an editor tab or in the system's default browser. The
  row's click and its globe button are the VS Code route, as they always were.
- **Open Container Log** — on a container row (its click and its inline button do the
  same): that container's log in an editor tab, following live. Read-only; see
  [container-logs.md](container-logs.md).
- **Reveal in File Explorer** — the worktree folder
- **Delete** — from any settled state, confirmation first; removes stack + volumes +
  worktree, keeps the branch

The section's title bar has **New Environment** (quick-picks a story or epic that has no
environment yet — or **Master**, the workspace itself, while there is none) and
**Refresh**. Status also refreshes on a timer while the section is
visible.

## Working in an environment

Right-click an environment → **Open in New Window** to open its worktree in a **new
VS Code window**. That window is a complete, configured BFAST workspace —
`.vscode/bfast.json` and the tracker are part of the checkout — and on activation BFAST
finds the marker file and opens the **board of the ticket the environment belongs to**,
once. You land in the window with the ticket in front of you and the code beside it.

The worktree window is a full citizen: its **Environments section shows every environment
of the original workspace**, this one included, and Start/Stop/Delete work from either
window. The marker is what makes that possible — it records the source repo
(`sourceRoot`), and the worktree sits directly under the original workspace's worktrees
folder, so the new window finds its siblings by looking at its own parent folder. The
allocated ports are also always at hand in the marker file itself
(`.bfast/environment.json`, example below).

## The MCP server in an environment

The worktree window is a complete BFAST workspace, so when `.vscode/bfast.json` switches
the [MCP server](../mcp/README.md) on, that window starts **its own** server — serving the
worktree's tracker, the one on the ticket's branch. Left alone it would ask for the same
port the workspace's own window already listens on, fail with *port in use*, and every
coding agent opened in the worktree would be pointed, by the committed `.mcp.json`, at the
workspace's server instead of its own.

So Create fixes the port as part of making the worktree, before anything opens it:

- **When.** Only when the checked-out `.vscode/bfast.json` has `mcp.enabled: true`. A
  server that is off asks for no port, and nothing is touched.
- **Which port.** The first port above the configured one that is free on this machine
  right now (a real bind attempt) and claimed by nobody else: **never** the configured
  port itself — that is the workspace's own, whether or not its window is open — never
  another environment's MCP port, and never an allocated stack port. A workspace on
  `17711` therefore gives its environments `17712`, `17713`, … in the order they are
  created. The port is recorded in the marker (`mcpPort`), which is how the next Create
  knows it is taken even while that environment's window is closed.
- **What is rewritten — in the worktree only.** `mcp.port` in the worktree's
  `.vscode/bfast.json` (every other key, unknown ones included, survives), and the
  `bfast` entry of each connection file BFAST knows (`.mcp.json` for Claude Code,
  `.vscode/mcp.json` for VS Code — see [Connecting](../mcp/README.md#connecting)) **when
  that entry points at the configured port**. An entry pointing anywhere else was put
  there on purpose and is left alone, and so is every other server in the file. The
  workspace's own files are never touched.
- **Hidden from git.** Those files are committed, so the rewrite would show as a change on
  the ticket's branch, and a commit of it would carry the environment's port back into
  the workspace at the next merge. Create therefore marks each rewritten file that git
  tracks with `git update-index --skip-worktree`, in **the worktree's own index** — the
  workspace's checkout and every other worktree are unaffected. `git status`, `git add -A`
  and `git commit -a` in the worktree then pass over them.
- **Best-effort.** A failure here — a file that is not JSON, no free port, git refusing —
  is said in the "BFAST Environments" output channel and the create still succeeds; the
  worktree window's server then reports the port in use as it would have anyway.

The output channel names the move:

```
— MCP server port for ST-1.2: 17711 → 17712 (.vscode/bfast.json, .mcp.json, .vscode/mcp.json — hidden from git in the worktree)
```

The skip-worktree mark has one consequence worth knowing. A merge or rebase **in the
worktree** that brings in a commit changing one of those files stops with *"Your local
changes … would be overwritten"*, because git keeps the local copy it was told to ignore.
Clear the mark, put the file back, merge, and re-apply the port:

```
git update-index --no-skip-worktree .vscode/bfast.json .mcp.json .vscode/mcp.json
git checkout -- .vscode/bfast.json .mcp.json .vscode/mcp.json
```

The same two lines are how to deliberately commit a settings change made in the worktree
window. Environments created before this behaviour existed keep the workspace's port; fix
it in their settings tab, or delete and re-create them.

## What is on disk, and what happens to it

| Artifact | Where | Fate |
|---|---|---|
| Worktree | `<worktrees folder>/<workspace>/<ticket-id>/` | Removed by Delete. Defaults to `<os temp>/bfast-worktrees` — the OS may clean the temp folder, so **uncommitted work there is at the OS's mercy**; commit to the branch, or point [`worktreesFolder`](configuration.md#where-worktrees-live) somewhere you control. |
| Marker | `.bfast/environment.json` inside the worktree | The environment's identity: ticket id, kind, branch, the port-variable → allocated-port mapping, main port, the worktree's own MCP port when it was given one, creation time, and the source repo it was cloned from. Untracked — do not commit it. Example below. |
| Settings and MCP connection files | `.vscode/bfast.json`, `.mcp.json`, `.vscode/mcp.json` inside the worktree | Rewritten at Create to the worktree's own MCP port when the server is switched on, and marked skip-worktree in the worktree's index — see [The MCP server in an environment](#the-mcp-server-in-an-environment). Go with the worktree. |
| Master marker | `<worktrees folder>/<workspace>/master.json` | The master environment's identity: its compose project name, its ports, the repo it belongs to. Beside the worktrees, never in the repo, so it cannot be committed. Removed by Delete. Example below. |
| Branch | `story/<id>` / `epic/<id>` in the repo | **Survives Delete.** Merge or delete it like any branch when the ticket is done. |
| Stack state (volumes, networks, containers) | Docker (later: a k8s namespace), under the project name | Stop keeps volumes; Delete removes containers, networks and volumes. Built images are left in Docker's image store. |

The marker is where the environment's identity lives — including **which allocated port
belongs to which port variable**. It is written once, at creation, and looks like this:

```json
{
  "version": 1,
  "ticketId": "ST-1.2",
  "kind": "docker-compose",
  "branch": "story/ST-1.2",
  "ports": {
    "WEB_PORT": 20000,
    "AUTH_PORT": 20001,
    "ORDERS_PORT": 20002,
    "DB_PORT": 20003
  },
  "mainPort": "WEB_PORT",
  "createdAt": "2026-08-30T10:15:00Z",
  "sourceRoot": "d:/projects/my-app",
  "mcpPort": 17712
}
```

`mcpPort` is present only when Create gave the worktree its own MCP port.

The master environment's marker has no ticket and no branch — the branch is read from the
workspace each time it is listed — and records its **project name** instead, so Start and
Delete can never disagree on it, even after the workspace folder is renamed:

```json
{
  "version": 1,
  "scope": "master",
  "kind": "docker-compose",
  "projectName": "bfast-master-my-app",
  "ports": {
    "WEB_PORT": 20004,
    "AUTH_PORT": 20005,
    "ORDERS_PORT": 20006,
    "DB_PORT": 20007
  },
  "mainPort": "WEB_PORT",
  "createdAt": "2026-09-05T10:15:00Z",
  "sourceRoot": "d:/projects/my-app"
}
```

To see the mapping, expand the environment in the sidebar (one row per variable, main
port first), hover the item for the tooltip table, or open the marker file itself. Every
`docker compose` command for the environment runs with exactly these variables set.

The Environments section is **derived from disk**: it lists whatever worktrees with valid
markers exist under the temp folder, plus the master marker beside them, and asks the
backend for their live status — the
sidebar keeps no state of its own, so what the marker says is what everything shows. If
the OS cleaned the temp folder, the environment simply no longer appears — recreate it
from the ticket (it gets fresh ports; the branch, and any commits on it, survive).

## Long paths on Windows

A worktree is a second checkout of the whole repository, tracker included, somewhere
else — so every path in it is longer than the same path in your workspace by the
difference between the two folders: `D:\workspaces\app\EP-1\` against `D:\app\` adds 16
characters to every file. Git for Windows refuses a path of 260 characters or more (248
for a folder) unless its `core.longpaths` setting is on — whatever Windows' own
`LongPathsEnabled` policy says — and a tracker gets close on its own: [ticket folder
names](../tracker/README.md) nest four deep and carry the full id at every level.

BFAST deals with it in two steps:

- **Every git command BFAST runs carries `-c core.longpaths=true`** — the worktree add,
  remove and prune among them — so creating or deleting an environment never fails on a
  long path. Git on other platforms ignores the key. The one exception is the question
  below of whether the setting is already on, which would otherwise read BFAST's own flag
  back.
- **After a create, on Windows only**, BFAST lists the files the new worktree checked out
  (`git ls-files`). If any of them is past the limit and `core.longpaths` is not already on
  — in the repository, or in your global or system git config — BFAST turns it on for the
  **repository** (`git config core.longpaths true`, written to `.git/config`, which the
  main working copy and every worktree share) and says so in the "BFAST Environments"
  output channel:

  ```
  — Enabled core.longpaths for this repository: 5 paths in the new worktree are longer than Windows allows (longest: 270 characters).
  ```

  That is what lets git *outside* BFAST work in the worktree too: the Source Control view
  of the environment's window, a terminal, a commit, a merge. Nothing is changed when every
  path fits or the setting is already on. If the check itself fails, the create still
  succeeds, and the output channel says what to run by hand.

To undo it, run `git config --unset core.longpaths` in the repository. Programs that are
not long-path aware — Windows Explorer among them — may still fail to open the deepest
files of a worktree; [Shorten Long Ticket Folder
Names](../tracker/README.md#shorten-long-ticket-folder-names) makes the tracker's own paths
short enough not to need any of this.

## Limitations and troubleshooting

- **A port can be taken out from under an environment.** Ports are allocated at creation;
  an unrelated process may grab one before Start runs. Start then fails with a bind error
  (in the output channel) — Delete and Create the environment again to get fresh ports.
- **Git submodules and LFS content are not initialized** by `git worktree add`. A stack
  that depends on them fails at build with Docker's own error — initialize them by hand
  inside the worktree, or keep the compose build free of them.
- **Delete verifies the folder is really gone** — it never takes git's word for it, and
  falls back to force-deleting with retries. On Linux it first **reclaims ownership** of
  files containers created as root (`chown` via a throwaway `alpine` container — pulled
  once, then cached), since those otherwise fail the removal with `Permission denied`.
  It can still fail on a window open on the worktree or a process holding a file;
  close those and run Delete again (the stack teardown that already happened does not
  repeat). A partially-removed folder does not dead-end the ticket: the next Create
  clears it.
- **Built images accumulate.** Delete does not remove the images an environment's builds
  produced (`<project>-<service>`); reclaim disk with `docker image prune -a`.
- **Create environments from one window at a time.** Creates in a single window are
  serialized, but two VS Code windows on the same repo creating simultaneously can race
  the port allocation; the loser fails at Start with a bind error — Delete and recreate.
- **Same-named workspaces share a compose project name.** Two repos whose folders are
  both called `app` share a worktrees folder, and the same ticket id in both yields the
  same `bfast-st-1` project — the second Start reuses the first's stack. The master
  environment is protected (the second workspace's create is refused); a ticket
  collision is not. Rename one folder.
- **A build that goes quiet can hit the Start timeout** (about 15 minutes *of silence* —
  a build that keeps printing is never stopped, however long it takes). The output
  channel shows how far it got; Start again once the Docker build cache is warm.
