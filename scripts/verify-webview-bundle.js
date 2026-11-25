// Refuses a webview bundle that still contains a dynamic `import()`.
//
// esbuild inlines a dynamic import whose specifier it can resolve, so a library
// that lazily loads its own parts still bundles into one classic script. One it
// cannot resolve is left in the output verbatim — and in a webview whose CSP is
// `default-src 'none'`, that fetch fails **asynchronously** at runtime: the
// panel goes blank and nothing reaches the Problems panel. esbuild reports it
// as neither an error nor a warning, so this has to be its own check.
//
// It is the inverse of `verify:esm`, which greps the built extension host to
// prove a dynamic import *survived* compilation. Here we prove none leaked.
//
// Grep cannot do this job: React ships the literal text `import(` inside an
// error-message string, so a regex would fail an innocent bundle. TypeScript's
// scanner is a real tokenizer — it knows a string from code — and `typescript`
// is already a direct devDependency, so this costs nothing to ship.

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

/** Every webview document, since any of them could pull in an offending import. */
const BUNDLES = ['main.js', 'settings.js', 'generate.js', 'scan.js'];

/**
 * The offsets of every real dynamic `import(` in `source`.
 *
 * `import.meta` is the other thing the import keyword introduces, so the check
 * is specifically "followed by an open parenthesis".
 */
function dynamicImports(source) {
	const scanner = ts.createScanner(ts.ScriptTarget.ESNext, /* skipTrivia */ true, ts.LanguageVariant.Standard, source);
	const found = [];
	let previous;
	let previousStart = 0;

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (previous === ts.SyntaxKind.ImportKeyword && token === ts.SyntaxKind.OpenParenToken) {
			found.push(previousStart);
		}
		previous = token;
		previousStart = scanner.getTokenStart();
	}

	return found;
}

/** `line:column`, so a failure names somewhere a person can actually look. */
function position(source, offset) {
	const upTo = source.slice(0, offset);
	const line = upTo.split('\n').length;
	return `${line}:${offset - upTo.lastIndexOf('\n')}`;
}

let failed = false;
for (const bundle of BUNDLES) {
	const file = path.join(__dirname, '..', 'out', 'webview', bundle);
	if (!fs.existsSync(file)) {
		console.error(`✘ ${bundle} has not been built`);
		failed = true;
		continue;
	}

	const source = fs.readFileSync(file, 'utf8');
	const offsets = dynamicImports(source);
	if (offsets.length === 0) {
		continue;
	}

	failed = true;
	console.error(
		`✘ ${bundle} contains ${offsets.length} dynamic import() that esbuild could not bundle; ` +
			'the webview would go blank at runtime with nothing in the Problems panel'
	);
	for (const offset of offsets.slice(0, 5)) {
		console.error(`    out/webview/${bundle}:${position(source, offset)}`);
	}
}

if (failed) {
	process.exit(1);
}
console.log('no dynamic import() in the webview bundles');
