import * as assert from 'assert';
import {
	parseTestRun,
	runIdFor,
	serializeTestRun,
	startedAtFromRunId,
	type RunFolderEntry
} from '../testing/testRunFile';

const file = (name: string, size?: number): RunFolderEntry => ({
	name,
	kind: 'file',
	...(size !== undefined ? { size } : {})
});

suite('Test run file', () => {
	test('the run id is the start time with the characters Windows refuses replaced', () => {
		assert.strictEqual(runIdFor('2026-09-05T10:22:33.123Z'), '2026-09-05T10-22-33.123Z');
		assert.strictEqual(startedAtFromRunId('2026-09-05T10-22-33.123Z'), '2026-09-05T10:22:33.123Z');
		assert.strictEqual(startedAtFromRunId('2026-09-05T10-22-33.123Z-2'), undefined);
		assert.strictEqual(startedAtFromRunId('by-hand'), undefined);
	});

	test('round-trips through serialize and parse', () => {
		const text = serializeTestRun({
			startedAt: '2026-09-05T10:22:33.123Z',
			finishedAt: '2026-09-05T10:22:45.600Z',
			outcome: 'failed',
			exitCode: 1,
			author: 'Hanh Thong',
			command: 'make e2e',
			evidencePattern: 'e2e/evidence/**/TC-1.*',
			files: [{ name: 'TC-1.webm', size: 10 }],
			outputTruncated: true,
			warnings: ['1 older file ignored: written before this run started.']
		});
		assert.ok(text.endsWith('\n'));
		const record = parseTestRun(text, '2026-09-05T10-22-33.123Z', [
			file('TC-1.webm', 10),
			file('output.log', 5),
			file('run.json', 300)
		]);
		assert.deepStrictEqual(record, {
			id: '2026-09-05T10-22-33.123Z',
			startedAt: '2026-09-05T10:22:33.123Z',
			finishedAt: '2026-09-05T10:22:45.600Z',
			outcome: 'failed',
			exitCode: 1,
			command: 'make e2e',
			author: 'Hanh Thong',
			evidencePattern: 'e2e/evidence/**/TC-1.*',
			files: [{ name: 'TC-1.webm', size: 10 }],
			hasOutput: true,
			outputTruncated: true,
			warnings: ['1 older file ignored: written before this run started.']
		});
	});

	test('a missing or junk run.json still lists the folder, as unknown, with what is on disk', () => {
		for (const text of [undefined, '', '{not json', '[]', '{"outcome":"green"}']) {
			const record = parseTestRun(text, '2026-09-05T10-22-33.123Z', [
				file('TC-1.webm', 7),
				{ name: 'run.json', kind: 'file' }
			]);
			assert.strictEqual(record.outcome, 'unknown', String(text));
			assert.strictEqual(record.startedAt, '2026-09-05T10:22:33.123Z');
			assert.deepStrictEqual(record.files, [{ name: 'TC-1.webm', size: 7 }]);
			assert.strictEqual(record.hasOutput, false);
		}
	});

	test('the listing is authoritative: a name run.json lists but disk lacks is only ever missing', () => {
		const text = serializeTestRun({
			startedAt: '2026-09-05T10:22:33.123Z',
			finishedAt: '2026-09-05T10:22:45.600Z',
			outcome: 'passed',
			command: 'x',
			files: [
				{ name: 'TC-1.zip', size: 4711002 },
				{ name: '../../.vscode/bfast.json', size: 1 },
				{ name: 'TC-1.webm', size: 10 }
			]
		});
		const record = parseTestRun(text, 'run', [file('TC-1.webm', 10), file('extra.png', 3)]);
		assert.deepStrictEqual(record.files, [
			{ name: 'extra.png', size: 3 },
			{ name: 'TC-1.webm', size: 10 },
			{ name: 'TC-1.zip', size: 4711002, missing: true }
		]);
	});

	test('symlinks, folders and the two fixed files are never evidence', () => {
		const record = parseTestRun(undefined, 'run', [
			{ name: 'link.webm', kind: 'symlink' },
			{ name: 'sub', kind: 'directory' },
			file('output.log'),
			file('run.json'),
			file('real.webm', 1)
		]);
		assert.deepStrictEqual(record.files, [{ name: 'real.webm', size: 1 }]);
		assert.strictEqual(record.hasOutput, true);
	});
});
