# The `ScanProvider` seam

For contributors: how the code-scan feature is split, what a provider owns, and how to add
a second scan tool. It follows the pattern `AiProvider` and `EnvironmentProvider` already
set — a `vscode`-free interface module with no implementation, one registry reading the
settings at call time, and fakes proving the seam needs no cast and no real server to test
against.

## The seam is the tool, not the deployment

`ScanProvider` is keyed by **tool** — `sonarqube` today, `semgrep` or `trivy` tomorrow.
Whether SonarQube is one BFAST deployed or one you already own is **SonarQube's own
question**, answered inside its provider, exactly as `composeFile` lives in
`EnvironmentsSettings` rather than in `EnvironmentProvider`.

Three reasons, in order of weight:

1. **A generic "deploy a scan server" provider cannot be written without knowing
   SonarQube.** What makes the deployed mode worth having is the compose file, the
   `/api/system/status` readiness shape and the change-the-password-then-mint-a-token
   sequence. All three are SonarQube facts. A deployment-shaped provider could start
   containers and answer nothing else, and every interesting decision would leak back out
   through a second, tool-shaped seam.
2. **The two axes are not symmetric.** Every scan tool has a scanner; not every scan tool
   has a server — semgrep is a container you run over a checkout, full stop. So "server" is
   a *capability*, and the codebase already has the idiom for one:
   `EnvironmentProvider.reclaim?`, whose doc comment reads *"Absent means the technology has
   nothing to reclaim."*
3. **The tool axis is the one that grows.** `ScanToolId` gains members; a per-tool
   deployment choice may not even mean the same thing for the next tool.

Hence `ScanProvider.server?: ScanServerLifecycle` is **optional**. Absent means the tool has
no server, and the Code Quality section draws no lifecycle rows for it.

There is deliberately **no stub second tool**. `k8sProvider` exists because
`EnvironmentProviderId` has had two members since day one and a settings value with no
implementation must fail with `'not-implemented'` rather than crash. `ScanToolId` has
exactly one member, and inventing a second to "prove the seam" would ship dead code —
`FakeScanProvider` is the proof, which is the standard CLAUDE.md already sets for
`AiProvider`.

## The split: store and runner vs provider

- The **`ScanServerStore`** owns a server's *existence*: the allocated port, the generated
  compose file, the state file, the one-at-a-time operation queue, and persisting whatever
  provisioning minted. It is tool-agnostic.
- The **`ScanRunner`** owns a *run's* existence: which ticket it was started from, which
  directory it analyses, which project key the verdict files under (properties file, then
  settings, then folder name — asking the provider for the first through
  `readProjectIdentity`), the outcome, and the history entry. Also tool-agnostic.
- A **`ScanProvider`** owns everything tool-specific: running the server, running the
  analysis, and reading a verdict back.

A provider is handed only the descriptor and its own settings. It must need nothing else —
no git, no tracker, no marker file, no knowledge of how the port was chosen.

**Credentials are not on the descriptor.** They arrive per call, read from secret storage at
the moment of use and spread over the child's environment — never assigned to `process.env`,
which is shared with every other extension in the window, and never interpolated into an
error message. The same rule `agentEnvironment` states, and the same reason
`environmentProvider.ts` already warns against interpolating a descriptor into an error.

## The interface

```ts
interface ScanProvider {
  /** Stable machine id; doubles as the settings value. */
  readonly id: ScanToolId;
  /** User-visible name, e.g. `'SonarQube'`. */
  readonly label: string;

  /** Cheap and cached where possible. A missing binary degrades to a refused
   *  action carrying this message, never a broken view. */
  availability(): Promise<ScanAvailability>;

  /** What the checkout at `directory` says its project is, when the tool has
   *  a file for that — `sonar-project.properties` for SonarQube. Optional, the
   *  `server?` idiom: a tool with no such file omits it and the runner falls
   *  back to settings and the folder name. Never throws. A provider method
   *  rather than a runner rule because the file's name and grammar are the
   *  tool's, and the runner must not learn them. */
  readProjectIdentity?(directory: string): Promise<ScanProjectIdentity | undefined>;

  /** The server half, when the tool has one. Absent means scanner-only. */
  readonly server?: ScanServerLifecycle;

  /** One analysis, start to finish: run the scanner, wait for the server to
   *  finish processing the report, and come back with the report the results
   *  tab renders. Short-lived and cancellable throughout — the opposite of the
   *  lifecycle, which is exactly why they are separate members. */
  scan(request: ScanRequest, onProgress?: ScanProgressListener): ScanOperation<ScanReport>;

  /** Cancels every live operation. The provider owns its child processes. */
  dispose(): void;
}

interface ScanServerLifecycle {
  availability(): Promise<ScanAvailability>;

  /** Everything that has to exist before the server can run. Does not start it. */
  create(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

  /** Brings it up **and waits until it answers**. A container that is running is
   *  not a server that is ready, and every caller after this one would otherwise
   *  re-implement the wait. */
  start(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

  /** Shuts it down, keeping its data. */
  stop(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

  /** Removes containers, networks **and volumes** — the analysis history goes too. */
  destroy(server: ScanServerDescriptor, onProgress?: ScanProgressListener): ScanOperation;

  /** Mints what a scan needs and **returns** it; it does not store it. A provider
   *  must not learn where a secret lives, exactly as it must not learn about git.
   *  Idempotent by contract: a second run replaces a dead token rather than
   *  failing. For a server BFAST does not own — or one it deployed with
   *  `autoProvision: false` — it mints nothing and only **verifies** what is
   *  configured, so one gesture answers "are my credentials good" in every mode.
   *  It never creates the project: that is the scan's, done in `scan()` under
   *  the key the runner resolved. */
  provision(
    server: ScanServerDescriptor,
    onProgress?: ScanProgressListener
  ): ScanOperation<ScanCredentials>;

  /** Never throws — an unreachable server is `'unknown'`, not an exception. */
  health(server: ScanServerDescriptor): Promise<ServerHealth>;

  /** Where to talk to it. `undefined` when it is not configured enough to say. */
  endpoint(server: ScanServerDescriptor): ScanEndpoint | undefined;
}
```

**Why `ScanOperation<T>` is generic.** A start yields nothing, a provision yields the
credentials it minted, and a scan yields its report. One type parameter beats three
near-identical interfaces, and the synchronous-returns-a-handle shape is
`EnvironmentOperation`'s, for `EnvironmentOperation`'s reason: the caller needs something to
`cancel()` before the promise settles.

**Why the endpoint is a type and not a string.**

```ts
interface ScanEndpoint {
  /** What the **host** reaches the server on: `http://localhost:9000`. */
  url: string;
  /** What a **scanner container** reaches it on, when that differs. */
  containerUrl?: string;
  /** The docker network the scanner must join to use `containerUrl`. */
  network?: string;
}
```

A container resolving `localhost` finds itself. That is the single most common way an
otherwise-correct scan setup fails, so the distinction is a first-class field rather than
something each caller re-derives.

**Why `provision` returns rather than stores.** The store is `vscode`-free and the provider
must not know where a secret lives; something has to write it, and that something is the
host-side context the store is handed. This is also the one thing `AiContext` has no
equivalent of, and the reason is the feature's: the AI half only ever *reads* a credential
the user supplied, while `auto` mode **mints** one.

## Status mapping

| Source | Sidebar status |
|---|---|
| An operation is queued or running | `deploying` / `starting` / `provisioning` / `stopping` / `removing` |
| The last operation failed, until a later one succeeds | `error` + detail |
| No state file | `absent` |
| The tool has no server, or the settings name one BFAST does not own | `external` |
| Container up **and** `health()` said `up` | `running` |
| Container up, `health()` said `starting` | `starting` |
| Container down | `stopped` |
| Docker could not be queried | `unknown` |

`external` is a status rather than a flag on the handle precisely so it never matches the
`when` clause of Start, Stop or Remove: "you cannot start someone else's server" becomes a
missing menu entry rather than a code path.

## Conventions a provider must follow

- **Errors** are `ScanError` with a code from `ScanErrorCode`. Never let a raw `Error`
  escape, and **never interpolate the descriptor or the credentials** into a message — it
  reaches a notification, the log and the results tab.
- **Processes** go through the shared `runProcess` helper: argument list, `shell: false`,
  `windowsHide: true`. The one exception is a user-written `command` line, which is
  inherently a shell line and goes through `shellCommand` exactly as `tests.command` does.
  Do not blur the two: reaching for `shellCommand` on the docker path would reintroduce a
  quoting problem that does not currently exist.
- **Timeouts are idle windows, never ceilings.** Any byte on either channel resets them. An
  HTTP poll manufactures its own traffic, so it must reset on a *changed payload* rather
  than on a request — a task frozen at `PENDING` is a hang, and a poll loop must be able to
  notice.
- **`statuses` and `health` never throw.** An unreachable backend is a status.
- **No dialogs, no `vscode`.** A provider that needs to ask the user something is a design
  smell; surface it as an error and let the command layer decide.
- **Credentials never reach the log** — not in a rendered command, not in an error, not in a
  progress line. A provider that echoes its own argv must redact first.

## Adding a tool

1. Add its id to `SCAN_TOOL_IDS` in `src/settings/scanSettings.ts`. Parsing accepts it from
   that moment and the settings form lists it.
2. Add whatever fields it needs to `ScanSettings` **flat**, beside the existing ones, and
   document in [configuration.md](configuration.md) which tool each belongs to — the shape
   `environments.composeFile` already uses. Do not nest a per-tool sub-object for a tool
   that does not exist yet.
3. Implement `ScanProvider` in `src/scan/<name>/<name>Provider.ts`, with a constructor
   taking `(context: ScanContext, runner: ProcessRunner = runProcess)` so tests inject a
   fake. Omit `server` entirely if the tool has none.
4. Register it in `configuredScanProvider` — every provider constructed once, `scan.tool`
   read **at call time**.
5. Test it against `FakeProcessRunner` (exact argv, cwd, env) and a fake HTTP client, never
   a real server. The store and runner suites drive `FakeScanProvider` and must not change.
6. Add a row to the outcome table in [README.md](README.md) only if the tool can produce an
   outcome that table does not have. **The folder is the spec; the code keeps matching it,
   not the other way round.**
