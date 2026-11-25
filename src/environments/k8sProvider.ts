// The Kubernetes provider — registered, selectable, not implemented.
//
// This stub is the extension point a real implementation replaces, and the
// template for "registered but not implemented": availability says why, the
// operations reject with `'not-implemented'`, statuses answer `'unknown'`,
// and nothing else in the feature knows the difference.
//
// What the real one will do with the same generic inputs (the contract is
// docs/environments/kubernetes.md): `descriptor.projectName` becomes the
// namespace, `descriptor.ports` become manifest substitutions
// (helm values / kustomize / envsubst — undecided), `worktreePath` is the
// build context, and `statuses` is one API query over Deployment readiness —
// where desired replicas `0` reads as stopped, not vacuously ready.

import {
	EnvironmentError,
	type EnvironmentAvailability,
	type EnvironmentContainer,
	type EnvironmentDescriptor,
	type EnvironmentOperation,
	type EnvironmentProvider,
	type StackStatus
} from './environmentProvider';

const MESSAGE = 'Kubernetes environments are not implemented yet.';

export class K8sProvider implements EnvironmentProvider {
	readonly id = 'k8s' as const;
	readonly label = 'Kubernetes';

	availability(): Promise<EnvironmentAvailability> {
		return Promise.resolve({ ok: false, reason: 'not-implemented', message: MESSAGE });
	}

	start(): EnvironmentOperation {
		return notImplemented();
	}

	stop(): EnvironmentOperation {
		return notImplemented();
	}

	destroy(): EnvironmentOperation {
		return notImplemented();
	}

	statuses(envs: readonly EnvironmentDescriptor[]): Promise<ReadonlyMap<string, StackStatus>> {
		return Promise.resolve(new Map(envs.map((env) => [env.id, 'unknown' as StackStatus])));
	}

	/**
	 * Rejects rather than answering `[]` — which is the whole reason
	 * `containers` may reject at all: the sidebar renders this reason as a row
	 * saying so, where an empty list would read as a stack with nothing in it.
	 */
	containers(): Promise<EnvironmentContainer[]> {
		return Promise.reject(new EnvironmentError('not-implemented', MESSAGE));
	}

	logs(): EnvironmentOperation {
		return notImplemented();
	}

	dispose(): void {
		// Nothing lives here to cancel.
	}
}

function notImplemented(): EnvironmentOperation {
	const completed = Promise.reject(new EnvironmentError('not-implemented', MESSAGE));
	// Nobody may await this handle; an unobserved rejection must not be noise.
	completed.catch(() => undefined);
	return { completed, cancel: () => undefined };
}
