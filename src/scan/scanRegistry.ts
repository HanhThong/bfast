// Which `ScanProvider` an operation uses.
//
// The same shape as `configuredEnvironmentProvider` and `configuredAiProvider`,
// for the same reasons: every implementation is built once and kept (lazy
// building would let a settings change go stale; per-call building would throw
// away the docker probe), and what comes back is itself a `ScanProvider`, so
// the store, the runner and the sidebar stay unaware that there is a choice at
// all.
//
// One tool today. The registry still earns its place: `scan.tool` is already a
// settings value, and the alternative — the store importing `SonarQubeProvider`
// directly — is exactly the coupling the seam exists to prevent.
//
// The seam's optional members (`server`, `readProjectIdentity`) reach through
// untouched: present when the selected tool has them, absent when it does not.
// That is what makes the sidebar draw no lifecycle rows for a tool with no
// server without anyone writing a branch — and a hand-written forwarder that
// forgot one silently read as a tool without it, which is exactly how the
// properties file went unread once.

import { scanToolId, type ScanToolId } from '../settings/scanSettings';
import { configuredProvider } from '../platform/providerRegistry';
import type { ScanContext } from './scanContext';
import type { ScanProvider } from './scanProvider';
import { SonarQubeProvider, type SonarQubeProviderDeps } from './sonarqube/sonarQubeProvider';

export type ConfiguredScanProviderDeps = Omit<SonarQubeProviderDeps, 'context'> & {
	context: ScanContext;
};

/** The tool `scan.tool` names, read at call time. Disposing it disposes every tool. */
export function configuredScanProvider(deps: ConfiguredScanProviderDeps): ScanProvider {
	return configuredProvider<ScanToolId, ScanProvider>(
		{ sonarqube: new SonarQubeProvider(deps) },
		() => scanToolId(deps.context.settings())
	);
}
