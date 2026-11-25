import * as assert from 'assert';
import {
	evidenceFileName,
	isEvidenceFileName,
	testCaseResultsFolder
} from '../testing/testResultsPaths';

suite('Test results paths', () => {
	test("a test case's folder is its id, with a rank's # made safe", () => {
		assert.strictEqual(testCaseResultsFolder('TC-1.2.1.1'), 'TC-1.2.1.1');
		assert.strictEqual(testCaseResultsFolder('TC-1#2.1.1'), 'TC-1_2.1.1');
		assert.strictEqual(testCaseResultsFolder('TC-1.1#3'), 'TC-1.1_3');
		for (const id of ['TC-1.2.1.1', 'TC-1#2.1.1', 'TC-1.1#3']) {
			assert.ok(isEvidenceFileName(testCaseResultsFolder(id)), id);
		}
	});

	test('an evidence file name keeps its dots and matches what the board may load', () => {
		assert.strictEqual(evidenceFileName('TC-2.1.1.1.page-2.webm'), 'TC-2.1.1.1.page-2.webm');
		assert.strictEqual(evidenceFileName('/tmp/e2e/evidence/EP-2/TC-1.zip'), 'TC-1.zip');
		assert.strictEqual(evidenceFileName('my shot (1)#final%.png'), 'my_shot_1_final_.png');
		assert.strictEqual(evidenceFileName("it's$(x).zip"), 'it_s_x_.zip');
		assert.strictEqual(evidenceFileName('.hidden'), 'hidden');
		assert.strictEqual(evidenceFileName('report'), 'report');
		assert.strictEqual(evidenceFileName('con.zip'), 'con_.zip');
		assert.strictEqual(evidenceFileName(''), 'file');
		assert.strictEqual(evidenceFileName('///'), 'file');
		const long = evidenceFileName(`${'a'.repeat(200)}.webm`);
		assert.ok(long.endsWith('.webm') && long.length <= 80, long);
		for (const name of ['TC-1.webm', 'x', 'a-b_c.d']) {
			assert.ok(isEvidenceFileName(evidenceFileName(name)), name);
		}
		assert.ok(!isEvidenceFileName('a b'));
		assert.ok(!isEvidenceFileName('.x'));
	});
});
