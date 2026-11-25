// The only place `marked` is imported.
//
// It lives under `src/webview` rather than `src/shared` on purpose: the root
// tsconfig compiles with `module: Node16` and no DOM lib, and marked is
// ESM-first, so keeping it on esbuild's side of the split sidesteps the whole
// interop question. Nothing in `out/` ever requires it, and it stays a
// devDependency — the packaged extension still ships no runtime dependencies.

import { marked, type Token, type Tokens } from 'marked';
import { UNDERLINE_PATTERN } from '../shared/markdownSafety';

marked.use({
	// A description used to render with `white-space: pre-wrap`, so every newline
	// the user typed was a newline they saw. Requiring two trailing spaces for a
	// line break now would silently reflow every ticket already written.
	breaks: true,
	gfm: true,
	extensions: [
		{
			// marked emits `<u>` and `</u>` as two separate `html` tokens with the
			// content loose between them, and pairing those up by hand is the kind
			// of code that gets an edge case wrong. A tokenizer yields one token
			// with its children already lexed, and makes `<u>` the only html tag
			// the renderer ever has to know about.
			name: 'underline',
			level: 'inline',
			start: (src: string) => src.indexOf('<u>'),
			tokenizer(src: string) {
				const match = UNDERLINE_PATTERN.exec(src);
				return match
					? { type: 'underline', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) }
					: undefined;
			}
		}
	]
});

/**
 * The description as a token tree. Nothing here produces html — the renderer
 * turns these into React elements, so a description can never introduce markup
 * of its own.
 */
export function parseMarkdown(text: string): Token[] {
	return marked.lexer(text);
}

export type { Token, Tokens };
