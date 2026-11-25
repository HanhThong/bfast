import * as assert from 'assert';
import {
	markerToDescriptor,
	parseEnvironmentMarker,
	serializeEnvironmentMarker,
	type EnvironmentMarker
} from '../environments/environmentMarker';

const MARKER: EnvironmentMarker = {
	version: 1,
	ticketId: 'ST-1.2',
	kind: 'docker-compose',
	branch: 'bfast/ST-1.2',
	ports: { WEB_PORT: 20000, DB_PORT: 20001 },
	mainPort: 'WEB_PORT',
	createdAt: '2026-08-31T10:00:00.000Z',
	sourceRoot: 'd:/projects/my-app'
};

const MASTER: EnvironmentMarker = {
	version: 1,
	scope: 'master',
	kind: 'docker-compose',
	projectName: 'bfast-master-my-app',
	ports: { WEB_PORT: 20002 },
	mainPort: 'WEB_PORT',
	createdAt: '2026-09-05T10:00:00.000Z',
	sourceRoot: 'd:/projects/my-app'
};

suite('BFAST environment marker', () => {
	test('round-trips through serialize and parse', () => {
		assert.deepStrictEqual(
			parseEnvironmentMarker(JSON.parse(serializeEnvironmentMarker(MARKER))),
			MARKER
		);
	});

	test('serializes as stable two-space JSON with a trailing newline', () => {
		const text = serializeEnvironmentMarker(MARKER);
		assert.ok(text.endsWith('}\n'));
		assert.ok(text.includes('  "ticketId": "ST-1.2"'));
		// A ticket marker predates `scope`; not writing it keeps every existing
		// file byte-identical across a read and a write.
		assert.ok(!text.includes('"scope"'));
	});

	test('a master marker round-trips and needs no ticket id', () => {
		assert.deepStrictEqual(
			parseEnvironmentMarker(JSON.parse(serializeEnvironmentMarker(MASTER))),
			MASTER
		);
	});

	test('a master marker without a compose-legal project name or a source root is no marker at all', () => {
		const { projectName: _name, ...withoutName } = MASTER;
		const { sourceRoot: _root, ...withoutRoot } = MASTER;
		for (const raw of [
			withoutName,
			withoutRoot,
			{ ...MASTER, projectName: 'Bad Name' },
			{ ...MASTER, projectName: '-leading' },
			{ ...MASTER, sourceRoot: '  ' }
		]) {
			assert.strictEqual(parseEnvironmentMarker(raw), undefined, JSON.stringify(raw));
		}
	});

	test('a ticket marker still needs its ticket id, whatever master fields it carries', () => {
		assert.strictEqual(
			parseEnvironmentMarker({
				kind: 'docker-compose',
				projectName: 'bfast-master-x',
				sourceRoot: 'd:/x'
			}),
			undefined
		);
	});

	test('an unusable ticket id or kind is no marker at all', () => {
		for (const raw of [
			undefined,
			null,
			'text',
			{},
			{ ticketId: '  ', kind: 'docker-compose' },
			{ ticketId: 'ST-1', kind: 'vagrant' }
		]) {
			assert.strictEqual(parseEnvironmentMarker(raw), undefined);
		}
	});

	test('a worktree’s own MCP port round-trips, is written last, and is dropped when unusable', () => {
		const withMcp: EnvironmentMarker = { ...MARKER, mcpPort: 17712 };
		const text = serializeEnvironmentMarker(withMcp);
		assert.deepStrictEqual(parseEnvironmentMarker(JSON.parse(text)), withMcp);
		assert.ok(text.trimEnd().endsWith('"mcpPort": 17712\n}'), text);
		// The MCP server's bounds, not the stack's: below 1024 is still a port.
		assert.strictEqual(
			(parseEnvironmentMarker({ ...MARKER, mcpPort: 811 }) as { mcpPort?: number }).mcpPort,
			811
		);
		for (const mcpPort of [0, 70000, 1.5, '17712', null]) {
			assert.ok(!('mcpPort' in parseEnvironmentMarker({ ...MARKER, mcpPort })!), String(mcpPort));
		}
	});

	test('a mainPort off the prototype chain is not a main port', () => {
		// `'toString' in ports` would be true; the own-value check must not be.
		const parsed = parseEnvironmentMarker({
			ticketId: 'ST-1',
			kind: 'docker-compose',
			ports: { WEB_PORT: 20000 },
			mainPort: 'toString'
		});
		assert.strictEqual(parsed?.mainPort, undefined);
	});

	test('everything else degrades field by field', () => {
		const parsed = parseEnvironmentMarker({
			ticketId: 'ST-1',
			kind: 'docker-compose',
			ports: { GOOD: 20000, low: 80, junk: 'x' },
			mainPort: 'MISSING',
			branch: 42,
			createdAt: {}
		});
		assert.deepStrictEqual(parsed, {
			version: 1,
			ticketId: 'ST-1',
			kind: 'docker-compose',
			branch: '',
			ports: { GOOD: 20000 },
			createdAt: ''
		});
	});

	test('a descriptor carries the worktree path and everything persisted', () => {
		assert.deepStrictEqual(markerToDescriptor(MARKER, 'C:/tmp/wt'), {
			id: 'ST-1.2',
			scope: 'ticket',
			ticketId: 'ST-1.2',
			kind: 'docker-compose',
			branch: 'bfast/ST-1.2',
			worktreePath: 'C:/tmp/wt',
			// Derived here and nowhere else — never stored in a ticket marker.
			projectName: 'bfast-st-1-2',
			ports: { WEB_PORT: 20000, DB_PORT: 20001 },
			mainPort: 'WEB_PORT',
			createdAt: '2026-08-31T10:00:00.000Z'
		});
	});

	test('a master descriptor runs in the folder it is handed, under its recorded project', () => {
		assert.deepStrictEqual(markerToDescriptor(MASTER, 'd:/projects/my-app'), {
			id: 'master',
			scope: 'master',
			kind: 'docker-compose',
			// Filled in by the store from `.git/HEAD` when listed; the marker never holds it.
			branch: '',
			worktreePath: 'd:/projects/my-app',
			projectName: 'bfast-master-my-app',
			ports: { WEB_PORT: 20002 },
			mainPort: 'WEB_PORT',
			createdAt: '2026-09-05T10:00:00.000Z'
		});
	});
});
