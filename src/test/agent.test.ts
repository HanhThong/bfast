import * as assert from 'assert';
import {
	agentsForType,
	composeInstruction,
	deslugifyAgent,
	parseAgent,
	parseSkill,
	resolveAgent,
	resolvePlanSkill,
	resolveDesignSkill,
	resolveSkill,
	serializeAgent,
	serializeSkill,
	skillKind,
	stylesFromAgents,
	skillLabel,
	slugifyAgentName,
	ticketTypeLabel,
	typeFromName,
	type AgentDefinition,
	type AgentSkill
} from '../ai/agent';
import { BUILT_IN_STYLES, DESIGN_TYPES } from '../design/designDocument';
import { TICKET_TYPES, type TicketType } from '../data/types';

const FILE = [
	'---',
	'name: Business Analyst',
	'description: Writes epics',
	'types: epic, story, ac',
	'---',
	'',
	'You are a business analyst.',
	'',
	'Write well.'
].join('\n');

/** A skill built by hand, so a case says exactly what it is about. */
function skill(slug: string, over: Partial<AgentSkill> = {}): AgentSkill {
	return {
		slug,
		name: slug,
		types: [],
		instruction: 'Shape it.',
		resources: [],
		...over
	};
}

suite('BFAST agents', () => {
	test('reads frontmatter and keeps the body as the instruction', () => {
		const agent = parseAgent(FILE, 'business-analyst');
		assert.strictEqual(agent.slug, 'business-analyst');
		assert.strictEqual(agent.name, 'Business Analyst');
		assert.strictEqual(agent.description, 'Writes epics');
		assert.deepStrictEqual(agent.types, ['epic', 'story', 'ac']);
		assert.strictEqual(agent.instruction, 'You are a business analyst.\n\nWrite well.');
	});

	test('accepts commas or spaces, and drops a type that does not exist', () => {
		assert.deepStrictEqual(parseAgent('---\ntypes: ac story\n---\nx', 'a').types, ['story', 'ac']);
		assert.deepStrictEqual(parseAgent('---\ntypes: EPIC, Bug\n---\nx', 'a').types, ['epic']);
		// Ordered by TICKET_TYPES, not by how they were listed, so the picker is
		// stable however someone wrote the file.
		assert.deepStrictEqual(parseAgent('---\ntypes: testcase, epic\n---\nx', 'a').types, [
			'epic',
			'testcase'
		]);
	});

	// Reading is forgiving: a hand-edited file must still load.
	test('falls back rather than failing on a broken file', () => {
		// No `name:`, so the filename stands in for one.
		const bare = parseAgent('Just an instruction.', 'tech-writer');
		assert.strictEqual(bare.name, 'Tech Writer');
		assert.strictEqual(bare.instruction, 'Just an instruction.');
		// No usable `types` would make the agent invisible everywhere, which reads
		// as it having silently vanished — so it offers all of them instead.
		assert.deepStrictEqual(bare.types, [...TICKET_TYPES]);

		assert.strictEqual(parseAgent('', 'x').instruction, '');
		assert.strictEqual(parseAgent('---\nnot: closed\nstill going', 'x').name, 'X');
		assert.deepStrictEqual(parseAgent('---\ntypes:\n---\n', 'x').types, [...TICKET_TYPES]);
	});

	// The Agent Skill format requires the two to match, and a folder cannot lie
	// about what it is called — the same reason the tracker lets nesting win over
	// a hand-typed id.
	test('a skill is named after its folder, whatever the frontmatter claims', () => {
		const named = parseSkill('---\nname: Writing an epic\n---\nx', 'write-epic');
		assert.strictEqual(named.name, 'write-epic');
		assert.strictEqual(parseSkill('x', 'write-epic').name, 'write-epic');

		// The sentence a person wants to read lives in `description` instead, and
		// `skillLabel` is what the UI shows: derived from the folder, so what is on
		// screen is always the file the user would go and edit. Verb first and
		// sentence case, because a skill is an action rather than a job title.
		const parsed = parseSkill(
			'---\ndescription: How to write one\n---\nx',
			'write-acceptance-criterion'
		);
		assert.strictEqual(parsed.description, 'How to write one');
		assert.strictEqual(skillLabel(parsed), 'Write acceptance criterion');
		assert.strictEqual(skillLabel(named), 'Write epic');
		assert.strictEqual(skillLabel(skill('discovery')), 'Discovery');
	});

	test('a skill folder naming a ticket type needs no frontmatter to say so', () => {
		assert.deepStrictEqual(parseSkill('Write it well.', 'epic').types, ['epic']);
		assert.deepStrictEqual(parseSkill('Write it well.', 'testcase').types, ['testcase']);
		// Verb first, which is how the shipped ones are named.
		assert.deepStrictEqual(parseSkill('x', 'write-epic').types, ['epic']);
		assert.deepStrictEqual(parseSkill('x', 'write-test-case').types, ['testcase']);
		assert.deepStrictEqual(parseSkill('x', 'write-acceptance-criterion').types, ['ac']);
		// Frontmatter still wins, so a skill can cover more than its folder name.
		assert.deepStrictEqual(parseSkill('---\ntypes: story, ac\n---\nx', 'epic').types, [
			'story',
			'ac'
		]);
		// A name that is not a type leaves it to the frontmatter — and with none,
		// the skill covers nothing rather than everything.
		assert.deepStrictEqual(parseSkill('x', 'discovery').types, []);
	});

	test('round-trips through the file format', () => {
		const written: Omit<AgentSkill, 'slug' | 'resources' | 'path'> = {
			name: 'epic',
			description: 'How to write one.',
			types: ['epic'],
			instruction: 'Shape it.'
		};
		assert.deepStrictEqual(parseSkill(serializeSkill(written), 'epic'), {
			...written,
			slug: 'epic',
			resources: []
		});

		const role: AgentDefinition = {
			slug: 'x',
			name: 'X',
			types: ['epic'],
			// A body containing `---` must not be mistaken for the frontmatter fence.
			instruction: 'First.\n\n---\n\nSecond.',
			skills: []
		};
		assert.deepStrictEqual(parseAgent(serializeAgent(role), 'x'), role);
	});

	test('the skills decide what an agent can write', () => {
		const role = '---\ntypes: epic\n---\nThe role.';
		const withSkills = parseAgent(role, 'ba', [
			skill('story', { types: ['story'] }),
			skill('ac', { types: ['ac'] })
		]);
		// Not `epic` from the frontmatter: the skills are the authority once there
		// are any, and they are ordered by TICKET_TYPES rather than by folder order.
		assert.deepStrictEqual(withSkills.types, ['story', 'ac']);

		// With no skills the role's own frontmatter is the fallback, which is what
		// keeps a hand-written single-file agent working.
		assert.deepStrictEqual(parseAgent(role, 'ba').types, ['epic']);
	});

	test('picks the agents that write a given type', () => {
		const ba = parseAgent('The role.', 'ba', [skill('epic', { types: ['epic'] })]);
		const qa = parseAgent('The role.', 'qa', [skill('testcase', { types: ['testcase'] })]);

		assert.deepStrictEqual(
			agentsForType([ba, qa], 'epic').map((a) => a.slug),
			['ba']
		);
		assert.deepStrictEqual(
			agentsForType([ba, qa], 'testcase').map((a) => a.slug),
			['qa']
		);
	});

	// The picker's choice goes stale whenever a file is edited mid-session, so
	// resolving has to fall back rather than fail.
	test('resolves the asked-for agent, else the first that fits', () => {
		const ba = parseAgent('The role.', 'ba', [skill('epic', { types: ['epic'] })]);
		const qa = parseAgent('The role.', 'qa', [skill('testcase', { types: ['testcase'] })]);
		const agents = [ba, qa];

		assert.strictEqual(resolveAgent(agents, 'epic', 'ba')?.slug, 'ba');
		assert.strictEqual(resolveAgent(agents, 'epic', 'qa')?.slug, 'ba');
		assert.strictEqual(resolveAgent(agents, 'epic', 'deleted')?.slug, 'ba');
		assert.strictEqual(resolveAgent(agents, 'epic')?.slug, 'ba');
		assert.strictEqual(resolveAgent([], 'epic'), undefined);
	});

	test('resolves the skill for a type, and composes role then skill', () => {
		const epic = skill('write-epic', { types: ['epic'], instruction: 'Shape the epic.' });
		const agent = parseAgent('The role.', 'ba', [epic]);

		assert.strictEqual(resolveSkill(agent, 'epic')?.slug, 'write-epic');
		assert.strictEqual(resolveSkill(agent, 'testcase'), undefined);
		assert.strictEqual(resolveSkill(undefined, 'epic'), undefined);

		const composed = composeInstruction(agent, epic);
		assert.ok(composed.startsWith('The role.'));
		assert.ok(composed.includes('Shape the epic.'));
		// The heading is the skill's own name, which starts with a verb, so it
		// reads as one without anything being added to it.
		assert.ok(composed.includes('## Write epic'));

		// An agent with no skill for this type still runs on its role alone.
		assert.strictEqual(composeInstruction(agent, undefined), 'The role.');
	});

	// A plan skill declares the type it *reads*, so it collides with the write
	// skill for that type on every lookup unless the kind is part of it.
	test('a plan skill never stands in for the write skill of the same type', () => {
		const plan = skill('break-down-epic', {
			kind: 'plan',
			types: ['epic'],
			instruction: 'List the stories.'
		});
		const write = skill('write-epic', { types: ['epic'], instruction: 'Shape the epic.' });

		// Listed plan-first, the order a directory read gives them.
		const agent = parseAgent('The role.', 'ba', [plan, write]);

		assert.strictEqual(resolveSkill(agent, 'epic')?.slug, 'write-epic');
		assert.strictEqual(resolvePlanSkill(agent, 'epic')?.slug, 'break-down-epic');
		assert.strictEqual(resolvePlanSkill(agent, 'story'), undefined);
		assert.strictEqual(resolvePlanSkill(undefined, 'epic'), undefined);

		// And it must not make the agent claim a type it cannot write.
		const planOnly = parseAgent('---\ntypes: story\n---\n\nThe role.', 'ba', [plan]);
		assert.deepStrictEqual(planOnly.types, ['story']);
	});

	// Two design skills cover the same ticket types, so the type separates
	// nothing — the style is the whole key, and a design skill must never become
	// the board's write skill for epics and stories.
	test('a design skill is found by style, and never stands in for a write skill', () => {
		const erd = parseSkill(
			'---\nkind: design\nstyle: entity-relationship-diagram\n---\n\nDraw the entities.',
			'design-entity-relationship-diagram'
		);
		const sequence = parseSkill(
			'---\nkind: design\nstyle: sequence-diagram\n---\n\nDraw the calls.',
			'design-sequence-diagram'
		);
		const write = skill('write-epic', { types: ['epic'], instruction: 'Shape the epic.' });

		// Listed design-first, the order a directory read gives them.
		const agent = parseAgent('The role.', 'sa', [erd, sequence, write]);

		assert.strictEqual(
			resolveDesignSkill(agent, 'sequence-diagram')?.slug,
			'design-sequence-diagram'
		);
		assert.strictEqual(resolveSkill(agent, 'epic')?.slug, 'write-epic');
		assert.strictEqual(resolveDesignSkill(agent, 'c4-context'), undefined);
		assert.strictEqual(resolveDesignSkill(undefined, 'sequence-diagram'), undefined);

		// And it must not make the agent claim a ticket type it cannot write.
		const designOnly = parseAgent('---\ntypes: story\n---\n\nThe role.', 'sa', [erd]);
		assert.deepStrictEqual(designOnly.types, ['story']);
	});

	test('a design skill infers its kind, style and types from its folder', () => {
		// A SKILL.md stripped of its frontmatter has to keep working: the slug is
		// the style, and a design covers every ticket one can hang off.
		const naked = parseSkill('Draw the calls.', 'design-sequence-diagram');
		assert.strictEqual(skillKind(naked), 'design');
		assert.strictEqual(naked.style, 'sequence-diagram');
		assert.deepStrictEqual(naked.types, [...DESIGN_TYPES]);
	});

	// `serializeSkill` wrote the key only for `plan`, so a design skill came back
	// as a write one — and would then have shadowed the real write skill.
	test('a design skill round-trips, and a write skill still gains no key', () => {
		const design = parseSkill(
			'---\nkind: design\nstyle: sequence-diagram\ntypes: epic, story\n---\n\nDraw it.',
			'design-sequence-diagram'
		);
		const again = parseSkill(serializeSkill(design), design.slug);
		assert.strictEqual(skillKind(again), 'design');
		assert.strictEqual(again.style, 'sequence-diagram');

		const write = parseSkill('---\ntypes: epic\n---\n\nShape it.', 'write-epic');
		assert.ok(!serializeSkill(write).includes('kind:'), 'a write skill gained a kind');
		assert.ok(!serializeSkill(write).includes('style:'), 'a write skill gained a style');
	});

	// A style is a design skill: the board's "+" menu is the built-in styles plus
	// whatever the agents' design skills declare, read forgivingly.
	test('the styles on offer are the built-in ones plus every skill-declared one', () => {
		const c4 = parseSkill(
			'---\nkind: design\nstyle: c4-context\nlabel: C4 Context\nprefix: C4\n---\n\nDraw it.',
			'design-c4-context'
		);
		const naked = parseSkill('Draw it.', 'design-data-flow');
		const clash = parseSkill('---\nkind: design\nprefix: ERD\n---\n\nDraw it.', 'design-other');
		const ticketish = parseSkill('---\nkind: design\nprefix: ST\n---\n\nDraw it.', 'design-story-map');
		const again = parseSkill('---\nkind: design\nlabel: Different\nprefix: C5\n---\n\nDraw it.', 'design-c4-context');

		const { styles, warnings } = stylesFromAgents([
			parseAgent('Role.', 'architect', [c4, naked, clash, ticketish]),
			parseAgent('Role.', 'zed', [again])
		]);

		assert.deepStrictEqual(
			styles.map((style) => style.id),
			[...BUILT_IN_STYLES.map((style) => style.id), 'c4-context']
		);
		const custom = styles.find((style) => style.id === 'c4-context')!;
		assert.strictEqual(custom.label, 'C4 Context');
		assert.strictEqual(custom.prefix, 'C4');
		assert.strictEqual(custom.skill, 'design-c4-context');

		// A skill with no prefix, one reusing a taken prefix and one claiming a
		// ticket prefix are each named rather than silently dropped.
		assert.strictEqual(warnings.length, 3, warnings.join('\n'));
		assert.ok(warnings.some((warning) => warning.includes('design-data-flow')));
		assert.ok(warnings.some((warning) => warning.includes('design-other')));
		assert.ok(warnings.some((warning) => warning.includes('design-story-map')));
	});

	test('a design skill reads its label and prefix, and falls back on the label', () => {
		const skill = parseSkill(
			'---\nkind: design\nstyle: c4-context\nlabel: C4 Context\nprefix: c4\n---\n\nx',
			'design-c4-context'
		);
		assert.strictEqual(skill.label, 'C4 Context');
		assert.strictEqual(skill.prefix, 'C4', 'the prefix is upper-cased on the way in');

		const naked = parseSkill('x', 'design-data-flow');
		assert.strictEqual(naked.label, 'Data Flow');
		assert.strictEqual(naked.prefix, undefined);

		const written = parseSkill(serializeSkill(skill), skill.slug);
		assert.strictEqual(written.label, 'C4 Context');
		assert.strictEqual(written.prefix, 'C4');
	});

	test('a skill is a write skill unless it says otherwise', () => {
		assert.strictEqual(skillKind(parseSkill('---\ntypes: epic\n---\n\nx', 'write-epic')), 'write');
		assert.strictEqual(skillKind(parseSkill('---\nkind: plan\n---\n\nx', 'thing')), 'plan');
		// A typo is not a third kind.
		assert.strictEqual(skillKind(parseSkill('---\nkind: nonsense\n---\n\nx', 'thing')), 'write');

		// The folder says it too, so a SKILL.md stripped of its frontmatter keeps
		// working — the same rule that makes `write-epic/` find its own type.
		assert.strictEqual(skillKind(parseSkill('x', 'break-down-epic')), 'plan');
		assert.strictEqual(skillKind(parseSkill('x', 'write-epic')), 'write');
	});

	// A write skill has to serialise exactly as it did before the key existed,
	// or every skill file in every workspace gains a line on its next save.
	test('only a plan skill writes a kind into its frontmatter', () => {
		const write = serializeSkill({ name: 'write-epic', types: ['epic'], instruction: 'x' });
		assert.ok(!write.includes('kind:'));

		const plan = serializeSkill({
			name: 'break-down-epic',
			kind: 'plan',
			types: ['epic'],
			instruction: 'x'
		});
		assert.ok(plan.includes('kind: plan'));
		assert.strictEqual(skillKind(parseSkill(plan, 'break-down-epic')), 'plan');
	});

	test('names a person would type map to the right ticket type', () => {
		assert.strictEqual(typeFromName('Epic'), 'epic');
		assert.strictEqual(typeFromName('  stories '), 'story');
		assert.strictEqual(typeFromName('Acceptance Criterion'), 'ac');
		assert.strictEqual(typeFromName('acceptance-criteria'), 'ac');
		assert.strictEqual(typeFromName('Test Case'), 'testcase');
		assert.strictEqual(typeFromName('tc'), 'testcase');
		assert.strictEqual(typeFromName('Discovery'), undefined);
		assert.strictEqual(typeFromName(''), undefined);

		// Found by word, not by substring: `write-fact` holds the letters of `ac`
		// and must not become an acceptance criterion.
		assert.strictEqual(typeFromName('write-epic'), 'epic');
		assert.strictEqual(typeFromName('write-acceptance-criterion'), 'ac');
		assert.strictEqual(typeFromName('write-test-case'), 'testcase');
		assert.strictEqual(typeFromName('write-fact'), undefined);
		assert.strictEqual(typeFromName('summarise-the-epic'), 'epic');
	});

	test('every ticket type has a label fit for a sentence', () => {
		for (const type of TICKET_TYPES) {
			const label: string = ticketTypeLabel(type as TicketType);
			assert.ok(label.length > 0 && label[0] === label[0].toUpperCase(), `${type} needs a label`);
		}
	});

	test('slugs are filename-safe and survive a round trip', () => {
		assert.strictEqual(slugifyAgentName('Business Analyst'), 'business-analyst');
		assert.strictEqual(slugifyAgentName('  QA / Engineer!  '), 'qa-engineer');
		assert.strictEqual(slugifyAgentName('Chuyên viên'), 'chuy-n-vi-n');
		assert.strictEqual(slugifyAgentName('***'), 'agent');
		assert.strictEqual(slugifyAgentName(''), 'agent');
		assert.strictEqual(deslugifyAgent('business-analyst'), 'Business Analyst');
		assert.strictEqual(deslugifyAgent('qa_engineer'), 'Qa Engineer');
	});
});
