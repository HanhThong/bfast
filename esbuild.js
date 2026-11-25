const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/**
 * Reports esbuild failures in the shape the `watch:web` problem matcher in
 * .vscode/tasks.json expects, so errors land in the Problems panel.
 * @type {import('esbuild').Plugin}
 */
const watchPlugin = {
	name: 'watch-plugin',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	}
};

/** @type {import('esbuild').BuildOptions} */
const options = {
	// One entry point per webview document: the board, the settings form, the
	// generate tab, the scan results tab and a container's log. Each produces
	// <name>.js plus the <name>.css its imports pull in.
	entryPoints: [
		'src/webview/main.tsx',
		'src/webview/settings.tsx',
		'src/webview/generate.tsx',
		'src/webview/scan.tsx',
		'src/webview/containerLog.tsx'
	],
	outdir: 'out/webview',
	bundle: true,
	// IIFE keeps the webview to a single classic <script>, which is simpler to
	// allow through the panel's content security policy than an ES module.
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	jsx: 'automatic',
	loader: { '.css': 'css' },
	sourcemap: !production,
	minify: production,
	logLevel: 'warning',
	plugins: [watchPlugin]
};

async function main() {
	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
	} else {
		await esbuild.build(options);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
