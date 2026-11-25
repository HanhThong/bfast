# Containers and their logs

Expanding an environment in the **Environments** section lists the containers its stack is
made of, beside the allocated ports it already listed. Clicking a container row opens that
container's log in an editor tab, following live.

This document is the **specification** for that: what a row shows, what the tab does in
every state a container can be in, and exactly what BFAST runs to find out. For what an
environment *is*, see [README.md](README.md); for the seam the two new provider calls sit
behind, see [provider-interface.md](provider-interface.md).

It is a **read-only** view. There is no restart, no stop-one-service, no shell-inside —
the Environments section's Start/Stop/Delete remain the only things that change a stack.

## The container rows

An environment row is always expandable now, whether or not it has ports: its containers
are the other half of what is under it, and a row that hides them would be the worse
mistake. Under it, in order:

1. one row per **allocated port**, main port first — unchanged
2. one row per **container** of the stack, exited ones included

A container row shows the **service** it is an instance of as its label and the backend's
own status line as its description, so the row reads the way `docker compose ps` does:

| Row | Means |
|---|---|
| `web` · `Up 3 minutes (healthy)` | running, and its healthcheck passes |
| `db` · `Up 3 minutes` | running, no healthcheck defined |
| `api` · `Exited (1) 12 seconds ago` | **the culprit** — it died, and its log says why |
| `worker` · `Restarting (1) 4 seconds ago` | crash-looping |
| `cache` · `Created` | created by the last Start but never started |

The icon carries the same verdict at a glance — green for running, a spinner for
restarting, **red for a non-zero exit or a dead container**, a hollow circle for a clean
exit or a merely created one. Finding which service broke an `error` environment is
meant to be one expand and no reading.

The list is **derived from the backend on every read**, never cached: Start recreates
every container, and the rows that come back after it are the new containers with new
ids. Nothing from the previous run survives in the view. The Environments section's own
refresh — the 10-second poll while it is visible, and the explicit refresh after every
command — is what repaints them, so the containers keep step with the environment status
above them rather than on a clock of their own. Only an **expanded** environment is
queried: the listing costs one backend call, and a collapsed row must not pay it.

Containers are matched by the environment's own **project name** (`bfast-st-1-2`,
`bfast-master-my-app`), which is unique per environment by construction — so an
environment never lists another environment's containers, and never lists a container that
is not BFAST's.

### When there are none, and when there cannot be

Three different things must never look alike, so each gets its own row:

| Situation | The row |
|---|---|
| The listing worked and the stack has no containers — the environment was never started, or Stop removed them | ℹ `No containers — the environment is not running` |
| The backend could not be queried at all (Docker is not running; the environment shows `unknown`) | ⚠ `Could not list containers: <the backend's reason>` |
| The configured provider does not implement this (the Kubernetes stub) | ⚠ `Kubernetes environments are not implemented yet.` |

An empty list is a fact about the stack; a failed query is a fact about the machine. The
second silently rendered as the first would read as "your environment has nothing in it",
which is the one wrong thing to tell someone whose Docker Desktop is not running.

Note that a **stopped** environment is not automatically an empty one. BFAST's Stop is
`compose down`, which removes the containers — so after Stop the list really is empty. But
an environment sitting at `error` because half the stack fell over still has containers,
exited ones included, and those are exactly the ones worth reading.

## The log tab

Clicking a container row opens a **webview editor tab** titled `Log — ST-1.2 web-1` (the
environment, then the container's own name with the project prefix stripped; the master
environment's reads `Log — Master web-1`). An editor tab rather than an Output channel
deliberately: the "BFAST Environments" channel is the log of Start/Stop/Delete *operations*
and stays exactly that — a container's log is a different thing about a different subject,
and interleaving the two, or making the user pick BFAST's channel out of a dropdown that
now has one entry per container, would serve neither.

- **Chronological, newest last, and the tab opens scrolled to the bottom.** What a
  developer wants first is the last thing the service said.
- **It follows.** New lines append as the container prints them, so you can drive the app
  in one tab and watch the service react in another.
- **Auto-scroll yields to reading.** New lines scroll the view only when it is already at
  the bottom; scroll up to read and the stream stops yanking you away, until you scroll
  back down.
- **`logTail` lines of history** are fetched when the follow starts — 1000 by default, see
  [Configuration](#configuration) below. Enough to hold a service's whole startup, which is
  where a failure usually explains itself, without dragging a week of a long-lived
  container's chatter across the bridge.
- **One tab per container, and it is pinned.** Opening the same container's log again
  reveals the tab that is already open rather than making a second one; opening a
  *different* container's log opens its own tab beside it. Where the workbench would have
  made it a preview tab — italic, reused by the next click — it is pinned as soon as the
  stream starts, which is the opposite of the ticket board's policy and for the opposite
  reason: a board is a thing to browse, a log tab is a stream that is already running, and
  watching the gateway while the worker crashes needs two tabs. If a tab's stream had
  ended, clicking its container again starts a fresh follow in it — the same tab, the
  history kept, a separator line between the two.
- **A container with nothing to say says so.** Before the first line arrives the tab reads
  `Waiting for output — the container has not printed anything yet`, so an empty tab is
  never ambiguous between "nothing yet" and "broken".

### When the stream ends

A follow ends when the container stops or is removed — a Start recreating the stack, a
Stop, a Delete, in this window or another — or when the tab is closed. **The lines already
on screen stay**, and a final line says why there will be no more:

```
— The log stream ended: the container is gone.
```

The tab is then a static record of what that container said, which is precisely what you
want to be reading after a Start swept it away mid-sentence. Closing the tab cancels the
follow; nothing keeps running behind a tab that is gone.

Failing to start the stream at all — the container was removed between the click and the
call, Docker went down — ends it the same way, with the backend's own reason. "No more
lines are coming, and here is why" is one fact, not two.

### Volume

A container in a restart loop, or one with debug logging on, can print faster than any
view can render. Two caps keep the editor usable, and both are deliberate lossy tails
rather than back-pressure — a log viewer that stalls the stack it is watching would be
worse than one that drops the middle:

- the host **coalesces output into batches** (a flush roughly every 100 ms) instead of
  posting each chunk, so a flood costs a handful of messages per second rather than
  thousands;
- the tab **keeps the last few thousand lines**; older ones fall off the top.

The backend still has everything — `docker logs` on the container id, with the tab's
title telling you which — so nothing is lost, only not held in a webview.

## Privacy

A stack prints whatever it prints: connection strings, tokens, environment dumps. This is
your machine's own log shown on your machine, so it is displayed **verbatim** — filtering
it would hide the line you opened the tab to read. But it goes nowhere else: no history
entry, no `updatedAt` bump, nothing into the tracker, and it is never attached to an AI
prompt. Viewing a log changes nothing about the ticket, because reading is not a change.

## Remote windows

In an SSH, WSL or container window the extension host runs on the **remote** machine, so
the backend BFAST queries is the one running the stack, and the logs are that machine's.
Nothing is forwarded and no port is involved. This is the same reason Start and Stop reach
the right Docker without being told which.

## What BFAST runs

Two commands, both added to the table in [docker-compose.md](docker-compose.md):

| Action | Command |
|---|---|
| Containers | `docker compose -p <project> ps --all --format json` |
| Log | `docker logs --follow --tail <logTail> <container id>` |

Neither takes a `--file`, a working directory or the stack's environment variables — like
`compose ls`, they match containers by the project label the engine already holds. Three
consequences, all wanted:

- **A broken or missing compose file does not hide the containers.** That is the state
  a failing environment is most likely to be in, and the one where the list matters most.
- **`--all` includes exited containers**, which is where the reason for a failure is.
- **`docker logs` reads the engine's own log store**, so a container that has exited still
  has a log to open, and opening it is instant.

`docker compose ps --format json` is read forgivingly, the posture of every other reader in
this codebase: newline-delimited objects (Compose v2.21 and later) and a single JSON array
(older v2) are both accepted, a line that does not parse is skipped, and a missing field
degrades that one container to `unknown` rather than failing the listing.

The log follow deliberately runs with **no idle timeout**. Every other command BFAST
spawns is stopped by silence, because silence from a build or a status query is a hang —
but silence from a container is the normal, healthy state of a service with nothing to
say. The only things that end a follow are the stream closing and the user closing the
tab.

## Configuration

One new field in the `environments` block — see
[configuration.md](configuration.md#fields):

| Field | Type | Default | Rules |
|---|---|---|---|
| `logTail` | number | `1000` | How many lines of existing history a log tab fetches when it starts following. Whole number, 0–100000; `0` starts from the next line printed. |

Reading is forgiving as everywhere else — a value out of range in a hand-edited or pulled
file is dropped and the default applies — and writing is strict: the settings form refuses
to save one.

## Providers other than Docker Compose

Listing containers is part of the `EnvironmentProvider` seam, not an optional extra bolted
onto the Docker one: `containers()` and `logs()` are required members, so a new provider
cannot quietly ship without an answer, and the registry cannot forget to forward them. The
Kubernetes stub answers both the way it answers everything else — `'not-implemented'` with
its reason — and that reason is what the row shows. Saying "not supported yet" where the
containers would be is the honest answer; hiding the section would read as a feature that
does not exist.

## Out of scope

Deliberately not here, and not to be added without a ticket that asks for it:

- **Acting on a container** — restart, stop one service, exec a shell. This story is
  `view` only; the stack's controls stay Start/Stop/Delete on the environment.
- **Changing the "BFAST Environments" output channel.** It is the operations log and
  remains untouched.
- **Search, filter, download-to-file, or merging several containers into one stream.**
  The tab shows one container's log, as the backend produced it.
