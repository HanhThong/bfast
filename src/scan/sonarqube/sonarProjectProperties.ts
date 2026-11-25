// `sonar-project.properties` — what a checkout says about itself.
//
// A repository that already scans in CI carries this file at its root, and it
// is the SonarQube-native place for the project key, the display name and the
// source layout. BFAST reads it rather than asking the user to say the same
// thing twice in `bfast.json`: the file names the project, and BFAST's own
// `-D` flags then **agree with it** instead of overriding it — `-D` beats the
// file inside the scanner, so a key BFAST invented would silently rename the
// project the team set up.
//
// The parser is Java's `.properties` grammar, hand-rolled for the same reason
// `yaml.ts` is: one dependency for one flat file is not a trade. It covers what
// a real file uses — `#`/`!` comments, `=` or `:` separators, backslash line
// continuation (SonarSource's own examples split `sonar.exclusions` over ten
// lines), and the `\n` `\t` `\\` `\uXXXX` escapes. Reading is forgiving, the
// tracker's rule: a line the grammar cannot place is skipped, never thrown on.
//
// Pure except for `readSonarProjectProperties`, which is the one `fs` touch and
// is kept apart so the parser is unit-testable on a string.

import { readFile } from 'fs/promises';
import * as path from 'path';
import type { ScanProjectIdentity } from '../scanProvider';

/** The scanner's own name for the file, read from the analysed directory's root. */
export const SONAR_PROJECT_FILE = 'sonar-project.properties';

/** The two keys that identify a project, as the scanner names them. */
export const PROJECT_KEY_PROPERTY = 'sonar.projectKey';
export const PROJECT_NAME_PROPERTY = 'sonar.projectName';

/**
 * Java `.properties` → a flat map. Later keys win, as they do in Java.
 *
 * Never throws. A key with no separator is a key with an empty value (Java's
 * rule too), a blank or comment line is skipped, and a continuation is joined
 * with the next line's leading whitespace stripped.
 */
export function parseProperties(text: string): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const logical of logicalLines(text)) {
		const line = logical.replace(/^[ \t\f]+/, '');
		if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) {
			continue;
		}
		const split = splitKeyValue(line);
		if (split === undefined) {
			continue;
		}
		const [key, value] = split;
		if (key.length > 0) {
			properties[key] = value;
		}
	}
	return properties;
}

/**
 * The file's project identity, or `undefined` when it names neither field.
 * A value is trimmed; an empty one reads as absent so `sonar.projectKey=`
 * does not become a project with no key.
 */
export function projectIdentityOf(
	properties: Record<string, string>
): ScanProjectIdentity | undefined {
	const projectKey = nonEmpty(properties[PROJECT_KEY_PROPERTY]);
	const projectName = nonEmpty(properties[PROJECT_NAME_PROPERTY]);
	if (projectKey === undefined && projectName === undefined) {
		return undefined;
	}
	return {
		...(projectKey === undefined ? {} : { projectKey }),
		...(projectName === undefined ? {} : { projectName })
	};
}

/**
 * The properties file at the root of `directory`, parsed; `undefined` when
 * there is none. Unreadable and missing are the same answer on purpose — a
 * file BFAST cannot read is a file it cannot honour, and the scanner will say
 * so itself if it matters.
 */
export async function readSonarProjectProperties(
	directory: string
): Promise<Record<string, string> | undefined> {
	try {
		return parseProperties(await readFile(path.join(directory, SONAR_PROJECT_FILE), 'utf8'));
	} catch {
		return undefined;
	}
}

// -------------------------------------------------------------------- private

/**
 * Physical lines joined across trailing backslashes. An **odd** run of
 * backslashes at the end continues the line; an even run is escaped
 * backslashes and does not — the rule that keeps `sonar.exclusions=**\\` from
 * eating the next property.
 */
function logicalLines(text: string): string[] {
	const lines: string[] = [];
	let current = '';
	let continuing = false;
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const physical = continuing ? raw.replace(/^[ \t\f]+/, '') : raw;
		const trailing = /\\+$/.exec(physical)?.[0].length ?? 0;
		if (trailing % 2 === 1) {
			current += physical.slice(0, -1);
			continuing = true;
			continue;
		}
		current += physical;
		lines.push(current);
		current = '';
		continuing = false;
	}
	if (current.length > 0) {
		lines.push(current);
	}
	return lines;
}

/** Splits on the first unescaped `=`, `:` or whitespace, and unescapes both halves. */
function splitKeyValue(line: string): [string, string] | undefined {
	let index = 0;
	let key = '';
	while (index < line.length) {
		const char = line[index];
		if (char === '\\') {
			// Keep the escape for `unescape` to resolve; the separator test below
			// must not see the escaped character.
			key += char + (line[index + 1] ?? '');
			index += 2;
			continue;
		}
		if (char === '=' || char === ':' || char === ' ' || char === '\t' || char === '\f') {
			break;
		}
		key += char;
		index += 1;
	}
	// Skip whitespace, then one separator, then whitespace again — `key = value`,
	// `key:value` and `key value` all read the same in Java.
	while (index < line.length && /[ \t\f]/.test(line[index])) {
		index += 1;
	}
	if (index < line.length && (line[index] === '=' || line[index] === ':')) {
		index += 1;
	}
	while (index < line.length && /[ \t\f]/.test(line[index])) {
		index += 1;
	}
	return [unescape(key), unescape(line.slice(index))];
}

function unescape(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== '\\') {
			result += char;
			continue;
		}
		const next = value[index + 1];
		index += 1;
		switch (next) {
			case 'n':
				result += '\n';
				break;
			case 't':
				result += '\t';
				break;
			case 'r':
				result += '\r';
				break;
			case 'f':
				result += '\f';
				break;
			case 'u': {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					result += String.fromCharCode(parseInt(hex, 16));
					index += 4;
				} else {
					result += 'u';
				}
				break;
			}
			case undefined:
				// A lone trailing backslash — nothing to escape, so it is dropped,
				// which is what Java does too.
				break;
			default:
				result += next;
		}
	}
	return result;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
