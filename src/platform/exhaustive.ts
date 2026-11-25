// Compile-time proof that a `switch` over a union named every member.

/**
 * Put in the `default` of a `switch` over a discriminated union: it compiles
 * only while every member has a `case`, so a message added to a protocol and
 * not to its handler is an error at the handler rather than a silent no-op.
 *
 * Deliberately does nothing at runtime. What reaches a handler came from a
 * webview, which is the untrusted half — an unknown message is ignored, never
 * thrown on.
 */
export function unhandled(_value: never): void {
	// Nothing: see above.
}
