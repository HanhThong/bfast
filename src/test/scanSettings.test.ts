// The `scan` block — see docs/scan/configuration.md for the contract.
//
// Shaped like `testsSettings.test.ts`: junk-in tables, trim/normalize
// round-trips, out-of-range drops, accept/reject tables, and the two
// `normalizeSettings` regressions that keep the fresh-literal trap closed.

import * as assert from 'assert';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';
import {
	defaultProjectKey,
	isReservedProperty,
	MAX_SCAN_IDLE_SECONDS,
	MIN_SCAN_IDLE_SECONDS,
	MIN_SCAN_PORT,
	normalizeScanSettings,
	parseScanSettings,
	SCAN_PLACEHOLDERS,
	scanAutoProvision,
	scanCommand,
	scanComposeOverrides,
	scanCwd,
	scanIdleTimeoutMs,
	scanMode,
	scannerImage,
	scannerMode,
	scanPortRange,
	scanProperties,
	scanToolId,
	substituteCommand,
	unknownScanPlaceholders,
	validateHostUrl,
	validateProjectKey,
	validateScanSettings,
	type ScanSettings
} from '../settings/scanSettings';

suite('BFAST scan settings', () => {
	test('returns undefined when nothing usable survives', () => {
		for (const raw of [
			undefined,
			null,
			'nonsense',
			42,
			[],
			{},
			{ tool: 'coverity' },
			{ mode: 'kubernetes' },
			{ scannerMode: 'bare' },
			{ hostUrl: 'not a url' },
			{ hostUrl: 'ftp://sonar.example.com' },
			{ hostUrl: 'https://admin:hunter2@sonar.example.com' },
			{ hostUrl: 'https://sonar.example.com/?id=x' },
			{ projectKey: '  ' },
			{ projectKey: '123' },
			{ projectKey: 'a b' },
			{ organization: 'A' },
			{ organization: '-acme' },
			{ portRangeStart: 80 },
			{ portRangeEnd: 65536 },
			{ command: '   ' },
			{ cwd: '/abs' },
			{ cwd: '../outside' },
			{ composeFile: '../outside.yml' },
			{ scannerImage: 'my image' },
			{ scannerImage: 'img;rm -rf /' },
			{ scannerNetwork: 'has space' },
			{ properties: [{ key: 'sonar.token', value: 'squ_x' }] },
			{ properties: 'sonar.sources=src' },
			{ properties: [{ key: 'ok', value: 'a\nb' }] },
			// `true` is the default and must never be what creates a block.
			{ autoProvision: true },
			{ autoProvision: 'yes' },
			{ idleTimeout: 5 },
			{ idleTimeout: 99999 }
		]) {
			assert.strictEqual(
				parseScanSettings(raw),
				undefined,
				`${JSON.stringify(raw)} should be dropped`
			);
		}
	});

	test('trims and normalizes what it keeps', () => {
		assert.deepStrictEqual(parseScanSettings({ hostUrl: '  HTTPS://Sonar.Example.com/  ' }), {
			hostUrl: 'https://sonar.example.com'
		});
		// A port and a reverse-proxy path prefix survive; a trailing slash does not.
		assert.deepStrictEqual(parseScanSettings({ hostUrl: 'https://x.com:9443/sonar/' }), {
			hostUrl: 'https://x.com:9443/sonar'
		});
		assert.deepStrictEqual(parseScanSettings({ organization: ' ACME ' }), {
			organization: 'acme'
		});
		assert.deepStrictEqual(parseScanSettings({ projectKey: ' my-app ' }), {
			projectKey: 'my-app'
		});
		assert.deepStrictEqual(parseScanSettings({ cwd: '.\\apps\\web\\' }), { cwd: 'apps/web' });
		assert.deepStrictEqual(
			parseScanSettings({ composeOverrides: ['a.yml', '', '../x.yml', 42] }),
			{ composeOverrides: ['a.yml'] }
		);
		assert.deepStrictEqual(
			parseScanSettings({ properties: [{ key: ' sonar.sources ', value: ' src ' }] }),
			{ properties: [{ key: 'sonar.sources', value: 'src' }] }
		);
		// Duplicate keys keep the first, case-insensitively.
		assert.deepStrictEqual(
			parseScanSettings({
				properties: [
					{ key: 'sonar.sources', value: 'a' },
					{ key: 'SONAR.SOURCES', value: 'b' }
				]
			}),
			{ properties: [{ key: 'sonar.sources', value: 'a' }] }
		);
		assert.deepStrictEqual(parseScanSettings({ autoProvision: false }), {
			autoProvision: false
		});
	});

	test('round-trips a fully populated block through JSON', () => {
		const scan: ScanSettings = {
			tool: 'sonarqube',
			mode: 'external',
			hostUrl: 'https://sonar.example.com',
			organization: 'acme',
			projectKey: 'acme_my-app',
			cwd: 'apps/web',
			sources: 'src',
			exclusions: '**/dist/**',
			properties: [{ key: 'sonar.javascript.lcov.reportPaths', value: 'coverage/lcov.info' }],
			scannerMode: 'command',
			scannerImage: 'sonarsource/sonar-scanner-cli:11',
			scannerNetwork: 'host',
			command: 'sonar-scanner -Dsonar.projectKey={{projectKey}}',
			composeFile: 'sonar.yml',
			composeOverrides: ['sonar.override.yml'],
			portRangeStart: 9000,
			portRangeEnd: 9099,
			autoProvision: false,
			idleTimeout: 900
		};
		assert.deepStrictEqual(parseScanSettings(JSON.parse(JSON.stringify(scan))), scan);
		assert.deepStrictEqual(normalizeScanSettings(scan), scan);
	});

	test('never carries a credential', () => {
		// A URL with userinfo is dropped on the way in and refused on the way out.
		assert.strictEqual(
			parseScanSettings({ hostUrl: 'https://admin:hunter2@sonar.example.com' }),
			undefined
		);
		assert.ok(validateHostUrl('https://admin:hunter2@sonar.example.com'));

		// So is any property that reads like one, however it is spelled.
		for (const key of [
			'sonar.token',
			'sonar.login',
			'sonar.password',
			'sonar.jdbc.password',
			'sonar.scm.password',
			'sonar.ci.LOGIN',
			'my.secret.thing'
		]) {
			assert.ok(isReservedProperty(key), key);
			assert.strictEqual(parseScanSettings({ properties: [{ key, value: 'x' }] }), undefined, key);
			assert.ok(validateScanSettings({ properties: [{ key, value: 'x' }] }), key);
		}

		// And the four BFAST owns, so a hand-edited file cannot point the scanner
		// somewhere other than the server the sidebar reports on.
		for (const key of [
			'sonar.host.url',
			'sonar.projectKey',
			'sonar.organization',
			'sonar.projectBaseDir'
		]) {
			assert.ok(isReservedProperty(key), key);
			assert.strictEqual(parseScanSettings({ properties: [{ key, value: 'x' }] }), undefined, key);
		}

		// The grammar has no token to substitute a secret into.
		assert.ok(!SCAN_PLACEHOLDERS.includes('token'));
		assert.deepStrictEqual(unknownScanPlaceholders('scan --token {{token}}'), ['token']);
		assert.strictEqual(
			substituteCommand('scan --token {{token}}', { projectKey: 'x' }),
			'scan --token {{token}}'
		);
	});

	test('validation rejects only what a write must not accept', () => {
		assert.strictEqual(validateScanSettings(undefined), undefined);
		assert.strictEqual(validateScanSettings({}), undefined);
		// Unconfigured is not invalid — the rule a pulled file depends on.
		assert.strictEqual(validateScanSettings({ mode: 'external' }), undefined);
		assert.strictEqual(validateScanSettings({ scannerMode: 'command' }), undefined);
		assert.strictEqual(validateScanSettings({ hostUrl: '' }), undefined);
		// A wholly empty property row is what an unfilled form row looks like.
		assert.strictEqual(validateScanSettings({ properties: [{ key: '', value: '' }] }), undefined);

		assert.ok(validateScanSettings({ hostUrl: 'sonar.example.com' }));
		assert.ok(validateScanSettings({ hostUrl: 'https://sonar.example.com/?id=x' }));
		assert.ok(validateScanSettings({ projectKey: '123' }));
		assert.ok(validateScanSettings({ projectKey: 'a/b' }));
		assert.ok(validateScanSettings({ projectKey: 'x'.repeat(401) }));
		assert.ok(validateScanSettings({ organization: 'A!' }));
		assert.ok(validateScanSettings({ portRangeStart: MIN_SCAN_PORT - 1 }));
		assert.ok(validateScanSettings({ portRangeStart: 9100, portRangeEnd: 9000 }));
		assert.ok(validateScanSettings({ cwd: '..\\shared' }));
		assert.ok(validateScanSettings({ composeOverrides: ['/abs.yml'] }));
		assert.ok(validateScanSettings({ scannerImage: 'my image' }));
		assert.ok(validateScanSettings({ scannerNetwork: 'a b' }));
		assert.ok(validateScanSettings({ idleTimeout: MAX_SCAN_IDLE_SECONDS + 1 }));
		assert.ok(validateScanSettings({ idleTimeout: MIN_SCAN_IDLE_SECONDS - 1 }));
		assert.ok(
			validateScanSettings({
				properties: [
					{ key: 'sonar.sources', value: 'a' },
					{ key: 'sonar.sources', value: 'b' }
				]
			})
		);
	});

	test('a parsed block always validates', () => {
		// Reading is forgiving and writing is strict; the two must agree, which is
		// exactly this: whatever survives the parse can be written back.
		for (const raw of [
			{ hostUrl: 'https://u:p@x.com', projectKey: '123', portRangeStart: 1 },
			{ mode: 'external' },
			{ scannerMode: 'command', command: 'scan {{typo}}' },
			{ properties: [{ key: 'sonar.token', value: 'x' }, { key: 'sonar.sources', value: ' src ' }] },
			{ composeOverrides: ['../x.yml', 'ok.yml'] },
			{ idleTimeout: 1, autoProvision: 'yes' },
			{ scannerImage: 'bad image', scannerNetwork: 'host' }
		]) {
			assert.strictEqual(
				validateScanSettings(parseScanSettings(raw)),
				undefined,
				JSON.stringify(raw)
			);
		}
	});

	test('accessors apply the defaults, and nowhere else does', () => {
		assert.strictEqual(scanToolId(undefined), 'sonarqube');
		assert.strictEqual(scanMode(undefined), 'auto');
		assert.strictEqual(scanMode({ mode: 'external' }), 'external');
		assert.strictEqual(scannerMode(undefined), 'docker');
		assert.strictEqual(scannerImage(undefined), 'sonarsource/sonar-scanner-cli');
		assert.strictEqual(scanCommand(undefined), undefined);
		assert.strictEqual(scanCommand({ command: '   ' }), undefined);
		assert.strictEqual(scanCommand({ command: ' run ' }), 'run');
		assert.strictEqual(scanCwd(undefined), undefined);
		assert.strictEqual(scanCwd({ cwd: 'apps/web' }), 'apps/web');
		assert.deepStrictEqual(scanPortRange(undefined), { start: 9000, end: 9099 });
		assert.deepStrictEqual(scanPortRange({ portRangeStart: 9500 }), { start: 9500, end: 9099 });
		assert.strictEqual(scanAutoProvision(undefined), true);
		assert.strictEqual(scanAutoProvision({ autoProvision: false }), false);
		assert.strictEqual(scanIdleTimeoutMs(undefined), 600_000);
		assert.strictEqual(scanIdleTimeoutMs({ idleTimeout: 900 }), 900_000);
		assert.deepStrictEqual(scanComposeOverrides(undefined), []);
	});

	test('command mode gets no -D properties of its own', () => {
		// "BFAST appends nothing to a line you wrote" — one address for the rule,
		// so no caller has to remember it.
		const properties = [{ key: 'sonar.sources', value: 'src' }];
		assert.deepStrictEqual(scanProperties({ properties }), properties);
		assert.deepStrictEqual(scanProperties({ scannerMode: 'command', properties }), []);
	});

	test('a workspace name becomes a usable project key', () => {
		assert.strictEqual(defaultProjectKey('My App'), 'my-app');
		assert.strictEqual(defaultProjectKey('  acme/store  '), 'acme-store');
		assert.strictEqual(defaultProjectKey('bfast'), 'bfast');
		// SonarQube refuses an all-digit key, so a folder named after a year gets
		// a prefix rather than a 400 minutes later.
		assert.strictEqual(defaultProjectKey('2024'), 'project-2024');
		assert.strictEqual(defaultProjectKey(''), 'bfast-project');
		assert.strictEqual(defaultProjectKey('///'), 'bfast-project');
		assert.strictEqual(defaultProjectKey('x'.repeat(500)).length, 400);
		// Whatever it produces must be a key the validator would accept.
		for (const name of ['My App', '2024', '', '///', 'x'.repeat(500)]) {
			assert.strictEqual(validateProjectKey(defaultProjectKey(name)), undefined, name);
		}
	});

	test('parseSettings reads the scan block off the whole file', () => {
		const parsed = parseSettings({
			trackerFolder: '.tracker',
			userName: 'x',
			scan: { projectKey: 'my-app' }
		});
		assert.deepStrictEqual(parsed.scan, { projectKey: 'my-app' });
		assert.strictEqual(parseSettings({ trackerFolder: '.tracker', userName: 'x' }).scan, undefined);
	});

	test('normalizeSettings keeps every scan field through a write', () => {
		// `normalizeSettings` returns a fresh literal, so a field not named there
		// is silently dropped on every save. This is the assertion that catches it.
		const scan: ScanSettings = {
			tool: 'sonarqube',
			mode: 'external',
			hostUrl: 'https://sonar.example.com',
			organization: 'acme',
			projectKey: 'my-app',
			cwd: 'apps/web',
			sources: 'src',
			exclusions: '**/dist/**',
			properties: [{ key: 'sonar.sources', value: 'src' }],
			scannerMode: 'command',
			scannerImage: 'sonarsource/sonar-scanner-cli:11',
			scannerNetwork: 'host',
			command: 'scan {{projectKey}}',
			composeFile: 'sonar.yml',
			composeOverrides: ['sonar.override.yml'],
			portRangeStart: 9000,
			portRangeEnd: 9099,
			autoProvision: false,
			idleTimeout: 900
		};
		assert.deepStrictEqual(
			normalizeSettings({ trackerFolder: '.tracker', userName: 'Hanh Thong', scan }).scan,
			scan
		);
	});

	test('normalizeSettings omits an empty scan block entirely', () => {
		// The other half: a workspace that never scans must keep `bfast.json`
		// byte-identical, which is what the older settings suites assume.
		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'Thu Ha',
			scan: {}
		});
		assert.deepStrictEqual(normalized, { trackerFolder: '.tracker', userName: 'Thu Ha' });
		assert.ok(!('scan' in normalized));
		assert.ok(
			!('scan' in normalizeSettings({ trackerFolder: '.tracker', userName: 'Thu Ha' }))
		);
		// And the default-valued flag never creates one.
		assert.ok(
			!(
				'scan' in
				normalizeSettings({
					trackerFolder: '.tracker',
					userName: 'Thu Ha',
					scan: { autoProvision: true }
				})
			)
		);
	});
});
