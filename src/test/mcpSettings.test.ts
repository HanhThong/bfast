import * as assert from 'assert';
import { normalizeSettings, parseSettings } from '../settings/bfastSettings';
import {
	DEFAULT_MCP_FUNCTIONS,
	DEFAULT_MCP_PORT,
	DEFAULT_MCP_REACH,
	MAX_MCP_PORT,
	MCP_ENDPOINT_PATH,
	MCP_FUNCTION_IDS,
	MIN_MCP_PORT,
	mcpAddress,
	mcpBindHost,
	mcpEnabled,
	mcpFunctionEnabled,
	mcpFunctions,
	mcpPort,
	mcpReach,
	normalizeMcpSettings,
	parseMcpSettings,
	validateMcpPortText,
	validateMcpSettings
} from '../settings/mcpSettings';

suite('MCP settings', () => {
	test('parseMcpSettings answers undefined when nothing usable survived', () => {
		for (const raw of [
			undefined,
			null,
			'nonsense',
			42,
			{},
			{ enabled: false },
			{ enabled: 'yes' },
			{ port: 'seven' },
			{ port: 0 },
			{ port: MAX_MCP_PORT + 1 },
			{ port: 7711.5 },
			// The default never creates a key.
			{ port: DEFAULT_MCP_PORT },
			{ reach: 'local' },
			{ reach: 'everywhere' },
			{ functions: 'read' },
			// Exactly the default list, in any spelling, is not a deviation.
			{ functions: ['read'] },
			{ functions: ['read', 'read'] },
			{ functions: ['read', 'telepathy'] }
		]) {
			assert.strictEqual(parseMcpSettings(raw), undefined, JSON.stringify(raw));
		}
	});

	test('only the values that differ from a default are kept', () => {
		assert.deepStrictEqual(parseMcpSettings({ enabled: true }), { enabled: true });
		assert.deepStrictEqual(parseMcpSettings({ port: 9000 }), { port: 9000 });
		assert.deepStrictEqual(parseMcpSettings({ reach: 'network' }), { reach: 'network' });
		assert.deepStrictEqual(parseMcpSettings({ enabled: true, port: DEFAULT_MCP_PORT }), {
			enabled: true
		});
	});

	test('an empty function list is a real answer and survives the round trip', () => {
		// "Everything switched off" and "the default" have to be tellable apart:
		// the first is a server a client connects to and finds nothing to do.
		const parsed = parseMcpSettings({ enabled: true, functions: [] });
		assert.deepStrictEqual(parsed, { enabled: true, functions: [] });
		assert.deepStrictEqual(normalizeMcpSettings(parsed), { enabled: true, functions: [] });
		assert.deepStrictEqual(mcpFunctions(parsed), []);
	});

	test('a function list is read in MCP_FUNCTION_IDS order, unknown names dropped', () => {
		const parsed = parseMcpSettings({ functions: ['tests', 'telepathy', 'read', 'tests'] });
		assert.deepStrictEqual(parsed, { functions: ['read', 'tests'] });
		assert.deepStrictEqual(mcpFunctions(parsed), ['read', 'tests']);
	});

	test('reading is forgiving, writing is strict', () => {
		// Anything the parse accepts, validate accepts too — a pulled or
		// hand-edited file never opens the form pre-invalid.
		for (const raw of [
			{ port: 70000 },
			{ reach: 'everywhere' },
			{ functions: ['telepathy'] },
			{ enabled: true, port: 9000, reach: 'network', functions: ['read', 'write'] }
		]) {
			assert.strictEqual(validateMcpSettings(parseMcpSettings(raw)), undefined, JSON.stringify(raw));
		}

		// …while a value that never came through the parse is refused.
		assert.ok(validateMcpSettings({ port: 0 }));
		assert.ok(validateMcpSettings({ port: MAX_MCP_PORT + 1 }));
		assert.ok(validateMcpSettings({ reach: 'everywhere' as never }));
		assert.ok(validateMcpSettings({ functions: ['telepathy' as never] }));
		assert.strictEqual(validateMcpSettings(undefined), undefined);
	});

	test('the port field refuses empty and non-numeric text, but only while the server is on', () => {
		// The parse turns an unusable value into "use the default", so the raw
		// text is the only place an erased field can be caught.
		assert.ok(validateMcpPortText('', true));
		assert.ok(validateMcpPortText('   ', true));
		assert.ok(validateMcpPortText('seven', true));
		assert.ok(validateMcpPortText('80.5', true));
		assert.ok(validateMcpPortText('0', true));
		assert.ok(validateMcpPortText(String(MAX_MCP_PORT + 1), true));

		assert.strictEqual(validateMcpPortText(String(DEFAULT_MCP_PORT), true), undefined);
		assert.strictEqual(validateMcpPortText(String(MIN_MCP_PORT), true), undefined);
		assert.strictEqual(validateMcpPortText(' 9000 ', true), undefined);

		// An empty field under a server that is off is not a mistake.
		assert.strictEqual(validateMcpPortText('', false), undefined);
		assert.strictEqual(validateMcpPortText('seven', false), undefined);
	});

	test('the accessors answer the defaults for an absent block', () => {
		assert.strictEqual(mcpEnabled(undefined), false);
		assert.strictEqual(mcpPort(undefined), DEFAULT_MCP_PORT);
		assert.strictEqual(mcpReach(undefined), DEFAULT_MCP_REACH);
		assert.deepStrictEqual(mcpFunctions(undefined), [...DEFAULT_MCP_FUNCTIONS]);
		assert.strictEqual(mcpFunctionEnabled(undefined, 'read'), true);
		for (const id of MCP_FUNCTION_IDS.filter((candidate) => candidate !== 'read')) {
			assert.strictEqual(mcpFunctionEnabled(undefined, id), false, id);
		}
	});

	test('reach picks the interface, and an address is never 0.0.0.0', () => {
		assert.strictEqual(mcpBindHost('local'), '127.0.0.1');
		assert.strictEqual(mcpBindHost('network'), '0.0.0.0');
		assert.strictEqual(mcpAddress('127.0.0.1', 7711), `http://127.0.0.1:7711${MCP_ENDPOINT_PATH}`);
		// An IPv6 literal has to be bracketed to be a url at all.
		assert.strictEqual(mcpAddress('::1', 80), `http://[::1]:80${MCP_ENDPOINT_PATH}`);
	});

	test('a workspace that never switches the server on writes no mcp key', () => {
		const settings = parseSettings({ trackerFolder: '.tracker', userName: 'Tester' });
		assert.deepStrictEqual(settings, { trackerFolder: '.tracker', userName: 'Tester' });
		assert.deepStrictEqual(normalizeSettings(settings), {
			trackerFolder: '.tracker',
			userName: 'Tester'
		});
	});

	test('the mcp block round-trips through the whole settings file', () => {
		const raw = {
			trackerFolder: '.tracker',
			userName: 'Tester',
			mcp: { enabled: true, port: 9001, reach: 'network', functions: ['read', 'tests'] }
		};
		const parsed = parseSettings(raw);
		assert.deepStrictEqual(parsed.mcp, {
			enabled: true,
			port: 9001,
			reach: 'network',
			functions: ['read', 'tests']
		});
		assert.deepStrictEqual(normalizeSettings(parsed).mcp, parsed.mcp);
	});
});
