// `tests.services` — docs/tests/services.md is the spec. The settings half,
// the compose command lines it reaches for, and the master-environment glue,
// none of which needs a VS Code window.

import * as assert from 'assert';
import {
	composeConfigServicesArgs,
	composeUpServicesArgs,
	parseComposeServices
} from '../environments/composeCommand';
import type { EnvironmentHandle } from '../environments/environmentProvider';
import { masterStack, NO_MASTER_MESSAGE } from '../environments/masterStack';
import {
	findService,
	parseTestServices,
	suggestServiceId,
	unknownServicePlaceholders,
	validateTestServices,
	type TestService
} from '../settings/testServices';
import {
	normalizeTestsSettings,
	parseTestsSettings,
	testsConfigured,
	testsCoverage,
	validateTestsSettings
} from '../settings/testsSettings';
import { FakeProcessRunner } from './fakeProcessRunner';

suite('Test services settings', () => {
	test('reading keeps every usable row and its suites, normalised', () => {
		assert.deepStrictEqual(
			parseTestServices([
				{
					id: 'orders',
					name: ' Orders ',
					folder: './services\\orders/',
					unit: { command: ' npm test ', coverage: 'coverage/lcov.info' },
					e2e: {
						command: 'npm run e2e',
						testCommand: 'npm run e2e -- --grep {{id}}',
						coverage: 'coverage/e2e/lcov.info',
						compose: ['orders', ' postgres ', 'orders']
					}
				}
			]),
			[
				{
					id: 'orders',
					name: 'Orders',
					folder: 'services/orders',
					unit: { command: 'npm test', coverage: 'coverage/lcov.info' },
					e2e: {
						command: 'npm run e2e',
						testCommand: 'npm run e2e -- --grep {{id}}',
						coverage: 'coverage/e2e/lcov.info',
						compose: ['orders', 'postgres']
					}
				}
			]
		);
	});

	test('reading is forgiving: a bad row is dropped, the first of two ids wins, nothing left is absent', () => {
		const parsed = parseTestServices([
			'nonsense',
			{ id: 'Orders', folder: 'a' },
			{ id: 'orders', folder: '/abs' },
			{ id: 'orders', folder: '../out' },
			{ id: 'orders' },
			{ id: 'orders', folder: 'services/orders', unit: {}, e2e: { compose: ['bad name!'] } },
			{ id: 'orders', folder: 'services/other' }
		]);
		assert.deepStrictEqual(parsed, [{ id: 'orders', folder: 'services/orders' }]);
		assert.strictEqual(parseTestServices([]), undefined);
		assert.strictEqual(parseTestServices({ id: 'x' }), undefined);
	});

	test('writing is strict, and a card left blank is skipped', () => {
		const row = (patch: Partial<TestService>): TestService => ({ id: 'orders', folder: 'services/orders', ...patch });
		assert.strictEqual(validateTestServices([row({})]), undefined);
		assert.strictEqual(validateTestServices([{ id: '', folder: '' }]), undefined);
		assert.match(validateTestServices([row({ id: '' })]) ?? '', /needs an id/);
		assert.match(validateTestServices([row({ id: 'Orders' })]) ?? '', /lower-case letters/);
		assert.match(validateTestServices([row({}), row({ folder: 'x' })]) ?? '', /share the id “orders”/);
		assert.match(validateTestServices([row({ folder: '' })]) ?? '', /needs a folder/);
		assert.match(validateTestServices([row({ folder: '../x' })]) ?? '', /stay inside the workspace/);
		assert.match(validateTestServices([row({ folder: '.tracker/x' })], '.tracker') ?? '', /inside the tracker/);
		assert.match(
			validateTestServices([row({ unit: { coverage: '/tmp/lcov.info' } })]) ?? '',
			/unit coverage file must be relative/
		);
		assert.match(
			validateTestServices([row({ e2e: { compose: ['ok', 'not ok'] } })]) ?? '',
			/“not ok” is not a compose service name/
		);
	});

	test('the tests block carries services and the project coverage file, omitted when empty', () => {
		const tests = parseTestsSettings({
			coverage: './coverage/e2e/lcov.info',
			services: [{ id: 'orders', folder: 'services/orders' }]
		});
		assert.deepStrictEqual(tests, {
			coverage: 'coverage/e2e/lcov.info',
			services: [{ id: 'orders', folder: 'services/orders' }]
		});
		assert.strictEqual(testsCoverage(tests), 'coverage/e2e/lcov.info');
		assert.strictEqual(normalizeTestsSettings({ services: [{ id: '', folder: '' }] }), undefined);
		assert.match(
			validateTestsSettings({ services: [{ id: 'x', folder: '' }] }) ?? '',
			/needs a folder/
		);
		assert.match(validateTestsSettings({ coverage: '../lcov.info' }) ?? '', /project coverage file/);
	});

	test('Run Tests is configured by a project command or by one service test case command', () => {
		assert.strictEqual(testsConfigured(undefined), false);
		assert.strictEqual(testsConfigured({ command: 'run' }), true);
		assert.strictEqual(testsConfigured({ services: [{ id: 'a', folder: 'a', unit: { command: 'x' } }] }), false);
		assert.strictEqual(
			testsConfigured({ services: [{ id: 'a', folder: 'a', e2e: { testCommand: 'x {{id}}' } }] }),
			true
		);
	});

	test('helpers: lookup, a proposed id, the placeholder hint', () => {
		const tests = { services: [{ id: 'orders', folder: 'o' }] };
		assert.strictEqual(findService(tests, 'orders')?.folder, 'o');
		assert.strictEqual(findService(tests, 'billing'), undefined);
		assert.strictEqual(findService(tests, undefined), undefined);
		assert.strictEqual(suggestServiceId('services/Orders API'), 'orders-api');
		assert.strictEqual(suggestServiceId('apps\\web\\'), 'web');
		assert.strictEqual(suggestServiceId('.'), '');
		assert.deepStrictEqual(unknownServicePlaceholders('e2e {{id}} {{title}}'), ['title']);
	});
});

suite('Compose command lines for services', () => {
	test('bring up named services, waiting for health, no rebuild', () => {
		assert.deepStrictEqual(
			composeUpServicesArgs('bfast-master-shop', ['docker-compose.yml', 'e2e.yml'], ['orders', 'postgres']),
			[
				'compose',
				'-p',
				'bfast-master-shop',
				'--file',
				'docker-compose.yml',
				'--file',
				'e2e.yml',
				'up',
				'-d',
				'--wait',
				'orders',
				'postgres'
			]
		);
	});

	test('list the services the files declare, and read the answer forgivingly', () => {
		assert.deepStrictEqual(composeConfigServicesArgs(['a.yml', 'b.yml']), [
			'compose',
			'--file',
			'a.yml',
			'--file',
			'b.yml',
			'config',
			'--services'
		]);
		assert.deepStrictEqual(
			parseComposeServices('orders\r\npostgres\n\nWARN[0000] something\norders\n'),
			['orders', 'postgres']
		);
	});
});

suite('Master stack for Run Tests', () => {
	const master: EnvironmentHandle = {
		id: 'master',
		scope: 'master',
		kind: 'docker-compose',
		branch: 'main',
		worktreePath: '/repo',
		projectName: 'bfast-master-shop',
		ports: { ORDERS_PORT: 41001 },
		createdAt: '2026-11-01T00:00:00.000Z',
		status: 'running'
	} as EnvironmentHandle;

	test('the stack variables come from the master, and nothing without one', async () => {
		const withMaster = masterStack({
			find: async (id) => (id === 'master' ? master : undefined),
			settings: () => undefined,
			runner: new FakeProcessRunner().runner,
			idleTimeoutMs: () => 1000
		});
		const env = await withMaster.stackEnvironment();
		assert.strictEqual(env?.ORDERS_PORT, '41001');
		assert.strictEqual(env?.BFAST_PROJECT_NAME, 'bfast-master-shop');

		const without = masterStack({
			find: async () => undefined,
			settings: () => undefined,
			runner: new FakeProcessRunner().runner,
			idleTimeoutMs: () => 1000
		});
		assert.strictEqual(await without.stackEnvironment(), undefined);
	});

	test('compose up runs in the master folder, under its project, with its variables', async () => {
		const fake = new FakeProcessRunner();
		const stack = masterStack({
			find: async () => master,
			settings: () => ({ composeOverrides: ['e2e.yml'] }),
			runner: fake.runner,
			idleTimeoutMs: () => 5000
		});
		await stack.composeUp(['orders'], { onOutput: () => {}, onCancel: () => {} });

		const [request] = fake.requests;
		assert.strictEqual(request.executable, 'docker');
		assert.strictEqual(request.cwd, '/repo');
		assert.deepStrictEqual(request.args.slice(-4), ['up', '-d', '--wait', 'orders']);
		assert.ok(request.args.includes('bfast-master-shop'));
		assert.ok(request.args.includes('e2e.yml'));
		assert.strictEqual(request.env?.ORDERS_PORT, '41001');
		assert.strictEqual(request.idleTimeoutMs, 5000);
	});

	test('no master, or a provider that is not compose, is refused in words', async () => {
		const run = { onOutput: () => {}, onCancel: () => {} };
		const noMaster = masterStack({
			find: async () => undefined,
			settings: () => undefined,
			runner: new FakeProcessRunner().runner,
			idleTimeoutMs: () => 1000
		});
		await assert.rejects(noMaster.composeUp(['orders'], run), (error: Error) => error.message === NO_MASTER_MESSAGE);

		const k8s = masterStack({
			find: async () => master,
			settings: () => ({ provider: 'k8s' }),
			runner: new FakeProcessRunner().runner,
			idleTimeoutMs: () => 1000
		});
		await assert.rejects(k8s.composeUp(['orders'], run), /docker-compose environment provider/);
	});
});
