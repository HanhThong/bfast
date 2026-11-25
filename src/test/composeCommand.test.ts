import * as assert from 'assert';
import {
	composeDestroyArgs,
	composeDownArgs,
	composeLsArgs,
	composePsArgs,
	composeUpArgs,
	composeVersionArgs,
	dockerLogsArgs,
	parseComposeLs,
	parseComposePs,
	stackStatusFromContainers
} from '../environments/composeCommand';
import { reclaimOwnershipArgs } from '../environments/dockerComposeProvider';
import {
	environmentLabel,
	environmentProjectName,
	stackEnvironment
} from '../environments/environmentProvider';
import { masterProjectName } from '../environments/environmentStore';

suite('BFAST compose command', () => {
	test('the argv arrays are exactly what the docs promise', () => {
		// docs/environments/docker-compose.md documents these verbatim; changing
		// one is a contract change, not a refactor.
		assert.deepStrictEqual(composeUpArgs('bfast-st-1-2', ['docker-compose.yml']), [
			'compose',
			'-p',
			'bfast-st-1-2',
			'--file',
			'docker-compose.yml',
			'up',
			'-d',
			'--build',
			'--force-recreate'
		]);
		assert.deepStrictEqual(composeDownArgs('p', ['f.yml']), [
			'compose',
			'-p',
			'p',
			'--file',
			'f.yml',
			'down'
		]);
		assert.deepStrictEqual(composeDestroyArgs('p', ['f.yml']), [
			'compose',
			'-p',
			'p',
			'--file',
			'f.yml',
			'down',
			'--volumes',
			'--remove-orphans'
		]);
		assert.deepStrictEqual(composeLsArgs(), ['compose', 'ls', '--all', '--format', 'json']);
		assert.deepStrictEqual(composeVersionArgs(), ['compose', 'version']);
	});

	test('override files become extra --file flags, base first, in order', () => {
		assert.deepStrictEqual(
			composeUpArgs('p', ['docker-compose.yml', 'docker-compose.bfast.yml', 'extra.yml']),
			[
				'compose',
				'-p',
				'p',
				'--file',
				'docker-compose.yml',
				'--file',
				'docker-compose.bfast.yml',
				'--file',
				'extra.yml',
				'up',
				'-d',
				'--build',
				'--force-recreate'
			]
		);
	});

	test('project names satisfy compose and are stable per ticket', () => {
		assert.strictEqual(environmentProjectName('ST-1.2'), 'bfast-st-1-2');
		assert.strictEqual(environmentProjectName('EP-10'), 'bfast-ep-10');
		assert.strictEqual(environmentProjectName('...'), 'bfast-ticket');
	});

	test('stackEnvironment is the whole contract a stack receives', () => {
		assert.deepStrictEqual(
			stackEnvironment({
				id: 'ST-1.2',
				scope: 'ticket',
				ticketId: 'ST-1.2',
				kind: 'docker-compose',
				branch: 'bfast/ST-1.2',
				worktreePath: 'x',
				projectName: 'bfast-st-1-2',
				ports: { WEB_PORT: 20000, DB_PORT: 20001 },
				createdAt: ''
			}),
			{
				WEB_PORT: '20000',
				DB_PORT: '20001',
				BFAST_TICKET_ID: 'ST-1.2',
				BFAST_PROJECT_NAME: 'bfast-st-1-2'
			}
		);
	});

	test('the master environment gets an empty ticket id — set, never missing — and its own project', () => {
		// Set but empty: compose warns on stderr for every unset variable a file
		// mentions, and `${BFAST_TICKET_ID:?}` still refuses on empty.
		assert.deepStrictEqual(
			stackEnvironment({
				id: 'master',
				scope: 'master',
				kind: 'docker-compose',
				branch: 'main',
				worktreePath: 'x',
				projectName: 'bfast-master-my-app',
				ports: { WEB_PORT: 20000 },
				createdAt: ''
			}),
			{
				WEB_PORT: '20000',
				BFAST_TICKET_ID: '',
				BFAST_PROJECT_NAME: 'bfast-master-my-app'
			}
		);
	});

	test('the master project name carries the workspace slug, so two repos cannot share a stack', () => {
		assert.strictEqual(masterProjectName('/tmp/bfast-worktrees/my-app'), 'bfast-master-my-app');
		// Re-slugged: a hand-made root still yields a compose-legal name.
		assert.strictEqual(masterProjectName('/tmp/bfast-worktrees/Odd Name'), 'bfast-master-odd-name');
	});

	test('messages name a ticket by id and the master environment by what it is', () => {
		assert.strictEqual(environmentLabel('ST-1.2'), 'environment ST-1.2');
		assert.strictEqual(environmentLabel('master'), 'the master environment');
	});

	test('the ownership-reclaim container mounts only the worktree', () => {
		// Delete's answer to root-owned bind-mount files on Linux: docker made
		// them, a throwaway container chowns them back before the folder goes.
		assert.deepStrictEqual(reclaimOwnershipArgs('/tmp/bfast-worktrees/app/ST-1', 1000, 1000), [
			'run',
			'--rm',
			'-v',
			'/tmp/bfast-worktrees/app/ST-1:/bfast-worktree',
			'alpine',
			'chown',
			'-R',
			'1000:1000',
			'/bfast-worktree'
		]);
	});

	test('a finished one-shot job does not make a running stack partial', () => {
		// The wordy shape: `compose ls` says `exited(1), running(6)` because an
		// install service exited 0 once it had done its work.
		const job = (exitCode: number | undefined) => ({
			id: 'w',
			name: 'p-workspace-1',
			service: 'workspace',
			state: 'exited' as const,
			status: 'Exited',
			...(exitCode === undefined ? {} : { exitCode })
		});
		const api = { id: 'a', name: 'p-api-1', service: 'api', state: 'running' as const, status: 'Up' };
		assert.strictEqual(stackStatusFromContainers([api, job(0)]), 'running');
		// A service that died is still the error it always was.
		assert.strictEqual(stackStatusFromContainers([api, job(1)]), 'partial');
		// No exit code reported: not assumed to be a clean finish.
		assert.strictEqual(stackStatusFromContainers([api, job(undefined)]), 'partial');
		assert.strictEqual(
			stackStatusFromContainers([api, { ...api, id: 'r', state: 'restarting' as const }]),
			'partial'
		);
		// Nothing running is stopped, however cleanly everything exited.
		assert.strictEqual(stackStatusFromContainers([job(0)]), 'stopped');
		assert.strictEqual(stackStatusFromContainers([]), 'stopped');
	});

	test('parseComposeLs maps status lines onto the projects asked about', () => {
		const listing = JSON.stringify([
			{ Name: 'bfast-st-1', Status: 'running(3)' },
			{ Name: 'bfast-st-2', Status: 'running(1), exited(1)' },
			{ Name: 'bfast-st-3', Status: 'exited(2)' },
			{ Name: 'bfast-st-4', Status: 'created(2)' },
			{ Name: 'bfast-st-5', Status: 'gibberish' }
		]);
		const statuses = parseComposeLs(listing, [
			'bfast-st-1',
			'bfast-st-2',
			'bfast-st-3',
			'bfast-st-4',
			'bfast-st-5',
			'bfast-st-absent'
		]);
		assert.strictEqual(statuses.get('bfast-st-1'), 'running');
		assert.strictEqual(statuses.get('bfast-st-2'), 'partial');
		assert.strictEqual(statuses.get('bfast-st-3'), 'stopped');
		assert.strictEqual(statuses.get('bfast-st-4'), 'stopped');
		// An unrecognisable state string still counts its non-running segments.
		assert.strictEqual(statuses.get('bfast-st-5'), 'stopped');
		// Absent means never started, which is stopped — not unknown.
		assert.strictEqual(statuses.get('bfast-st-absent'), 'stopped');
	});

	test('junk output maps every project to unknown, never throws', () => {
		for (const junk of ['', 'not json', '{"Name":"x"}']) {
			const statuses = parseComposeLs(junk, ['a', 'b']);
			if (junk === '{"Name":"x"}') {
				// Parses but is not a listing: nothing matches, so never-started.
				assert.strictEqual(statuses.get('a'), 'stopped');
			} else {
				assert.strictEqual(statuses.get('a'), 'unknown');
				assert.strictEqual(statuses.get('b'), 'unknown');
			}
		}
	});
});

/**
 * The container listing and the log follow — docs/environments/container-logs.md
 * is the spec, and the whole point of both argv arrays is what they do *not*
 * carry: no cwd, no `--file`, none of the stack's variables. A compose file
 * that is missing or will not parse is the state a failing environment is most
 * likely to be in, and it must not be able to hide the containers.
 */
suite('BFAST container listing', () => {
	test('the argv arrays are exactly what the docs promise', () => {
		assert.deepStrictEqual(composePsArgs('bfast-st-1-2'), [
			'compose',
			'-p',
			'bfast-st-1-2',
			'ps',
			'--all',
			'--format',
			'json'
		]);
		assert.deepStrictEqual(dockerLogsArgs('abc123', 1000), [
			'logs',
			'--follow',
			'--tail',
			'1000',
			'abc123'
		]);
		// A tail of nothing is a real answer — "only what happens from now on" —
		// and must reach docker as `0`, not be dropped as falsy.
		assert.deepStrictEqual(dockerLogsArgs('abc123', 0).slice(2), ['--tail', '0', 'abc123']);
	});

	test('reads the newline-delimited objects compose writes today', () => {
		const containers = parseComposePs(
			[
				'{"ID":"aaa","Name":"bfast-st-1-2-web-1","Service":"web","State":"running","Status":"Up 3 minutes (healthy)","ExitCode":0}',
				'{"ID":"bbb","Name":"bfast-st-1-2-api-1","Service":"api","State":"exited","Status":"Exited (1) 12 seconds ago","ExitCode":1}'
			].join('\n')
		);

		// Sorted by name, so a ten-second poll does not shuffle the sidebar.
		assert.deepStrictEqual(
			containers.map((container) => container.service),
			['api', 'web']
		);
		assert.deepStrictEqual(containers[0], {
			id: 'bbb',
			name: 'bfast-st-1-2-api-1',
			service: 'api',
			state: 'exited',
			status: 'Exited (1) 12 seconds ago',
			exitCode: 1
		});
		// `ExitCode: 0` is reported for a running container too, so it is only
		// read where it means something — a tooltip must not claim a healthy
		// service "exited with 0".
		assert.strictEqual(containers[1].exitCode, undefined);
	});

	test('reads the JSON array older compose versions write', () => {
		const containers = parseComposePs(
			'[{"ID":"aaa","Name":"p-web-1","Service":"web","State":"running","Status":"Up 3 minutes"}]'
		);
		assert.strictEqual(containers.length, 1);
		assert.strictEqual(containers[0].state, 'running');
	});

	test('junk never throws, and never loses the containers beside it', () => {
		for (const junk of ['', '   ', 'not json', '[]', '{"Name":"x"}']) {
			assert.doesNotThrow(() => parseComposePs(junk));
		}
		// A container with no name at all cannot be shown or followed; one
		// beside it still can, so a half-readable listing still names the
		// service that died.
		const containers = parseComposePs(
			[
				'a warning compose printed onto stdout',
				'{"State":"running"}',
				'{"ID":"bbb","Name":"p-api-1","Service":"api","State":"exited","Status":"Exited (1)","ExitCode":1}'
			].join('\n')
		);
		assert.deepStrictEqual(
			containers.map((container) => container.id),
			['bbb']
		);
	});

	test('a state the backend words differently degrades to unknown, never a guess', () => {
		const containers = parseComposePs(
			'{"ID":"a","Name":"p-web-1","Service":"web","State":"Removing","Status":"Removing"}'
		);
		assert.strictEqual(containers[0].state, 'unknown');
	});

	test('a record carrying only one of id and name still works — docker logs takes either', () => {
		const byName = parseComposePs('{"Names":"p-web-1","Service":"web","State":"running"}');
		assert.strictEqual(byName[0].id, 'p-web-1');
		assert.strictEqual(byName[0].name, 'p-web-1');

		const byId = parseComposePs('{"ID":"aaa","State":"running"}');
		assert.strictEqual(byId[0].name, 'aaa');
		// With no service reported the row still has a label rather than a blank.
		assert.strictEqual(byId[0].service, 'aaa');
	});
});
