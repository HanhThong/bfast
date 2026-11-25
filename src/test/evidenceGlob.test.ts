import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findEvidence, normalizeEvidencePattern } from '../testing/evidenceGlob';

/**
 * A scratch tree under the OS temp folder — not the fixture workspace, whose
 * `.gitignore` covers only `.tracker*`, `.vscode` and `.bfast`.
 */
const ROOT = path.join(os.tmpdir(), `bfast-evidence-glob-${process.pid}`);

async function write(relative: string, content = 'x'): Promise<string> {
	const file = path.join(ROOT, relative);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
	return file;
}

const relative = (matches: { path: string }[]): string[] =>
	matches.map((match) => path.relative(ROOT, match.path).split(path.sep).join('/'));

suite('Evidence glob', () => {
	suiteSetup(async () => {
		await fs.rm(ROOT, { recursive: true, force: true });
		await write('e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.webm');
		await write('e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.page-2.webm');
		await write('e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.zip');
		// The id boundary: a run for TC-2.1.1.1 must not claim TC-2.1.1.10's files.
		await write('e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.10.webm');
		await write('e2e/evidence/EP-2/ST-2.1/AC-2.1.2/TC-2.1.2.1.webm');
		await write('e2e/evidence/index.json');
		await write('e2e/evidence/node_modules/TC-2.1.1.1.webm');
		await write('e2e/evidence/.hidden/TC-2.1.1.1.webm');
		await write('outside/TC-2.1.1.1.webm');
	});

	suiteTeardown(async () => {
		await fs.rm(ROOT, { recursive: true, force: true });
	});

	test('** spans folders, * matches within a name, and every other character is literal', async () => {
		const { matches, truncated } = await findEvidence(ROOT, 'e2e/evidence/**/TC-2.1.1.1.*');
		assert.deepStrictEqual(relative(matches), [
			'e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.webm',
			'e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.zip',
			'e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.page-2.webm'
		]);
		assert.strictEqual(truncated, false);
		assert.ok(matches.every((match) => match.size === 1 && match.mtimeMs > 0));
	});

	test('? matches exactly one character', async () => {
		const { matches } = await findEvidence(ROOT, 'e2e/evidence/**/TC-2.1.1.?.webm');
		// Not TC-2.1.1.10 (two characters) and not the .page-2 variant (many).
		assert.deepStrictEqual(relative(matches), ['e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.webm']);
	});

	test('node_modules and dot-folders are skipped unless the pattern names them', async () => {
		const implicit = await findEvidence(ROOT, 'e2e/**/TC-2.1.1.1.webm');
		assert.deepStrictEqual(relative(implicit.matches), [
			'e2e/evidence/EP-2/ST-2.1/AC-2.1.1/TC-2.1.1.1.webm'
		]);
		const explicit = await findEvidence(ROOT, 'e2e/evidence/.hidden/*.webm');
		assert.deepStrictEqual(relative(explicit.matches), ['e2e/evidence/.hidden/TC-2.1.1.1.webm']);
	});

	test('a missing root is no match, not an error', async () => {
		const { matches } = await findEvidence(ROOT, 'nowhere/**/*.webm');
		assert.deepStrictEqual(matches, []);
	});

	test('the file cap stops the walk and says so', async () => {
		const { matches, truncated } = await findEvidence(ROOT, 'e2e/evidence/**/*.webm', {
			maxFiles: 2
		});
		assert.strictEqual(matches.length, 2);
		assert.strictEqual(truncated, true);
	});

	test('a cancelled walk returns what it has', async () => {
		let reads = 0;
		const { matches } = await findEvidence(ROOT, 'e2e/evidence/**/*.webm', {
			isCancelled: () => reads++ > 0
		});
		assert.ok(matches.length < 5);
	});

	(process.platform === 'win32' ? test.skip : test)(
		'a symbolic link is never followed or matched',
		async () => {
			await fs.symlink(path.join(ROOT, 'outside'), path.join(ROOT, 'e2e/evidence/linked'), 'dir');
			await fs.symlink(
				path.join(ROOT, 'outside/TC-2.1.1.1.webm'),
				path.join(ROOT, 'e2e/evidence/EP-2/TC-2.1.1.1.link.webm')
			);
			const { matches } = await findEvidence(ROOT, 'e2e/evidence/**/TC-2.1.1.1*.webm');
			assert.ok(!relative(matches).some((file) => file.includes('linked') || file.includes('.link.')));
		}
	);

	test('a trailing ** means every file below', async () => {
		const { matches } = await findEvidence(ROOT, 'e2e/evidence/EP-2/ST-2.1/AC-2.1.2/**');
		assert.deepStrictEqual(relative(matches), ['e2e/evidence/EP-2/ST-2.1/AC-2.1.2/TC-2.1.2.1.webm']);
	});

	(process.platform === 'win32' ? test.skip : test)(
		'a symbolic link at the literal prefix finds nothing',
		async () => {
			await fs.symlink(path.join(ROOT, 'e2e/evidence'), path.join(ROOT, 'linked-evidence'), 'dir');
			const { matches } = await findEvidence(ROOT, 'linked-evidence/**/*.webm');
			assert.deepStrictEqual(matches, []);
		}
	);

	test('an absolute or escaping pattern is refused before anything is read', () => {
		assert.throws(() => normalizeEvidencePattern('/tmp/**/*.webm'));
		assert.throws(() => normalizeEvidencePattern('C:/tmp/*.webm'));
		assert.throws(() => normalizeEvidencePattern('../sibling/**/*.webm'));
		assert.throws(() => normalizeEvidencePattern('e2e/../../*.webm'));
		assert.throws(() => normalizeEvidencePattern('   '));
		assert.deepStrictEqual(normalizeEvidencePattern('./e2e\\evidence\\**\\{{id}}.*'), [
			'e2e',
			'evidence',
			'**',
			'{{id}}.*'
		]);
	});
});
