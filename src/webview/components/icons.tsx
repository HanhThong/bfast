// Toolbar icons, drawn inline rather than pulled from a font.
//
// VS Code's codicon font is not on a webview's classpath — it would mean a new
// dependency, a font file copied into `out/webview` and a `font-src` the CSP
// has to allow. An inline SVG costs none of that, and `currentColor` makes it
// follow the theme the same way a codicon would.
//
// All of them are drawn on a 16×16 grid so they line up in the toolbar.

const SIZE = 16;

function Icon({ children }: { children: React.ReactNode }) {
	return (
		<svg
			className="format-icon"
			width={SIZE}
			height={SIZE}
			viewBox="0 0 16 16"
			// The button beside it carries the accessible name.
			aria-hidden="true"
			focusable="false"
		>
			{children}
		</svg>
	);
}

/** A framed picture: the conventional "insert image". */
export function ImageIcon() {
	return (
		<Icon>
			<rect
				x="1.75"
				y="2.75"
				width="12.5"
				height="10.5"
				rx="1.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.2"
			/>
			<circle cx="5.6" cy="6.4" r="1.15" fill="currentColor" />
			<path
				d="M2.4 12.1 6.1 8.6l2.3 2.1 2.4-2.8 2.8 3.2"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Icon>
	);
}

/** Three dots and three rules: a bulleted list. */
export function BulletListIcon() {
	return (
		<Icon>
			{[3.6, 8, 12.4].map((y) => (
				<g key={y}>
					<circle cx="2.6" cy={y} r="1.15" fill="currentColor" />
					<rect x="5.6" y={y - 0.6} width="8.8" height="1.2" rx="0.6" fill="currentColor" />
				</g>
			))}
		</Icon>
	);
}

/** A sparkle: the conventional "generated with AI". */
export function SparkleIcon() {
	return (
		<Icon>
			<path
				d="M8 1.6 9.35 5.9 13.6 7.3 9.35 8.7 8 13 6.65 8.7 2.4 7.3 6.65 5.9Z"
				fill="currentColor"
			/>
			<path d="M12.9 10.6 13.5 12.4 15.2 13 13.5 13.6 12.9 15.4 12.3 13.6 10.6 13Z" fill="currentColor" />
		</Icon>
	);
}

/** A plus: add one of something. */
export function PlusIcon() {
	return (
		<Icon>
			<path
				d="M8 3.25v9.5M3.25 8h9.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
			/>
		</Icon>
	);
}
