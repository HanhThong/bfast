// What Run Tests asks of the master environment: its stack variables for every
// test command, and some of its compose services up before a service's e2e
// test cases run. docs/tests/services.md §Bringing compose services up.
//
// `vscode`-free, everything injected — the environment store's `find`, the
// environments settings read at call time, and the process runner — so
// `masterStack.test.ts` drives it against fakes.
//
// Only the master: the tests run in the workspace folder, and the master
// environment is the stack that lives there. A ticket's environment has its
// own worktree, which the test commands never see.

import type { EnvironmentsSettings } from '../settings/environmentSettings';
import { environmentComposeFiles, environmentProviderId } from '../settings/environmentSettings';
import type { ProcessRunner } from '../platform/runProcess';
import { composeUpServicesArgs } from './composeCommand';
import {
	MASTER_ENVIRONMENT_ID,
	stackEnvironment,
	type EnvironmentHandle
} from './environmentProvider';

export interface MasterStackDeps {
	find: (id: string) => Promise<EnvironmentHandle | undefined>;
	settings: () => EnvironmentsSettings | undefined;
	runner: ProcessRunner;
	/** The silence a bring-up may keep before it is stopped — the tests' own window. */
	idleTimeoutMs: () => number;
}

/** The sentence a service's test cases carry when there is no master to bring anything up in. */
export const NO_MASTER_MESSAGE =
	'There is no Master environment. Create one in the Environments section (Create Master Environment), then run again.';

export function masterStack(deps: MasterStackDeps) {
	return {
		/** The master's port variables and project name, or `undefined` when there is no master. */
		async stackEnvironment(): Promise<Record<string, string> | undefined> {
			const master = await deps.find(MASTER_ENVIRONMENT_ID);
			return master ? stackEnvironment(master) : undefined;
		},

		/**
		 * `docker compose -p <master> … up -d --wait <services>` in the workspace
		 * folder, with the master's variables. Rejects with a sentence: no master,
		 * a provider that is not compose, or what docker said.
		 */
		async composeUp(
			services: readonly string[],
			run: { onOutput: (text: string) => void; onCancel: (cancel: () => void) => void }
		): Promise<void> {
			const settings = deps.settings();
			if (environmentProviderId(settings) !== 'docker-compose') {
				throw new Error('Compose services can only be brought up with the docker-compose environment provider.');
			}
			const master = await deps.find(MASTER_ENVIRONMENT_ID);
			if (master === undefined) {
				throw new Error(NO_MASTER_MESSAGE);
			}
			const child = deps.runner({
				executable: 'docker',
				args: composeUpServicesArgs(master.projectName, environmentComposeFiles(settings), services),
				cwd: master.worktreePath,
				env: { ...process.env, ...stackEnvironment(master) },
				idleTimeoutMs: deps.idleTimeoutMs(),
				onOutput: (text) => run.onOutput(text)
			});
			run.onCancel(() => child.cancel('The test run was cancelled.'));
			await child.completed;
		}
	};
}
