# The `EnvironmentProvider` seam

For contributors: how the environments feature is split, what a provider is responsible
for, and how to add a new kind of environment. The seam follows the same pattern as the
extension's `AiProvider` (see `src/ai/aiProvider.ts` and CLAUDE.md): a `vscode`-free
interface module, one registry that reads the configured provider at call time, and fakes
that prove the seam needs no cast and no real backend to test against.

## The split: store vs provider

Two halves with a sharp line between them:

- **`EnvironmentStore`** owns everything about an environment's *existence*: git worktrees,
  branch naming, port allocation, the marker files (a ticket's inside its worktree, the
  master environment's `master.json` beside them), the per-environment operation queue,
  and the inventory the sidebar lists. It is provider-agnostic.
- **`EnvironmentProvider`** owns everything about *running the stack* in an environment
  that already exists: start, stop, destroy, reporting live status, and listing and
  following its containers. It is technology-specific — Docker Compose today, Kubernetes
  later.

`containers()` and `logs()` are **reads**, and the store forwards them without putting
them through the per-environment queue: listing what is running must not wait behind a
fifteen-minute build, and neither changes anything there is a race to lose.

A provider is handed only the **descriptor** and must need nothing else:

```ts
interface EnvironmentDescriptor {
  id: string;                        // the key everything is keyed on: 'ST-1.2', or 'master'
  scope: 'ticket' | 'master';        // a ticket's worktree, or the workspace itself
  ticketId?: string;                 // absent for the master environment; === id otherwise
  kind: EnvironmentProviderId;       // 'docker-compose' | 'k8s'
  branch: string;                    // 'story/ST-1.2', 'epic/EP-1'; for master, whatever the
                                     // workspace has checked out when listed, or ''
  worktreePath: string;              // absolute path of the folder the stack runs in — the
                                     // checkout, or the workspace for the master environment
  projectName: string;               // the isolation name: 'bfast-st-1-2', 'bfast-master-<slug>'
  ports: Record<string, number>;     // portVariables name -> allocated port
  mainPort?: string;                 // which ports entry is the main (browser-facing) one;
                                     // recorded explicitly — a Record carries no order
  createdAt: string;                 // ISO 8601
}
```

`mainPort` is a host-side concept — sidebar ordering and the open-in-browser click on a
port row; providers are free to ignore it. A provider never asks which `scope` it was
handed: `worktreePath` is the folder to run in and `projectName` the isolation name, for a
ticket's worktree and the master environment's workspace alike.

Per **operation**, the descriptor is the only input. Workspace configuration a provider
legitimately needs — the compose file path, later a chart path — comes from
`EnvironmentContext.settings()`, handed to the constructor and read **at call time**, so
a settings change takes effect on the next operation without a reload.

What a provider must **not** know: git, the marker file, how ports were allocated,
anything from the `vscode` module. Those belong to the store (or the extension host).
If an implementation needs one of them, the seam is in the wrong place — fix the seam,
don't import around it.

## The interface

```ts
interface EnvironmentProvider {
  readonly id: EnvironmentProviderId;   // stable machine id, e.g. 'docker-compose'
  readonly label: string;               // user-visible, e.g. 'Docker Compose'

  /** Cheap and cached where possible; a missing binary must degrade to a
   *  refused action carrying this message — the command layer surfaces it
   *  before Create/Start touch anything — never a broken view. */
  availability(): Promise<EnvironmentAvailability>;

  /** The whole stack, from scratch. Synchronous, returning a handle rather than a
   *  promise: an operation starts, emits progress, and finishes, and the caller
   *  needs a cancel for the middle. */
  start(env: EnvironmentDescriptor, onProgress?: EnvironmentProgressListener): EnvironmentOperation;

  /** Shut the stack down, keeping its persistent data. */
  stop(env: EnvironmentDescriptor, onProgress?: EnvironmentProgressListener): EnvironmentOperation;

  /** Remove the running footprint start() created — containers, networks,
   *  volumes, or the namespace. Built images are deliberately left in the image
   *  store (see docker-compose.md). Called by Delete before the worktree is
   *  removed. */
  destroy(env: EnvironmentDescriptor, onProgress?: EnvironmentProgressListener): EnvironmentOperation;

  /** Optional: make the worktree deletable by the invoking user, called right
   *  before the host removes the folder — the docker provider chowns back
   *  root-owned bind-mount files on Linux via a throwaway container.
   *  Deliberately independent of the stack definition (a half-deleted worktree
   *  may have lost its compose file) and best-effort: it must never fail the
   *  delete. Absent means the technology has nothing to reclaim. */
  reclaim?(env: EnvironmentDescriptor, onProgress?: EnvironmentProgressListener): EnvironmentOperation;

  /** Batch on purpose: compose answers every project in one `compose ls`, k8s in
   *  one API call. Never throws — an unreachable backend maps every entry to
   *  'unknown'. Keyed by `id`. */
  statuses(envs: readonly EnvironmentDescriptor[]): Promise<ReadonlyMap<string, StackStatus>>;

  /** The containers the environment's stack is made of, **exited ones included** —
   *  a container that died is the one worth reading. Unlike statuses() this one
   *  *does* reject, with an EnvironmentError: "the backend could not be asked" and
   *  "the stack has no containers" are different facts and the sidebar shows them
   *  differently. Required, not optional: a provider that cannot answer says so
   *  with 'not-implemented', and a registry then has nothing to forget to forward. */
  containers(env: EnvironmentDescriptor): Promise<EnvironmentContainer[]>;

  /** Follows one container's log, newest last, starting with `tail` lines of
   *  history. Emits `{kind: 'output'}` progress and settles when the stream ends —
   *  the container stopped or was removed — or when cancelled. Deliberately armed
   *  with **no idle timeout**: silence from a container is its healthy state, not a
   *  hang, so the usual watchdog would be wrong here. */
  logs(
    env: EnvironmentDescriptor,
    container: EnvironmentContainer,
    options: { tail: number },
    onProgress?: EnvironmentProgressListener
  ): EnvironmentOperation;

  /** Cancels every live operation. The provider owns its child processes. */
  dispose(): void;
}

interface EnvironmentOperation {
  readonly completed: Promise<void>;   // rejects with EnvironmentError
  cancel(reason?: string): void;       // idempotent, safe after settle
}

interface EnvironmentAvailability {
  ok: boolean;
  reason?: EnvironmentErrorCode;       // why not, when ok is false
  message?: string;                    // the disabled action's tooltip
}

type EnvironmentProgress =
  | { kind: 'phase'; label: string }                            // 'Building images', …
  | { kind: 'output'; text: string; channel: 'stdout' | 'stderr' };
type EnvironmentProgressListener = (progress: EnvironmentProgress) => void;

type StackStatus = 'running' | 'partial' | 'stopped' | 'unknown';

/** One container of a stack — a row under the environment, and what a log opens on. */
interface EnvironmentContainer {
  id: string;            // the backend's own id; what logs() is opened on
  name: string;          // the container's own name, 'bfast-st-1-2-web-1' — stable across
                         // a recreate, so a log tab keyed on it survives a Start
  service: string;       // the service it is an instance of — the row's label
  state: ContainerState;
  status: string;        // the backend's own words: 'Up 3 minutes (healthy)',
                         // 'Exited (1) 12 seconds ago' — the row's description
  exitCode?: number;     // present when it has exited
}

type ContainerState =
  | 'running' | 'restarting' | 'created' | 'paused' | 'exited' | 'dead' | 'unknown';
```

`EnvironmentContainer` is provider-generic on purpose: `id`/`name` are opaque strings the
host only ever hands back, and `status` is the backend's own sentence rather than
something BFAST composes — a k8s provider fills it with a pod phase and the rows keep
reading correctly. `state` is the small closed set the icon and the "is this the culprit"
verdict are drawn from; anything a provider cannot map is `'unknown'`, never invented.

## `stackEnvironment` — the one place the env-var contract lives

```ts
/** Everything a stack ever receives from BFAST. Both providers and the docs
 *  point here; add a variable in this one function or not at all. */
function stackEnvironment(env: EnvironmentDescriptor): Record<string, string>;
// = each ports entry stringified
// + BFAST_TICKET_ID   = env.ticketId ?? ''   // set but empty for the master environment
// + BFAST_PROJECT_NAME = env.projectName     // 'bfast-st-1-2', 'bfast-master-my-app'
```

A provider spreads it over the process environment (`{...process.env, ...stackEnvironment(env)}`)
— never assign to `process.env` itself, which is shared with every extension in the window.
It must be passed to *every* invocation including stop/destroy: a compose file using
`${WEB_PORT:?}` refuses to even parse without it.

## Status mapping

`statuses()` speaks `StackStatus`; the store overlays operation state and failures before
the sidebar sees anything:

| Source | Sidebar status |
|---|---|
| An operation is queued or running for this environment | `creating` / `starting` / `stopping` / `deleting` |
| The last operation failed (until a later one succeeds) | `error` + detail |
| `running` | `running` |
| `partial` (some services up, some not) | `error`, detail "some services are not running" |

`compose ls` only counts states, so the compose provider asks a `partial` project again
container by container (`compose ps --all`): a container that **exited with code 0** is a
one-shot job that finished — an install or a migration — and does not count against the stack.
At least one container running and every other one exited 0 is `running`; a non-zero exit,
`dead`, `restarting` or an exit code compose did not report is still `partial`.
| `stopped` (or the project unknown to the backend) | `stopped` |
| `unknown` (backend unreachable) | `unknown` |

## Conventions a provider must follow

- **Errors** are `EnvironmentError` with a code from `EnvironmentErrorCode`
  (`'not-installed' | 'not-implemented' | 'not-configured' | 'exists' | 'no-ports' |
  'git-error' | 'busy' | 'cancelled' | 'timeout' | 'provider-error'`). A missing binary
  (spawn `ENOENT`) is `'not-installed'` with an actionable message; never let a raw
  `Error` escape. Error messages must never interpolate the environment object — it may
  carry secrets in a future caller.
- **Processes** are spawned through the shared `runProcess` helper: argv list with
  `shell: false` (nothing is ever interpreted by a command interpreter; on Windows this
  also means only real `.exe`s launch — `docker.exe` and `git.exe` qualify, `.cmd` shims
  do not), `windowsHide: true`, stderr kept for diagnostics only.
- **Progress** is emitted through the listener as
  `{kind: 'phase', label}` (a stage heading) or `{kind: 'output', text, channel}` (raw
  process output). The host writes it to the "BFAST Environments" output channel — the
  proof a minutes-long operation has not hung. None of it is parsed.
- **Cancellation**: `cancel()` records the reason and kills the child; the settled
  operation rejects with `EnvironmentCancelledError`. Idempotent, and honoured even if
  pressed before the process has spawned.
- **Timeouts are idle windows, not ceilings on the work.** They measure how long an
  operation may produce **no output at all**, and any byte on either channel resets
  them — so `docker compose up --build` may build for an hour so long as it keeps
  streaming, and only silence stops it. A wall clock would kill exactly the slow first
  builds it was meant to protect. The windows: the availability probe ~10 seconds;
  Start ~15 minutes; Stop/Destroy ~2 minutes; status and the container listing ~30
  seconds. Exceeding one rejects with `'timeout'` — a provider with slower operations
  picks its own values but must map them to the same code. **`logs()` is the one
  exception and has no window at all**: a container that says nothing for an hour is a
  healthy container, not a hang, so the one signal the watchdog reads means the opposite
  here.
- **No dialogs, no `vscode`.** A provider that needs to ask the user something is a
  design smell; surface it as an error and let the command layer decide.

## Adding a provider

1. Add its id to `ENVIRONMENT_PROVIDER_IDS` in `src/settings/environmentSettings.ts`
   (parsing accepts it from that moment; the settings form lists it).
2. Implement `EnvironmentProvider` in `src/environments/<name>Provider.ts`, constructor
   taking `(context: EnvironmentContext, runner: ProcessRunner = runProcess)` so tests
   inject a fake runner.
3. Register it in `configuredEnvironmentProvider` (`src/environments/environmentRegistry.ts`)
   — all providers are constructed once, up front; the `environments.provider` setting is
   read **at call time**, so switching takes effect without a reload.
4. Test it against `FakeProcessRunner` (exact argv, cwd, env), never a real backend; the
   orchestration suite drives `EnvironmentStore` with `FakeEnvironmentProvider` and must
   not change.

The stub in `src/environments/k8sProvider.ts` is the template for "registered but not
implemented": availability says why, operations reject with `'not-implemented'`, statuses
answer `'unknown'`, `containers()` rejects with the same code — which the sidebar renders
as a row saying so, never as an empty list — and nothing else in the feature knows the
difference.
