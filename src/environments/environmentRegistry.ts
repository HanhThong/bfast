// Which `EnvironmentProvider` an operation uses.
//
// The same shape as `configuredAiProvider`, for the same reasons: both
// implementations are built once and kept (lazy building would let a settings
// change go stale; per-call building would throw away the docker probe), and
// what comes back is itself an `EnvironmentProvider`, so the store and the
// sidebar stay unaware that there is a choice at all.
//
// `reclaim` is optional on the seam and stays optional here: it is there when
// the selected provider has something to reclaim and absent otherwise, which
// is the question `EnvironmentStore.reclaimWorktree` already asks.

import {
	environmentProviderId,
	type EnvironmentProviderId
} from '../settings/environmentSettings';
import { configuredProvider } from '../platform/providerRegistry';
import { DockerComposeProvider } from './dockerComposeProvider';
import type { EnvironmentContext } from './environmentContext';
import type { EnvironmentProvider } from './environmentProvider';
import { K8sProvider } from './k8sProvider';

/** The provider `environments.provider` names, read at call time. Disposing it disposes both. */
export function configuredEnvironmentProvider(context: EnvironmentContext): EnvironmentProvider {
	return configuredProvider<EnvironmentProviderId, EnvironmentProvider>(
		{
			'docker-compose': new DockerComposeProvider(context),
			k8s: new K8sProvider()
		},
		() => environmentProviderId(context.settings())
	);
}
