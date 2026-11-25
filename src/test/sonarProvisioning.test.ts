// Auto-provisioning — see docs/scan/sonarqube.md#provisioning for the contract.
//
// Driven entirely by a scripted `FakeSonarClient`: no network, no docker. What
// it pins is the *order*, because the order is what makes the sequence safe —
// cheapest-first means a healthy instance costs one call and writes nothing, and
// least-destructive-first means a user who changed the admin password by hand
// still gets a working scan.

import * as assert from 'assert';
import { ScanError } from '../scan/scanProvider';
import {
	ANALYSIS_TOKEN_NAME,
	DEFAULT_ADMIN_PASSWORD,
	ensureProject,
	generatePassword,
	MIN_PASSWORD_LENGTH,
	provisionSonarQube,
	RESULTS_TOKEN_NAME,
	satisfiesPasswordPolicy,
	verifyResultsToken,
	type ProvisionDeps
} from '../scan/sonarqube/sonarProvisioning';
import { FakeSonarClient } from './fakeSonarClient';

const GENERATED = 'Aa1!Bb2@Cc3#Dd4$';

function makeDeps(
	client: FakeSonarClient,
	overrides: Partial<ProvisionDeps> = {}
): ProvisionDeps & { remembered: string[] } {
	const remembered: string[] = [];
	return {
		client,
		current: {},
		rememberPassword: async (password) => {
			remembered.push(password);
		},
		makePassword: () => GENERATED,
		remembered,
		...overrides
	};
}

/** A client that answers every provisioning call of a fresh instance. */
function freshInstance(): FakeSonarClient {
	return new FakeSonarClient()
		.reply('GET api/user_tokens/search', 200, { login: 'admin', userTokens: [] })
		.reply('POST api/users/change_password', 204)
		.reply('POST api/user_tokens/revoke', 204)
		.sequence('POST api/user_tokens/generate', [
			{ status: 200, body: { name: ANALYSIS_TOKEN_NAME, token: 'sqa_analysis' } },
			{ status: 200, body: { name: RESULTS_TOKEN_NAME, token: 'squ_results' } }
		]);
}

suite('SonarQube provisioning', () => {
	test('a fresh instance is set up in one pass', async () => {
		const client = freshInstance();
		const deps = makeDeps(client);

		const credentials = await provisionSonarQube(deps);

		assert.deepStrictEqual(credentials, {
			analysisToken: 'sqa_analysis',
			resultsToken: 'squ_results',
			adminPassword: GENERATED
		});
		assert.deepStrictEqual(client.calls, [
			// Step 3's probe. Step 1 and 2 are skipped: nothing is stored yet.
			'GET api/user_tokens/search',
			'POST api/users/change_password',
			'POST api/user_tokens/revoke',
			'POST api/user_tokens/generate',
			'POST api/user_tokens/revoke',
			'POST api/user_tokens/generate'
		]);
		// The project is not created here: provisioning runs before any scan has
		// said what it will analyse, and the key is the scan's — see ensureProject.
		assert.ok(!client.calls.includes('POST api/projects/create'));
	});

	test('the password is written before it is sent, and cleared if the send fails', async () => {
		// Changing a password is an irreversible effect on a server. A crash
		// between "the server accepted it" and "the extension wrote it down" would
		// lock the user out of their own instance.
		const client = freshInstance();
		const deps = makeDeps(client);
		await provisionSonarQube(deps);
		assert.deepStrictEqual(deps.remembered, [GENERATED]);

		const failing = new FakeSonarClient()
			.reply('GET api/user_tokens/search', 200, { userTokens: [] })
			.reply('POST api/users/change_password', 400, {
				errors: [{ msg: 'Password is too weak' }]
			});
		const failedDeps = makeDeps(failing);
		await assert.rejects(() => provisionSonarQube(failedDeps));
		// Written, then cleared — never left claiming a password the server refused.
		assert.deepStrictEqual(failedDeps.remembered, [GENERATED, '']);
	});

	test('two tokens, of two different types, for two different jobs', async () => {
		const client = freshInstance();
		await provisionSonarQube(makeDeps(client));

		const generates = client.requests.filter(
			(request) => request.path === 'api/user_tokens/generate'
		);
		assert.deepStrictEqual(
			generates.map((request) => [request.params?.name, request.params?.type]),
			[
				// The only credential that enters the scanner container: if it leaks
				// an attacker can push a bogus analysis and little else.
				[ANALYSIS_TOKEN_NAME, 'GLOBAL_ANALYSIS_TOKEN'],
				// Never leaves the host, and must be a user token because
				// api/issues/search answers 403 to an analysis token.
				[RESULTS_TOKEN_NAME, 'USER_TOKEN']
			]
		);
		// No expiry: a token that silently expires turns a working feature into a
		// 401 months later, and re-provisioning already replaces it.
		assert.ok(generates.every((request) => request.params?.expirationDate === undefined));
	});

	test('revoke names the token', async () => {
		const client = freshInstance();
		await provisionSonarQube(makeDeps(client));

		const revoke = client.requests.find((request) => request.path === 'api/user_tokens/revoke');
		assert.deepStrictEqual(revoke?.params, { name: ANALYSIS_TOKEN_NAME });
		// It is `name`, not `token` — the parameter a live instance's own web_api
		// listing gets wrong and the server source gets right.
		assert.deepStrictEqual(Object.keys(revoke?.params ?? {}), ['name']);
	});

	test('a healthy instance costs one call and writes nothing', async () => {
		// The common case, and the reason the order is cheapest-first.
		const client = new FakeSonarClient().reply('GET api/user_tokens/search', 200, {
			userTokens: []
		});
		const deps = makeDeps(client, {
			current: { analysisToken: 'sqa_x', resultsToken: 'squ_y', adminPassword: 'Pw' }
		});

		const credentials = await provisionSonarQube(deps);

		assert.deepStrictEqual(credentials, {}, 'nothing was minted, so nothing is returned');
		assert.deepStrictEqual(client.calls, ['GET api/user_tokens/search']);
		assert.deepStrictEqual(deps.remembered, []);
	});

	test('a revoked token is re-minted with the stored admin password', async () => {
		const client = new FakeSonarClient()
			.on('GET api/user_tokens/search', (request) => {
				// The dead results token 401s; the admin password still works.
				const dead = request.auth?.kind === 'token' && request.auth.token === 'squ_dead';
				return dead
					? { status: 401, text: '' }
					: { status: 200, body: { userTokens: [] }, text: '{}' };
			})
			.reply('POST api/user_tokens/revoke', 204)
			.sequence('POST api/user_tokens/generate', [
				{ status: 200, body: { token: 'sqa_new' } },
				{ status: 200, body: { token: 'squ_new' } }
			]);

		const deps = makeDeps(client, {
			current: { analysisToken: 'sqa_old', resultsToken: 'squ_dead', adminPassword: 'StoredPw1!' }
		});
		const credentials = await provisionSonarQube(deps);

		assert.deepStrictEqual(credentials, { analysisToken: 'sqa_new', resultsToken: 'squ_new' });
		// The password was not touched — only the tokens were replaced.
		assert.deepStrictEqual(deps.remembered, []);
		assert.strictEqual(client.countOf('POST api/users/change_password'), 0);
		// And the project is not re-created on this path; it already exists.
		assert.strictEqual(client.countOf('POST api/projects/create'), 0);
	});

	test('changing the admin password by hand does not break scanning', async () => {
		// SonarQube does not revoke tokens when a password changes, and step 1
		// runs before step 2 — so the tokens still work and nothing is re-minted.
		const client = new FakeSonarClient().on('GET api/user_tokens/search', (request) => {
			const byPassword = request.auth?.kind === 'password';
			return byPassword
				? { status: 401, text: '' }
				: { status: 200, body: { userTokens: [] }, text: '{}' };
		});
		const deps = makeDeps(client, {
			current: { analysisToken: 'sqa_x', resultsToken: 'squ_y', adminPassword: 'StaleP1!' }
		});

		assert.deepStrictEqual(await provisionSonarQube(deps), {});
		assert.deepStrictEqual(client.calls, ['GET api/user_tokens/search']);
	});

	test('an instance nobody has the password for stops rather than guessing', async () => {
		const progress: string[] = [];
		const client = new FakeSonarClient().reply('GET api/user_tokens/search', 401);
		const deps = makeDeps(client, {
			current: { adminPassword: 'WrongPw1!' },
			onProgress: (label) => progress.push(label)
		});

		await assert.rejects(
			() => provisionSonarQube(deps),
			(error: unknown) =>
				error instanceof ScanError &&
				error.code === 'unauthorized' &&
				/Set SonarQube Token/.test(error.message) &&
				/Remove Scan Server/.test(error.message)
		);
		// It probed the stored password and the factory one, and stopped. No list
		// of candidates, and nothing was written.
		assert.deepStrictEqual(client.calls, [
			'GET api/user_tokens/search',
			'GET api/user_tokens/search'
		]);
		assert.deepStrictEqual(deps.remembered, []);
		assert.ok(progress.includes('The stored admin password no longer works'));
	});

	suite('ensureProject', () => {
		test('an existing project costs one Browse-level call and writes nothing', async () => {
			// `api/components/show` needs only Browse, where `api/projects/search`
			// needs Administer System — so this is the probe every usable token can make.
			const client = new FakeSonarClient().reply('GET api/components/show', 200, {
				component: { key: 'ice-hrm' }
			});
			const created = await ensureProject({ client, token: 'squ_y', projectKey: 'ice-hrm' });
			assert.strictEqual(created, false);
			assert.deepStrictEqual(client.calls, ['GET api/components/show']);
		});

		test('a missing project is created under the key and the name the checkout gave it', async () => {
			const client = new FakeSonarClient()
				.reply('GET api/components/show', 404, { errors: [{ msg: 'not found' }] })
				.reply('POST api/projects/create', 200, { project: { key: 'ice-hrm' } });
			const created = await ensureProject({
				client,
				token: 'squ_y',
				projectKey: 'ice-hrm',
				projectName: 'ICE HRM',
				organization: 'acme'
			});
			assert.strictEqual(created, true);

			const create = client.requests.find((request) => request.path === 'api/projects/create');
			// `project`, not `key` — the parameter the live web_api listing gets wrong.
			assert.deepStrictEqual(create?.params, {
				project: 'ice-hrm',
				name: 'ICE HRM',
				organization: 'acme'
			});
			// Under the results token — a user token; an analysis token answers 403.
			assert.strictEqual(create?.authorization, 'token:squ_y');
		});

		test('the name falls back to the key, and Cloud is only named when configured', async () => {
			const client = new FakeSonarClient()
				.reply('GET api/components/show', 404)
				.reply('POST api/projects/create', 200);
			await ensureProject({ client, token: 'squ_y', projectKey: 'my-app' });
			const create = client.requests.find((request) => request.path === 'api/projects/create');
			assert.deepStrictEqual(create?.params, { project: 'my-app', name: 'my-app' });
		});

		test('a key that already exists from a race is success, not a failure', async () => {
			const client = new FakeSonarClient()
				.reply('GET api/components/show', 404)
				.reply('POST api/projects/create', 400, {
					errors: [{ msg: 'Could not create Project, key already exists: my-app' }]
				});
			await assert.doesNotReject(() =>
				ensureProject({ client, token: 'squ_y', projectKey: 'my-app' })
			);
		});

		test('a refusal to create is an unauthorized error the caller can soften', async () => {
			const client = new FakeSonarClient()
				.reply('GET api/components/show', 404)
				.reply('POST api/projects/create', 403, { errors: [{ msg: 'Insufficient privileges' }] });
			await assert.rejects(
				() => ensureProject({ client, token: 'squ_y', projectKey: 'my-app' }),
				(error: unknown) => error instanceof ScanError && error.code === 'unauthorized'
			);
		});
	});

	suite('verifyResultsToken', () => {
		test('no token stops with the command that sets one', async () => {
			await assert.rejects(
				() => verifyResultsToken(new FakeSonarClient(), undefined),
				(error: unknown) =>
					error instanceof ScanError &&
					error.code === 'unauthorized' &&
					/Set SonarQube Token/.test(error.message)
			);
		});

		test('an analysis-only token is named as the wrong kind, in one call', async () => {
			// api/issues/search is the endpoint an analysis token answers 403 to.
			const client = new FakeSonarClient().reply('GET api/issues/search', 403);
			await assert.rejects(
				() => verifyResultsToken(client, 'sqa_analysis'),
				(error: unknown) => error instanceof ScanError && /user\*\* token/.test(error.message)
			);
			assert.deepStrictEqual(client.calls, ['GET api/issues/search']);
		});

		test('a user token passes and mints nothing', async () => {
			const client = new FakeSonarClient().reply('GET api/issues/search', 200, { issues: [] });
			await assert.doesNotReject(() => verifyResultsToken(client, 'squ_y'));
			assert.deepStrictEqual(client.calls, ['GET api/issues/search']);
		});
	});

	test('a 401 anywhere maps to unauthorized, not to a generic server error', async () => {
		const client = freshInstance().reply('POST api/user_tokens/generate', 403, {
			errors: [{ msg: 'Insufficient privileges' }]
		});
		await assert.rejects(
			() => provisionSonarQube(makeDeps(client)),
			(error: unknown) =>
				error instanceof ScanError &&
				error.code === 'unauthorized' &&
				error.message === 'Insufficient privileges'
		);
	});

	test('a token the server did not return is an error, never an empty string', async () => {
		const client = freshInstance().reply('POST api/user_tokens/generate', 200, { name: 'x' });
		await assert.rejects(
			() => provisionSonarQube(makeDeps(client)),
			(error: unknown) => error instanceof ScanError && /did not return its value/.test(error.message)
		);
	});

	test('the generated password satisfies SonarQube policy every time', () => {
		// At least 12 characters with an upper, a lower, a digit and a special.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const password = generatePassword();
			assert.ok(satisfiesPasswordPolicy(password), password);
			assert.strictEqual(password.length, 32);
			// Nothing a shell, a URL or a log would mangle.
			assert.ok(!/["'`$&;\\ ]/.test(password), password);
		}
		// A caller asking for less than the policy allows still gets a legal one.
		assert.ok(generatePassword(4).length >= MIN_PASSWORD_LENGTH);
		assert.ok(!satisfiesPasswordPolicy('short1!A'));
		assert.ok(!satisfiesPasswordPolicy('alllowercase1!'));
		assert.ok(!satisfiesPasswordPolicy(DEFAULT_ADMIN_PASSWORD));
	});

	test('the factory password is never what gets stored', async () => {
		const client = freshInstance();
		const deps = makeDeps(client, { makePassword: generatePassword });
		const credentials = await provisionSonarQube(deps);
		assert.notStrictEqual(credentials.adminPassword, DEFAULT_ADMIN_PASSWORD);
		assert.ok(satisfiesPasswordPolicy(credentials.adminPassword ?? ''));
	});
});
