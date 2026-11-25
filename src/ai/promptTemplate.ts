// Turning a settings template plus a ticket into the prompt a provider runs.
//
// Pure and `vscode`-free, so it is directly unit-testable and so the policy
// lives in exactly one place: `AiRequest.prompt` arrives at a provider already
// rendered, and a second provider never reimplements any of this.

import type { AiTicketContext } from './aiProvider';

/** The placeholders a template may use. Anything else is left alone. */
export interface PromptVars {
	title: string;
	type: string;
	status: string;
	description: string;
	instruction: string;
	/** English name of the language to write in; `''` when no preference. */
	language: string;
	/** The ticket this one will hang under; `''` when there is none. */
	parent: string;
	/** The design document being written; `''` when the run is not a design run. */
	design: string;
	/** What this run may edit in the tracker; `''` when it may edit nothing. */
	writePolicy: string;
}

/**
 * The one sentence that keeps a translated ticket the same shape as an English
 * one. Exported so a test can pin the prompt to it rather than to its wording.
 */
export const STRUCTURE_STAYS_ENGLISH =
	'Translate only the prose: every markdown heading and every bold keyword the ' +
	'instructions above prescribe (such as `## Behaviour`, **As a** / **I want** / ' +
	'**So that**, **Given** / **When** / **Then**) stays in English, spelled and ' +
	'capitalised exactly as the instructions show it, so every ticket shares one structure.';

/**
 * The lines every prompt ends with when a language is set.
 *
 * Exported so a follow-up turn of a resumed conversation ends the same way:
 * one address for the sentences that stop a model translating identifiers and
 * headings, rather than a second copy that drifts. `[]` when there is no
 * preference, so a caller can spread it unconditionally.
 */
export function languageBlock(language: string | undefined): string[] {
	const name = language?.trim() ?? '';
	return name.length > 0
		? [
				`Write the description in ${name}.`,
				'Keep code, identifiers, file paths and ticket ids exactly as they are.',
				STRUCTURE_STAYS_ENGLISH
			]
		: [];
}

const TYPE_LABEL: Record<string, string> = {
	epic: 'epic',
	story: 'story',
	ac: 'acceptance criterion',
	testcase: 'test case'
};

/**
 * Substitutes `{{name}}` for the known keys.
 *
 * An unknown token is left **untouched** rather than replaced with an empty
 * string: a description is markdown written by a person, and text containing
 * `{{…}}` must survive a round trip through here unharmed.
 */
export function renderTemplate(template: string, vars: PromptVars): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		Object.hasOwn(vars, name) ? (vars[name as keyof PromptVars] ?? '') : match
	);
}

/**
 * The full prompt for one run.
 *
 * When the template never mentions `{{description}}` the current text is
 * appended as its own block, so ticket context can never be silently lost by a
 * template that simply forgot to ask for it. `{{language}}` and `{{parent}}`
 * follow the same policy — and the language lands here rather than in
 * `SYSTEM_PROMPT` because only the SDK provider sends a system prompt, while
 * both send this string verbatim.
 *
 * `parent` is for a ticket that does **not exist yet**: the sidebar's generate
 * commands write a story from nothing but its title, and the epic it will hang
 * under is the only context there is. It is its own block rather than being
 * folded into `instruction` (which would file an epic's body under "Additional
 * instruction from the user") or into `ticket.description` (which the model
 * would read as a draft of the story to rewrite).
 */
/**
 * The optional half of a prompt, gathered rather than threaded on as more
 * positional parameters — `buildPrompt` was already at five, and the sixth was
 * where `BoardServices` was gathered for the same reason.
 */
export interface PromptContext {
	language?: string;
	/** The ticket a proposed one will hang under. */
	parent?: AiTicketContext;
	/**
	 * The ticket `parent` itself hangs under, for a parent too thin to write
	 * from alone — an acceptance criterion names neither the screen nor the
	 * user its story does. Part of the `{{parent}}` block, and ignored without
	 * a `parent`.
	 */
	grandparent?: AiTicketContext;
	/** The design document a design run is rewriting. */
	design?: { title: string; style: string; body: string };
	/**
	 * Set when the run may edit other tickets' description files. Carries paths,
	 * not bodies: the agent has to read a file before it may edit it anyway, and
	 * what it cannot guess is where the file is.
	 */
	edits?: TrackerEditPolicy;
}

export interface TrackerEditPolicy {
	/** Workspace-relative, forward slashes. */
	trackerFolder: string;
	/** The content file of the ticket being written, which the run may not edit. */
	ownPath?: string;
	/** The ticket it hangs under, when there is one. */
	parent?: { id: string; title: string; path: string };
}

export function buildPrompt(
	template: string,
	ticket: AiTicketContext,
	instruction: string,
	context: PromptContext = {}
): string {
	const { language, parent, grandparent, design, edits } = context;
	const vars: PromptVars = {
		title: ticket.title,
		type: TYPE_LABEL[ticket.type] ?? ticket.type,
		status: ticket.status,
		description: ticket.description,
		instruction: instruction.trim(),
		language: language?.trim() ?? '',
		parent: parent ? parentBlock(parent, grandparent) : '',
		design: design ? designBlock(design) : '',
		writePolicy: edits ? writePolicyBlock(edits) : ''
	};

	const parts = [renderTemplate(template, vars)];

	if (!template.includes('{{description}}')) {
		parts.push(
			'',
			'---',
			'',
			// Joined rather than interpolated: a ticket being written from a title
			// alone has no id yet, and `Ticket:  — Title` reads as a bug.
			`Ticket: ${[ticket.id, ticket.title].filter(Boolean).join(' — ')} ` +
				`(${vars.type}, ${ticket.status})`,
			'',
			'Current description:',
			'',
			ticket.description.trim().length > 0 ? ticket.description.trim() : '(empty)'
		);
	}

	if (vars.parent.length > 0 && !template.includes('{{parent}}')) {
		parts.push('', '---', '', vars.parent);
	}

	// After the ticket and its parent — those are context — and before the
	// instruction, which is a directive. Its heading says "rewrite it in full"
	// outright: a block of markdown with no such heading reads as a draft of the
	// *ticket* to rewrite, which is the failure `parentBlock` exists to avoid.
	if (vars.design.length > 0 && !template.includes('{{design}}')) {
		parts.push('', '---', '', vars.design);
	}

	// After the context and before the directives: the policy is a fact about
	// this run, not something the user asked for. It ends with the sentence that
	// overrides the skill's "do not modify any files" — a seeded copy in an older
	// workspace still says that, and only the prompt reaches every run.
	if (vars.writePolicy.length > 0 && !template.includes('{{writePolicy}}')) {
		parts.push('', '---', '', vars.writePolicy);
	}

	if (vars.instruction.length > 0 && !template.includes('{{instruction}}')) {
		parts.push('', '---', '', 'Additional instruction from the user:', '', vars.instruction);
	}

	// Last, so it is the nearest thing to the answer. The second line is
	// load-bearing: without it a model translates function names and file paths
	// too, and the description stops matching the repository it describes. So is
	// the third: left to itself a model renders `**As a**` as one translation in
	// one story, a longer one in the next and "As a" in a third, and `## Behaviour`
	// under three spellings, so no two tickets in the tracker share a shape. The skills say
	// the same, but a skill is a file the user owns and may have trimmed; this
	// line reaches every run whatever the skill says.
	if (vars.language.length > 0 && !template.includes('{{language}}')) {
		parts.push('', '---', '', ...languageBlock(vars.language));
	}

	return parts.join('\n').trim();
}

/**
 * The design document being written, as its own prompt section.
 *
 * Carrying the current body is what makes a second press a refinement rather
 * than a restart — the same reason the description is in the prompt at all.
 */
function designBlock(design: { title: string; style: string; body: string }): string {
	const body = design.body.trim();
	return [
		`You are writing the ${design.style} “${design.title}” for this ticket. ` +
			'Return the complete document, rewritten in full — not a patch and not only what changed.',
		'',
		'It currently reads:',
		'',
		body.length > 0 ? body : '(empty — this is the first draft)'
	].join('\n');
}

/**
 * What the run may change on disk, stated where the agent will act on it.
 *
 * Paths rather than bodies — the parent's description would read as a draft to
 * rewrite, the failure `parentBlock` exists to avoid — and the file-name rule,
 * because "update the epic" is a request to find `Epic.mdx`, not to guess. The
 * last sentence is load-bearing: every shipped skill ends with "do not write or
 * modify any files", and a copy seeded into a workspace before this existed
 * still does.
 */
function writePolicyBlock(edits: TrackerEditPolicy): string {
	const lines = [
		'You may edit the description file of another existing ticket when the user',
		'asks you to. A ticket is a folder under `' +
			edits.trackerFolder +
			'/`; its description is the',
		'`Epic.mdx`, `Story.mdx`, `AC.mdx` or `TestCase.mdx` inside that folder, and that',
		'file is the only thing in it you may change — never `metadata.yaml`, never',
		'`history.md`, never a file outside the tracker, and never a file that does not',
		'exist yet. Read a file before you edit it. BFAST records every edit you make',
		'in that ticket’s history after this run.'
	];
	if (edits.ownPath) {
		lines.push(
			'',
			'The ticket you are writing is `' +
				edits.ownPath +
				'`. Do not edit that file: return its',
			'description as your answer, as instructed above.'
		);
	}
	if (edits.parent) {
		lines.push(
			'',
			`It hangs under ${edits.parent.id} — “${edits.parent.title}” — whose description is`,
			'`' + edits.parent.path + '`.'
		);
	}
	lines.push(
		'',
		'This overrides any line above saying not to write or modify files: those refer',
		'to the document you return, which is still returned, never written.'
	);
	return lines.join('\n');
}

/** The ticket a proposed one will hang under, as its own prompt section. */
function parentBlock(parent: AiTicketContext, grandparent?: AiTicketContext): string {
	const label = TYPE_LABEL[parent.type] ?? parent.type;
	const heading = `It belongs under the ${label} ` +
		`${[parent.id, `“${parent.title}”`].filter(Boolean).join(' — ')}:`;
	const body = parent.description.trim();
	const lines = [heading, '', body.length > 0 ? body : '(no description yet)'];

	if (grandparent) {
		const above = grandparent.description.trim();
		lines.push(
			'',
			`That ${label} is part of the ${TYPE_LABEL[grandparent.type] ?? grandparent.type} ` +
				`${[grandparent.id, `“${grandparent.title}”`].filter(Boolean).join(' — ')}, ` +
				'given for context:',
			'',
			above.length > 0 ? above : '(no description yet)'
		);
	}

	return lines.join('\n');
}
