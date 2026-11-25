# Configuration — the `mcp` block

The MCP server is configured in `.vscode/bfast.json`, next to the tracker, AI, environments,
tests, scan and implement settings. The file is **committed to git**, so the whole team shares
one description of what the server offers — and nothing here is ever a credential, because there
are none: the server has no accounts, tokens or per-client permissions (see
[README.md](README.md#reach)).

Edit it in the BFAST settings form (gear icon → **MCP server** tab) or by hand. Reading is
forgiving: a hand-edited value that is out of range or unknown is ignored and the default
applies. Writing is strict: the form refuses to save a port that is empty, not a number, or
outside the range a port can take.

## Fields

Every field is optional; the whole block is omitted from the file when nothing in it is set, so
a workspace that never switches the server on keeps its `bfast.json` unchanged.

| Field | Type | Default | Rules |
|---|---|---|---|
| `enabled` | boolean | `false` | Whether the server listens at all. Only `true` is ever written — the default never creates a key. |
| `port` | number | `7711` | 1–65535. The TCP port the server listens on. Only a value **other than the default** is written. If the port is already taken — by another window with the same workspace open, or by anything else — the server does not start, the tab says so, and the settings you typed are kept so you can change the number and save again. An [environment's](../environments/README.md#the-mcp-server-in-an-environment) worktree is given a port of its own when it is created, so its window never asks for this one. |
| `reach` | `"local"` \| `"network"` | `"local"` | `local` binds `127.0.0.1` and only this machine can connect; `network` binds `0.0.0.0` and any machine that can reach this one can. Only `"network"` is ever written. Switching to `network` is warned in a modal dialog and takes effect only if you confirm. |
| `functions` | string[] | `["read"]` | Which [functions](README.md#the-functions) the server offers: any of `read`, `write`, `designs`, `status`, `tests`, `scan`, `environments`, `settings`. Written only when it differs from the default — including when it is **empty**, which is allowed: the server starts, a client connects, and there is nothing for it to do. Unknown names are dropped on read; order in the file does not matter. |

## Example

```json
{
  "trackerFolder": ".tracker",
  "userName": "Hanh Thong",
  "mcp": {
    "enabled": true,
    "port": 7711,
    "functions": ["read", "status", "tests"]
  }
}
```

A server on the default port, reachable only from this machine, that lets a client read the
tracker, move a ticket's status and start a test run — but not create, rename, scan or touch an
environment.

## What saving does

Saving is the only lifecycle gesture there is: it starts the server, restarts it on the new
settings when the `mcp` block changed, or stops it when `enabled` is false. A save that leaves the
`mcp` block as it was leaves a running server — and its clients — alone. See
[README.md](README.md#lifecycle) — including why a restart disconnects every client.

The settings tab stays open after saving so it can show what happened: whether the server is
running, the address to paste into a client, and a button that copies it — plus the
**Connect a tool** picker that builds a chosen tool's own snippet and can save it into the
tool's project config file (see [README.md](README.md#connecting)). Nothing that picker does is
stored in `bfast.json`: the tool's file is the tool's.

## When there is nowhere to store the choice

With no folder open there is no `.vscode/bfast.json` to write, so there is nothing to switch on:
the tab says so, the way the rest of the settings form does. A workspace that simply has not been
configured yet is fine — saving writes the file, and the server starts with it.
