# Configuration — the `environments` block

Environments are configured in `.vscode/bfast.json`, next to the tracker and AI settings.
The file is **committed to git**, so the whole team shares one contract between BFAST and
the stack definition — nothing here is per-machine, and nothing here is ever a credential.

Edit it in the BFAST settings form (gear icon → **Environments** tab) or by hand. Reading
is forgiving: a hand-edited value that is out of range or malformed is ignored and the
default applies. Writing is strict: the form refuses to save an invalid block.

## Fields

Every field is optional; the whole block is omitted from the file when nothing in it is
set, so a workspace that never uses environments keeps its `bfast.json` unchanged.

| Field | Type | Default | Rules |
|---|---|---|---|
| `provider` | `"docker-compose"` \| `"k8s"` | `"docker-compose"` | Which backend runs the stack. `k8s` is a stub today — selectable in a hand-edited file, but availability reports it as not implemented. See [provider-interface.md](provider-interface.md). |
| `worktreesFolder` | string | `<os temp>/bfast-worktrees` | Where BFAST keeps the worktrees it creates. Absolute, or starting with `~` for your home folder — a repository-relative path and `..` segments are refused. A `<workspace-slug>` folder is always created beneath it. See [Where worktrees live](#where-worktrees-live). |
| `portRangeStart` | number | `20000` | 1024–65535 |
| `portRangeEnd` | number | `20999` | 1024–65535, ≥ `portRangeStart`; the range must hold at least as many ports as `portVariables` has names |
| `portVariables` | string[] | `[]` | The environment-variable names your stack consumes, one allocated port each. Names must match `[A-Za-z_][A-Za-z0-9_]*`, are de-duplicated, and may not start with the reserved `BFAST_` prefix. |
| `mainPort` | string | first entry of `portVariables` | Which of the `portVariables` names is the environment's **main port** — the URL a developer opens, usually the frontend. Must be one of the listed names. Shown first in the sidebar, where clicking any port row opens `http://localhost:<port>` in VS Code — right-click it for the system browser instead. |
| `composeFile` | string | `"docker-compose.yml"` | Worktree-relative path to the base compose file (docker-compose provider only). May not be absolute or escape the repo with `..`. |
| `composeOverrides` | string[] | `[]` | Additional compose files layered over `composeFile`, **in order** — each becomes one more `--file` flag, and later files override earlier ones (standard compose merging). Same path rules as `composeFile`; the settings form edits them one file per row. |
| `logTail` | number | `1000` | How many lines of existing history a container's log tab fetches when it starts following. Whole number, 0–100000; `0` starts from the next line the container prints. See [container-logs.md](container-logs.md). |

## Where worktrees live

By default every worktree BFAST creates goes under the OS temp folder:

```
<os temp>/bfast-worktrees/<workspace-slug>/
  ST-1.2/           ← the worktree for ST-1.2, on branch story/ST-1.2
  EP-1/
  master.json       ← the master environment's marker
```

The temp folder is the default because a worktree is disposable and must not sit inside the
workspace, where a second checkout would turn up in every search, every file watcher and
every `git status`. The price is that **the OS may clean it**: uncommitted work in a
worktree is at the OS's mercy. Set `worktreesFolder` to keep them somewhere you control:

```jsonc
"environments": {
  "worktreesFolder": "~/bfast-worktrees"   // or "D:/dev/worktrees", "/Users/me/worktrees"
}
```

Four rules:

- **It names the parent folder, not this workspace's own.** BFAST always appends
  `<workspace-slug>` beneath it, so two repos on one machine can never share a folder —
  and the master environment's project name, `bfast-master-<workspace-slug>`, is read back
  from that very segment.
- **`~` expands to your home folder**, on every platform. `bfast.json` is committed to
  git, so a `~`-relative value is the one shape a Windows and a macOS teammate can share;
  an absolute path is per-machine and someone will end up overriding it. The settings
  form's **Browse…** button does that for you: pick a folder inside your home folder and
  it is stored as `~/…`, which you can still edit back to an absolute path.
- **Absolute or `~` only, and outside the workspace.** A repository-relative path is
  refused, and so is an absolute one that points back inside the workspace — both for the
  reason the default is outside it in the first place.
- **Changing it moves nothing.** Worktrees already created keep working, and a window
  opened on one is still recognised, but they stop appearing in the Environments
  section — the inventory is a scan of the folder that is configured *now*. Delete them
  from the old location before switching, or move them by hand.

The folder is created on demand, at the first **Create Environment**. A path BFAST cannot
create is reported by that command, not at save.

**Every character of this folder's path is added to every path inside a worktree.** On
Windows that matters: git refuses a path of 260 characters or more unless its
`core.longpaths` setting is on, which BFAST turns on for the repository when a new
worktree needs it — see [Long paths on Windows](README.md#long-paths-on-windows). A short
folder (`D:/wt`) still helps the programs that are not long-path aware.

In the settings form (gear icon → **Environments**) the field's placeholder is the real
default for the machine you are on — `C:\Users\you\AppData\Local\Temp\bfast-worktrees`
on Windows, `/tmp/bfast-worktrees` on most Linux systems — so an empty field says where
the worktrees actually land, not `<os temp>`.

## Ports are names, not roles

`portVariables` is deliberately **semantics-free**. BFAST has no notion of frontend,
backend or database — it allocates one free port per name from the configured range and
hands them to the stack as environment variables. What the names mean is entirely the
stack's business, so any topology is just a different list:

| Topology | `portVariables` | Main port |
|---|---|---|
| **A frontend + any number of backends** — one main port, more ports for whichever services the host must reach | `["FRONTEND_PORT", "AUTH_PORT", "ORDERS_PORT", "DB_PORT"]` | `FRONTEND_PORT` |
| **Single entry point via a proxy** (optional pattern) — one nginx/traefik/caddy service publishes the only host port and routes internally; adding a service changes the proxy config, never this list | `["WEB_PORT"]` | `WEB_PORT` |
| **Classic 3-tier** | `["FRONTEND_PORT", "BACKEND_PORT", "DB_PORT"]` | `FRONTEND_PORT` |

The one name BFAST does single out is the **main port** — by default the first in the
list, or the one `mainPort` names explicitly. It is the environment's front door: what a
developer opens in a browser — one click on its sidebar row does exactly that. The
rest of the list is undifferentiated.

Ports are allocated once, when the environment is created, and are shown in the sidebar.
Two environments never share a port, even while stopped.

## Reserved variables

Alongside the allocated ports, every command BFAST runs also receives:

| Variable | Example | Use it for |
|---|---|---|
| `BFAST_TICKET_ID` | `ST-1.2` | Labels, log tags, per-story database names. **Empty** for the master environment, which has no ticket — still set, so a `${BFAST_TICKET_ID:?}` refuses there as it should. |
| `BFAST_PROJECT_NAME` | `bfast-st-1-2`, `bfast-master-my-app` | The stack's project/namespace name — per-environment routing in a proxy, container labels. Unique per stack, the master environment included: key on this one. |

The `BFAST_` prefix is reserved: a port variable named with it is refused.

## Example

```jsonc
// .vscode/bfast.json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "environments": {
    "provider": "docker-compose",
    "worktreesFolder": "~/bfast-worktrees", // optional — defaults to <os temp>/bfast-worktrees
    "portRangeStart": 20000,
    "portRangeEnd": 20999,
    "portVariables": ["WEB_PORT", "AUTH_PORT", "ORDERS_PORT", "DB_PORT"],
    "mainPort": "WEB_PORT",              // optional — defaults to the first entry anyway
    "composeFile": "docker-compose.yml",
    "composeOverrides": ["docker-compose.bfast.yml"],  // optional — layered in order
    "logTail": 1000                      // optional — history a container log tab starts with
  }
}
```

With this block, creating an environment for `ST-1.2` might allocate
`WEB_PORT=20000`, `AUTH_PORT=20001`, `ORDERS_PORT=20002`, `DB_PORT=20003` — `WEB_PORT`
being the main port — and every `docker compose` invocation for that environment runs
with those four variables plus `BFAST_TICKET_ID=ST-1.2` and
`BFAST_PROJECT_NAME=bfast-st-1-2` in its environment.

How the stack should consume them: [docker-compose.md](docker-compose.md).
