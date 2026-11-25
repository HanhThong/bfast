import * as assert from 'assert';
import { evidenceFileName } from '../testing/testResultsPaths';
import { evidenceUrl, isSafeEvidenceSegment } from '../shared/evidencePath';

suite('Evidence path', () => {
	test('a safe segment is one BFAST would have written', () => {
		for (const ok of ['TC-2.1.1.1.webm', '2026-09-05T10-22-33.123Z', 'output.log', 'a_b-c.d']) {
			assert.ok(isSafeEvidenceSegment(ok), ok);
		}
		for (const bad of ['', '..', '.', '.hidden', 'a/b', 'a\\b', 'a b', 'x#y', 'x%y', "it's", 'a$(b)', '../x']) {
			assert.ok(!isSafeEvidenceSegment(bad), JSON.stringify(bad));
		}
	});

	test('whatever evidenceFileName writes, the board may load — one allow-list', () => {
		for (const source of ['TC-1.page-2.webm', "it's$(x).zip", 'my shot (1)#final%.png', '.hidden', '', 'con.zip']) {
			assert.ok(isSafeEvidenceSegment(evidenceFileName(source)), source);
		}
	});

	test("the url resolves under the test case's results folder and encodes each segment", () => {
		const base = 'https://file+.vscode-resource.vscode-cdn.net/repo/.bfast/test-results/TC-1.1.1/';
		assert.strictEqual(
			evidenceUrl(base, '2026-09-05T10-22-33.123Z', 'TC-1.webm'),
			`${base}2026-09-05T10-22-33.123Z/TC-1.webm`
		);
	});

	test('no base, or a segment that could climb or break the url, yields nothing', () => {
		const base = 'https://x/repo/.bfast/test-results/TC-1.1.1/';
		assert.strictEqual(evidenceUrl(undefined, 'run', 'file.webm'), undefined);
		assert.strictEqual(evidenceUrl(base, '..', 'file.webm'), undefined);
		assert.strictEqual(evidenceUrl(base, 'run', '../../.vscode/bfast.json'), undefined);
		assert.strictEqual(evidenceUrl(base, 'run', 'a#b.webm'), undefined);
		assert.strictEqual(evidenceUrl(base, 'run', 'a%2e%2e.webm'), undefined);
		assert.strictEqual(evidenceUrl(base, 'run', 'with space.webm'), undefined);
		assert.strictEqual(evidenceUrl(base, 'run', '.hidden'), undefined);
	});
});
