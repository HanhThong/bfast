// The scan results tab.
//
// One file per webview concern, joined in `index.ts`. See the note there.

// `scanReport.ts` is Node-free precisely so this import is safe: the protocol is
// bundled into every webview, and the seam (`scanProvider.ts`) must never come
// along for the ride. `ScanServerStatus` is the one type taken from the seam,
// and it is a string union — nothing runtime crosses.
import type { ScanServerStatus } from '../../scan/scanProvider';
import type { ScanOutcome, ScanPhase, ScanReport, ScanTargetRef } from '../../scan/scanReport';
import type { ScanMode } from '../../settings/scanSettings';

/** What this part of the webview sends to the extension host. */
export type ScanToHost =
	/**
	 * The scan results tab.
	 *
	 * A tab for the generate tab's reason — a first boot is minutes of log that
	 * prove it has not hung — plus one of its own: a quality gate and thirty
	 * issues are a table, and a table cannot be a toast.
	 */
	| { type: 'scanReady'; target?: ScanTargetRef }
	| { type: 'scanStart' }
	| { type: 'scanCancel' }
	/** Back to the setup screen, to run it again. */
	| { type: 'scanReset' }
	/**
	 * Open the file an issue is on.
	 *
	 * The webview sends the **repo-relative** path the server reported and
	 * nothing else: the host joins it onto the run's own directory and refuses a
	 * result that escapes, so a `component` string that arrived over the network
	 * can never name a file outside the scan.
	 */
	| { type: 'openScanIssue'; file: string; line?: number }
	/**
	 * Open a page on the scan server. Checked against the run's own origin before
	 * it is opened — a report is data from a server, and `safeLinkHref`'s
	 * allow-list posture applies to it too.
	 */
	| { type: 'openScanUrl'; url: string };

/** What the extension host sends back. */
export type HostToScan =
	/** Everything the scan tab's setup screen needs, sent on `scanReady`. */
	| {
			type: 'scanContext';
			target: ScanTargetRef;
			toolLabel: string;
			mode: ScanMode;
			/** The server as the sidebar sees it, so the tab can say "not started yet". */
			serverStatus: ScanServerStatus;
			serverUrl?: string;
			available: boolean;
			/** Why a scan cannot run, when it cannot. */
			unavailable?: string;
	  }
	/** Which of the five screens the tab is on. The host owns it, as `generatePhase` does. */
	| { type: 'scanPhase'; phase: ScanPhase }
	/**
	 * One line for the log — a boot line, a scanner line, or the flow's own. The
	 * whole reason this is a tab: a first boot takes minutes and says nothing on
	 * its own, so without this there is no telling working from hung.
	 */
	| { type: 'scanLog'; line: string }
	| { type: 'scanReport'; report: ScanReport }
	| { type: 'scanDone'; message: string; outcome: ScanOutcome }
	| { type: 'scanError'; message: string; code?: string };
