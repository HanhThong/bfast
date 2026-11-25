// The Tests tab's Services section: one card per service in `tests.services`
// — its folder, its unit suite and its end-to-end suite, with the compose
// services that suite needs up first. docs/tests/services.md is the spec.
//
// The folder comes from a host dialog (`pickServiceFolder`, inside the
// workspace only) and the compose names from `docker compose config
// --services` over the form's own environments block (`listComposeServices`),
// so a name typed on the Environments tab a moment ago is the one listed.
// When that cannot be read the checklist becomes a comma-separated field: no
// docker on this machine must not make the section unusable.

import { useEffect, useState } from 'react';
import type { ServiceE2e, ServiceSuite, TestService } from '../../../settings/testServices';
import { postMessage } from './shared';
import type { SettingsFormState } from './useSettingsForm';

export function ServicesSection({ form }: { form: SettingsFormState }) {
	const { services, addService, loaded, composeList, refreshComposeServices } = form;

	// Asked once the form has loaded, and again by Refresh — never on every
	// render, since each ask is a `docker` process.
	useEffect(() => {
		if (loaded && composeList === undefined) {
			refreshComposeServices();
		}
	}, [loaded]);

	return (
		<div className="settings-field">
			<div className="settings-row">
				<label className="settings-label">Services</label>
				<button type="button" className="settings-button secondary" onClick={addService}>
					Add service…
				</button>
			</div>
			<p className="settings-hint">
				The services this repository holds. Each has a folder its commands run in, an optional unit
				suite and an optional end-to-end suite. A test case ticket assigned to a service (right-click
				it → <b>Set Service…</b>) runs with that service’s test case command instead of the test
				command above.
			</p>
			{services.map((service, index) => (
				<ServiceCard key={index} form={form} service={service} index={index} />
			))}
		</div>
	);
}

function ServiceCard({
	form,
	service,
	index
}: {
	form: SettingsFormState;
	service: TestService;
	index: number;
}) {
	const { updateService, removeService, strayServicePlaceholders } = form;
	const id = `service-${index}`;
	const updateUnit = (patch: Partial<ServiceSuite>) =>
		updateService(index, { unit: emptyToUndefined({ ...service.unit, ...patch }) });
	const updateE2e = (patch: Partial<ServiceE2e>) =>
		updateService(index, { e2e: emptyToUndefined({ ...service.e2e, ...patch }) });
	const stray = strayServicePlaceholders(service.e2e?.testCommand);
	// Read once: a controlled `open` would collapse the section the moment its
	// last field was cleared, mid-edit.
	const [unitOpen] = useState(service.unit !== undefined);
	const [e2eOpen] = useState(service.e2e !== undefined);
	const title = service.name?.trim() || service.id?.trim() || `Service ${index + 1}`;

	return (
		<div className="service-card">
			<div className="settings-row">
				<span className="service-title">{title}</span>
				<button
					type="button"
					className="settings-button secondary"
					onClick={() => removeService(index)}
				>
					Remove
				</button>
			</div>

			<div className="service-grid">
				<label className="settings-label" htmlFor={`${id}-id`}>
					Id
				</label>
				<input
					id={`${id}-id`}
					className="settings-input"
					type="text"
					spellCheck={false}
					value={service.id ?? ''}
					placeholder="orders"
					onChange={(event) => updateService(index, { id: event.target.value })}
				/>
				<label className="settings-label" htmlFor={`${id}-name`}>
					Name
				</label>
				<input
					id={`${id}-name`}
					className="settings-input"
					type="text"
					value={service.name ?? ''}
					placeholder={service.id || 'Orders'}
					onChange={(event) => updateService(index, { name: event.target.value || undefined })}
				/>
				<label className="settings-label" htmlFor={`${id}-folder`}>
					Folder
				</label>
				<div className="settings-input-row">
					<input
						id={`${id}-folder`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.folder ?? ''}
						placeholder="services/orders"
						onChange={(event) => updateService(index, { folder: event.target.value })}
					/>
					<button
						type="button"
						className="settings-button secondary"
						onClick={() => postMessage({ type: 'pickServiceFolder', index })}
					>
						Browse…
					</button>
				</div>
			</div>

			<details className="settings-section" open={unitOpen}>
				<summary className="settings-summary">Unit tests</summary>
				<div className="service-grid">
					<label className="settings-label" htmlFor={`${id}-unit-command`}>
						Command
					</label>
					<input
						id={`${id}-unit-command`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.unit?.command ?? ''}
						placeholder="npm test -- --coverage"
						onChange={(event) => updateUnit({ command: event.target.value })}
					/>
					<label className="settings-label" htmlFor={`${id}-unit-coverage`}>
						Coverage
					</label>
					<input
						id={`${id}-unit-coverage`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.unit?.coverage ?? ''}
						placeholder="coverage/lcov.info"
						onChange={(event) => updateUnit({ coverage: event.target.value })}
					/>
				</div>
				<p className="settings-hint">
					Runs the whole unit suite in the service’s folder. Coverage is an lcov file the command
					writes, relative to that folder.
				</p>
			</details>

			<details className="settings-section" open={e2eOpen}>
				<summary className="settings-summary">E2E tests</summary>
				<div className="service-grid">
					<label className="settings-label" htmlFor={`${id}-e2e-command`}>
						Suite command
					</label>
					<input
						id={`${id}-e2e-command`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.e2e?.command ?? ''}
						placeholder="npm run e2e"
						onChange={(event) => updateE2e({ command: event.target.value })}
					/>
					<label className="settings-label" htmlFor={`${id}-e2e-test`}>
						Test case command
					</label>
					<input
						id={`${id}-e2e-test`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.e2e?.testCommand ?? ''}
						placeholder="npm run e2e -- --grep {{id}}"
						onChange={(event) => updateE2e({ testCommand: event.target.value })}
					/>
					<label className="settings-label" htmlFor={`${id}-e2e-coverage`}>
						Coverage
					</label>
					<input
						id={`${id}-e2e-coverage`}
						className="settings-input"
						type="text"
						spellCheck={false}
						value={service.e2e?.coverage ?? ''}
						placeholder="coverage/e2e/lcov.info"
						onChange={(event) => updateE2e({ coverage: event.target.value })}
					/>
					<span className="settings-label">Compose services</span>
					<ComposePicker
						form={form}
						selected={service.e2e?.compose ?? []}
						onChange={(compose) => updateE2e({ compose: compose.length > 0 ? compose : undefined })}
					/>
				</div>
				<p className="settings-hint">
					The test case command runs one test case ticket assigned to this service, with{' '}
					<code>{'{{id}}'}</code>, <code>{'{{key}}'}</code> and <code>{'{{folder}}'}</code>{' '}
					substituted. Before it runs, the ticked compose services are brought up in the{' '}
					<b>Master</b> environment and left running.
				</p>
				{stray.length > 0 && (
					<p className="settings-hint">
						⚠ {stray.map((token) => `{{${token}}}`).join(', ')}{' '}
						{stray.length === 1 ? 'is' : 'are'} not substituted and will reach the shell as written.
					</p>
				)}
			</details>
		</div>
	);
}

/**
 * A checklist of the compose chain's services, or a comma-separated field
 * when the chain could not be read. A ticked name the files no longer declare
 * stays ticked and is flagged — the file may be edited back — never dropped.
 */
function ComposePicker({
	form,
	selected,
	onChange
}: {
	form: SettingsFormState;
	selected: string[];
	onChange: (compose: string[]) => void;
}) {
	const { composeList, refreshComposeServices } = form;
	const [text, setText] = useState(selected.join(', '));

	if (composeList === undefined || composeList.error !== undefined || composeList.services.length === 0) {
		return (
			<div className="compose-picker">
				<input
					className="settings-input"
					type="text"
					spellCheck={false}
					value={text}
					placeholder="orders, postgres"
					onChange={(event) => {
						setText(event.target.value);
						onChange(
							event.target.value
								.split(',')
								.map((name) => name.trim())
								.filter((name) => name.length > 0)
						);
					}}
				/>
				<p className="settings-hint">
					{composeList === undefined
						? 'Reading the compose files…'
						: composeList.error !== undefined
							? `Could not list the compose services (${composeList.error}). Type their names.`
							: `${composeList.files.join(', ')} declares no service.`}{' '}
					<button type="button" className="link-button" onClick={refreshComposeServices}>
						Refresh
					</button>
				</p>
			</div>
		);
	}

	const unknown = selected.filter((name) => !composeList.services.includes(name));
	const toggle = (name: string, on: boolean) =>
		onChange(
			on
				? [...composeList.services.filter((candidate) => candidate === name || selected.includes(candidate)), ...unknown]
				: selected.filter((candidate) => candidate !== name)
		);

	return (
		<div className="compose-picker">
			<div className="compose-options">
				{composeList.services.map((name) => (
					<label key={name} className="compose-option">
						<input
							type="checkbox"
							checked={selected.includes(name)}
							onChange={(event) => toggle(name, event.target.checked)}
						/>{' '}
						{name}
					</label>
				))}
			</div>
			<p className="settings-hint">
				From {composeList.files.join(' + ')}.{' '}
				<button type="button" className="link-button" onClick={refreshComposeServices}>
					Refresh
				</button>
			</p>
			{unknown.length > 0 && (
				<p className="settings-hint">
					⚠ {unknown.join(', ')} {unknown.length === 1 ? 'is' : 'are'} not declared by the compose
					files.
				</p>
			)}
		</div>
	);
}

/** A suite with nothing typed in it is no suite: the parse would drop it on save anyway. */
function emptyToUndefined<T extends object>(suite: T): T | undefined {
	return Object.values(suite).some((value) =>
		Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim().length > 0 : value !== undefined
	)
		? suite
		: undefined;
}
