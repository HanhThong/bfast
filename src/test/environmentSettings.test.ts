import * as assert from 'assert';
import {
	DEFAULT_COMPOSE_FILE,
	DEFAULT_LOG_TAIL,
	DEFAULT_PORT_RANGE_END,
	DEFAULT_PORT_RANGE_START,
	MAX_LOG_TAIL,
	environmentComposeFile,
	environmentComposeFiles,
	environmentLogTail,
	environmentMainPort,
	environmentPortRange,
	environmentProviderId,
	environmentWorktreesFolder,
	parseEnvironmentsSettings,
	parsePortVariableList,
	validateEnvironmentsSettings,
	validatePortVariableText,
	validateWorktreesFolder
} from '../settings/environmentSettings';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';

suite('BFAST environment settings', () => {
	test('returns undefined when nothing usable survives', () => {
		for (const raw of [undefined, null, 'nonsense', 42, {}, { provider: 'vagrant' }]) {
			assert.strictEqual(
				parseEnvironmentsSettings(raw),
				undefined,
				`${JSON.stringify(raw)} should be dropped`
			);
		}
	});

	test('keeps only a known provider, and k8s still loads', () => {
		assert.strictEqual(
			parseEnvironmentsSettings({ provider: 'docker-compose' })?.provider,
			'docker-compose'
		);
		// A hand-edited file naming the stub must still load; availability is
		// what says "not implemented", not the parser.
		assert.strictEqual(parseEnvironmentsSettings({ provider: 'k8s' })?.provider, 'k8s');
	});

	test('drops ports outside 1024–65535 on the way in', () => {
		for (const port of [80, 0, -1, 70000, 1.5, '20000', null]) {
			assert.strictEqual(
				parseEnvironmentsSettings({ portRangeStart: port })?.portRangeStart,
				undefined,
				`${String(port)} should be dropped`
			);
		}
		assert.strictEqual(parseEnvironmentsSettings({ portRangeStart: 20000 })?.portRangeStart, 20000);
	});

	test('filters, trims and dedupes port variable names', () => {
		assert.deepStrictEqual(
			parseEnvironmentsSettings({
				portVariables: [' WEB_PORT ', 'web_port', '2BAD', 'has space', 'DB_PORT', 42]
			})?.portVariables,
			['WEB_PORT', 'DB_PORT']
		);
	});

	test('refuses the reserved BFAST_ prefix in both directions', () => {
		// Forgiving on the way in…
		assert.strictEqual(parseEnvironmentsSettings({ portVariables: ['BFAST_X'] }), undefined);
		assert.strictEqual(parseEnvironmentsSettings({ portVariables: ['bfast_x'] }), undefined);
		// …and refused on the way out.
		assert.ok(validateEnvironmentsSettings({ portVariables: ['BFAST_X'] }));
	});

	test('drops a mainPort that names no variable', () => {
		assert.strictEqual(
			parseEnvironmentsSettings({ portVariables: ['A_PORT'], mainPort: 'B_PORT' })?.mainPort,
			undefined
		);
		assert.strictEqual(
			parseEnvironmentsSettings({ portVariables: ['A_PORT', 'B_PORT'], mainPort: 'B_PORT' })
				?.mainPort,
			'B_PORT'
		);
	});

	test('accessors fall back to the defaults', () => {
		assert.strictEqual(environmentProviderId(undefined), 'docker-compose');
		assert.deepStrictEqual(environmentPortRange(undefined), {
			start: DEFAULT_PORT_RANGE_START,
			end: DEFAULT_PORT_RANGE_END
		});
		assert.strictEqual(environmentComposeFile(undefined), DEFAULT_COMPOSE_FILE);
		// The main port defaults to the first variable.
		assert.strictEqual(environmentMainPort({ portVariables: ['A', 'B'] }), 'A');
		assert.strictEqual(environmentMainPort({ portVariables: ['A', 'B'], mainPort: 'B' }), 'B');
		assert.strictEqual(environmentMainPort(undefined), undefined);
	});

	test('a compose file that escapes the repo is dropped, not handed to path.join', () => {
		// The kept value would flow into `--file` with cwd = worktree, so the
		// forgiving read falls back to the default instead of keeping it.
		for (const composeFile of [
			'/abs/docker-compose.yml',
			'C:/abs/docker-compose.yml',
			'../../shared/docker-compose.yml',
			'..\\..\\shared\\docker-compose.yml'
		]) {
			assert.strictEqual(
				parseEnvironmentsSettings({ composeFile }),
				undefined,
				`${composeFile} should be dropped`
			);
		}
		assert.strictEqual(
			parseEnvironmentsSettings({ composeFile: '.\\deploy\\compose.yml' })?.composeFile,
			'deploy/compose.yml'
		);
	});

	test('validate checks the compose file on its normalized form', () => {
		// On the raw string a backslash path is one '/'-segment and would pass.
		assert.ok(validateEnvironmentsSettings({ composeFile: '..\\..\\shared\\compose.yml' }));
		assert.ok(validateEnvironmentsSettings({ composeFile: '\\\\server\\share\\compose.yml' }));
	});

	test('override files follow the same path rules, keep their order, and chain after the base', () => {
		assert.deepStrictEqual(
			parseEnvironmentsSettings({
				composeOverrides: ['docker-compose.bfast.yml', '../outside.yml', '  ', 42, 'deploy\\extra.yml']
			})?.composeOverrides,
			['docker-compose.bfast.yml', 'deploy/extra.yml']
		);
		// Refused on the way out; an empty row is dropped, never refused.
		assert.ok(validateEnvironmentsSettings({ composeOverrides: ['..\\outside.yml'] }));
		assert.strictEqual(validateEnvironmentsSettings({ composeOverrides: ['', 'a.yml'] }), undefined);
		// The provider consumes one chain: base first, overrides in order.
		assert.deepStrictEqual(environmentComposeFiles(undefined), ['docker-compose.yml']);
		assert.deepStrictEqual(
			environmentComposeFiles({ composeFile: 'base.yml', composeOverrides: ['a.yml', 'b.yml'] }),
			['base.yml', 'a.yml', 'b.yml']
		);
	});

	test('the raw port-variable text is refused where the parse would silently drop', () => {
		assert.ok(validatePortVariableText('BFAST_WEB, DB_PORT'));
		assert.ok(validatePortVariableText('WEB-PORT'));
		assert.ok(validatePortVariableText('2BAD'));
		assert.strictEqual(validatePortVariableText('WEB_PORT, DB_PORT'), undefined);
		assert.strictEqual(validatePortVariableText('  '), undefined);
	});

	test('validate refuses what parse merely drops', () => {
		assert.ok(validateEnvironmentsSettings({ portRangeStart: 80 }));
		assert.ok(validateEnvironmentsSettings({ portRangeStart: 21000, portRangeEnd: 20000 }));
		assert.ok(
			validateEnvironmentsSettings({
				portRangeStart: 20000,
				portRangeEnd: 20001,
				portVariables: ['A', 'B', 'C']
			})
		);
		assert.ok(validateEnvironmentsSettings({ portVariables: ['2BAD'] }));
		assert.ok(validateEnvironmentsSettings({ portVariables: ['A'], mainPort: 'B' }));
		assert.ok(validateEnvironmentsSettings({ composeFile: '/abs/compose.yml' }));
		assert.ok(validateEnvironmentsSettings({ composeFile: '../outside.yml' }));
		assert.strictEqual(
			validateEnvironmentsSettings({
				provider: 'docker-compose',
				portVariables: ['WEB_PORT', 'DB_PORT'],
				mainPort: 'WEB_PORT',
				composeFile: 'deploy/compose.yml'
			}),
			undefined
		);
		assert.strictEqual(validateEnvironmentsSettings(undefined), undefined);
	});

	test('the form and the parser read a variable list the same way', () => {
		assert.deepStrictEqual(parsePortVariableList(' WEB_PORT, db_port  AUTH_PORT '), [
			'WEB_PORT',
			'db_port',
			'AUTH_PORT'
		]);
		assert.deepStrictEqual(parsePortVariableList('WEB_PORT, web_port'), ['WEB_PORT']);
		assert.deepStrictEqual(parsePortVariableList(''), []);
	});

	test('bfast.json omits an empty environments block entirely', () => {
		// The byte-identical rule: a workspace that never uses environments
		// writes no key at all — same posture as the `ai` block.
		const parsed = parseSettings({ trackerFolder: '.tracker', userName: 'x', environments: {} });
		assert.ok(!('environments' in parsed));

		const normalized = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'x',
			environments: { portVariables: [] }
		});
		assert.ok(!('environments' in normalized));

		const kept = normalizeSettings({
			trackerFolder: '.tracker',
			userName: 'x',
			environments: { portVariables: ['WEB_PORT'] }
		});
		assert.deepStrictEqual(kept.environments, { portVariables: ['WEB_PORT'] });
	});
	test('worktreesFolder reads forgivingly, refuses strictly, and survives a write', () => {
		// Forgiving on the way in: a value that would put a worktree inside the
		// repository — or nowhere at all — is dropped so the default applies.
		for (const bad of ['', '   ', 'worktrees', './worktrees', '../worktrees', '~user/wt', 'C:wt', 42, null]) {
			assert.strictEqual(
				parseEnvironmentsSettings({ worktreesFolder: bad })?.worktreesFolder,
				undefined,
				`${JSON.stringify(bad)} should be dropped`
			);
		}

		// Absolute and ~-relative both survive, normalized to forward slashes and
		// without a trailing one, so the same folder is one string either way.
		assert.strictEqual(
			parseEnvironmentsSettings({ worktreesFolder: '~/bfast-worktrees' })?.worktreesFolder,
			'~/bfast-worktrees'
		);
		assert.strictEqual(parseEnvironmentsSettings({ worktreesFolder: '~' })?.worktreesFolder, '~');
		assert.strictEqual(
			parseEnvironmentsSettings({ worktreesFolder: 'D:\\dev\\worktrees\\' })?.worktreesFolder,
			'D:/dev/worktrees'
		);
		assert.strictEqual(
			parseEnvironmentsSettings({ worktreesFolder: '  /var/tmp/wt  ' })?.worktreesFolder,
			'/var/tmp/wt'
		);

		// The accessor deliberately does not default: naming <os temp> here would
		// drag `os` into a module the settings webview bundles.
		assert.strictEqual(environmentWorktreesFolder(undefined), undefined);
		assert.strictEqual(environmentWorktreesFolder({ logTail: 5 }), undefined);
		assert.strictEqual(environmentWorktreesFolder({ worktreesFolder: '~/wt' }), '~/wt');

		// Strict on the way out: what the parse would silently drop, the form
		// refuses — otherwise the typo saves fine and the next Create Environment
		// quietly uses the temp folder instead.
		assert.ok(validateEnvironmentsSettings({ worktreesFolder: 'worktrees' }));
		assert.ok(validateEnvironmentsSettings({ worktreesFolder: '/var/tmp/../wt' }));
		assert.ok(validateEnvironmentsSettings({ worktreesFolder: '/var/tmp/w?t' }));
		assert.strictEqual(validateEnvironmentsSettings({ worktreesFolder: '~/wt' }), undefined);
		// A backslash path is checked in its normalized form, the
		// `validateComposePath` order: on the raw string it is one '/'-segment
		// and the '..' check would never see it.
		assert.ok(validateWorktreesFolder('D:\\dev\\..\\wt'));
		// An empty field is how the form says "use the default", never an error.
		assert.strictEqual(validateWorktreesFolder(''), undefined);

		// And it survives a write: `normalizeSettings` returns a fresh literal,
		// so a field it does not name is dropped on every save.
		assert.deepStrictEqual(
			normalizeSettings({
				trackerFolder: '.tracker',
				userName: 'x',
				environments: { worktreesFolder: '~/wt' }
			}).environments,
			{ worktreesFolder: '~/wt' }
		);
	});

	test('logTail reads forgivingly, refuses strictly, and survives a write', () => {
		// Forgiving on the way in: a value out of range in a hand-edited or
		// pulled file is dropped so the default applies — `portRangeStart`'s rule.
		for (const bad of [-1, 1.5, MAX_LOG_TAIL + 1, '500', null]) {
			assert.strictEqual(
				parseEnvironmentsSettings({ logTail: bad })?.logTail,
				undefined,
				`${JSON.stringify(bad)} should be dropped`
			);
		}

		// Zero is a real answer — 'only what happens from now on' — so it must
		// survive the parse and beat the default in the accessor.
		assert.strictEqual(parseEnvironmentsSettings({ logTail: 0 })?.logTail, 0);
		assert.strictEqual(environmentLogTail({ logTail: 0 }), 0);
		assert.strictEqual(parseEnvironmentsSettings({ logTail: 250 })?.logTail, 250);
		assert.strictEqual(environmentLogTail(undefined), DEFAULT_LOG_TAIL);
		assert.strictEqual(environmentLogTail({ portVariables: [] }), DEFAULT_LOG_TAIL);

		// Strict on the way out: the form refuses what the parse would silently
		// drop, so a typo cannot be saved and then surface as a surprise.
		assert.ok(validateEnvironmentsSettings({ logTail: -1 }));
		assert.ok(validateEnvironmentsSettings({ logTail: 1.5 }));
		assert.ok(validateEnvironmentsSettings({ logTail: MAX_LOG_TAIL + 1 }));
		assert.strictEqual(validateEnvironmentsSettings({ logTail: MAX_LOG_TAIL }), undefined);

		// And it survives a write: `normalizeSettings` returns a fresh literal,
		// so a field it does not name is dropped on every save.
		assert.deepStrictEqual(
			normalizeSettings({ trackerFolder: '.tracker', userName: 'x', environments: { logTail: 50 } })
				.environments,
			{ logTail: 50 }
		);
	});
});
