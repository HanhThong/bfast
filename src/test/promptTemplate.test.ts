import * as assert from 'assert';
import type { AiTicketContext } from '../ai/aiProvider';
import { parseTitleList, sanitizeAiDescription } from '../ai/aiResult';
import { TITLE_LIST_FORMAT, buildResumedPrompt, combineInstruction } from '../ai/generateChildren';
import {
	STRUCTURE_STAYS_ENGLISH,
	buildPrompt,
	languageBlock,
	renderTemplate
} from '../ai/promptTemplate';

const TICKET: AiTicketContext = {
	id: 'EP-1',
	type: 'epic',
	title: 'Authentication',
	status: 'todo',
	description: 'Sign-in is missing.'
};

suite('BFAST AI prompt', () => {
	test('substitutes the known placeholders', () => {
		assert.strictEqual(
			renderTemplate('{{title}} / {{type}} / {{status}} / {{description}} / {{instruction}}', {
				title: 'Auth',
				type: 'epic',
				status: 'todo',
				description: 'text',
				instruction: 'be brief',
				language: 'Vietnamese',
				parent: '', design: '', writePolicy: ''
			}),
			'Auth / epic / todo / text / be brief'
		);
	});

	// A description is markdown written by a person; text containing braces has
	// to survive a round trip through here untouched.
	test('leaves an unknown placeholder alone', () => {
		const vars = {
			title: 'a',
			type: 'b',
			status: 'c',
			description: 'd',
			instruction: 'e',
			language: '',
			parent: '', design: '', writePolicy: ''
		};
		assert.strictEqual(renderTemplate('{{nonsense}} {{title}}', vars), '{{nonsense}} a');
		assert.strictEqual(renderTemplate('use {{ spaced }} here', vars), 'use {{ spaced }} here');
		assert.strictEqual(renderTemplate('{{}}', vars), '{{}}');
	});

	test('appends the ticket when the template never asks for the description', () => {
		const prompt = buildPrompt('Write the epic "{{title}}".', TICKET, '');
		assert.ok(prompt.startsWith('Write the epic "Authentication".'));
		assert.ok(prompt.includes('EP-1 — Authentication (epic, todo)'));
		assert.ok(prompt.includes('Sign-in is missing.'));
	});

	test('does not append it twice when the template already substituted it', () => {
		const prompt = buildPrompt('Rewrite: {{description}}', TICKET, '');
		assert.ok(prompt.includes('Sign-in is missing.'));
		assert.strictEqual(prompt.split('Sign-in is missing.').length - 1, 1);
		assert.ok(!prompt.includes('Current description:'));
	});

	test('says so explicitly when the description is empty', () => {
		const prompt = buildPrompt('Write it.', { ...TICKET, description: '   ' }, '');
		assert.ok(prompt.includes('(empty)'));
	});

	test('appends the instruction only when the template did not place it', () => {
		const appended = buildPrompt('Write it.', TICKET, '  focus on SSO  ');
		assert.ok(appended.includes('Additional instruction from the user:'));
		assert.ok(appended.includes('focus on SSO'));

		const placed = buildPrompt('Write it. {{instruction}}', TICKET, 'focus on SSO');
		assert.ok(!placed.includes('Additional instruction from the user:'));
		assert.strictEqual(placed.split('focus on SSO').length - 1, 1);

		assert.ok(!buildPrompt('Write it.', TICKET, '   ').includes('Additional instruction'));
	});

	// The setting is off by default, and off has to mean the prompt is exactly
	// what it was before the setting existed.
	test('says nothing about language when none was chosen', () => {
		for (const language of [undefined, '', '   ']) {
			assert.ok(!buildPrompt('Write it.', TICKET, '', { language: language }).includes('Write the description in'));
		}
	});

	test('appends the language last, and protects identifiers', () => {
		const prompt = buildPrompt('Write it.', TICKET, 'focus on SSO', { language: ' Vietnamese ' });
		assert.ok(prompt.includes('Write the description in Vietnamese.'));
		assert.ok(prompt.includes('Keep code, identifiers, file paths and ticket ids exactly as they are.'));
		assert.ok(
			prompt.indexOf('Write the description in Vietnamese.') >
				prompt.indexOf('Additional instruction from the user:'),
			'the language block belongs nearest the answer'
		);
	});

	test('lets a skill place {{language}} itself instead', () => {
		const placed = buildPrompt('Write it in {{language}}.', TICKET, '', { language: 'Japanese' });
		assert.ok(placed.includes('Write it in Japanese.'));
		assert.ok(!placed.includes('Write the description in Japanese.'));
		assert.ok(!placed.includes(STRUCTURE_STAYS_ENGLISH));
	});

	// A translated story used to open with "Là", "Là một" or "As a" depending on
	// the run, and its headings under as many spellings. The language block is
	// the one seam every run passes through, so it is where the structure rule
	// has to live — a skill file in the workspace may have been trimmed.
	test('keeps the headings and keywords in English whatever the language', () => {
		const prompt = buildPrompt('Write it.', TICKET, '', { language: 'Vietnamese' });
		assert.ok(prompt.includes(STRUCTURE_STAYS_ENGLISH));
		assert.ok(
			prompt.indexOf(STRUCTURE_STAYS_ENGLISH) > prompt.indexOf('Write the description in Vietnamese.')
		);
		for (const keyword of ['**As a**', '**I want**', '**So that**', '**Given**', '**When**', '**Then**', '## Behaviour']) {
			assert.ok(STRUCTURE_STAYS_ENGLISH.includes(keyword), `the rule should name ${keyword}`);
		}
		assert.ok(!buildPrompt('Write it.', TICKET, '', { language: '' }).includes(STRUCTURE_STAYS_ENGLISH));
	});

	// The sidebar writes a story from nothing but a title, so the ticket block
	// has to survive a context that has no id yet.
	test('leaves out an id the ticket does not have yet', () => {
		const prompt = buildPrompt('Write it.', { ...TICKET, id: '', type: 'story' }, '');
		assert.ok(prompt.includes('Ticket: Authentication (story, todo)'));
		assert.ok(!prompt.includes(' — Authentication'), 'an empty id left a dangling dash');
	});

	// A design run rewrites a whole document, so the current one is context the
	// way the description is — that is what makes a second press a refinement.
	test('carries the design being written, and says to rewrite it in full', () => {
		const prompt = buildPrompt('Draw it.', TICKET, '', {
			design: { title: 'Account model', style: 'erd', body: '```mermaid\nerDiagram\n```' }
		});
		assert.ok(prompt.includes('the erd “Account model”'));
		assert.ok(prompt.includes('rewritten in full'));
		assert.ok(prompt.includes('erDiagram'));
	});

	test('an empty design says so rather than looking like a missing block', () => {
		const prompt = buildPrompt('Draw it.', TICKET, '', {
			design: { title: 'Account model', style: 'erd', body: '   ' }
		});
		assert.ok(prompt.includes('(empty — this is the first draft)'));
	});

	test('the design block is skipped when the template asks for it itself', () => {
		const prompt = buildPrompt('Draw it: {{design}}', TICKET, '', {
			design: { title: 'A', style: 'erd', body: 'BODY' }
		});
		assert.strictEqual(prompt.match(/BODY/g)?.length, 1, 'the block was appended as well');
	});

	// Order matters: the ticket and its parent are context, the instruction and
	// the language are directives, and the language stays nearest the answer.
	test('the design block sits between the parent and the instruction', () => {
		const prompt = buildPrompt('Draw it.', TICKET, 'Keep it small.', {
			language: 'Vietnamese',
			parent: { ...TICKET, id: 'EP-9', title: 'Parent', description: 'PARENTBODY' },
			design: { title: 'A', style: 'erd', body: 'DESIGNBODY' }
		});
		assert.ok(
			prompt.indexOf('PARENTBODY') < prompt.indexOf('DESIGNBODY'),
			'the design came before the parent'
		);
		assert.ok(
			prompt.indexOf('DESIGNBODY') < prompt.indexOf('Keep it small.'),
			'the design came after the instruction'
		);
		assert.ok(
			prompt.indexOf('Keep it small.') < prompt.indexOf('Vietnamese'),
			'the language is no longer last'
		);
	});

	// A board run that may edit other tickets is told so where it will act on it:
	// which files, by path; which one is its own; and that this overrides the
	// skill's "do not modify any files" for other tickets only.
	test('states the write policy, with paths, when the run may edit other tickets', () => {
		const prompt = buildPrompt('Write it.', TICKET, 'also update the epic', {
			edits: {
				trackerFolder: '.tracker',
				ownPath: '.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx',
				parent: { id: 'EP-1', title: 'Auth', path: '.tracker/EP-1-Auth/Epic.mdx' }
			}
		});
		assert.ok(prompt.includes('`.tracker/`'));
		assert.ok(prompt.includes('`.tracker/EP-1-Auth/ST-1.1-Sign_in/Story.mdx`'));
		assert.ok(prompt.includes('Do not edit that file'));
		assert.ok(prompt.includes('EP-1 — “Auth”'));
		assert.ok(prompt.includes('`.tracker/EP-1-Auth/Epic.mdx`'));
		assert.ok(prompt.includes('never `metadata.yaml`'));
		assert.ok(prompt.includes('This overrides any line above'));
		// Between the context and the instruction, so the directive stays nearest the answer.
		assert.ok(prompt.indexOf('This overrides') < prompt.indexOf('also update the epic'));
	});

	test('says nothing about editing when the run may not', () => {
		const prompt = buildPrompt('Write it.', TICKET, '');
		assert.ok(!prompt.includes('This overrides any line above'));
		assert.ok(!prompt.includes('metadata.yaml'));
	});

	test('the policy block is skipped when the template asks for it itself', () => {
		const prompt = buildPrompt('Policy: {{writePolicy}}', TICKET, '', {
			edits: { trackerFolder: '.tracker' }
		});
		assert.strictEqual(prompt.match(/This overrides any line above/g)?.length, 1);
	});

	test('says nothing about a design when the run is not a design run', () => {
		assert.ok(!buildPrompt('Write it.', TICKET, '').includes('rewritten in full'));
	});

	test('says nothing about a parent when there is none', () => {
		assert.ok(!buildPrompt('Write it.', TICKET, '').includes('It belongs under'));
	});

	test('appends the parent between the ticket and the instruction', () => {
		const prompt = buildPrompt('Write it.', { ...TICKET, id: '', type: 'story', title: 'Sign in', description: '' }, 'focus on SSO', { language: 'Vietnamese', parent: TICKET });

		assert.ok(prompt.includes('It belongs under the epic EP-1 — “Authentication”:'));
		assert.ok(prompt.includes('Sign-in is missing.'));

		// Order is the point: the parent is context, so it comes after the ticket
		// and before the two directives that end the prompt.
		assert.ok(prompt.indexOf('It belongs under') > prompt.indexOf('Current description:'));
		assert.ok(prompt.indexOf('It belongs under') < prompt.indexOf('Additional instruction'));
		assert.ok(prompt.indexOf('It belongs under') < prompt.indexOf('Write the description in'));
	});

	test('names a parent that has no description of its own', () => {
		const prompt = buildPrompt('Write it.', TICKET, '', { parent: {
			...TICKET,
			description: '   '
		} });
		assert.ok(prompt.includes('(no description yet)'));
	});

	test('a grandparent follows its parent, inside the parent block', () => {
		const criterion: AiTicketContext = {
			id: 'AC-1.1.1',
			type: 'ac',
			title: 'Wrong password',
			status: 'todo',
			description: 'CRITERIONBODY'
		};
		const story: AiTicketContext = { ...criterion, id: 'ST-1.1', type: 'story', title: 'Sign in', description: 'STORYBODY' };
		const proposed: AiTicketContext = { ...criterion, id: '', type: 'testcase', title: 'A test', description: '' };

		const prompt = buildPrompt('Write it.', proposed, 'be brief', { parent: criterion, grandparent: story });
		assert.ok(prompt.includes('It belongs under the acceptance criterion AC-1.1.1 — “Wrong password”:'));
		assert.ok(prompt.includes('That acceptance criterion is part of the story ST-1.1 — “Sign in”, given for context:'));
		assert.ok(prompt.indexOf('CRITERIONBODY') < prompt.indexOf('STORYBODY'));
		assert.ok(prompt.indexOf('STORYBODY') < prompt.indexOf('Additional instruction'));

		// `{{parent}}` carries both, so a skill that places the block gets the story too.
		const placed = buildPrompt('Under: {{parent}}', proposed, '', { parent: criterion, grandparent: story });
		assert.ok(placed.includes('STORYBODY'));
		assert.strictEqual(placed.split('STORYBODY').length - 1, 1);

		// With no parent to hang it off, there is nothing to say it is above.
		assert.ok(!buildPrompt('Write it.', proposed, '', { grandparent: story }).includes('STORYBODY'));
	});

	test('lets a skill place {{parent}} itself instead', () => {
		const placed = buildPrompt('Under: {{parent}}', TICKET, '', { parent: TICKET });
		assert.ok(placed.startsWith('Under: It belongs under the epic EP-1'));
		assert.strictEqual(
			placed.split('It belongs under').length - 1,
			1,
			'the block was appended as well as substituted'
		);
	});
});

suite('BFAST AI resumed plan prompt', () => {
	// A model answering "split the third one" tends to return the third one
	// alone; the restated contract is what makes the answer the whole list.
	test('a follow-up restates the contract and asks for the whole list, not a diff', () => {
		const prompt = buildResumedPrompt(
			{ sessionId: 's1', followUp: '  split the third one  ' },
			TICKET
		);
		assert.ok(prompt.includes('The user has reviewed your list and asks:\n\nsplit the third one'));
		assert.ok(prompt.includes('complete updated list'));
		assert.ok(prompt.includes(TITLE_LIST_FORMAT));
		assert.ok(/do not write or modify any files/i.test(prompt));
		assert.ok(!prompt.includes('Since your last answer'));
		// The ticket and the skill are already in the session.
		assert.ok(!prompt.includes('Current description:'));
		assert.ok(!prompt.includes('List the stories.'));
	});

	test('a continued batch names what exists and asks for new titles only', () => {
		const prompt = buildResumedPrompt(
			{
				sessionId: 's1',
				followUp: 'the recovery flows',
				existing: [{ id: 'ST-1.1', title: 'Sign in' }]
			},
			TICKET
		);
		assert.ok(prompt.includes('these stories now exist under EP-1:'));
		assert.ok(prompt.includes('- ST-1.1 — Sign in'));
		assert.ok(prompt.includes('still missing'));
		assert.ok(!prompt.includes('complete updated list'));
		assert.ok(prompt.indexOf('now exist') < prompt.indexOf('the recovery flows'));
	});

	test('says so when nothing was created', () => {
		const prompt = buildResumedPrompt({ sessionId: 's1', existing: [] }, TICKET);
		assert.ok(prompt.includes('None of the stories you proposed has been created.'));
		assert.ok(prompt.includes('still missing'));
		assert.ok(!prompt.includes('The user has reviewed'));
	});

	test('ends with the same language block buildPrompt uses', () => {
		const tail = languageBlock('Vietnamese').join('\n');
		assert.ok(tail.includes(STRUCTURE_STAYS_ENGLISH));
		assert.ok(buildPrompt('Write it.', TICKET, '', { language: 'Vietnamese' }).endsWith(tail));
		assert.ok(
			buildResumedPrompt({ sessionId: 's1', followUp: 'shorter' }, TICKET, 'Vietnamese').endsWith(tail)
		);
		assert.ok(
			!buildResumedPrompt({ sessionId: 's1', followUp: 'shorter' }, TICKET).includes(
				'Write the description in'
			)
		);
		assert.deepStrictEqual(languageBlock('  '), []);
		assert.deepStrictEqual(languageBlock(undefined), []);
	});

	// An unrefined batch has to prompt exactly as it always did.
	test('combineInstruction leaves an instruction with no follow-ups byte-identical', () => {
		assert.strictEqual(combineInstruction('  focus on SSO ', []), '  focus on SSO ');
		assert.strictEqual(combineInstruction('', ['  ']), '');
	});

	test('combineInstruction numbers the follow-ups under the instruction', () => {
		assert.strictEqual(
			combineInstruction('focus on SSO', ['drop billing', 'add the empty\nstate']),
			'focus on SSO\n\nThe user then refined the proposed list with these follow-ups, in order:\n' +
				'1. drop billing\n2. add the empty\n   state'
		);
		assert.ok(combineInstruction('', ['drop billing']).startsWith('The user then refined'));
	});
});

suite('BFAST AI result', () => {
	test('unwraps one fence wrapping the whole answer', () => {
		assert.strictEqual(sanitizeAiDescription('```markdown\n# Goal\ntext\n```'), '# Goal\ntext');
		assert.strictEqual(sanitizeAiDescription('```\ntext\n```'), 'text');
		assert.strictEqual(sanitizeAiDescription('~~~md\ntext\n~~~'), 'text');
	});

	test('leaves a genuine code block alone', () => {
		const typescript = '```ts\nconst x = 1;\n```';
		assert.strictEqual(sanitizeAiDescription(typescript), typescript);

		// Two fences inside mean these are content, not a wrapper.
		const two = '```\na\n```\ntext\n```\nb\n```';
		assert.strictEqual(sanitizeAiDescription(two), two);

		const unclosed = '```markdown\ntext';
		assert.strictEqual(sanitizeAiDescription(unclosed), unclosed);
	});

	test('drops a heading that just repeats the ticket title', () => {
		assert.strictEqual(sanitizeAiDescription('# Authentication\n\ntext', 'Authentication'), 'text');
		assert.strictEqual(sanitizeAiDescription('## authentication!\n\ntext', 'Authentication'), 'text');
		assert.strictEqual(
			sanitizeAiDescription('# Sign-in flow\n\ntext', 'Authentication'),
			'# Sign-in flow\n\ntext'
		);
		assert.strictEqual(sanitizeAiDescription('# Authentication\n\ntext'), '# Authentication\n\ntext');
	});

	test('handles both wrappers at once, and trims', () => {
		assert.strictEqual(
			sanitizeAiDescription('```markdown\n# Authentication\n\ntext\n```\n\n', 'Authentication'),
			'text'
		);
		assert.strictEqual(sanitizeAiDescription('   \n\n text \n\n '), 'text');
		assert.strictEqual(sanitizeAiDescription(''), '');
	});
});

suite('BFAST AI title list', () => {
	test('takes the titles out of a plain bulleted list', () => {
		assert.deepStrictEqual(parseTitleList('- Sign in with email\n- Reset a password'), [
			'Sign in with email',
			'Reset a password'
		]);
	});

	// The skill asks for `- one per line`; a model periodically does something
	// else, and none of those should cost the user the whole run.
	test('survives the decoration a model adds anyway', () => {
		assert.deepStrictEqual(
			parseTitleList(
				[
					'Here are the stories:',
					'',
					'1. **Sign in with email**',
					'2) Story 2: Reset a password',
					'* [ ] Lock the account after five failures',
					'',
					'Let me know if you want more.'
				].join('\n')
			),
			['Sign in with email', 'Reset a password', 'Lock the account after five failures']
		);
	});

	test('reads a list the model wrapped in a fence', () => {
		assert.deepStrictEqual(parseTitleList('```markdown\n- Sign in\n- Sign out\n```'), [
			'Sign in',
			'Sign out'
		]);
		// One the whole-answer unwrapper does not touch, because it is labelled.
		assert.deepStrictEqual(parseTitleList('Stories:\n```text\n- Sign in\n```\ndone'), ['Sign in']);
	});

	test('takes bare lines only when they still read like a list', () => {
		assert.deepStrictEqual(parseTitleList('Sign in with email\nReset a password'), [
			'Sign in with email',
			'Reset a password'
		]);

		// A paragraph is one long line, so it cannot be mistaken for a title.
		const prose =
			'This epic is really about authentication, and it covers signing in, ' +
			'signing out, resetting a password and locking an account after repeated failures.';
		assert.deepStrictEqual(parseTitleList(prose), []);
	});

	test('drops duplicates and empties, and honours the cap', () => {
		assert.deepStrictEqual(parseTitleList('- Sign in\n- sign in\n-   \n- Sign out'), [
			'Sign in',
			'Sign out'
		]);
		assert.strictEqual(parseTitleList('- a\n- b\n- c\n- d', 2).length, 2);
		assert.deepStrictEqual(parseTitleList(''), []);
	});

	// Titles come back in whatever `ai.language` asked for, and become folder
	// slugs — nothing here may be ASCII-only.
	test('keeps a non-ASCII title intact', () => {
		assert.deepStrictEqual(parseTitleList('- Đăng nhập bằng email\n- Đặt lại mật khẩu'), [
			'Đăng nhập bằng email',
			'Đặt lại mật khẩu'
		]);
	});
});
