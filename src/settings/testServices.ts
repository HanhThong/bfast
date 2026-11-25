// The services a repository holds, as `tests.services` in `.vscode/bfast.json`.
// docs/tests/services.md is the spec.
//
// Shaped like the rest of the `tests` block: no `vscode` or Node import (the
// settings webview bundles it and validates as you type), reading is forgiving
// — a row with no usable id or folder is dropped, the first of two ids wins —
// while writing is strict, and an empty list is omitted so a workspace that
// declares no service keeps `bfast.json` byte-identical.
//
// A service is a folder its commands run in, an optional unit suite and an
// optional end-to-end suite. The e2e half also says which compose services
// must be up first, and how to run **one** test case ticket assigned to the
// service (`testCommand`, the `tests.command` grammar).

import { unknownPlaceholders as unknownTemplatePlaceholders } from './commandTemplate';

export interface ServiceSuite {
	/** The shell line that runs the whole suite, in the service's folder. No placeholders. */
	command?: string;
	/** An lcov file the suite writes, relative to the service's folder. */
	coverage?: string;
}

export interface ServiceE2e extends ServiceSuite {
	/**
	 * The shell line that runs one test case ticket assigned to this service —
	 * `{{id}}`, `{{key}}`, `{{folder}}`, exactly as `tests.command` takes them.
	 */
	testCommand?: string;
	/** Compose services brought up in the master environment before any e2e run. */
	compose?: string[];
}

export interface TestService {
	/** `[a-z0-9-]`, unique — what a test case's `service:` names, and its results folder. */
	id: string;
	/** What the board shows; the id when absent. */
	name?: string;
	/** Workspace-relative; every command of the service runs here. */
	folder: string;
	unit?: ServiceSuite;
	e2e?: ServiceE2e;
}

/** The tokens `testCommand` takes — `tests.command`'s set. */
export const SERVICE_TEST_PLACEHOLDERS: readonly string[] = ['id', 'key', 'folder'];

export const MAX_SERVICE_ID = 40;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;
/** What `docker compose` accepts as a service name. */
const COMPOSE_SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const INVALID_PATH_CHARS = /[*?"<>|]/;

export function isServiceId(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_SERVICE_ID && SERVICE_ID.test(value);
}

/**
 * A service id from a folder or a name: `services/Orders API` → `orders-api`.
 * What the form proposes when a folder is picked before an id was typed.
 */
export function suggestServiceId(source: string): string {
	const last = source.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
	return last
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SERVICE_ID)
		.replace(/-+$/, '');
}

/** The services of a parsed `tests` block, never `undefined`. */
export function testServices(tests: { services?: TestService[] } | undefined): TestService[] {
	return tests?.services ?? [];
}

export function findService(
	tests: { services?: TestService[] } | undefined,
	id: string | undefined
): TestService | undefined {
	return id === undefined ? undefined : testServices(tests).find((service) => service.id === id);
}

export function serviceLabel(service: TestService): string {
	return service.name ?? service.id;
}

/**
 * Reads `tests.services`. Never throws: a row that is not an object, or has no
 * usable id or folder, is dropped; so is a later row repeating an id. Answers
 * `undefined` when nothing survived, so the key is omitted.
 */
export function parseTestServices(raw: unknown): TestService[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const services: TestService[] = [];
	const seen = new Set<string>();
	for (const row of raw) {
		if (typeof row !== 'object' || row === null) {
			continue;
		}
		const source = row as Record<string, unknown>;
		const id = typeof source.id === 'string' ? source.id.trim() : '';
		const folder = typeof source.folder === 'string' ? normalizePath(source.folder) : '';
		if (!isServiceId(id) || seen.has(id) || folder.length === 0 || pathError(folder) !== undefined) {
			continue;
		}
		seen.add(id);
		const unit = parseSuite(source.unit);
		const e2e = parseE2e(source.e2e);
		services.push({
			id,
			...text('name', source.name),
			folder,
			...(unit ? { unit } : {}),
			...(e2e ? { e2e } : {})
		});
	}
	return services.length > 0 ? services : undefined;
}

/**
 * The first problem with the list, or `undefined`. A row whose every field is
 * empty is skipped — it is a card the user added and has not filled in, and
 * the parse drops it on save — the `scan.properties` rule.
 */
export function validateTestServices(
	services: readonly TestService[] | undefined,
	trackerFolder?: string
): string | undefined {
	const seen = new Set<string>();
	for (const [index, service] of (services ?? []).entries()) {
		if (isBlank(service)) {
			continue;
		}
		const where = service.id?.trim() ? `Service “${service.id.trim()}”` : `Service ${index + 1}`;
		const id = service.id?.trim() ?? '';
		if (id.length === 0) {
			return `${where} needs an id.`;
		}
		if (!isServiceId(id)) {
			return `${where}: an id is lower-case letters, digits and dashes, starting with a letter or digit, at most ${MAX_SERVICE_ID} characters.`;
		}
		if (seen.has(id)) {
			return `Two services share the id “${id}”.`;
		}
		seen.add(id);
		const folder = normalizePath(service.folder ?? '');
		if (folder.length === 0) {
			return `${where} needs a folder.`;
		}
		const folderError = pathError(folder);
		if (folderError) {
			return `${where}: the folder ${folderError}`;
		}
		const tracker = trackerFolder === undefined ? '' : normalizePath(trackerFolder);
		if (tracker.length > 0 && (folder === tracker || folder.startsWith(`${tracker}/`))) {
			return `${where}: the folder must not be inside the tracker folder.`;
		}
		for (const [label, coverage] of [
			['unit coverage file', service.unit?.coverage],
			['e2e coverage file', service.e2e?.coverage]
		] as const) {
			const value = normalizePath(coverage ?? '');
			const error = value.length > 0 ? pathError(value) : undefined;
			if (error) {
				return `${where}: the ${label} ${error}`;
			}
		}
		const badCompose = (service.e2e?.compose ?? [])
			.map((name) => name.trim())
			.find((name) => name.length > 0 && !COMPOSE_SERVICE.test(name));
		if (badCompose !== undefined) {
			return `${where}: “${badCompose}” is not a compose service name.`;
		}
	}
	return undefined;
}

/** The `{{token}}`s in a service's test case command that it does not take — a hint, never a refusal. */
export function unknownServicePlaceholders(command: string): string[] {
	return unknownTemplatePlaceholders(command, SERVICE_TEST_PLACEHOLDERS);
}

/** A row the user added and left empty. */
function isBlank(service: TestService): boolean {
	const values = [
		service.id,
		service.name,
		service.folder,
		service.unit?.command,
		service.unit?.coverage,
		service.e2e?.command,
		service.e2e?.testCommand,
		service.e2e?.coverage,
		...(service.e2e?.compose ?? [])
	];
	return values.every((value) => value === undefined || value.trim().length === 0);
}

function parseSuite(raw: unknown): ServiceSuite | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const suite: ServiceSuite = { ...text('command', source.command), ...relative('coverage', source.coverage) };
	return Object.keys(suite).length > 0 ? suite : undefined;
}

function parseE2e(raw: unknown): ServiceE2e | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const source = raw as Record<string, unknown>;
	const compose = Array.isArray(source.compose)
		? [
				...new Set(
					source.compose
						.filter((name): name is string => typeof name === 'string')
						.map((name) => name.trim())
						.filter((name) => COMPOSE_SERVICE.test(name))
				)
			]
		: [];
	const e2e: ServiceE2e = {
		...text('command', source.command),
		...text('testCommand', source.testCommand),
		...relative('coverage', source.coverage),
		...(compose.length > 0 ? { compose } : {})
	};
	return Object.keys(e2e).length > 0 ? e2e : undefined;
}

function text<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/** A workspace- or folder-relative path, dropped when it would leave the workspace. */
function relative<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
	if (typeof value !== 'string') {
		return {};
	}
	const normalized = normalizePath(value);
	return normalized.length > 0 && pathError(normalized) === undefined
		? ({ [key]: normalized } as Record<K, string>)
		: {};
}

/** Why a relative path is unusable, finishing a sentence, or `undefined`. */
function pathError(value: string): string | undefined {
	if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
		return 'must be relative to the workspace, not absolute.';
	}
	if (value.split('/').includes('..')) {
		return 'must stay inside the workspace.';
	}
	if (INVALID_PATH_CHARS.test(value)) {
		return 'contains characters that are not allowed in a path.';
	}
	return undefined;
}

export function normalizePath(value: string): string {
	let folder = value.trim().replace(/\\/g, '/');
	while (folder.startsWith('./')) {
		folder = folder.slice(2);
	}
	while (folder.endsWith('/')) {
		folder = folder.slice(0, -1);
	}
	return folder;
}
