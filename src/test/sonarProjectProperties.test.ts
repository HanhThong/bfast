// `sonar-project.properties` — the file a checkout uses to name its own
// project. The parser is Java's grammar, and what matters is the shape a real
// file takes: SonarSource's examples split `sonar.exclusions` over ten
// backslash-continued lines, and ice-hrm's file does the same.

import * as assert from 'assert';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	parseProperties,
	projectIdentityOf,
	readSonarProjectProperties,
	SONAR_PROJECT_FILE
} from '../scan/sonarqube/sonarProjectProperties';

const SCRATCH = path.join(os.tmpdir(), `bfast-test-sonarprops-${process.pid}`);

suite('sonar-project.properties', () => {
	suiteSetup(() => mkdir(SCRATCH, { recursive: true }));
	suiteTeardown(() => rm(SCRATCH, { recursive: true, force: true }));

	test('reads a real file: comments, continuations and a multi-line exclusion list', () => {
		const text = [
			'# SonarQube / SonarCloud project definition for ICE HRM.',
			'!  another comment style',
			'',
			'sonar.projectKey=ice-hrm',
			'sonar.projectName=ICE HRM',
			'sonar.sourceEncoding=UTF-8',
			'sonar.sources=services/api/src,services/ui/src',
			'sonar.exclusions=\\',
			'  **/node_modules/**,\\',
			'  **/dist/**,\\',
			'  **/*.d.ts',
			'sonar.javascript.lcov.reportPaths=e2e/coverage/lcov.info'
		].join('\n');

		assert.deepStrictEqual(parseProperties(text), {
			'sonar.projectKey': 'ice-hrm',
			'sonar.projectName': 'ICE HRM',
			'sonar.sourceEncoding': 'UTF-8',
			'sonar.sources': 'services/api/src,services/ui/src',
			// The continuation lines' leading whitespace is stripped, so the list
			// reads exactly as the scanner reads it.
			'sonar.exclusions': '**/node_modules/**,**/dist/**,**/*.d.ts',
			'sonar.javascript.lcov.reportPaths': 'e2e/coverage/lcov.info'
		});
	});

	test('the three Java separators read the same, and whitespace around them goes', () => {
		assert.deepStrictEqual(parseProperties('a=1\nb : 2\nc 3\n d\t=\t4 '), {
			a: '1',
			b: '2',
			c: '3',
			// A value keeps its trailing space — Java does too — and callers trim.
			d: '4 '
		});
	});

	test('a key with no value is an empty string, and later keys win', () => {
		assert.deepStrictEqual(parseProperties('sonar.projectKey\nsonar.projectKey=second'), {
			'sonar.projectKey': 'second'
		});
		assert.deepStrictEqual(parseProperties('empty='), { empty: '' });
	});

	test('escapes resolve, and an even run of backslashes is not a continuation', () => {
		assert.deepStrictEqual(parseProperties('path=C\\:\\\\dir\\\\\nnext=1'), {
			// `\:` is a literal colon and `\\` a literal backslash; the line ends on
			// an even run, so `next` is its own property.
			path: 'C:\\dir\\',
			next: '1'
		});
		assert.deepStrictEqual(parseProperties('key\\=with=value\\tab'), { 'key=with': 'value\tab' });
		assert.deepStrictEqual(parseProperties('u=\\u0041\\u00e9'), { u: 'Aé' });
		assert.deepStrictEqual(parseProperties('bad=\\uZZZZ'), { bad: 'uZZZZ' });
	});

	test('CRLF and a trailing continuation with nothing after it are harmless', () => {
		assert.deepStrictEqual(parseProperties('a=1\r\nb=2\\'), { a: '1', b: '2' });
		assert.deepStrictEqual(parseProperties(''), {});
	});

	test('the identity is the two project keys, trimmed, and absent when neither is set', () => {
		assert.deepStrictEqual(
			projectIdentityOf({ 'sonar.projectKey': ' ice-hrm ', 'sonar.projectName': 'ICE HRM' }),
			{ projectKey: 'ice-hrm', projectName: 'ICE HRM' }
		);
		assert.deepStrictEqual(projectIdentityOf({ 'sonar.projectName': 'Only a name' }), {
			projectName: 'Only a name'
		});
		// `sonar.projectKey=` must not become a project with no key.
		assert.strictEqual(projectIdentityOf({ 'sonar.projectKey': '' }), undefined);
		assert.strictEqual(projectIdentityOf({ 'sonar.sources': 'src' }), undefined);
	});

	test('reads the file at the directory root, and a missing one is undefined', async () => {
		const directory = path.join(SCRATCH, 'repo');
		await mkdir(directory, { recursive: true });
		assert.strictEqual(await readSonarProjectProperties(directory), undefined);

		await writeFile(
			path.join(directory, SONAR_PROJECT_FILE),
			'sonar.projectKey=ice-hrm\nsonar.sources=src\n',
			'utf8'
		);
		assert.deepStrictEqual(await readSonarProjectProperties(directory), {
			'sonar.projectKey': 'ice-hrm',
			'sonar.sources': 'src'
		});
		// A nested copy is not the checkout's; only the root one counts.
		assert.strictEqual(await readSonarProjectProperties(SCRATCH), undefined);
	});
});
