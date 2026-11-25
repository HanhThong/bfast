// Draws a ```mermaid fence as a diagram.
//
// **The only file allowed to import `mermaid`** — the rule `markdown.ts` states
// for `marked`, and for the same reason: it is a devDependency bundled into the
// webview, and the extension host must never grow a runtime dependency on it.
// It lands only in `out/webview/main.js`, since `markdown.tsx` is reached from
// the board and nowhere else.
//
// **The only file that writes `innerHTML`.** `markdown.tsx` states, as an
// invariant, that it never touches `dangerouslySetInnerHTML`, and that invariant
// survives here by confinement rather than by exception: mermaid returns an SVG
// as a string, so *something* has to inject it, and the safety argument is worth
// making in exactly one place.
//
// Two settings carry that argument, and both are deliberate:
//
//   - `securityLevel: 'strict'` runs mermaid's bundled DOMPurify over the output.
//     A description can arrive in a `git pull`, so the diagram source is not
//     trusted input.
//   - `htmlLabels: false` keeps labels as SVG `<text>` rather than `<foreignObject>`
//     holding real HTML. ER and sequence diagrams use `<text>` anyway, so today
//     it changes nothing — which is the point of setting it now, before someone
//     adds a flowchart style and the default quietly starts mattering.
//
// The CSP needs no change for any of this: `style-src` already allows inline
// styles, mermaid in strict mode fetches nothing, and there is no `connect-src`
// (a test asserts there never is).

import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { errorMessage } from '../../platform/errors';

/**
 * A fresh id per render. Mermaid uses it for the ids inside the SVG it builds,
 * so two diagrams sharing one would collide — and a board can easily show two.
 */
let sequence = 0;

/** Which theme mermaid was last configured for, so a re-render is a real change. */
let configuredFor: string | undefined;

interface Rendered {
	svg?: string;
	error?: string;
}

export function MermaidDiagram({ code }: { code: string }) {
	const container = useRef<HTMLDivElement>(null);
	const [rendered, setRendered] = useState<Rendered>({});
	const [theme, setTheme] = useState(() => themeKey());

	// VS Code sends a webview no message when the theme changes; the only signal
	// is the class and `data-vscode-theme-kind` it stamps on `document.body`.
	// Mermaid caches its palette at `initialize`, so without this a diagram keeps
	// yesterday's colours until the tab is rebuilt.
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(themeKey()));
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ['class', 'data-vscode-theme-kind']
		});
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			configure(theme);
			try {
				// Parse first: `render` throws on bad syntax and can leave a stray
				// measuring node behind on `document.body` when it does.
				await mermaid.parse(code);
				const { svg } = await mermaid.render(`bfast-mermaid-${++sequence}`, code);
				if (!cancelled) {
					setRendered({ svg });
				}
			} catch (error) {
				if (!cancelled) {
					setRendered({
						error: errorMessage(error, 'This diagram could not be drawn.')
					});
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [code, theme]);

	useEffect(() => {
		if (container.current) {
			// The one innerHTML in the webview. See the header comment.
			container.current.innerHTML = rendered.svg ?? '';
		}
	}, [rendered.svg]);

	if (rendered.error !== undefined) {
		return (
			<div className="mermaid-error">
				<p className="mermaid-error-message">{rendered.error}</p>
				<pre>
					<code>{code}</code>
				</pre>
			</div>
		);
	}

	return <div className="mermaid-diagram" ref={container} />;
}

/**
 * Mermaid's palette, taken from the editor's own theme variables so a diagram
 * belongs to the page it is on. `theme: 'base'` is the only one that lets every
 * variable be overridden.
 */
function configure(key: string): void {
	if (configuredFor === key) {
		return;
	}
	configuredFor = key;

	const style = getComputedStyle(document.body);
	const read = (name: string, fallback: string) =>
		style.getPropertyValue(name).trim() || fallback;

	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		htmlLabels: false,
		theme: 'base',
		fontFamily: read('--vscode-editor-font-family', 'monospace'),
		themeVariables: {
			background: read('--vscode-editor-background', '#1e1e1e'),
			primaryColor: read('--vscode-editorWidget-background', '#252526'),
			primaryTextColor: read('--vscode-editor-foreground', '#d4d4d4'),
			primaryBorderColor: read('--vscode-panel-border', '#454545'),
			lineColor: read('--vscode-editor-foreground', '#d4d4d4'),
			textColor: read('--vscode-editor-foreground', '#d4d4d4'),
			secondaryColor: read('--vscode-editorWidget-background', '#252526'),
			tertiaryColor: read('--vscode-editor-background', '#1e1e1e')
		}
	});
}

/** Changes exactly when the palette a diagram should use changes. */
function themeKey(): string {
	const style = getComputedStyle(document.body);
	return [
		document.body.dataset.vscodeThemeKind ?? '',
		style.getPropertyValue('--vscode-editor-background').trim(),
		style.getPropertyValue('--vscode-editor-foreground').trim()
	].join('|');
}
