// The two rules the board's markdown renderer enforces itself. `marked` decides
// what is a heading and what is a list; these decide what is allowed to become
// a link and which html tag survives — the only two places where a description
// could otherwise do something rather than just say something.
//
// A description is a file in the user's repository. It arrives from a git pull,
// a merge or a colleague's commit, so it is untrusted input even though nothing
// about editing it feels like it.
//
// Pure string work, no DOM, no `marked`: unit-testable from `src/test/`.

/** Schemes a link in a description may use. An allow-list, never a block-list. */
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * The href to render, or `undefined` when the link should stay plain text.
 *
 * Relative links are refused too: there is nowhere for them to resolve to
 * inside a webview, so they can only mislead.
 */
export function safeLinkHref(href: string): string | undefined {
	// Whitespace and control characters go before the scheme is read, because a
	// browser ignores them there: `java\nscript:` and `java script:` both
	// navigate. Filtering by code point avoids spelling out a control range.
	const cleaned = [...href].filter((character) => character.charCodeAt(0) > 0x20).join('');

	const colon = cleaned.indexOf(':');
	if (colon < 0) {
		return undefined;
	}

	// Anything the allow-list does not name — `javascript:`, `data:`, `vscode:`,
	// `command:`, an entity-encoded scheme, a typo — falls through to plain text.
	const scheme = cleaned.slice(0, colon + 1).toLowerCase();
	return ALLOWED_SCHEMES.includes(scheme) ? cleaned : undefined;
}

/**
 * `<u>…</u>` — the one html tag the renderer understands, because markdown has
 * no underline of its own. Non-greedy, so two underlines on a line stay two.
 *
 * Everything else that looks like a tag is rendered as text, which is what makes
 * "the board never uses `innerHTML`" a property of the code rather than a hope.
 */
export const UNDERLINE_PATTERN = /^<u>([\s\S]*?)<\/u>/;
