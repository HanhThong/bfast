// The `{{token}}` grammar shared by every command template in `bfast.json`.
//
// `tests.command` and `scan.command` are both shell lines with placeholders
// substituted, and both are read twice: by the settings form, which warns about
// a token it does not recognise, and by the runner, which leaves that same token
// untouched. **One grammar for both readers** — a second copy of the regex would
// let the form's hint and the runner's behaviour drift apart, which is the whole
// reason this module exists rather than a second `placeholderPattern` beside the
// second caller.
//
// No `vscode` and no `node:` import: this is bundled into the settings webview
// by esbuild, exactly as the settings blocks that import it are.

/**
 * A fresh instance per call, because a shared `/g` regex carries `lastIndex`
 * between calls and would silently skip half the matches on the second one.
 */
const placeholderPattern = (): RegExp => /\{\{(\w+)\}\}/g;

/**
 * The `{{token}}`s in a template that are not in `known`.
 *
 * Advisory only, never a refusal: an unknown token is left in the line untouched
 * at render, and refusing one here would make a pulled `bfast.json` open the
 * form pre-invalid over a command the user may not own.
 */
export function unknownPlaceholders(template: string, known: readonly string[]): string[] {
	const unknown: string[] = [];
	for (const match of template.matchAll(placeholderPattern())) {
		const token = match[1];
		if (!known.includes(token) && !unknown.includes(token)) {
			unknown.push(token);
		}
	}
	return unknown;
}

/**
 * `{{token}}`-style substitution; an unknown token is left in the line
 * untouched — exactly what `unknownPlaceholders` promises the user in the form.
 *
 * `Object.hasOwn`, never `in`: `'toString' in vars` is true via the prototype
 * chain, and coercing `Object.prototype.toString` into a shell line is how a
 * "left untouched" token would silently become garbage the shell runs.
 */
export function substituteCommand(template: string, vars: Record<string, string>): string {
	return template.replace(placeholderPattern(), (token, name: string) =>
		Object.hasOwn(vars, name) ? vars[name] : token
	);
}
