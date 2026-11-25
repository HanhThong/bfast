// `EnvironmentProvider` backed by Docker Compose v2.
//
// The default implementation, and a thin one on purpose: the argv arrays and
// the `compose ls` parsing live in `composeCommand.ts` where they are pure and
// unit-tested, and every process goes through the injected `ProcessRunner`, so
// this file's tests never touch a real docker.
//
// Start is always the whole stack from scratch (`up -d --build
// --force-recreate`), and every per-environment command runs in the
// environment's folder — a ticket's worktree, or the workspace itself for the
// master environment; the provider reads `worktreePath` and `projectName` off
// the descriptor and never asks which — with `stackEnvironment(env)` spread
// over the process environment — down included, because a compose file using
// `${WEB_PORT:?}` refuses to even parse without the variables.
// docs/environments/docker-compose.md is the contract.

import { access } from 'fs/promises';
import * as path from 'path';
import { environmentComposeFiles } from '../settings/environmentSettings';
import {
	composeDestroyArgs,
	composeDownArgs,
	composeLsArgs,
	composePsArgs,
	composeUpArgs,
	composeVersionArgs,
	dockerLogsArgs,
	parseComposeLs,
	parseComposePs,
	stackStatusFromContainers
} from './composeCommand';
import type { EnvironmentContext } from './environmentContext';
import {
	EnvironmentCancelledError,
	EnvironmentError,
	stackEnvironment,
	type EnvironmentAvailability,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentOperation,
	type EnvironmentProgressListener,
	type EnvironmentProvider,
	type StackStatus
} from './environmentProvider';
import { ProcessError, runProcess, type ProcessRunner, type RunningProcess } from '../platform/runProcess';

const DOCKER_EXECUTABLE = 'docker';

/** The throwaway image `reclaimOwnershipArgs` runs; tiny, and cached after one pull. */
const CLEANUP_IMAGE = 'alpine';

/**
 * `docker run --rm -v <worktree>:/bfast-worktree alpine chown -R <uid>:<gid> …`
 * — pure so a test can pin the argv without a docker.
 */
export function reclaimOwnershipArgs(worktreePath: string, uid: number, gid: number): string[] {
	return [
		'run',
		'--rm',
		'-v',
		`${worktreePath}:/bfast-worktree`,
		CLEANUP_IMAGE,
		'chown',
		'-R',
		`${uid}:${gid}`,
		'/bfast-worktree'
	];
}

/** How long `docker compose version` gets before availability calls it missing. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How long an operation may say **nothing** before it is stopped.
 *
 * Idle windows, not ceilings on the work: `docker compose up --build` streams
 * its build for as long as the build takes and is obviously alive while it
 * does, so a wall clock would kill exactly the slow first builds it was meant
 * to protect. Fifteen minutes of *silence* from a compose command is a hang.
 *
 * `docker compose ps` prints nothing until it exits, so its window behaves
 * exactly as the wall clock it replaced did.
 */
export const START_IDLE_TIMEOUT_MS = 15 * 60_000;
export const STOP_IDLE_TIMEOUT_MS = 2 * 60_000;
const STATUS_IDLE_TIMEOUT_MS = 30_000;
/** `docker compose ps` prints nothing until it exits, exactly like `compose ls`. */
const CONTAINERS_IDLE_TIMEOUT_MS = 30_000;

/** Characters per channel a log follow retains — enough for its own failure line. */
const LOG_ERROR_BUFFER = 4_000;

export class DockerComposeProvider implements EnvironmentProvider {
	readonly id = 'docker-compose' as const;
	readonly label = 'Docker Compose';

	private readonly live = new Set<ComposeOperation>();
	private probed: { ok: boolean; message?: string } | undefined;

	constructor(
		private readonly context: EnvironmentContext,
		private readonly runner: ProcessRunner = runProcess
	) {}

	async availability(): Promise<EnvironmentAvailability> {
		if (!this.context.repositoryRoot()) {
			return {
				ok: false,
				reason: 'not-configured',
				message: 'Open a folder before using environments.'
			};
		}

		// Compose v2 specifically: a machine with only the old `docker-compose`
		// v1 binary has no `docker compose` and must not probe as available.
		this.probed ??= await this.probe();

		return this.probed.ok
			? { ok: true }
			: { ok: false, reason: 'not-installed', message: this.probed.message };
	}

	start(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation(env, onProgress, 'Starting stack', (composeFiles) =>
			composeUpArgs(env.projectName, composeFiles)
		);
	}

	stop(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation(
			env,
			onProgress,
			'Stopping stack',
			(composeFiles) => composeDownArgs(env.projectName, composeFiles),
			STOP_IDLE_TIMEOUT_MS
		);
	}

	destroy(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		return this.operation(
			env,
			onProgress,
			'Removing stack',
			(composeFiles) => composeDestroyArgs(env.projectName, composeFiles),
			STOP_IDLE_TIMEOUT_MS
		);
	}

	/**
	 * On Linux, containers running as root leave root-owned files in
	 * bind-mounted folders — `git worktree remove` and `rm` then fail with
	 * `Permission denied`. Docker made that mess and docker can clean it: one
	 * throwaway container chowns the worktree back to the invoking user.
	 * Deliberately **not** part of `destroy`: a half-deleted worktree may have
	 * lost its compose file, and this must still work then. Best-effort — a
	 * failed pull (offline) or a stack that never wrote as root must not fail
	 * the delete; a root-owned survivor surfaces through `removeWorktree`'s
	 * own message.
	 */
	reclaim(
		env: EnvironmentDescriptor,
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		const operation = new ComposeOperation(
			async (track) => {
				if (process.platform !== 'linux') {
					// Docker Desktop's mount translation already maps ownership.
					return;
				}
				const uid = process.getuid?.();
				const gid = process.getgid?.();
				if (uid === undefined || gid === undefined) {
					return;
				}

				onProgress?.({ kind: 'phase', label: 'Reclaiming file ownership' });
				const child = this.runner({
					executable: DOCKER_EXECUTABLE,
					args: reclaimOwnershipArgs(env.worktreePath, uid, gid),
					idleTimeoutMs: STOP_IDLE_TIMEOUT_MS,
					onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
				});
				track(child);
				try {
					await child.completed;
				} catch {
					// Best-effort; a cancel still lands — the operation re-checks
					// its own `cancelledWith` after this settles.
				}
			},
			() => this.live.delete(operation)
		);
		this.live.add(operation);
		return operation;
	}

	async statuses(
		envs: readonly EnvironmentDescriptor[]
	): Promise<ReadonlyMap<string, StackStatus>> {
		const unknown = new Map<string, StackStatus>(envs.map((env) => [env.id, 'unknown']));
		if (envs.length === 0) {
			return unknown;
		}

		// One engine-wide listing for every environment at once; no cwd, no
		// per-environment variables — it never reads a compose file.
		let listing: string;
		try {
			const result = await this.runner({
				executable: DOCKER_EXECUTABLE,
				args: composeLsArgs(),
				idleTimeoutMs: STATUS_IDLE_TIMEOUT_MS
			}).completed;
			listing = result.stdout;
		} catch {
			// Docker unreachable is a status, not an exception.
			return unknown;
		}

		const byProject = parseComposeLs(
			listing,
			envs.map((env) => env.projectName)
		);

		// `ls` only counts states, so a stack whose one exited container is a
		// finished one-shot job (exit 0) reads `partial` there. Those — and only
		// those, so a healthy poll still costs one call — are asked again
		// container by container; a listing that fails keeps `partial`.
		const refined = await Promise.all(
			envs.map(async (env): Promise<[string, StackStatus]> => {
				const status = byProject.get(env.projectName) ?? 'unknown';
				if (status !== 'partial') {
					return [env.id, status];
				}
				try {
					const result = await this.runner({
						executable: DOCKER_EXECUTABLE,
						args: composePsArgs(env.projectName),
						idleTimeoutMs: STATUS_IDLE_TIMEOUT_MS
					}).completed;
					const containers = parseComposePs(result.stdout);
					return [env.id, containers.length > 0 ? stackStatusFromContainers(containers) : status];
				} catch {
					return [env.id, status];
				}
			})
		);
		return new Map(refined);
	}

	/**
	 * One project's containers, exited ones included. No cwd, no `--file` and
	 * none of the stack's variables — see `composePsArgs`: a compose file that
	 * is missing or will not parse is exactly the state this has to keep
	 * working in.
	 *
	 * Rejects rather than answering an empty list when docker cannot be
	 * reached, which is the opposite of `statuses` and deliberate: the sidebar
	 * has to tell "could not ask" from "nothing there".
	 */
	async containers(env: EnvironmentDescriptor): Promise<EnvironmentContainer[]> {
		try {
			const result = await this.runner({
				executable: DOCKER_EXECUTABLE,
				args: composePsArgs(env.projectName),
				idleTimeoutMs: CONTAINERS_IDLE_TIMEOUT_MS
			}).completed;
			return parseComposePs(result.stdout);
		} catch (error) {
			throw mapProcessError(error);
		}
	}

	/**
	 * `docker logs --follow` on the container id — the engine's log store, not
	 * compose, so an exited container still opens.
	 *
	 * Deliberately spawned with **no** `idleTimeoutMs`: every other command
	 * here is stopped by silence because silence means a hang, and a container
	 * with nothing to say is the one case where it means the opposite.
	 */
	logs(
		env: EnvironmentDescriptor,
		container: EnvironmentContainer,
		options: { tail: number },
		onProgress?: EnvironmentProgressListener
	): EnvironmentOperation {
		const operation = new ComposeOperation(
			async (track) => {
				const child = this.runner({
					executable: DOCKER_EXECUTABLE,
					args: dockerLogsArgs(container.id, options.tail),
					// A follow can run for days: nothing may accumulate here. The
					// panel keeps its own bounded window and the engine keeps the
					// rest — this cap exists only so a failure ("No such
					// container") still has a last stderr line to be summarised
					// from.
					maxBufferedOutput: LOG_ERROR_BUFFER,
					onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
				});
				track(child);
				await child.completed;
			},
			() => this.live.delete(operation)
		);
		this.live.add(operation);
		return operation;
	}

	dispose(): void {
		for (const operation of [...this.live]) {
			operation.cancel('the extension was shut down');
		}
		this.live.clear();
	}

	private operation(
		env: EnvironmentDescriptor,
		onProgress: EnvironmentProgressListener | undefined,
		phase: string,
		argsFor: (composeFiles: string[]) => string[],
		idleTimeoutMs: number = START_IDLE_TIMEOUT_MS
	): EnvironmentOperation {
		// Read at call time, so a settings change reaches the next operation.
		const composeFiles = environmentComposeFiles(this.context.settings());

		const operation = new ComposeOperation(
			async (track) => {
				// Every file in the chain, overrides included — compose's own "file
				// not found" names no path relative to anything the user typed.
				for (const composeFile of composeFiles) {
					try {
						await access(path.join(env.worktreePath, ...composeFile.split('/')));
					} catch (error) {
						// Names the folder rather than "the worktree": for the master
						// environment it is the workspace, and the fix differs (a
						// missing file there is simply missing, not uncommitted).
						throw new EnvironmentError(
							'not-configured',
							`The compose file \`${composeFile}\` does not exist in \`${env.worktreePath}\`. ` +
								'Commit it, or fix the path in BFAST settings.',
							error
						);
					}
				}

				onProgress?.({ kind: 'phase', label: phase });
				const child = this.runner({
					executable: DOCKER_EXECUTABLE,
					args: argsFor(composeFiles),
					cwd: env.worktreePath,
					// Spread, never assign: `process.env` is shared with every
					// extension in the window.
					env: { ...process.env, ...stackEnvironment(env) },
					idleTimeoutMs,
					onOutput: (text, channel) => onProgress?.({ kind: 'output', text, channel })
				});
				track(child);
				await child.completed;
			},
			() => this.live.delete(operation)
		);
		this.live.add(operation);
		return operation;
	}

	private probe(): Promise<{ ok: boolean; message?: string }> {
		const missing =
			'Could not run `docker compose`. Install Docker with the Compose v2 plugin ' +
			'and make sure `docker` is on your PATH.';
		return this.runner({
			executable: DOCKER_EXECUTABLE,
			args: composeVersionArgs(),
			idleTimeoutMs: PROBE_TIMEOUT_MS
		}).completed.then(
			() => ({ ok: true }),
			() => ({ ok: false, message: missing })
		);
	}
}

/**
 * One compose invocation as an `EnvironmentOperation`. The constructor runs
 * the work; `cancel` records its reason first and then kills the child, so
 * the settled error says "cancelled" rather than whatever the kill looked
 * like to docker — and a cancel that lands before the process spawns is
 * honoured the moment `track` sees it.
 */
class ComposeOperation implements EnvironmentOperation {
	readonly completed: Promise<void>;

	private child: RunningProcess | undefined;
	private cancelledWith: EnvironmentCancelledError | undefined;
	private settled = false;

	constructor(
		execute: (track: (child: RunningProcess) => void) => Promise<void>,
		onSettled: () => void
	) {
		this.completed = this.run(execute).finally(() => {
			this.settled = true;
			onSettled();
		});
	}

	cancel(reason = 'The operation was cancelled.'): void {
		if (this.settled) {
			return;
		}
		this.cancelledWith ??= new EnvironmentCancelledError(reason);
		this.child?.cancel(reason);
	}

	private async run(
		execute: (track: (child: RunningProcess) => void) => Promise<void>
	): Promise<void> {
		try {
			await execute((child) => {
				this.child = child;
				if (this.cancelledWith) {
					child.cancel(this.cancelledWith.message);
				}
			});
		} catch (error) {
			if (this.cancelledWith) {
				throw this.cancelledWith;
			}
			throw mapProcessError(error);
		}
		if (this.cancelledWith) {
			throw this.cancelledWith;
		}
	}
}

function mapProcessError(error: unknown): EnvironmentError {
	if (error instanceof EnvironmentError) {
		return error;
	}
	if (error instanceof ProcessError) {
		switch (error.code) {
			case 'not-installed':
				return new EnvironmentError(
					'not-installed',
					'Could not run `docker`. Install Docker and make sure it is on your PATH.',
					error
				);
			case 'timeout':
				return new EnvironmentError(
					'timeout',
					'Docker took too long and was stopped. The output channel shows how far it got.',
					error
				);
			case 'cancelled':
				return new EnvironmentCancelledError(error.message);
			default:
				return new EnvironmentError('provider-error', error.message, error);
		}
	}
	return new EnvironmentError('provider-error', 'The stack operation failed.', error);
}
