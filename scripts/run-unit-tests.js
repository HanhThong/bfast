// `npm run test:unit` — the tests that need no VS Code, run by Mocha in plain
// Node.
//
// `npm test` launches a real VS Code for every suite, which is right for the
// ones that touch the API and slow for the ones that do not. Which is which is
// not a naming convention a person has to keep: a compiled test is a unit test
// exactly when nothing it requires — transitively, through `out/` — requires
// `vscode`. So a pure module that grows a `vscode` import drops its tests out of
// this run, and `--list` says which files are on which side.
//
// It reads `out/`, so compile first (`npm run compile:tsc`).

const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'out');
const testDir = path.join(outDir, 'test');

const REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(from, specifier) {
	const base = path.resolve(path.dirname(from), specifier);
	for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return undefined;
}

/** file → the local files it requires, and whether it requires `vscode` itself. */
const modules = new Map();

function read(file) {
	let entry = modules.get(file);
	if (entry === undefined) {
		entry = { vscode: false, requires: [] };
		modules.set(file, entry);
		for (const match of fs.readFileSync(file, 'utf8').matchAll(REQUIRE)) {
			const specifier = match[1];
			if (specifier === 'vscode') {
				entry.vscode = true;
			} else if (specifier.startsWith('.')) {
				const target = resolveLocal(file, specifier);
				if (target) {
					entry.requires.push(target);
				}
			}
		}
	}
	return entry;
}

/**
 * Whether anything `file` requires, at any depth, requires `vscode`.
 *
 * A fresh walk per file, with nothing remembered between walks but what each
 * module requires: caching "does not reach" while a require cycle is still
 * being walked would record it for a module whose way to `vscode` runs back
 * through the cycle's entry.
 */
function reachesVscode(file) {
	const seen = new Set([file]);
	const queue = [file];
	while (queue.length > 0) {
		const entry = read(queue.pop());
		if (entry.vscode) {
			return true;
		}
		for (const target of entry.requires) {
			if (!seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return false;
}

if (!fs.existsSync(testDir)) {
	console.error('out/test does not exist — run `npm run compile:tsc` first.');
	process.exit(1);
}

const all = fs
	.readdirSync(testDir)
	.filter((name) => name.endsWith('.test.js'))
	.map((name) => path.join(testDir, name))
	.sort();
const unit = all.filter((file) => !reachesVscode(file));
const host = all.filter((file) => !unit.includes(file));

if (process.argv.includes('--list')) {
	console.log(`unit (${unit.length}):`);
	unit.forEach((file) => console.log(`  ${path.basename(file)}`));
	console.log(`needs VS Code (${host.length}):`);
	host.forEach((file) => console.log(`  ${path.basename(file)}`));
	process.exit(0);
}

// mocha is not a direct dependency: it arrives with @vscode/test-cli, which is
// what runs the full suite. npm hoists it to node_modules/mocha, pnpm does not,
// so it is resolved from where test-cli itself finds it — the same copy either way.
const Mocha = require(require.resolve('mocha', { paths: [require.resolve('@vscode/test-cli')] }));
const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10_000 });
unit.forEach((file) => mocha.addFile(file));
console.log(`${unit.length} of ${all.length} test files need no VS Code.`);
mocha.run((failures) => {
	process.exitCode = failures > 0 ? 1 : 0;
});
