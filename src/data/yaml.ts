// A deliberately tiny YAML reader/writer for flat `key: value` maps, so the
// tracker's `metadata.yaml` needs no runtime dependency. It handles exactly the
// subset BFAST writes plus whatever a person is likely to type by hand — no
// nesting, no lists, no anchors, no multi-document files.
//
// Like `parseSettings`, it never throws: a line it cannot make sense of is
// skipped rather than failing the whole file, because half a ticket is better
// than no ticket.

export type YamlMap = Record<string, string>;

export interface SerializeYamlOptions {
	/** Keys written first, in this order. Everything else follows, as-is. */
	order?: readonly string[];
	/** Comment block put at the top of the file, written verbatim. */
	header?: string;
}

/** Values a bare word would mean something other than a string in real YAML. */
const AMBIGUOUS_WORDS = new Set([
	'true', 'false', 'yes', 'no', 'on', 'off', 'null', 'nil', '~'
]);

/** Leading characters that give a scalar a special meaning in YAML. */
const INDICATOR_START = /^[#&*!%@`>|[\]{},'"]/;

export function parseYamlMap(text: string): YamlMap {
	const map: YamlMap = {};
	if (typeof text !== 'string') {
		return map;
	}

	for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
		const trimmed = line.trim();

		// Blank lines, comments and document markers carry nothing.
		if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') {
			continue;
		}

		// Split on the FIRST colon only, so `title: Fix: the login bug` keeps the
		// second colon as part of the value.
		const colon = line.indexOf(':');
		if (colon === -1) {
			continue;
		}

		const key = line.slice(0, colon).trim();
		if (key === '') {
			continue;
		}

		// Last one wins, which is also what a real YAML loader does.
		map[key] = parseScalar(line.slice(colon + 1).trim());
	}

	return map;
}

export function serializeYamlMap(map: YamlMap, options: SerializeYamlOptions = {}): string {
	const { order = [], header } = options;

	// Known keys first for a stable, readable file; anything a person added by
	// hand keeps its own order and rides along untouched.
	const ordered = order.filter((key) => key in map);
	const rest = Object.keys(map).filter((key) => !ordered.includes(key));

	const lines = header ? [header, ''] : [];
	for (const key of [...ordered, ...rest]) {
		lines.push(`${key}: ${formatScalar(map[key])}`);
	}

	return `${lines.join('\n')}\n`;
}

function parseScalar(raw: string): string {
	if (raw === '') {
		return '';
	}

	if (raw.startsWith('"')) {
		const quoted = readDoubleQuoted(raw);
		if (quoted !== undefined) {
			return quoted;
		}
	}

	if (raw.startsWith("'")) {
		const quoted = readSingleQuoted(raw);
		if (quoted !== undefined) {
			return quoted;
		}
	}

	// Unquoted: a ` #` starts a trailing comment. A `#` with no space before it
	// is part of the value (`TC-1#0`, a colour like `#fff`).
	const comment = raw.search(/\s#/);
	return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/** `undefined` when the quote never closes, so the caller can fall back to the raw text. */
function readDoubleQuoted(raw: string): string | undefined {
	let out = '';
	for (let i = 1; i < raw.length; i++) {
		const char = raw[i];
		if (char === '\\') {
			const next = raw[++i];
			out += next === 'n' ? '\n' : next === 't' ? '\t' : (next ?? '');
			continue;
		}
		if (char === '"') {
			return out;
		}
		out += char;
	}
	return undefined;
}

/** Single quotes have one escape: `''` means a literal apostrophe. */
function readSingleQuoted(raw: string): string | undefined {
	let out = '';
	for (let i = 1; i < raw.length; i++) {
		if (raw[i] === "'") {
			if (raw[i + 1] === "'") {
				out += "'";
				i++;
				continue;
			}
			return out;
		}
		out += raw[i];
	}
	return undefined;
}

function formatScalar(value: string): string {
	if (value.includes('\n')) {
		// The only case single quotes cannot express on one line.
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
	}

	const needsQuotes =
		value === '' ||
		value !== value.trim() ||
		value.includes(' #') ||
		value.startsWith('- ') ||
		INDICATOR_START.test(value) ||
		AMBIGUOUS_WORDS.has(value.toLowerCase());

	return needsQuotes ? `'${value.replace(/'/g, "''")}'` : value;
}
