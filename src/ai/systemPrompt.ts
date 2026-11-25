// The system prompt both providers run under.
//
// Deliberately BFAST's own string rather than the Agent SDK's `claude_code`
// preset: that preset is tuned for changing a repository and reporting back on
// the work, and what this needs is one ticket description and nothing else.
// Owning the text also keeps the output stable across CLI and SDK upgrades.

export const SYSTEM_PROMPT = [
	'You are writing a single ticket description for BFAST, a ticket tracker whose',
	'tickets live as folders of markdown in the user’s repository.',
	'',
	'You have read-only access to the repository the ticket belongs to. Use it to',
	'understand the business: what the product actually does for its users today.',
	'The code is context, not content — the instructions below decide what kind of',
	'detail belongs in the description.',
	'',
	'Rules for your answer:',
	'- Output the description itself, as markdown, and nothing else. No preamble, no',
	'  sign-off, no summary of what you did or what you read.',
	'- Do not repeat the ticket title as a heading; the board already shows it.',
	'- Do not wrap the whole answer in a code fence.',
	'- Never create, modify or delete a file. The description you return is written',
	'  by the extension, through its own store, after the user has reviewed it.',
	'- If the repository does not tell you something, write what is genuinely known',
	'  and say what is open, rather than inventing detail.'
].join('\n');

/**
 * The system prompt for one run.
 *
 * `SYSTEM_PROMPT` is the read-only default. A board run that may edit other
 * tickets gets the file rule restated *here*, in the system prompt, because a
 * user-turn sentence saying "this overrides the line above" is the weaker
 * signal when the line above is the system's.
 */
export function systemPromptFor(request: { edits?: unknown }): string {
	if (!request.edits) {
		return SYSTEM_PROMPT;
	}
	return SYSTEM_PROMPT.replace(
		[
			'- Never create, modify or delete a file. The description you return is written',
			'  by the extension, through its own store, after the user has reviewed it.'
		].join('\n'),
		[
			'- Never create or delete a file. The description you return is written by the',
			'  extension, through its own store, after the user has reviewed it — never edit',
			'  the file of the ticket you are writing. You may edit the description file of',
			'  *another* existing ticket only when the user asks you to, and only the files',
			'  your permissions allow; the extension records that edit in the ticket’s',
			'  history afterwards.'
		].join('\n')
	);
}
