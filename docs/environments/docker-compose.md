# The Docker Compose contract

This document is the **contract** between BFAST and your `docker-compose.yml`: exactly
what the extension runs, and what the compose file must look like to satisfy it. For what
an environment *is*, see [README.md](README.md); for where the values below are configured,
see [configuration.md](configuration.md).

## What BFAST runs

Start, Stop and Delete run **in the environment's folder**: for a ticket that is the
worktree root — a checkout of the ticket's branch, *not* your main working copy — and for
the [master environment](README.md#the-master-environment) it is the workspace folder
itself. Probe is a global availability check, and Status is a single global query covering
every environment at once, matched back by project name — neither touches a folder.
`<project>` is `bfast-<ticket-id>` lower-cased with dots replaced (`ST-1.2` →
`bfast-st-1-2`), or `bfast-master-<workspace-slug>` for the master environment.

| Action | Command |
|---|---|
| Probe | `docker compose version` (Compose **v2** required — the `docker compose` plugin, not the old `docker-compose` v1 binary) |
| Start | `docker compose -p <project> <files> up -d --build --force-recreate` |
| Stop | `docker compose -p <project> <files> down` |
| Delete | `docker compose -p <project> <files> down --volumes --remove-orphans` |
| Status | `docker compose ls --all --format json` |
| Containers | `docker compose -p <project> ps --all --format json` |
| Log | `docker logs --follow --tail <logTail> <container id>` |

Containers and Log take no folder, no `--file` and none of the variables below: like
Status they match containers by the project label the engine already holds, so a broken or
missing compose file — the state a failing environment is most likely to be in — never
hides the containers or their logs. `--all` includes containers that have **exited**,
which is where a failure explains itself. See
[container-logs.md](container-logs.md) for what is done with them.

`<files>` is one `--file` flag per configured compose file: the base
`environments.composeFile` (default `docker-compose.yml`) followed by every
`environments.composeOverrides` entry **in order** — standard compose merging,
so later files override earlier ones. Use overrides to layer environment-only
tweaks (published ports, dev volumes) over a compose file the team also uses
elsewhere. Every file in the chain must exist in the worktree — a missing one
refuses the operation naming the path.

Delete removes containers, networks and volumes — **not** the images the builds produced
(`<project>-<service>`); prune those with `docker image prune -a` when they pile up.

Every per-environment command (Start, Stop, Delete) receives your normal environment plus:

- **One variable per entry in `environments.portVariables`**, each holding a free port
  BFAST allocated from `portRangeStart..portRangeEnd`. The names are **yours** — BFAST
  attaches no meaning to them and has no notion of frontend, backend or database. Ports
  are allocated once, at environment creation, and shown in the sidebar.
- **`BFAST_TICKET_ID`** (e.g. `ST-1.2`) and **`BFAST_PROJECT_NAME`** (e.g. `bfast-st-1-2`),
  always set — useful for a proxy that routes per environment, log labels, database names.
  For the master environment `BFAST_TICKET_ID` is set but **empty** — there is no ticket —
  so key per-stack things on `BFAST_PROJECT_NAME`, which is unique. The `BFAST_` prefix is
  reserved; a port variable named with it is refused.

Shell environment beats a `.env` file in Compose's precedence order, so BFAST's values
always win.

Two facts drive every rule below:

1. **Several environments run side by side** — same compose file, different project names,
   different ports. Anything globally named or globally bound collides.
2. **Start is always from scratch** (`--build --force-recreate`). Containers are cattle;
   anything worth keeping lives in a named volume, and anything that seeds data must be
   idempotent.

## Writing the compose file

### Any topology — BFAST only asks for a main port

`portVariables` is just a list of names; one free port is allocated per name, and the
shape of the stack behind them is entirely yours. The only concept BFAST attaches is the
**main port**: the first name in `portVariables` (or the one `environments.mainPort`
names — see [configuration.md](configuration.md)). It is the URL a developer opens —
usually the frontend — shown first in the sidebar, where clicking any port row opens
`http://localhost:<port>` in VS Code (right-click it for the system browser instead).

Everything else is free-form. Publish exactly as many ports as *your* architecture
exposes to the host — one main port plus any number of backend, database or tooling
ports. No reverse proxy is required; it is one option among several:

| Topology | `portVariables` | Main port |
|---|---|---|
| **A frontend + any number of backends** | `["FRONTEND_PORT", "AUTH_PORT", "ORDERS_PORT", "DB_PORT"]` | `FRONTEND_PORT` |
| **Single entry point via a proxy** (optional pattern) | `["WEB_PORT"]` — one nginx/traefik/caddy service publishes the only host port and routes internally; adding a service changes the proxy config, never `bfast.json` | `WEB_PORT` |
| **Classic 3-tier** | `["FRONTEND_PORT", "BACKEND_PORT", "DB_PORT"]` | `FRONTEND_PORT` — the reference example below |

Change the list any time in BFAST settings (the Environments tab) — it is your
`.vscode/bfast.json`, committed with the repo, so the whole team shares one contract with
the compose file.

### Ports: variables only, never literals

Publish every host port through a variable named in `portVariables`:

```yaml
    ports:
      - "${FRONTEND_PORT:?set by BFAST}:80"
```

- `:?` is preferred because it turns a misconfiguration into an immediate, named error.
  The hazard of `:-default` is subtle: a variable used in the compose file but missing
  from `portVariables` (a typo, or never added) silently falls back to the same default
  in **every** BFAST environment — the first one works, the second collides with it.
  A `:-default` is still convenient if you also run `docker compose up` by hand outside
  BFAST; pick one style per team, knowing what `:-` hides.
- A hard-coded host port anywhere (`"5432:5432"` on the db is the classic) breaks the
  second environment that starts. The **container-side** port stays literal — only the
  host side is BFAST's.

A frontend with several backend services, each with its own published port, looks like
this (build contexts and healthchecks elided — the reference example below shows them
in full):

```yaml
services:
  frontend:
    build: ./frontend
    ports:
      - "${FRONTEND_PORT:?set by BFAST}:80"     # the main port

  auth:
    build: ./services/auth
    ports:
      - "${AUTH_PORT:?}:8080"

  orders:
    build: ./services/orders
    ports:
      - "${ORDERS_PORT:?}:8080"

  db:
    image: postgres:16
    ports:
      - "${DB_PORT:?}:5432"                     # published only for host-side tools
```

If you prefer a single entry point instead, a reverse proxy is the only service with
`ports:` at all — every other service stays internal:

```yaml
services:
  proxy:
    image: nginx:alpine
    ports:
      - "${WEB_PORT:?set by BFAST}:80"          # the main port — and the only one
    volumes:
      - ./proxy/nginx.conf:/etc/nginx/nginx.conf:ro   # routes /api/auth → auth:8080, / → web:80 …
    depends_on:                # use service_healthy only for services that define a
      web:                     # healthcheck (see the reference file) — compose refuses
        condition: service_started    # to wait on the health of a service without one
      auth:
        condition: service_started
      orders:
        condition: service_started

  web:
    build: ./web        # no ports: — reached only through the proxy

  auth:
    build: ./services/auth

  orders:
    build: ./services/orders

  db:
    image: postgres:16  # not published at all, or give it DB_PORT for GUI tools
```

### Only publish what the developer's browser or tools need

Services talk to each other over the compose network **by service name and internal
port** — `postgres://app:app@db:5432/app` — which needs no published port and no variable.
Publish only what is reached *from the host*: the frontend, the API the browser calls
directly, and the db port if you want to point a GUI at it.

One subtlety: if the **browser** (not the frontend container) calls the backend, it does so
via the host-published port, so pass it through:

```yaml
    environment:
      API_URL: "http://localhost:${BACKEND_PORT:?}"
```

### Isolation rules

- **No `container_name:`** — fixed names collide across projects. Compose's generated
  `<project>-<service>-1` names are already unique.
- **No top-level `name:`** — `-p` overrides it, but leaving it in misleads anyone reading.
- **Named volumes only, no `external: true`** — a named volume is automatically prefixed
  with the project name, so isolation is free. An external volume or network with a fixed
  name is shared state between environments. Note **Delete removes volumes**
  (`down --volumes`): treat every volume as disposable.
- **No absolute paths, no bind mounts reaching outside the repo** (`../something`). The
  worktree lives under the temp folder — a path that works in your main checkout points at
  nothing there. Relative in-repo paths (`./frontend`, `./db/init`) are fine — but the
  worktree is a checkout of **committed files only**: anything gitignored (a local `.env`,
  certs, generated config) is absent there, and submodules are not initialized. Everything
  the compose file mounts or reads must be tracked in git. The master environment is the
  mirror image — it runs in the workspace, where gitignored files *are* present — so a
  compose file that only works there is a file that only works there; keep it working in
  a worktree and treat what the master environment sees on top as a convenience.
- **Prefer named volumes over writable bind mounts.** On Linux, a container running as
  root that writes into a bind-mounted folder leaves root-owned files in the worktree.
  Delete copes — it reclaims ownership through a throwaway `alpine` container before
  removing the folder — but data belongs in named volumes anyway: they are
  project-scoped, removed by Delete, and never collide with git.

### Surviving `--build --force-recreate`

- Database init/seed must be idempotent — e.g. scripts in
  `/docker-entrypoint-initdb.d` (they only run on an empty volume), or migrations that are
  safe to re-run.
- Give every service another service depends on a **healthcheck**, and depend with
  `condition: service_healthy` — otherwise the backend races the db on every cold start,
  which under `--force-recreate` is *every* start.
- The health command must exist **inside the image**: slim and alpine base images often
  ship no `curl` — install it in the Dockerfile, or use `wget -qO-` (busybox/alpine), or
  a language-native probe (`node -e "fetch(...)"`, `python -c "urllib..."`).

### Reference compose file

For `"portVariables": ["FRONTEND_PORT", "BACKEND_PORT", "DB_PORT"]`:

```yaml
services:
  frontend:
    build: ./frontend
    ports:
      - "${FRONTEND_PORT:?set by BFAST}:80"
    environment:
      API_URL: "http://localhost:${BACKEND_PORT:?}"
    depends_on:
      backend:
        condition: service_healthy

  backend:
    build: ./backend
    ports:
      - "${BACKEND_PORT:?}:8080"
    environment:
      DATABASE_URL: "postgres://app:app@db:5432/app"   # service name + internal port
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 20

  db:
    image: postgres:16
    ports:
      - "${DB_PORT:?}:5432"          # published only for host-side tools (psql, GUIs)
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data          # named → project-prefixed → isolated
      - ./db/init:/docker-entrypoint-initdb.d:ro  # runs only on an empty volume
    healthcheck:
      # -h forces TCP: postgres's first-run init phase serves a socket-only temporary
      # server, which a socket-based pg_isready would report as ready too early
      test: ["CMD-SHELL", "pg_isready -U app -h 127.0.0.1"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  db-data:
```

And the matching `.vscode/bfast.json` block:

```jsonc
"environments": {
  "portVariables": ["FRONTEND_PORT", "BACKEND_PORT", "DB_PORT"],
  "portRangeStart": 20000,
  "portRangeEnd": 20999
}
```

### Checklist

- [ ] Every host port is `${VAR:?}` (or `:-default`), and every `VAR` is listed in
      `environments.portVariables`
- [ ] The **main port** (first in `portVariables`, or the one `mainPort` names) is the
      URL a developer would open in a browser
- [ ] No `container_name:`, no top-level `name:`
- [ ] No hard-coded host port anywhere (db included)
- [ ] No `external:` volumes/networks; no absolute or out-of-repo bind-mount paths
- [ ] Services reach each other by service name, not `localhost:<port>`
- [ ] Healthchecks on anything depended on; `depends_on` uses `condition: service_healthy`
- [ ] Seeds/migrations survive a second `up -d --build --force-recreate`

### Verifying by hand

Simulate exactly what BFAST will run (PowerShell shown; any shell works):

```powershell
# Add your --file overrides after the base file, in the configured order.
$env:FRONTEND_PORT='20000'; $env:BACKEND_PORT='20001'; $env:DB_PORT='20002'
$env:BFAST_TICKET_ID='ST-1.2'; $env:BFAST_PROJECT_NAME='bfast-test'
docker compose -p bfast-test --file docker-compose.yml config        # substitution resolves?
docker compose -p bfast-test --file docker-compose.yml up -d --build --force-recreate
docker compose -p bfast-test --file docker-compose.yml up -d --build --force-recreate  # idempotent?
docker compose -p bfast-test --file docker-compose.yml down --volumes --remove-orphans
```

If that sequence works twice in a row, the file satisfies BFAST.
