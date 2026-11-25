// What to say about something that was thrown.
//
// Node-free and `vscode`-free, so the host and every webview share it.

/**
 * The message of a thrown value: an `Error`'s own, else `fallback`, else the
 * value as a string — a rejection is not always an `Error`, and "undefined" in
 * a notification helps nobody, which is what the fallback is for.
 */
export function errorMessage(failure: unknown, fallback?: string): string {
	if (failure instanceof Error) {
		return failure.message;
	}
	return fallback ?? String(failure);
}
