// The MCP server: on or off, port, reach, the functions on offer, and its live status.

import { useState } from 'react';
import {
	DEFAULT_MCP_PORT,
	MCP_REACHES,
	mcpReach,
	type McpReach
} from '../../../settings/mcpSettings';
import { MCP_FUNCTION_DESCRIPTIONS, toolsOf } from '../../../mcp/mcpTools';
import type { McpServerStatus } from '../../../mcp/mcpStatus';
import {
	DEFAULT_MCP_CLIENT,
	MCP_CLIENTS,
	mcpClient,
	mcpClientSnippet,
	type McpClientId
} from '../../../mcp/mcpClients';
import { SETTINGS_FILE } from '../../../settings/bfastSettings';
import { MCP_REACH_LABEL, postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function McpTab({ form, hidden }: { form: SettingsFormState; hidden: boolean }) {
	const {
		settings,
		configured,
		mcpPortText,
		setMcpPortText,
		mcpStatus,
		mcpError,
		mcpPortTextError,
		updateMcp,
		mcpOn,
		mcpOffered,
		toggleMcpFunction,
	} = form;

	return (
		<div className="tab-panel settings-panel" role="tabpanel" hidden={hidden}>
				<p className="settings-hint">
					BFAST can listen on an HTTP port and speak the{' '}
					<strong>Model Context Protocol</strong>, so a coding agent or another tool outside
					this window can read and change this workspace's tickets and trigger BFAST's own
					actions. The transport is <strong>Streamable HTTP</strong> and nothing else — a
					client that only speaks stdio or the older HTTP+SSE transport cannot connect, and
					that failure is not a symptom of the port or the reach below. See{' '}
					<code>docs/mcp/</code>.
				</p>

				{!configured && (
					<p className="settings-hint">
						This workspace has no <code>{SETTINGS_FILE}</code> yet, so there is nowhere to
						store the choice. Saving writes the file — and starts the server with it.
					</p>
				)}

				<div className="settings-field">
					<label className="settings-label" htmlFor="mcpEnabled">
						<input
							id="mcpEnabled"
							type="checkbox"
							checked={mcpOn}
							onChange={(event) =>
								// Only `true` is ever stored: off is the default, and writing it
								// would create an `mcp` block in a file that has none.
								updateMcp({ enabled: event.target.checked ? true : undefined })
							}
						/>{' '}
						Run the MCP server
					</label>
					<p className="settings-hint">
						Off until you switch it on, so nothing listens for a workspace that does not want
						it. Saving is the whole lifecycle: it starts the server, restarts it on the new
						settings when it was already running, or stops it.
					</p>
				</div>

				{/* Hidden rather than unmounted, the reason the tabs themselves are:
				    Save writes the whole object, so switching the server off and on
				    again must not look like it discarded the port and the switches. */}
				<div className="settings-field" hidden={!mcpOn}>
					<label className="settings-label" htmlFor="mcpPort">
						Port
					</label>
					<input
						id="mcpPort"
						className="settings-input settings-input-compact"
						type="text"
						inputMode="numeric"
						spellCheck={false}
						value={mcpPortText}
						placeholder={String(DEFAULT_MCP_PORT)}
						onChange={(event) => {
							setMcpPortText(event.target.value);
							const port = Number(event.target.value.trim());
							updateMcp({
								port: /^\d+$/.test(event.target.value.trim()) ? port : undefined
							});
						}}
					/>
					<p className="settings-hint">
						The TCP port the server listens on. If it is already taken — by another window
						with this workspace open, or by anything else — the server does not start, and
						what you typed is kept so you can change the number and save again.
					</p>
					{mcpPortTextError && <p className="settings-error">{mcpPortTextError}</p>}
				</div>

				<div className="settings-field" hidden={!mcpOn}>
					<label className="settings-label" htmlFor="mcpReach">
						Who may reach it
					</label>
					<select
						id="mcpReach"
						className="settings-input"
						value={mcpReach(settings.mcp)}
						onChange={(event) =>
							// Only `network` is ever stored; `local` is the default.
							updateMcp({
								reach: event.target.value === 'network' ? 'network' : undefined
							})
						}
					>
						{MCP_REACHES.map((reach) => (
							<option key={reach} value={reach}>
								{MCP_REACH_LABEL[reach]}
							</option>
						))}
					</select>
					<p className="settings-hint">
						{mcpReach(settings.mcp) === 'network'
							? 'Anyone who can reach this machine on that port can read and change this workspace’s tickets and trigger whatever is switched on below. There is no password and no token — BFAST asks a connecting client for nothing at all. You are asked to confirm before this takes effect.'
							: 'Only this machine can connect. Opening it to the network is a deliberate choice, and BFAST asks you to confirm it before it takes effect.'}
					</p>
				</div>

				<div className="settings-field" hidden={!mcpOn}>
					<label className="settings-label">Functions it offers</label>
					<p className="settings-hint">
						A client sees exactly the functions that are switched on, and nothing else. One
						that is switched off cannot be called, even by a client that listed it a moment
						ago. Only reading is on by default.
					</p>
					<ul className="skill-list">
						{MCP_FUNCTION_DESCRIPTIONS.map((fn) => (
							<li className="skill" key={fn.id}>
								<label className="skill-name" htmlFor={`mcpFunction-${fn.id}`}>
									<input
										id={`mcpFunction-${fn.id}`}
										type="checkbox"
										checked={mcpOffered.includes(fn.id)}
										onChange={(event) => toggleMcpFunction(fn.id, event.target.checked)}
									/>{' '}
									{fn.label}
								</label>
								<span className="agent-types">
									{fn.hint}{' '}
									{toolsOf(fn.id)
										.map((tool) => tool.name)
										.join(', ')}
								</span>
							</li>
						))}
					</ul>
					{mcpOffered.length === 0 && (
						<p className="settings-hint">
							Every function is switched off. The server will still start and a client will
							still connect — and find nothing it can do.
						</p>
					)}
				</div>

				<div className="settings-field">
					<label className="settings-label">Status</label>
					<McpStatusView status={mcpStatus} enabled={mcpOn} />
				</div>
				{mcpError && <p className="settings-error">{mcpError}</p>}
		</div>
	);
}

/**
 * Where the MCP server actually is — pushed by the host, never inferred from
 * the form.
 *
 * The two have to be able to disagree, and saying so is the point: the switch
 * above is what the user wants, and this is what happened when BFAST tried it.
 * A port already taken is exactly that gap, and hiding it behind the checkbox
 * would leave the user believing a server is listening when none is.
 */
function McpStatusView({ status, enabled }: { status: McpServerStatus; enabled: boolean }) {
	if (status.state === 'running') {
		return (
			<>
				<p className="mcp-status mcp-status-running">
					Running — serving{' '}
					{status.functions && status.functions.length > 0
						? status.functions.join(', ')
						: 'no functions at all'}
					.
				</p>
				<div className="settings-input-row">
					<code className="settings-input mcp-address">{status.address}</code>
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => postMessage({ type: 'copyMcpAddress' })}
					>
						Copy
					</button>
				</div>
				<p className="settings-hint">
					Paste that into a client as an MCP server of type <code>http</code>.
					{status.reach === 'network' &&
						' That is this machine’s own network address, not the interface the server listens on — a client on another machine uses it as it is.'}
				</p>
				<McpConnectView address={status.address ?? ''} reach={status.reach} />
			</>
		);
	}

	if (status.state === 'error') {
		return (
			<>
				<p className="settings-error">{status.message}</p>
				{status.code === 'port-in-use' && (
					<p className="settings-hint">
						Nothing you typed was lost — change the port above and save again.
					</p>
				)}
				<McpConnectView />
			</>
		);
	}

	return (
		<>
			<p className="mcp-status">
				{enabled
					? 'Not listening yet. Save to start it.'
					: 'Not running. Switch the server on and save to start it.'}
			</p>
			<McpConnectView />
		</>
	);
}

/**
 * Connect a tool: pick it, see its own snippet for the running server's
 * address, then Copy — or, for a tool that reads its servers from a file in
 * the project, Save for the team.
 *
 * The preview is built here from the address the status carried, but Copy and
 * Save send only the tool's id: the host rebuilds the snippet from the address
 * it is serving on, so the webview never hands it text to write. With no
 * address there is nothing to build from, so the picker and both buttons are
 * disabled and the line under them says why.
 */
function McpConnectView({ address, reach }: { address?: string; reach?: McpReach }) {
	const [clientId, setClientId] = useState<McpClientId>(DEFAULT_MCP_CLIENT);
	const client = mcpClient(clientId);
	const running = address !== undefined && address.length > 0;

	return (
		<div className="mcp-connect">
			<label className="settings-label" htmlFor="mcpClient">
				Connect a tool
			</label>
			<div className="settings-input-row">
				<select
					id="mcpClient"
					className="settings-input"
					value={clientId}
					disabled={!running}
					onChange={(event) => setClientId(event.target.value as McpClientId)}
				>
					{MCP_CLIENTS.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.label}
						</option>
					))}
				</select>
				<button
					type="button"
					className="settings-button secondary"
					disabled={!running}
					onClick={() => postMessage({ type: 'copyMcpClientSnippet', client: clientId })}
				>
					Copy
				</button>
				{client.projectFile && (
					<button
						type="button"
						className="settings-button secondary"
						disabled={!running}
						title={`Writes the bfast entry into ${client.projectFile.path}, keeping whatever else is there.`}
						onClick={() => postMessage({ type: 'saveMcpClientConfig', client: clientId })}
					>
						Save for the team
					</button>
				)}
			</div>
			{running ? (
				<>
					<pre className="mcp-snippet">{mcpClientSnippet(clientId, address)}</pre>
					<p className="settings-hint">
						{client.hint}
						{client.projectFile &&
							` Save for the team writes it into ${client.projectFile.path}, merged with what is already there; commit that file and a teammate who pulls finds the server already offered. The file keeps this address until someone saves again${
								reach === 'network'
									? ', and it is this machine’s network address, so a teammate elsewhere may not reach it'
									: ''
							}.`}
					</p>
				</>
			) : (
				<p className="settings-hint">
					The server is not running, so there is no address to build a snippet from. Start it and
					come back to copy or save a tool’s connection config.
				</p>
			)}
		</div>
	);
}
