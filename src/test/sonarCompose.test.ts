// The docker command lines for the SonarQube tool — the contract
// docs/scan/sonarqube.md documents.
//
// Two of these are security assertions rather than behaviour ones, and they are
// not optional: the token travels in the environment and never in an argument,
// and `redactArgs` blanks it before anything is echoed.

import * as assert from 'assert';
import { scannerEnvironment } from '../scan/scanContext';
import type { ScanEndpoint } from '../scan/scanProvider';
import {
	composeVersionArgs,
	describeCommand,
	dockerMemoryArgs,
	imageInspectArgs,
	imagePullArgs,
	parseComposePort,
	redactArgs,
	resolveEndpoint,
	scanStackEnvironment,
	scannerDockerArgs,
	scannerProperties,
	sonarDestroyArgs,
	sonarDownArgs,
	sonarLogsArgs,
	sonarPortArgs,
	sonarUpArgs,
	type ScannerArgsOptions
} from '../scan/sonarqube/sonarCompose';

const PROJECT = 'bfast-sonar-my-app';
const FILES = ['/home/scan/docker-compose.yml', '/repo/sonar.override.yml'];

const ENDPOINT: ScanEndpoint = {
	url: 'http://localhost:9000',
	containerUrl: 'http://sonarqube:9000',
	network: `${PROJECT}_default`
};

function scannerOptions(overrides: Partial<ScannerArgsOptions> = {}): ScannerArgsOptions {
	return {
		image: 'sonarsource/sonar-scanner-cli',
		directory: '/repo/my app',
		cacheDir: '/home/scan/cache',
		workDir: '/home/scan/scannerwork',
		endpoint: ENDPOINT,
		projectKey: 'my-app',
		scmDisabled: false,
		platform: 'linux',
		...overrides
	};
}

suite('SonarQube compose and scanner commands', () => {
	test('the compose argv arrays are exactly what the docs promise', () => {
		assert.deepStrictEqual(sonarUpArgs(PROJECT, FILES), [
			'compose',
			'-p',
			PROJECT,
			'--file',
			FILES[0],
			'--file',
			FILES[1],
			'up',
			'-d',
			'--remove-orphans'
		]);
		// No --build, no --force-recreate, no --pull always: this instance is a
		// pet whose volume holds the credentials BFAST generated.
		assert.ok(!sonarUpArgs(PROJECT, FILES).includes('--build'));
		assert.ok(!sonarUpArgs(PROJECT, FILES).includes('--force-recreate'));
		assert.ok(!sonarUpArgs(PROJECT, FILES).join(' ').includes('--pull'));

		assert.deepStrictEqual(sonarDownArgs(PROJECT, FILES).slice(-1), ['down']);
		assert.deepStrictEqual(sonarDestroyArgs(PROJECT, FILES).slice(-3), [
			'down',
			'--volumes',
			'--remove-orphans'
		]);
		assert.deepStrictEqual(sonarLogsArgs(PROJECT, FILES).slice(-5), [
			'logs',
			'--follow',
			'--no-color',
			'--tail',
			'50'
		]);
		assert.deepStrictEqual(sonarPortArgs(PROJECT, FILES).slice(-3), ['port', 'sonarqube', '9000']);
		assert.deepStrictEqual(composeVersionArgs(), ['compose', 'version']);
		assert.deepStrictEqual(dockerMemoryArgs(), ['info', '--format', '{{.MemTotal}}']);
		assert.deepStrictEqual(imageInspectArgs('img'), ['image', 'inspect', 'img']);
		assert.deepStrictEqual(imagePullArgs('img'), ['pull', 'img']);
	});

	test('one --file per configured file, in order', () => {
		// Later files override earlier ones; the order is the contract.
		const args = sonarUpArgs(PROJECT, ['a.yml', 'b.yml', 'c.yml']);
		assert.deepStrictEqual(
			args.filter((_, index) => args[index - 1] === '--file'),
			['a.yml', 'b.yml', 'c.yml']
		);
	});

	test('every compose invocation gets the port variable, down included', () => {
		// A compose file using ${BFAST_SONAR_PORT:?} refuses to even parse
		// without it, so `down` needs it as much as `up` does.
		assert.deepStrictEqual(scanStackEnvironment(9001, PROJECT), {
			BFAST_SONAR_PORT: '9001',
			BFAST_SONAR_PROJECT: PROJECT
		});
		// A placeholder when the port is unknown: `down` still has to parse.
		assert.strictEqual(scanStackEnvironment(undefined, PROJECT).BFAST_SONAR_PORT, '0');
	});

	test('reads a host port back out of docker compose port', () => {
		assert.strictEqual(parseComposePort('0.0.0.0:20500\n'), 20500);
		assert.strictEqual(parseComposePort('[::]:9000'), 9000);
		assert.strictEqual(parseComposePort(''), undefined);
		assert.strictEqual(parseComposePort('nonsense'), undefined);
	});

	test('the scanner argv mounts the directory and puts -D flags after the image', () => {
		const args = scannerDockerArgs(scannerOptions({ uid: 1001, gid: 1001 }));

		const image = args.indexOf('sonarsource/sonar-scanner-cli');
		assert.ok(image > 0, 'the image must be in the argv');
		// -D flags replace the image's CMD, and its entrypoint recognises a
		// leading flag; before the image name they would be docker's own.
		assert.ok(args.slice(image + 1).every((arg) => arg.startsWith('-D')));
		assert.ok(args.slice(0, image).includes('--rm'));

		// The path has a space in it and stays one argv element: `shell: false`
		// is what makes that reach docker byte-for-byte.
		assert.ok(args.includes('/repo/my app:/usr/src'));
		assert.ok(args.includes('/home/scan/cache:/opt/sonar-scanner/.sonar'));
		assert.ok(args.includes('--network'));
		assert.ok(args.includes(`${PROJECT}_default`));
	});

	test('.scannerwork lands in a BFAST-owned folder, never in the repository', () => {
		// The image writes it to /tmp/.scannerwork inside the container (its own
		// SCANNER_WORKDIR_PATH), which is where an earlier BFAST did *not* look —
		// "the scanner finished but wrote no report-task.txt". Mount a folder
		// there, say so in both the variable and the property, and read it back.
		const args = scannerDockerArgs(scannerOptions());
		assert.ok(args.includes('/home/scan/scannerwork:/tmp/.scannerwork'));
		assert.ok(args.includes('SCANNER_WORKDIR_PATH=/tmp/.scannerwork'));
		// The variable only: the entrypoint emits the `-D` from it, and a second
		// copy makes the scanner warn "overridden with value" — the same value —
		// on every run.
		assert.ok(!args.some((arg) => arg.startsWith('-Dsonar.working.directory')));
	});

	test('-u is passed on Linux and nowhere else', () => {
		// The image runs as uid 1000; a different host uid leaves an undeletable
		// .scannerwork in the repo. Docker Desktop already translates ownership,
		// and passing -u there breaks the image's own assumptions.
		const linux = scannerDockerArgs(scannerOptions({ platform: 'linux', uid: 1001, gid: 1001 }));
		assert.deepStrictEqual(linux.slice(linux.indexOf('-u'), linux.indexOf('-u') + 2), [
			'-u',
			'1001:1001'
		]);

		for (const platform of ['win32', 'darwin'] as const) {
			const args = scannerDockerArgs(scannerOptions({ platform, uid: 1001, gid: 1001 }));
			assert.ok(!args.includes('-u'), platform);
		}
		// And not on Linux either when there is no uid to pass.
		assert.ok(!scannerDockerArgs(scannerOptions({ platform: 'linux' })).includes('-u'));
	});

	test('the token is in the environment and never in an argument', () => {
		// The security assertion. The image's entrypoint turns SONAR_TOKEN into
		// -Dsonar.token itself; a token on the command line would sit in the
		// host's process table and in the argv the output channel echoes.
		const args = scannerDockerArgs(scannerOptions());
		const line = args.join(' ');
		assert.ok(!line.includes('sonar.token'), line);
		assert.ok(!line.includes('sonar.login'));
		assert.ok(!line.includes('SONAR_TOKEN='));
		assert.ok(!line.includes('SONAR_HOST_URL='));

		// But the container must still *receive* both: a bare `-e NAME` makes
		// docker copy the value from the client's environment. Without these the
		// scanner sees no host url, defaults to SonarCloud and demands
		// sonar.organization — the failure a real ice-hrm scan produced.
		const forwarded = args.flatMap((arg, index) =>
			arg === '-e' && !args[index + 1].includes('=') ? [args[index + 1]] : []
		);
		assert.deepStrictEqual(forwarded, ['SONAR_HOST_URL', 'SONAR_TOKEN']);
		// And they come before the image, where docker reads flags.
		assert.ok(args.indexOf('SONAR_TOKEN') < args.indexOf('sonarsource/sonar-scanner-cli'));

		const environment = scannerEnvironment({
			hostUrl: 'http://sonarqube:9000',
			projectKey: 'my-app',
			ticketId: 'ST-1.2',
			credentials: { analysisToken: 'sqa_secret' }
		});
		assert.strictEqual(environment.SONAR_TOKEN, 'sqa_secret');
		assert.strictEqual(environment.SONAR_HOST_URL, 'http://sonarqube:9000');
		assert.strictEqual(environment.BFAST_TICKET_ID, 'ST-1.2');
	});

	test('redaction blanks a secret before anything is echoed', () => {
		assert.deepStrictEqual(
			redactArgs(['run', '-e', 'SONAR_TOKEN=sqa_secret', '-e', 'SONAR_HOST_URL=http://x']),
			['run', '-e', 'SONAR_TOKEN=***', '-e', 'SONAR_HOST_URL=http://x']
		);
		// Belt and braces: a `-Dsonar.token=` should never be built, but the log
		// stays safe even if one ever is.
		assert.deepStrictEqual(redactArgs(['-Dsonar.token=sqa_secret']), ['-Dsonar.token=***']);
		assert.deepStrictEqual(redactArgs(['-Dsonar.projectKey=my-app']), ['-Dsonar.projectKey=my-app']);
		assert.strictEqual(
			describeCommand('docker', ['run', '-e', 'SONAR_TOKEN=sqa_secret']),
			'docker run -e SONAR_TOKEN=***'
		);
	});

	test('BFAST supplies only the properties it owns, and never a branch', () => {
		const bare = scannerProperties(scannerOptions());
		assert.deepStrictEqual(bare, [
			['sonar.projectKey', 'my-app'],
			['sonar.sources', '.'],
			['sonar.scm.provider', 'git']
		]);
		// Community Edition has no branch analysis; passing it fails the run.
		assert.ok(!bare.some(([key]) => key === 'sonar.branch.name'));
		// `sonar.working.directory` reaches the scanner through the image's own
		// SCANNER_WORKDIR_PATH (see the .scannerwork test), never as a property.
		assert.ok(!bare.some(([key]) => key === 'sonar.working.directory'));

		const full = scannerProperties(
			scannerOptions({
				projectName: 'My App',
				organization: 'acme',
				sources: 'src',
				exclusions: '**/dist/**',
				properties: [{ key: 'sonar.javascript.lcov.reportPaths', value: 'coverage/lcov.info' }]
			})
		);
		assert.deepStrictEqual(full, [
			['sonar.projectKey', 'my-app'],
			['sonar.projectName', 'My App'],
			['sonar.organization', 'acme'],
			['sonar.sources', 'src'],
			['sonar.exclusions', '**/dist/**'],
			['sonar.scm.provider', 'git'],
			['sonar.javascript.lcov.reportPaths', 'coverage/lcov.info']
		]);
	});

	test('a checkout with its own sonar-project.properties keeps its layout', () => {
		// `-D` beats the file inside the scanner. ice-hrm's file lays out
		// `sonar.sources` and `sonar.tests` itself; BFAST's `.` on top of it would
		// make every test file a source file too, which the scanner refuses as a
		// file indexed twice.
		const laidOut = scannerProperties(
			scannerOptions({ fileProperties: ['sonar.projectKey', 'sonar.sources', 'sonar.tests'] })
		);
		assert.ok(!laidOut.some(([key]) => key === 'sonar.sources'));
		// The key is still sent: the runner resolved it *from* that file, so the
		// two agree, and the scanner needs it either way.
		assert.deepStrictEqual(laidOut[0], ['sonar.projectKey', 'my-app']);

		// A file that names only the tests has a layout too.
		const testsOnly = scannerProperties(scannerOptions({ fileProperties: ['sonar.tests'] }));
		assert.ok(!testsOnly.some(([key]) => key === 'sonar.sources'));

		// A file that says nothing about the layout still gets the default.
		const bare = scannerProperties(scannerOptions({ fileProperties: ['sonar.projectKey'] }));
		assert.ok(bare.some(([key, value]) => key === 'sonar.sources' && value === '.'));

		// A value the user typed into settings is a -D they asked for, and wins.
		const configured = scannerProperties(
			scannerOptions({ sources: 'src', fileProperties: ['sonar.sources'] })
		);
		assert.ok(configured.some(([key, value]) => key === 'sonar.sources' && value === 'src'));

		// The SCM default yields too; the worktree fix does not.
		const scm = scannerProperties(scannerOptions({ fileProperties: ['sonar.scm.disabled'] }));
		assert.ok(!scm.some(([key]) => key.startsWith('sonar.scm.')));
		const worktree = scannerProperties(
			scannerOptions({ scmDisabled: true, fileProperties: ['sonar.scm.provider'] })
		);
		assert.ok(worktree.some(([key, value]) => key === 'sonar.scm.disabled' && value === 'true'));
	});

	test('a worktree disables SCM rather than flooding the log', () => {
		// A worktree's `.git` is a file pointing outside the mount, so the scanner
		// finds a repository it cannot read.
		const properties = scannerProperties(scannerOptions({ scmDisabled: true }));
		assert.ok(properties.some(([key, value]) => key === 'sonar.scm.disabled' && value === 'true'));
		assert.ok(!properties.some(([key]) => key === 'sonar.scm.provider'));
	});

	test('a deployed server is reached by service name on the compose network', () => {
		// Never the published host port: this works identically on Docker Desktop,
		// native Linux, rootless, colima and a remote context, and no firewall or
		// loopback bind can break it.
		assert.deepStrictEqual(
			resolveEndpoint({ hostUrl: 'http://localhost:9000/', project: PROJECT, deployed: true }),
			{
				url: 'http://localhost:9000',
				containerUrl: 'http://sonarqube:9000',
				network: `${PROJECT}_default`
			}
		);
	});

	test('an external localhost server gets host.docker.internal on every platform', () => {
		// A container resolving `localhost` finds itself — the single most common
		// way a correct-looking setup fails.
		for (const host of ['localhost', '127.0.0.1']) {
			const endpoint = resolveEndpoint({
				hostUrl: `http://${host}:9000`,
				project: PROJECT,
				deployed: false
			});
			assert.strictEqual(endpoint.containerUrl, 'http://host.docker.internal:9000', host);
			assert.deepStrictEqual(endpoint.runFlags, [
				'--add-host',
				'host.docker.internal:host-gateway'
			]);
			assert.strictEqual(endpoint.network, undefined);
		}
	});

	test('an external server with a real hostname is left alone', () => {
		const endpoint = resolveEndpoint({
			hostUrl: 'https://sonarcloud.io/',
			project: PROJECT,
			deployed: false
		});
		assert.deepStrictEqual(endpoint, { url: 'https://sonarcloud.io' });
	});

	test('the network override is the loopback escape hatch', () => {
		const endpoint = resolveEndpoint({
			hostUrl: 'http://localhost:9000',
			project: PROJECT,
			deployed: false,
			networkOverride: 'host'
		});
		// `host` reaches a loopback-bound server on Linux, and the url needs no
		// rewrite because the container shares the host's network namespace.
		assert.strictEqual(endpoint.network, 'host');
		assert.strictEqual(endpoint.containerUrl, undefined);
	});
});
