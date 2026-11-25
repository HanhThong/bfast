# SonarQube — the deployed stack and the external instance

Two things this file pins down: exactly what BFAST runs when it deploys SonarQube for you,
and exactly what an instance you already own has to offer. Both halves are contracts — the
code must keep matching them.

## What BFAST runs

`<project>` is `bfast-sonar-<workspace-slug>` — one per workspace, so two projects open at
once never touch each other's containers, networks or volumes. `<files>` is one `--file`
per configured path: the compose file BFAST ships (or `scan.composeFile`), then every
`scan.composeOverrides` entry **in order**.

| Action | Command |
|---|---|
| Probe | `docker compose version` |
| Memory check | `docker info --format {{.MemTotal}}` |
| Deploy / Start | `docker compose -p <project> <files> up -d --remove-orphans` |
| Boot log | `docker compose -p <project> <files> logs --follow --no-color --tail 50` |
| Stop | `docker compose -p <project> <files> down` |
| Remove | `docker compose -p <project> <files> down --volumes --remove-orphans` |
| Status | `docker compose ls --all --format json` |
| Port recovery | `docker compose -p <project> <files> port sonarqube 9000` |

Every invocation receives `BFAST_SONAR_PORT` and `BFAST_SONAR_PROJECT` in its environment —
**`down` included**, because a compose file using `${BFAST_SONAR_PORT:?}` refuses to even
parse without it.

Three deliberate absences from that `up`:

- **No `--build`.** There is nothing to build; the images are published.
- **No `--force-recreate`.** An environment's stack is cattle and is rebuilt from scratch
  every Start. This instance is a **pet**: its volume holds the admin password BFAST
  generated and the tokens it issued, and its analysis history.
- **No `--pull always`.** `sonarqube:community` is a rolling tag, and pulling on every
  start is precisely what would silently upgrade the image and drop you into a database
  migration you did not ask for. The default (`--pull missing`) pulls only on a machine
  that has never seen the image.

## The compose contract

BFAST ships its own compose file, adapted from SonarSource's published example. You only
need this section if you replace it with `scan.composeFile` or layer
`scan.composeOverrides` on top.

- **The service running SonarQube must be named `sonarqube`,** and it must expose container
  port `9000`. The scanner container reaches it by that name on the compose network, and
  `docker compose port sonarqube 9000` is how BFAST re-learns a forgotten host port.
- **The host port must come from `${BFAST_SONAR_PORT}`,** never a literal. BFAST allocates
  it, builds `http://localhost:<port>` from the same number, and polls that URL to decide
  `starting` from `running`. A literal makes every link and every status lie.
- **Exactly one service publishes a host port**, and it is SonarQube's web UI.
- **No `container_name:` and no `hostname:`.** SonarSource's example has them, and they are
  the first thing to delete: a fixed container name collides the moment a second workspace
  deploys. `-p <project>` already makes every object unique.
- **Named volumes only, no `external: true`, no top-level `name:`** — the same isolation
  rules the environments contract states, for the same reasons.
- **The database must persist.** BFAST ships PostgreSQL rather than SonarQube's embedded
  H2, and the choice is not a preference: **H2 data cannot be migrated**, so the first
  image bump silently discards every issue, every measure, and the admin password and
  tokens BFAST provisioned. The cost of the alternative is one container and one volume,
  which compose makes free.
- **No healthcheck on the `sonarqube` service.** A healthcheck would let BFAST use
  `up -d --wait`, but the readiness answer it actually needs — `STARTING` versus
  `DB_MIGRATION_NEEDED` versus `UP` — only exists over HTTP, and BFAST has to poll that
  anyway for external instances. One readiness path, not two.
- **`read_only: true` is a package deal** with the four named volumes and the `/tmp`
  tmpfs. Remove one volume in an override and the container dies on an unexplained write.
- **Do not add `user: root`.** SonarQube's Elasticsearch refuses to run as root; the image
  already runs as a non-root user and knows what it is doing.

### Verifying by hand

If you replaced the compose file, prove it satisfies the contract the way BFAST will use
it:

```powershell
$env:BFAST_SONAR_PORT = "9000"
$env:BFAST_SONAR_PROJECT = "bfast-sonar-check"

docker compose -p bfast-sonar-check --file your-compose.yml config
docker compose -p bfast-sonar-check --file your-compose.yml up -d
# poll until this prints {"id":...,"version":"...","status":"UP"}
curl http://localhost:9000/api/system/status

docker compose -p bfast-sonar-check --file your-compose.yml down
docker compose -p bfast-sonar-check --file your-compose.yml up -d
# the data survived a stop: this must still answer UP, and the admin password
# you set on the first run must still work
curl http://localhost:9000/api/system/status

docker compose -p bfast-sonar-check --file your-compose.yml down --volumes
```

If that sequence works twice in a row, the file satisfies BFAST.

## Provisioning

`auto` mode, `autoProvision: true`. It runs as the last step of **Deploy** and **Start**
and again before every scan. Everything here is idempotent and ordered cheapest-first, so
the common case — a healthy instance that was provisioned last week — costs exactly one
HTTP call and writes nothing.

1. **Both tokens stored?** Probe the results token. It works → done.
2. **Admin password stored?** Probe it. It works → the tokens are missing or were revoked:
   revoke by name and mint both again.
3. **`admin`/`admin` still works?** A fresh instance. Change the password to a generated
   one and mint both tokens.
4. **None of the above** → BFAST stops and tells you, rather than guessing. It never tries
   a list of candidate passwords and never touches your data.

With **`autoProvision: false`** none of that runs: the instance is yours to manage, BFAST
never touches its admin password, and the same step only **verifies** the token you stored
with **BFAST: Set SonarQube Token** — exactly what it does against an external server.

The **project is not created here.** Provisioning is about the server and runs before any
scan has said what it will analyse; the key belongs to the scan, and comes from the
checkout's own `sonar-project.properties` when it has one. The project is created — under
that key and that file's `sonar.projectName` — at the start of the first scan, and checked
with one Browse-level call on every scan after. See
[configuration.md](configuration.md#where-the-project-key-comes-from).

Two rules inside that make it safe:

- **The generated password is written to secret storage *before* it is sent.** Changing a
  password is an irreversible effect on a server; a crash between "the server accepted it"
  and "the extension wrote it down" would lock you out of your own instance. Write-then-act
  is the only safe order.
- **Token names are fixed — `BFAST analysis` and `BFAST results` — and re-provisioning
  revokes and re-mints them.** SonarQube shows a token's value exactly once, so a token
  BFAST cannot read is dead weight that must be replaced regardless; unique names would
  only postpone that and would leave your Security page with ten indistinguishable rows,
  so "revoke BFAST's access" stops being one obvious click.

**Changing the admin password yourself does not break anything.** SonarQube does not revoke
tokens when a password changes, and step 1 runs before step 2 — the only consequence is a
warning line in the log.

**A volume that already has data and a BFAST that has no password** — a cloned workspace, a
wiped keychain, a colleague who set it up first — is the one case that stops. BFAST offers
two ways out and no third: create a Global Analysis Token in the UI yourself and run
**BFAST: Set SonarQube Token**, or **Remove** the server and start clean.

## Networking

Getting the scanner container to reach the server is the hardest part of this feature and
the most common way an otherwise-correct setup fails silently.

| Server | Platform | What BFAST does |
|---|---|---|
| deployed by BFAST | all | joins the compose network and uses `http://sonarqube:9000` |
| external, host is `localhost` | all | `--add-host host.docker.internal:host-gateway`, and rewrites the URL to match |
| external, bound to loopback only | Linux | set `scan.scannerNetwork` to `host` |
| external, a real hostname or Cloud | all | nothing; the URL is used as-is |

The first row is not a compromise but the best available answer: joining the compose
network reaches container port 9000 by service name, identically on Docker Desktop, native
Linux, rootless, colima and a remote Docker context. It never touches the published host
port, so it cannot be broken by a firewall, by loopback-only binding, or by the port having
drifted.

## How the scanner runs

`docker` mode runs the official image with the analysed directory bind-mounted at
`/usr/src`. Four details are load-bearing:

- **`SONAR_HOST_URL` and `SONAR_TOKEN` are environment variables, never `-D` flags.** They
  are set in the environment of the `docker` process BFAST spawns and forwarded into the
  container with bare `-e SONAR_HOST_URL -e SONAR_TOKEN` flags — name only, so docker
  copies the value and it never appears in an argument. The image's entrypoint turns
  `SONAR_TOKEN` into `-Dsonar.token` itself. Passing the token on the command line would
  put it in the host's process table and in the argv BFAST echoes to its output channel —
  BFAST redacts it there regardless, but the right fix is not to put it there. The
  forwarding is load-bearing: the docker client's environment is **not** the container's,
  and a scanner that sees no host url defaults to SonarCloud and fails with "mandatory
  properties … sonar.organization".
- **`-D` properties go after the image name.** They replace the image's default command,
  and its entrypoint recognises a leading flag and runs the scanner with them.
- **On Linux the container runs as your uid.** The image runs as uid 1000 by default, and
  if that is not you, anything it writes into a bind mount ends up owned by someone else
  and cannot be deleted. BFAST passes `-u <uid>:<gid>` on Linux only — Docker Desktop
  already translates ownership on Windows and macOS, and passing it there breaks the
  image's own assumptions. The scanner's cache and its working folder are mounted from
  BFAST-owned folders so the container user still has somewhere to write.
- **`.scannerwork/` never touches your repository.** The image writes it to
  `/tmp/.scannerwork` *inside the container* — its own `SCANNER_WORKDIR_PATH`, which the
  entrypoint turns into `-Dsonar.working.directory` — so BFAST mounts a folder of its own
  (`<scan home>/scannerwork`) at exactly that path and reads `report-task.txt` back out of
  it. It restates the variable explicitly, so a pinned image that defaults differently still
  writes there. Only `command` mode, where your own scanner
  runs on the host with its defaults, leaves a `.scannerwork/` in the analysed directory;
  add it to `.gitignore` then.

BFAST supplies `sonar.projectKey` and `sonar.projectName` — the ones it resolved *from*
the checkout's `sonar-project.properties` when there is one, so the two agree — and adds
`sonar.sources` / `sonar.exclusions` from settings **only when they are set**. Its own
`sonar.sources=.` default is sent only when that file does not lay the sources out itself
(`sonar.sources` or `sonar.tests`): `-D` overrides the file, and `.` on top of a file that
separates tests from sources would make every test file a source file too, which the
scanner refuses as a file indexed twice. BFAST never writes a properties file into your
repository.

**SCM detection.** `sonar.scm.provider=git` is set only when `.git` is a real directory
inside the analysed folder. In an environment worktree it is a *file* pointing outside the
mount, which makes the scanner find a repository it cannot read and flood the log with
blame failures — so BFAST sets `sonar.scm.disabled=true` there instead, and says so in the
summary, because without SCM data SonarQube's "new code" measures are meaningless.

**`sonar.branch.name` is never sent.** Community Edition has no branch analysis, and
passing it fails the analysis outright.

## Reading the verdict

The scanner exiting `0` means the report was *uploaded*, not that it was processed. BFAST
reads `report-task.txt` — from its own scanner work folder in `docker` mode, from the
analysed directory's `.scannerwork/` in `command` mode — for the task id, having removed
the previous run's copy before the scanner started so a failed run can never hand back the
last run's verdict. It then polls the server until that task finishes, then fetches the quality gate for that specific analysis — not for the project's
latest, which on a shared instance could be a colleague's run that landed in between.

The URLs inside `report-task.txt` are the **container's** view of the server and are
useless in your browser; BFAST reads only the task id and the project key from it and
builds every link itself.

## First-run gotchas

- **`vm.max_map_count` on Linux.** SonarQube's Elasticsearch exits immediately below
  262144 (SonarQube asks for 524288); the Linux default is 65530. `docker compose up -d`
  reports success while it happens. BFAST checks `/proc/sys/vm/max_map_count` before
  deploying and recognises the failure in the boot log afterwards, but it cannot fix it:
  the sysctl is not namespaced, so compose cannot set it and the only workaround would be a
  privileged init container — an escalation a ticket tracker has no business requesting.

  ```sh
  sudo sysctl -w vm.max_map_count=524288
  echo 'vm.max_map_count=524288' | sudo tee /etc/sysctl.d/99-sonarqube.conf
  ```

  Docker Desktop's VM already sets it; the check only runs on Linux.
- **About 1 GB of images** on the first deploy, plus another ~500 MB for the scanner image
  on the first scan, plus 100–200 MB of analyzer plugins the scanner fetches from the
  server. BFAST caches the last of those; the first two are Docker's.
- **2 GB of RAM for SonarQube**, plus your OS and whatever environments are running. BFAST
  warns below 4 GB available and lets you continue.
- **2–5 GB of disk** in normal use, between Elasticsearch's indices and PostgreSQL, and it
  does not shrink on its own. **Remove** is the only reclaim — and it takes the analysis
  history and the provisioned credentials with it.
- **After an image bump** the server comes up needing a database migration. BFAST starts it
  and reports progress rather than dead-ending, but it can take minutes on a large volume.

## What an external instance must offer

| Requirement | Why |
|---|---|
| Reachable over `http`/`https` from this machine | The scanner and BFAST both talk to it directly; there is no proxy inside BFAST. |
| A **user token** | BFAST reads the quality gate, the measures and the issues back through the Web API. An analysis-only token answers 403 there — the analysis would succeed and the verdict would be unreadable, which is an `error` outcome rather than a useful one. |
| **Execute Analysis** on the project | The minimum for the scan itself. Without it the scanner gets a 403 that reads like a bad token. |
| **Browse** on the project | For reading the results back. |
| **Create Projects**, only until the project exists | BFAST creates the project before the first scan, under the checkout's own key and name. Or create it once in the web UI and drop the permission — a refusal here is a warning in the log, not a failed scan, since the analysis itself provisions an unknown key. |
| `organization`, on SonarQube Cloud | Mandatory there, and Cloud's error when it is missing does not say so clearly. |
| A trusted TLS certificate | A self-signed certificate must be trusted by the **machine**: `NODE_EXTRA_CA_CERTS` for VS Code's own process, and the scanner container's Java truststore for the scanner. BFAST does not offer an "ignore certificate errors" setting and will not. |

**The token must not be an administrator's.** Nothing BFAST does against an external
instance needs administration — it does not create quality gates, change profiles or touch
users. Provisioning is `auto` mode only, and there the instance is BFAST's own.
