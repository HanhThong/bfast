import type { ReactNode } from 'react';
import { safeLinkHref } from '../../shared/markdownSafety';
import { parseMarkdown, type Token, type Tokens } from '../markdown';
import { MermaidDiagram } from './mermaidDiagram';

interface MarkdownProps {
	text: string;
	/** The ticket's folder, as a uri this webview may load. */
	assetBase?: string;
}

/**
 * Renders a description.
 *
 * Every branch below builds a React element, and the one at the bottom turns
 * anything unrecognised — `<script>` included — into a text node. There is no
 * `dangerouslySetInnerHTML` anywhere in this file, and that is the point: a
 * description is a file that arrives from a git pull or a colleague's commit,
 * so markup in it must be something the reader sees, never something the board
 * runs.
 */
export function Markdown({ text, assetBase }: MarkdownProps) {
	if (text.trim() === '') {
		return <p className="empty">No description yet.</p>;
	}

	return <Blocks tokens={parseMarkdown(text)} assetBase={assetBase} />;
}

/**
 * The children a token carries, for the tokens that carry any.
 *
 * marked's `Token` union ends in an open `Tokens.Generic` whose `type` is a
 * bare `string`, so switching on `type` never fully narrows — `Generic` stays a
 * candidate in every branch. This reads the field safely instead; the same
 * quirk is why `list` and `table` below need a cast.
 */
function childrenOf(token: Token): Token[] {
	return 'tokens' in token && token.tokens ? token.tokens : [];
}

function Blocks({ tokens, assetBase }: { tokens: Token[]; assetBase?: string }) {
	return (
		<>
			{tokens.map((token, index) => (
				<Block key={index} token={token} assetBase={assetBase} />
			))}
		</>
	);
}

function Block({ token, assetBase }: { token: Token; assetBase?: string }): ReactNode {
	switch (token.type) {
		case 'space':
			return null;

		case 'heading': {
			// `h1` is the ticket title in the header, so a description's own
			// headings start one level down and the page keeps a single outline.
			const Tag = `h${Math.min(token.depth + 1, 6)}` as 'h2';
			return (
				<Tag>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</Tag>
			);
		}

		case 'paragraph':
			return (
				<p>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</p>
			);

		case 'blockquote':
			return (
				<blockquote>
					<Blocks tokens={childrenOf(token)} assetBase={assetBase} />
				</blockquote>
			);

		case 'list':
			return <List token={token as Tokens.List} assetBase={assetBase} />;

		case 'code':
			// `token.lang` is read through `in` rather than off the narrowed token:
			// marked's union ends in an open `Tokens.Generic`, so a `switch` never
			// fully narrows — see `childrenOf` above.
			return 'lang' in token && token.lang === 'mermaid' ? (
				<MermaidDiagram code={token.text} />
			) : (
				<pre>
					<code>{token.text}</code>
				</pre>
			);

		case 'table':
			return <Table token={token as Tokens.Table} assetBase={assetBase} />;

		case 'hr':
			return <hr />;

		case 'html':
			// Block-level html is shown, not run. See the comment on `Markdown`.
			return <p className="markdown-raw">{token.raw}</p>;

		default: {
			// A bare `text` block, and anything a future marked version adds.
			const children = childrenOf(token);
			return <p>{children.length > 0 ? <Inlines tokens={children} assetBase={assetBase} /> : token.raw}</p>;
		}
	}
}

function List({ token, assetBase }: { token: Tokens.List; assetBase?: string }) {
	const body = token.items.map((item, index) => (
		<li key={index} className={item.task ? 'markdown-task' : undefined}>
			{item.task && <input type="checkbox" checked={Boolean(item.checked)} disabled readOnly />}
			<Inlines tokens={item.tokens} assetBase={assetBase} />
		</li>
	));

	// `start` is '' for a bullet list and a number for `3.`-style lists.
	return token.ordered ? (
		<ol start={token.start === '' ? undefined : token.start}>{body}</ol>
	) : (
		<ul>{body}</ul>
	);
}

function Table({ token, assetBase }: { token: Tokens.Table; assetBase?: string }) {
	return (
		// Wide content scrolls inside itself rather than stretching the pane.
		<div className="markdown-table">
			<table>
				<thead>
					<tr>
						{token.header.map((cell, index) => (
							<th key={index} style={cell.align ? { textAlign: cell.align } : undefined}>
								<Inlines tokens={cell.tokens} assetBase={assetBase} />
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{token.rows.map((row, rowIndex) => (
						<tr key={rowIndex}>
							{row.map((cell, index) => (
								<td key={index} style={cell.align ? { textAlign: cell.align } : undefined}>
									<Inlines tokens={cell.tokens} assetBase={assetBase} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Inlines({ tokens, assetBase }: { tokens: Token[]; assetBase?: string }) {
	return (
		<>
			{tokens.map((token, index) => (
				<Inline key={index} token={token} assetBase={assetBase} />
			))}
		</>
	);
}

function Inline({ token, assetBase }: { token: Token; assetBase?: string }): ReactNode {
	switch (token.type) {
		case 'text':
			// A list item's text is lexed one level further down; a paragraph's is not.
			return token.tokens ? (
				<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
			) : (
				<>{token.text}</>
			);

		case 'escape':
			return <>{token.text}</>;

		case 'strong':
			return (
				<strong>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</strong>
			);

		case 'em':
			return (
				<em>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</em>
			);

		case 'del':
			return (
				<del>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</del>
			);

		case 'codespan':
			return <code>{token.text}</code>;

		case 'br':
			return <br />;

		case 'image': {
			const src = assetUrl(assetBase, token.href);
			// A remote or unresolvable image is named rather than fetched: loading
			// one would tell whoever hosts it that this ticket was opened.
			return src ? (
				<img src={src} alt={token.text} title={token.title ?? undefined} />
			) : (
				<span className="markdown-missing-image">{token.text || token.href}</span>
			);
		}

		case 'link': {
			const href = safeLinkHref(token.href);
			const children = <Inlines tokens={childrenOf(token)} assetBase={assetBase} />;
			return href ? (
				<a href={href} title={token.title ?? undefined}>
					{children}
				</a>
			) : (
				children
			);
		}

		// Markdown has no underline, so `<u>` is lexed by our own tokenizer and
		// arrives as a token type marked's own union does not know about.
		case 'underline':
			return (
				<u>
					<Inlines tokens={childrenOf(token)} assetBase={assetBase} />
				</u>
			);

		default:
			// `html` lands here, and so does anything else unrecognised: shown as
			// the characters it is made of, never as markup.
			return <>{token.raw}</>;
	}
}

/**
 * Turns an `assets/x.png` from the description into something the webview can
 * actually load. Anything carrying a scheme of its own is refused: the panel's
 * CSP only allows this webview's own origin, and widening it would let a
 * description phone home the moment someone opened the ticket.
 */
function assetUrl(base: string | undefined, href: string): string | undefined {
	if (!base || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
		return undefined;
	}

	try {
		return new URL(href, base).toString();
	} catch {
		return undefined;
	}
}
