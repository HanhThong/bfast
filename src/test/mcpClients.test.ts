import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	DEFAULT_MCP_CLIENT,
	MCP_CLIENTS,
	MCP_SERVER_NAME,
	isMcpClientId,
	mcpClient,
	mcpClientSnippet,
	mergeMcpClientConfig,
	retargetMcpClientConfig
} from '../mcp/mcpClients';
import { saveMcpClientConfig } from '../mcp/mcpClientFiles';

const ADDRESS = 'http://127.0.0.1:7711/mcp';

/** A scratch "workspace folder" of this suite's own — the `.tracker*` ignore covers it. */
const ROOT = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '.tracker-mcp-clients');

async function read(path: string): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(
			await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ROOT, ...path.split('/')))
		);
	} catch {
		return undefined;
	}
}

async function write(path: string, text: string): Promise<void> {
	const uri = vscode.Uri.joinPath(ROOT, ...path.split('/'));
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

async function reset(): Promise<void> {
	try {
		await vscode.workspace.fs.delete(ROOT, { recursive: true, useTrash: false });
	} catch {
		// Nothing there yet, which is the state we wanted anyway.
	}
}

suite('MCP clients — ST-1.12 choose the AI coding tool', () => {
	setup(reset);
	suiteTeardown(reset);

	test('every tool has a label and a snippet naming the address, and the ids are closed', () => {
		for (const client of MCP_CLIENTS) {
			assert.ok(client.label.length > 0, client.id);
			assert.ok(isMcpClientId(client.id));
			assert.strictEqual(mcpClient(client.id), client);
			const snippet = mcpClientSnippet(client.id, ADDRESS);
			assert.ok(snippet.includes(ADDRESS), `${client.id} snippet names the address`);
			assert.ok(snippet.includes(MCP_SERVER_NAME), `${client.id} snippet names the server`);
		}
		assert.strictEqual(isMcpClientId('cursor'), false);
		assert.strictEqual(isMcpClientId(undefined), false);
	});

	test('each snippet is in the tool’s own shape, not BFAST’s address alone', () => {
		assert.deepStrictEqual(JSON.parse(mcpClientSnippet('vscode', ADDRESS)), {
			servers: { bfast: { type: 'http', url: ADDRESS } }
		});
		assert.strictEqual(
			mcpClientSnippet('claude-code', ADDRESS),
			`claude mcp add --transport http bfast ${ADDRESS}`
		);
		assert.strictEqual(
			mcpClientSnippet('codex', ADDRESS),
			`[mcp_servers.bfast]\nurl = "${ADDRESS}"`
		);
	});

	test('a tool with only a personal config file offers no project file, so only Copy applies', () => {
		assert.strictEqual(mcpClient('codex').projectFile, undefined);
		const merge = mergeMcpClientConfig('codex', undefined, ADDRESS);
		assert.strictEqual(merge.ok, false);
		assert.ok(!merge.ok && /Copy/.test(merge.reason));

		assert.deepStrictEqual(mcpClient('vscode').projectFile, {
			path: '.vscode/mcp.json',
			container: 'servers'
		});
		assert.deepStrictEqual(mcpClient('claude-code').projectFile, {
			path: '.mcp.json',
			container: 'mcpServers'
		});
	});

	test('merging into no file creates the tool’s document with the bfast entry alone', () => {
		for (const existing of [undefined, '', '  \n']) {
			const merge = mergeMcpClientConfig('vscode', existing, ADDRESS);
			assert.ok(merge.ok);
			assert.deepStrictEqual(JSON.parse(merge.text), {
				servers: { bfast: { type: 'http', url: ADDRESS } }
			});
			assert.ok(merge.text.endsWith('\n'));
		}
		const claude = mergeMcpClientConfig('claude-code', undefined, ADDRESS);
		assert.ok(claude.ok);
		assert.deepStrictEqual(JSON.parse(claude.text), {
			mcpServers: { bfast: { type: 'http', url: ADDRESS } }
		});
	});

	test('merging keeps every other server and every other key, and replaces only bfast', () => {
		const existing = JSON.stringify({
			inputs: [{ id: 'token', type: 'promptString' }],
			servers: {
				github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
				bfast: { type: 'http', url: 'http://127.0.0.1:9000/mcp' }
			}
		});
		const merge = mergeMcpClientConfig('vscode', existing, ADDRESS);
		assert.ok(merge.ok);
		assert.deepStrictEqual(JSON.parse(merge.text), {
			inputs: [{ id: 'token', type: 'promptString' }],
			servers: {
				github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
				bfast: { type: 'http', url: ADDRESS }
			}
		});
	});

	test('a file that cannot be read as a JSON object is refused, naming the file', () => {
		for (const existing of [
			'{ "servers": { "github": ',
			'// a comment\n{ "servers": {} }',
			'[1, 2, 3]',
			'"just a string"',
			'null',
			'{ "servers": [] }',
			'{ "servers": "nope" }'
		]) {
			const merge = mergeMcpClientConfig('vscode', existing, ADDRESS);
			assert.strictEqual(merge.ok, false, existing);
			assert.ok(!merge.ok && merge.reason.includes('.vscode/mcp.json'), existing);
			assert.ok(!merge.ok && /nothing was written/.test(merge.reason), existing);
		}
	});

	test('saveMcpClientConfig writes the entry under the folder and merges on a second save', async () => {
		assert.strictEqual(await saveMcpClientConfig(ROOT, 'vscode', ADDRESS), '.vscode/mcp.json');
		assert.deepStrictEqual(JSON.parse((await read('.vscode/mcp.json'))!), {
			servers: { bfast: { type: 'http', url: ADDRESS } }
		});

		// Someone adds another server by hand; the next save keeps it and moves ours.
		await write(
			'.vscode/mcp.json',
			JSON.stringify({
				servers: { other: { type: 'stdio', command: 'other-mcp' }, bfast: { type: 'http', url: ADDRESS } }
			})
		);
		const moved = 'http://127.0.0.1:7712/mcp';
		await saveMcpClientConfig(ROOT, 'vscode', moved);
		assert.deepStrictEqual(JSON.parse((await read('.vscode/mcp.json'))!), {
			servers: { other: { type: 'stdio', command: 'other-mcp' }, bfast: { type: 'http', url: moved } }
		});

		assert.strictEqual(await saveMcpClientConfig(ROOT, 'claude-code', ADDRESS), '.mcp.json');
		assert.deepStrictEqual(JSON.parse((await read('.mcp.json'))!), {
			mcpServers: { bfast: { type: 'http', url: ADDRESS } }
		});
	});

	test('saveMcpClientConfig leaves a malformed file byte-identical and rejects with the reason', async () => {
		const broken = '{ "servers": { "github": { "type": "http" }, // trailing comment\n}';
		await write('.vscode/mcp.json', broken);
		await assert.rejects(saveMcpClientConfig(ROOT, 'vscode', ADDRESS), /could not be read as JSON/);
		assert.strictEqual(await read('.vscode/mcp.json'), broken);
	});

	test('Connect a tool opens on Claude Code, which heads the list', () => {
		assert.strictEqual(DEFAULT_MCP_CLIENT, 'claude-code');
		assert.strictEqual(MCP_CLIENTS[0].id, DEFAULT_MCP_CLIENT);
	});

	test('retargeting moves only the bfast entry’s port, and keeps every other key and server', () => {
		const existing = JSON.stringify({
			inputs: [{ id: 'token' }],
			mcpServers: {
				github: { type: 'http', url: 'http://127.0.0.1:17711/other' },
				bfast: { type: 'http', url: 'http://127.0.0.1:17711/mcp', headers: { x: '1' } }
			}
		});
		const retargeted = retargetMcpClientConfig('claude-code', existing, 17711, 17712);
		assert.ok(retargeted?.endsWith('\n'));
		assert.deepStrictEqual(JSON.parse(retargeted!), {
			inputs: [{ id: 'token' }],
			mcpServers: {
				// Another server on the same port is not ours to move.
				github: { type: 'http', url: 'http://127.0.0.1:17711/other' },
				bfast: { type: 'http', url: 'http://127.0.0.1:17712/mcp', headers: { x: '1' } }
			}
		});

		const vscodeFile = JSON.stringify({ servers: { bfast: { type: 'http', url: 'http://192.168.1.5:7711/mcp' } } });
		assert.deepStrictEqual(JSON.parse(retargetMcpClientConfig('vscode', vscodeFile, 7711, 7712)!), {
			servers: { bfast: { type: 'http', url: 'http://192.168.1.5:7712/mcp' } }
		});
	});

	test('retargeting leaves alone anything that is not the bfast entry on the old port', () => {
		for (const existing of [
			'{ "mcpServers": { "bfast": { "type": "http", "url": "http://127.0.0.1:9000/mcp" } } }',
			'{ "mcpServers": { "bfast": { "type": "http", "url": "not a url" } } }',
			'{ "mcpServers": { "bfast": { "type": "stdio", "command": "bfast" } } }',
			'{ "mcpServers": { "other": { "type": "http", "url": "http://127.0.0.1:17711/mcp" } } }',
			'{ "servers": { "bfast": { "type": "http", "url": "http://127.0.0.1:17711/mcp" } } }',
			'// a comment\n{}',
			'[]'
		]) {
			assert.strictEqual(retargetMcpClientConfig('claude-code', existing, 17711, 17712), undefined, existing);
		}
		assert.strictEqual(retargetMcpClientConfig('codex', '{}', 17711, 17712), undefined);
	});

	test('saveMcpClientConfig refuses a tool with no project file and writes nothing', async () => {
		await assert.rejects(saveMcpClientConfig(ROOT, 'codex', ADDRESS), /no project-scoped config file/);
		let entries: [string, vscode.FileType][] = [];
		try {
			entries = await vscode.workspace.fs.readDirectory(ROOT);
		} catch {
			// The folder was never created, which is the stronger answer.
		}
		assert.deepStrictEqual(entries, []);
	});
});
