// The templates BFAST ships, tested as the files they actually are.
//
// These used to be string arrays in `agent.ts` and were asserted on directly.
// Now that they are markdown under `templates/`, the only honest test reads the
// same files `AgentStore` copies into a workspace — so a bad edit to one is
// caught here rather than the first time someone presses Generate.
//
// The shipped tree keeps roles and skills apart, because a skill belongs to no
// particular role; `seedable()` below joins them the way seeding does.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { TITLE_LIST_FORMAT } from '../ai/generateChildren';
import {
	RESOURCES_FOLDER,
	SKILL_FILE,
	composeInstruction,
	parseAgent,
	parseSkill,
	resolveSkill,
	serializeSkill,
	skillKind,
	skillLabel,
	type AgentDefinition,
	type AgentSkill,
	type SkillKind
} from '../ai/agent';
import { BUILT_IN_STYLES, DESIGN_TYPES } from '../design/designDocument';
import { allowedChildTypes } from '../data/trackerPaths';
import { TICKET_TYPES, type TicketType } from '../data/types';

/** `out/test/` → the repository root, where `templates/` sits. */
const ROOT = path.join(__dirname, '..', '..', 'templates');

const AGENT_TEMPLATE = 'AGENT-TEMPLATE.md';

function read(...parts: string[]): string {
	return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function entries(...parts: string[]): fs.Dirent[] {
	return fs.readdirSync(path.join(ROOT, ...parts), { withFileTypes: true });
}

/** The design skill a new style is scaffolded from; not a skill in its own right. */
const DESIGN_TEMPLATE = 'DESIGN-TEMPLATE';

/** One skill out of the library, by its folder name. */
function librarySkill(slug: string): AgentSkill {
	const dir = path.join(ROOT, 'skills', slug, RESOURCES_FOLDER);
	const resources = fs.existsSync(dir)
		? fs.readdirSync(dir).map((name) => ({
				name,
				path: `.bfast/agents/x/${slug}/${RESOURCES_FOLDER}/${name}`,
				content: read('skills', slug, RESOURCES_FOLDER, name)
			}))
		: [];
	return parseSkill(read('skills', slug, SKILL_FILE), slug, resources);
}

/** Every skill in the library. */
function library(): AgentSkill[] {
	return entries('skills')
		.filter((entry) => entry.isDirectory() && entry.name !== DESIGN_TEMPLATE)
		.map((entry) => librarySkill(entry.name));
}

/**
 * The library's skill of one kind for a ticket type, the way the store looks it
 * up.
 *
 * The kind is part of the lookup and not a filter afterwards, because the
 * library is read in directory order: `break-down-epic` comes back before
 * `write-epic`, so matching on the type alone finds the wrong one.
 */
function skillFor(kind: SkillKind, type: TicketType): AgentSkill | undefined {
	return library().find((skill) => skillKind(skill) === kind && skill.types.includes(type));
}

/**
 * The library's design skill for one style — a second lookup, because the type
 * cannot tell two design skills apart: both cover epic and story.
 */
function designSkillFor(style: string): AgentSkill | undefined {
	return library().find((skill) => skillKind(skill) === 'design' && skill.style === style);
}

/** The roles joined to their skills, the way `seed()` composes them. */
function seedable(): AgentDefinition[] {
	return entries('agents')
		.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== AGENT_TEMPLATE)
		.map((entry) => {
			const slug = entry.name.slice(0, -'.md'.length);
			const text = read('agents', entry.name);
			const types = parseAgent(text, slug).types;
			// A role's own `types:` is what says which skills it is seeded with —
			// both how it writes that type and how it breaks one down.
			const skills = types.flatMap((type) =>
				(['write', 'plan'] as const).flatMap((kind) => skillFor(kind, type) ?? [])
			);
			// Design skills are keyed by style, and cover epic *and* story — walking
			// the role's types would seed each of them twice. `readTemplates` does
			// exactly this, and this mirrors it by hand.
			if (types.includes('epic') || types.includes('story')) {
				skills.push(...BUILT_IN_STYLES.flatMap((style) => designSkillFor(style.id) ?? []));
			}
			return parseAgent(text, slug, skills);
		});
}

suite('BFAST bundled templates', () => {
	const agents = seedable();

	test('the extension ships roles, skills and a template for a new agent', () => {
		assert.ok(agents.length >= 2, 'templates/agents should hold at least the analyst and the engineer');
		assert.ok(fs.existsSync(path.join(ROOT, 'agents', AGENT_TEMPLATE)), 'the role template is missing');
		assert.ok(fs.existsSync(path.join(ROOT, 'skills')), 'the skill library is missing');
	});

	// `createSkill` looks the folder up by the type its SKILL.md declares, so a
	// type nothing declares cannot be added to any agent.
	test('the library holds exactly one skill for every ticket type', () => {
		for (const type of TICKET_TYPES) {
			const writing = library().filter(
				(skill) => skillKind(skill) === 'write' && skill.types.includes(type)
			);
			assert.strictEqual(writing.length, 1, `${writing.length} library skills write a ${type}`);
		}
	});

	// One per (kind, type), not one per type: a second plan skill for epics would
	// never run, since `resolvePlanSkill` takes the first match too.
	test('the library holds at most one plan skill per parent type', () => {
		for (const type of TICKET_TYPES) {
			const planning = library().filter(
				(skill) => skillKind(skill) === 'plan' && skill.types.includes(type)
			);
			assert.ok(planning.length <= 1, `${planning.length} library skills break down a ${type}`);

			// A type with no children cannot be broken down into anything.
			if (planning.length > 0) {
				assert.ok(
					allowedChildTypes(type).length > 0,
					`${planning[0].slug} breaks down a ${type}, which has no children`
				);
			}
		}
	});

	// Every ticket the sidebar breaks down — an epic, a story, a criterion — needs
	// a plan skill to fall back on: an agent without one of its own has no list
	// contract, and its answer is prose that parses to nothing.
	test('the library ships a plan skill for every ticket the sidebar breaks down', () => {
		const planners: Partial<Record<TicketType, string>> = {
			epic: 'break-down-epic',
			story: 'break-down-story',
			ac: 'break-down-acceptance-criterion'
		};
		for (const [type, slug] of Object.entries(planners)) {
			assert.strictEqual(skillFor('plan', type as TicketType)?.slug, slug, type);
		}
	});

	// `readTemplates` gives a role the plan skill for each type it declares, so a
	// role that writes no epics is never asked to break one down either — and the
	// ones that are left rely on `AgentStore.planSkill`'s library fallback. That
	// includes Test Engineer, the only shipped role that writes test cases: it
	// breaks a criterion down with the library's copy.
	test('a shipped role is seeded the plan skills its own types name', () => {
		const composition = Object.fromEntries(
			agents.map((agent) => [agent.slug, agent.skills.map((skill) => skill.slug)])
		);

		assert.deepStrictEqual(composition['qa-lead'], [
			'write-acceptance-criterion',
			'break-down-acceptance-criterion'
		]);
		assert.deepStrictEqual(composition['test-engineer'], ['write-test-case']);
		assert.ok(composition['business-analyst'].includes('break-down-story'));
		assert.ok(!composition['solution-architect'].includes('break-down-story'));

		// The regression this whole `kind` marker exists to prevent: the board's
		// epic skill must still be `write-epic`, whatever sorts before it.
		for (const agent of agents.filter((candidate) => candidate.types.includes('epic'))) {
			assert.strictEqual(resolveSkill(agent, 'epic')?.slug, 'write-epic', agent.slug);
		}
	});

	test('the library ships one design skill for every built-in style', () => {
		for (const style of BUILT_IN_STYLES) {
			const skill = designSkillFor(style.id);
			assert.ok(skill, `no design skill for ${style.id}`);
			// The board looks a skill up by the style's id, and `AgentStore` looks
			// the bundled fallback up the same way. A style whose skill slug did not
			// follow would silently have no fallback at all.
			assert.strictEqual(skill.slug, `design-${style.id}`);
			// A style is its skill, so the two must say the same thing about it —
			// or the "+" menu and a seeded copy would disagree on the prefix.
			assert.strictEqual(skill.label, style.label, skill.slug);
			assert.strictEqual(skill.prefix, style.prefix, skill.slug);
		}
	});

	// The scaffold for a new style, with the three facts a person supplies left
	// as placeholders — the `AGENT-TEMPLATE.md` rule, folder-shaped.
	test('the design template is a whole skill with its facts left blank', () => {
		const skill = read('skills', DESIGN_TEMPLATE, SKILL_FILE);
		for (const token of ['{{label}}', '{{style}}', '{{prefix}}']) {
			assert.ok(skill.includes(token), `SKILL.md should carry ${token}`);
		}
		assert.match(skill, /^kind: design$/m);
		assert.match(skill, /one ```mermaid fence/);
		assert.match(read('skills', DESIGN_TEMPLATE, RESOURCES_FOLDER, 'expected-output.md'), /<[^>]{4,}>/);
		// And it is not a skill: `library()` must skip it, or a style called
		// "template" would be offered on every board.
		assert.ok(!library().some((candidate) => candidate.slug === DESIGN_TEMPLATE));
	});

	// `readTemplates` used to walk a role's ticket types and ask for every kind,
	// which matched a design skill on the epic pass *and* the story pass — seeding
	// the folder twice. Nothing about the result looked wrong until you counted.
	test('a role that writes epics or stories is seeded each design skill once', () => {
		for (const agent of agents) {
			const designs = agent.skills.filter((skill) => skillKind(skill) === 'design');
			const expected =
				agent.types.includes('epic') || agent.types.includes('story')
					? BUILT_IN_STYLES.length
					: 0;
			assert.strictEqual(designs.length, expected, `${agent.slug} was seeded ${designs.length}`);
			assert.strictEqual(
				new Set(designs.map((skill) => skill.slug)).size,
				designs.length,
				`${agent.slug} was seeded the same design skill twice`
			);
		}
	});

	// `serializeSkill` wrote the key only when the kind was `plan`, so a design
	// skill came back as a write one — and would then have become the board's
	// skill for epics and stories.
	test('a design skill survives being written back out', () => {
		for (const style of BUILT_IN_STYLES) {
			const skill = designSkillFor(style.id)!;
			const again = parseSkill(serializeSkill(skill), skill.slug);
			assert.strictEqual(skillKind(again), 'design', skill.slug);
			assert.strictEqual(again.style, style.id, skill.slug);
			assert.deepStrictEqual(again.types, skill.types, skill.slug);
		}
	});

	// Every design answer has to survive `ensureMermaidFence` and land in a tab
	// that renders it: a wrapper around the whole answer turns the document into
	// one grey code block, and a translated identifier stops a diagram rendering
	// at all. How many diagrams a style takes is its own business — see below.
	test('a design skill fences its diagrams and wraps nothing', () => {
		for (const style of BUILT_IN_STYLES) {
			const skill = designSkillFor(style.id)!;
			const text = skill.instruction;
			assert.match(text, /```mermaid fence/, skill.slug);
			assert.match(text, /Do not wrap the whole answer in a code fence/, skill.slug);
			assert.match(text, /do not write or modify any files/, skill.slug);
			// A translated `erDiagram` does not render, and `ai.language` would
			// otherwise ask for exactly that.
			assert.match(text, /stay in English/, skill.slug);
			assert.ok(skill.resources.length > 0, `${skill.slug} ships no expected output`);
			assert.match(skill.resources[0].content, /```mermaid/, skill.slug);
		}
	});

	// The two picture styles are one diagram each and say so, since a second
	// `erDiagram` in one document is a second document. Low Level Design is
	// deliberately absent: it is free-form, and a ticket may want three diagrams
	// or none. A style added later is held to this only by being named here,
	// which is the safe default — the rule belongs to the style, not to design
	// skills as a kind.
	const ONE_DIAGRAM = ['entity-relationship-diagram', 'sequence-diagram'];

	test('a one-diagram style asks for exactly one mermaid fence', () => {
		for (const style of ONE_DIAGRAM) {
			const skill = designSkillFor(style);
			assert.ok(skill, `no design skill for ${style}`);
			assert.match(skill.instruction, /one ```mermaid fence/, skill.slug);
		}
	});

	test('a library skill is named after its folder, verb first', () => {
		for (const entry of entries('skills')) {
			assert.ok(entry.isDirectory(), `templates/skills/${entry.name} should be a folder`);
			if (entry.name === DESIGN_TEMPLATE) {
				continue;
			}

			const skill = librarySkill(entry.name);
			// The Agent Skill format requires it, and a validator elsewhere says so.
			assert.strictEqual(skill.name, entry.name);
			// The verb tracks the kind, so the folder name says which of the three
			// contracts the file carries before anyone opens it.
			const verb = { plan: /^break-down-/, design: /^design-/, write: /^write-/ }[
				skillKind(skill)
			];
			assert.ok(
				verb.test(skill.name),
				`${entry.name} should start with a verb, as a skill is an action`
			);

			if (skillKind(skill) === 'design') {
				// A design skill is keyed by style, not by type: it covers every
				// ticket a design can hang off, and its slug names the style so the
				// two cannot drift.
				assert.deepStrictEqual(skill.types, [...DESIGN_TYPES], entry.name);
				assert.strictEqual(
					skill.style,
					entry.name.slice('design-'.length),
					`${entry.name} should shape the style its folder names`
				);
			} else {
				assert.strictEqual(skill.types.length, 1, `${entry.name} should write one type`);
			}

			// The folder still says which type it writes and which kind it is, so a
			// SKILL.md stripped of its frontmatter keeps working.
			const naked = parseSkill(skill.instruction, entry.name);
			assert.deepStrictEqual(naked.types, skill.types);
			assert.strictEqual(skillKind(naked), skillKind(skill));
			assert.strictEqual(naked.style, skill.style);
		}
	});

	// Five roles that read alike would be padding: the only thing a role adds
	// over the skill it shares is its voice, so each has to have one.
	test('the shipped roles are genuinely different from one another', () => {
		const instructions = new Set(agents.map((agent) => agent.instruction));
		assert.strictEqual(instructions.size, agents.length, 'two roles share an instruction');

		for (const agent of agents) {
			// Each says what it is, so a copied file that was never rewritten shows up.
			assert.ok(
				agent.instruction.toLowerCase().includes(agent.name.toLowerCase()),
				`${agent.slug} never names the job it is doing`
			);
		}
	});

	test('every ticket type has a shipped role that writes it', () => {
		for (const type of TICKET_TYPES) {
			assert.ok(
				agents.some((agent) => agent.types.includes(type)),
				`nothing shipped writes a ${type}`
			);
		}
	});

	test('every role and skill carries real instructions', () => {
		for (const agent of agents) {
			assert.ok(agent.instruction.trim().length > 100, `${agent.slug} needs a role`);
			assert.ok(agent.description, `${agent.slug} needs a description`);
			assert.ok(agent.skills.length > 0, `${agent.slug} names no skills in its types`);

			for (const skill of agent.skills) {
				assert.ok(skill.instruction.trim().length > 100, `${skill.slug} needs an instruction`);
				assert.ok(skill.description, `${skill.slug} needs a description`);

				// The contract belongs on the skill, since that is the half that ends
				// the prompt. Without it the agent periodically decides the helpful
				// thing is to edit the .mdx itself, going round the store entirely.
				assert.ok(
					/do not write or modify any files/i.test(skill.instruction),
					`${skill.slug} must forbid writing files`
				);
			}
		}
	});

	// A follow-up turn restates the list format from BFAST's own string, so
	// that copy has to carry the same contract the skills do.
	test('the restated list format carries the same contract as the skills', () => {
		assert.ok(/do not write or modify any files/i.test(TITLE_LIST_FORMAT));
		assert.ok(TITLE_LIST_FORMAT.includes('one title per line'));
	});

	// The expected output is a *template*, not a worked example: a concrete one
	// invites the model to reuse its subject matter, and there is nothing for a
	// placeholder to be copied from.
	test('every skill ships an expected-output template', () => {
		for (const skill of library()) {
			const entry = { name: skill.slug };
			assert.ok(
				skill.resources.length > 0,
				`${entry.name} needs a template in ${RESOURCES_FOLDER}/`
			);

			for (const resource of skill.resources) {
				const content = resource.content.trim();
				assert.ok(content.length > 100, `${entry.name}/${resource.name} is too thin`);
				assert.ok(
					/<[^>]{4,}>/.test(content),
					`${entry.name}/${resource.name} should be placeholders, not a worked example`
				);
			}
		}
	});

	// One AC is one behaviour: the negative cases are sibling tickets, so the
	// template must not show a second scenario and invite a list.
	test('the acceptance criterion template holds exactly one Given / When / Then', () => {
		const [template] = skillFor('write', 'ac')!.resources;
		const count = (word: string) =>
			(template.content.match(new RegExp(`\\*\\*${word}\\*\\*`, 'g')) ?? []).length;

		assert.strictEqual(count('Given'), 1);
		assert.strictEqual(count('When'), 1);
		assert.strictEqual(count('Then'), 1);
	});

	// `ai.language` translates the prose, and left to itself a model translates
	// the headings and keywords with it — differently on every run. Each write
	// skill therefore names its fixed structure and says it stays in English;
	// the plan skills return bare titles and have no structure to hold.
	test('every write skill fixes its headings and keywords in English', () => {
		const structure: Record<TicketType, string[]> = {
			epic: ['`## Problem`', '`## Goals`', '`## Non-goals`', '`## Scope`'],
			story: ['**As a**', '**I want**', '**So that**', '`## Behaviour`', '`## Edge cases`', '`## Out of scope`'],
			ac: ['**Given**', '**When**', '**Then**'],
			testcase: ['`## Preconditions`', '`## Steps`', '`## Expected result`', '`## Test data`']
		};

		for (const type of TICKET_TYPES) {
			const skill = skillFor('write', type)!;
			assert.ok(/stay\s+in English/.test(skill.instruction), `${skill.slug} should keep its structure in English`);
			for (const marker of structure[type]) {
				assert.ok(skill.instruction.includes(marker), `${skill.slug} should name ${marker} as fixed`);
			}
		}
	});

	// The template and the instruction have to agree on the story's opening, or
	// the example teaches one spelling and the rule another.
	test('the story template opens with the three keyword lines', () => {
		const [template] = skillFor('write', 'story')!.resources;
		const lines = template.content.split('\n').slice(0, 3);
		assert.deepStrictEqual(
			lines.map((line) => line.split('** ')[0] + '**'),
			['**As a**', '**I want**', '**So that**']
		);
	});

	// A test case proves one criterion, so its template follows that criterion's
	// three parts and adds nothing of its own.
	test('the test case template follows one criterion end to end', () => {
		const [template] = skillFor('write', 'testcase')!.resources;
		for (const heading of ['## Preconditions', '## Steps', '## Expected result', '## Test data']) {
			assert.ok(template.content.includes(heading), `the template is missing ${heading}`);
		}
	});

	// The split is the whole point of two levels: a role that also shapes the
	// ticket makes its skills redundant. And a skill that names a role could not
	// be shared, which is why the library works at all.
	test('a role says how to work, and a skill says nothing about who is writing', () => {
		for (const agent of agents) {
			for (const marker of ['Given', 'Non-goals', 'As a', '## Steps']) {
				assert.ok(
					!agent.instruction.includes(marker),
					`${agent.slug} should leave "${marker}" to a skill`
				);
			}
		}

		for (const skill of library()) {
			for (const marker of ['You are a', 'business analyst', 'test engineer']) {
				assert.ok(
					!skill.instruction.includes(marker),
					`${skill.slug} should not name a role — it is shared by all of them`
				);
			}
		}
	});

	test('a composed prompt carries the role, the skill and the example', () => {
		const analyst = agents.find((agent) => agent.types.includes('epic'));
		assert.ok(analyst);

		const epic = resolveSkill(analyst, 'epic');
		assert.ok(epic);

		const composed = composeInstruction(analyst, epic);
		assert.ok(composed.startsWith(analyst.instruction.slice(0, 40)));
		assert.ok(composed.includes(epic.instruction.slice(0, 40)));
		assert.ok(composed.includes('## Write epic'));
		assert.ok(composed.includes('## Expected output'));
		assert.ok(composed.includes('```markdown'));
		assert.strictEqual(skillLabel(epic), 'Write epic');
	});

	test('the role template has both write-time placeholders', () => {
		const template = read('agents', AGENT_TEMPLATE);

		// Substituted as the file is written; without them a new agent would be
		// called "{{name}}" and would write nothing.
		assert.ok(template.includes('{{name}}'));
		assert.ok(template.includes('{{types}}'));
		// And the prompt-time ones still have to survive into the file.
		assert.ok(template.includes('{{title}}'));
		assert.ok(template.includes('{{type}}'));
	});
});
