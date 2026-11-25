// Extension host ↔ webview messages.
//
// One file per concern, and one pair of unions per webview document. A webview
// can only send what its own document's `…ToHost` union names, and its panel
// only has to answer those — where one union for every document let the
// settings form post a board's message as far as the compiler could tell, and
// made every panel's handler skip the others' cases by convention.
//
//   board          ticket + ai + tests + design   (`BoardToHost` / `HostToBoard`)
//   settings form  settings
//   generate tab   generate
//   scan tab       scan
//   container log  containerLog
//
// Every module here is bundled into a webview, so each imports types only, and
// only from Node-free modules — even an `import type` from a module that
// imports `node:` fails `typecheck:web`.

import type { AiToHost, HostToAi } from './ai';
import type { ContainerLogToHost, HostToContainerLog } from './containerLog';
import type { DesignToHost, HostToDesign } from './design';
import type { GenerateToHost, HostToGenerate } from './generate';
import type { HostToScan, ScanToHost } from './scan';
import type { HostToSettings, SettingsToHost } from './settings';
import type { HostToTests, TestsToHost } from './tests';
import type { HostToTicket, TicketToHost } from './ticket';

export * from './ai';
export * from './containerLog';
export * from './design';
export * from './generate';
export * from './scan';
export * from './settings';
export * from './tests';
export * from './ticket';

/** Everything a board's webview sends: its ticket, the assistant, the Tests tab, the design tabs. */
export type BoardToHost = TicketToHost | AiToHost | TestsToHost | DesignToHost;

/** Everything a board's webview is sent. */
export type HostToBoard = HostToTicket | HostToAi | HostToTests | HostToDesign;

/** Any message any webview sends. Prefer the document's own union. */
export type WebviewToExtension =
	| BoardToHost
	| SettingsToHost
	| GenerateToHost
	| ScanToHost
	| ContainerLogToHost;

/** Any message the host sends any webview. Prefer the document's own union. */
export type ExtensionToWebview =
	| HostToBoard
	| HostToSettings
	| HostToGenerate
	| HostToScan
	| HostToContainerLog;
