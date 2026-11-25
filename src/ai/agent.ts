// Agents and their skills: who writes a ticket's content, and how.
//
// Two levels, because they answer different questions and change at different
// rates. The **agent** is a role — the voice, the audience, the standard of
// evidence — and it is the same whatever it is writing. A **skill** is how that
// role writes one kind of ticket, and an epic, a story and an acceptance
// criterion genuinely differ in shape. Folding them into one file would mean
// every ticket type re-stating the role, and a change of voice touching four
// files.
//
// On disk that is a role file with a folder of skills beside it:
//
//   .bfast/agents/business-analyst.md      the role
//   .bfast/agents/business-analyst/epic.md the skill for an epic
//
// Files rather than settings strings because these are long prose: they belong
// in an editor with wrapping and spell-check, in a git diff that reads, and
// shared with the team by being committed.
//
// Pure and `vscode`-free, so parsing and the built-in defaults are directly
// unit-testable, and so the settings webview can name the same types the host
// writes. Like every other reader in BFAST it **never throws**: a hand-edited
// file missing its frontmatter still loads, with the filename as its name.

import { TICKET_TYPES, type TicketType } from '../data/types';
// `designDocument.ts` is `vscode`-free, so this stays a pure module.
import {
	BUILT_IN_STYLES,
	DESIGN_TYPES,
	labelFromStyleId,
	validateStylePrefix,
	type DesignStyle
} from '../design/designDocument';
import { parseYamlMap, serializeYamlMap } from '../data/yaml';

/** The folder agents live in, relative to the workspace root. */
export const AGENTS_FOLDER = '.bfast/agents';

export const AGENT_EXTENSION = '.md';

/**
 * A skill is a folder, following the Agent Skill layout:
 *
 *   <agent>/<skill>/SKILL.md          how to shape this kind of ticket
 *   <agent>/<skill>/resources/…       what a good one looks like
 *
 * A bare `<agent>/<skill>.md` is still read as a skill with no resources, so a
 * hand-written one-file skill keeps working.
 */
export const SKILL_FILE = 'SKILL.md';
export const RESOURCES_FOLDER = 'resources';

/**
 * An example of the output a skill is aiming for, carried into the prompt.
 *
 * Inlined rather than left for the agent to `Read`: a run is one-shot, and an
 * example the model only sometimes goes and fetches makes the output
 * inconsistent for no benefit. Anything too large to inline is named by path
 * instead, which the agent can read for itself.
 */
export interface SkillResource {
	/** File name inside `resources/`. */
	name: string;
	/** Workspace-relative path, so a resource left out of the prompt can be found. */
	path: string;
	content: string;
}

/**
 * What a skill is for.
 *
 * `write` shapes one ticket's prose and is what the board runs. `plan` proposes
 * the **titles of a ticket's children** and is what the sidebar's "Generate
 * stories" / "Generate acceptance criteria" run: a different contract entirely,
 * since its answer is parsed into a list rather than saved as a description.
 *
 * `design` is the third: it shapes one **technical design document** on a
 * ticket — an ERD, a sequence diagram — and is what a board's design tab runs.
 *
 * The kinds have to be told apart because every lookup in here and in
 * `AgentStore` takes the *first* skill matching, and a plan skill declares the
 * type it reads (an epic), not the type it produces. Without the marker
 * `break-down-epic` would sort ahead of `write-epic` and quietly become the
 * board's epic skill.
 *
 * A design skill takes that one step further: two of them cover the same ticket
 * types, so the type cannot separate them at all. They are keyed by `style`
 * instead, and their `types` say only which tickets they may be seeded onto.
 */
export type SkillKind = 'write' | 'plan' | 'design';

/** How a role writes one kind of ticket. */
export interface AgentSkill {
	/** Folder (or filename) without the extension. */
	slug: string;
	name: string;
	description?: string;
	/** Which ticket types this skill covers. Never empty. */
	types: TicketType[];
	/**
	 * Absent means `write`, which is the only kind there was — so every skill
	 * file written before this existed keeps its meaning, and `serializeSkill`
	 * writes the key only for a plan skill. Read it through `skillKind`.
	 */
	kind?: SkillKind;
	/**
	 * Which design style this shapes — a `design` skill's real key, since two of
	 * them cover the same ticket types. A free string rather than a union: styles
	 * are configuration, so a workspace can invent one.
	 */
	style?: string;
	/**
	 * What a design skill's style is called in the board's "+" menu, and what
	 * starts the file name of every document in it. Both are frontmatter of the
	 * skill rather than settings, because the skill *is* the style: adding a
	 * style to a workspace is adding the skill that knows how to draw it.
	 */
	label?: string;
	prefix?: string;
	instruction: string;
	/** Examples of the expected output, in name order. */
	resources: SkillResource[];
	/** Workspace-relative path of its `SKILL.md`, for opening it in an editor. */
	path?: string;
}

/** The one place the "absent means `write`" default lives. */
export function skillKind(skill: Pick<AgentSkill, 'kind'>): SkillKind {
	return skill.kind ?? 'write';
}

/**
 * How much resource text one prompt may carry.
 *
 * Generous enough for a few worked examples, small enough that a folder someone
 * filled with a whole design document cannot quietly double the cost of every
 * run.
 */
export const MAX_RESOURCE_CHARS = 8000;

export interface AgentDefinition {
	/** Filename without the extension; the id the board and history refer to. */
	slug: string;
	name: string;
	description?: string;
	/**
	 * Which ticket types this agent offers to write: the union of its skills'
	 * types, or — for an agent with no skills folder — whatever its own
	 * frontmatter declared. Never empty.
	 */
	types: TicketType[];
	/** The role: how this agent writes, whatever it is writing. */
	instruction: string;
	skills: AgentSkill[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const KEY_ORDER = ['name', 'description', 'kind', 'style', 'label', 'prefix', 'types'] as const;

interface ParsedFile {
	name: string;
	description?: string;
	types: TicketType[];
	instruction: string;
}

/**
 * The frontmatter map and the body, or `{}` and the whole text when there is
 * none. Exported for the Implement templates, which carry the same grammar —
 * one reader, so a `SKILL.md` and an `implement/story.md` cannot drift apart.
 */
export function splitFrontmatter(text: string): { front: Record<string, string>; body: string } {
	const match = FRONTMATTER.exec(text ?? '');
	return {
		front: match ? parseYamlMap(match[1]) : {},
		body: (match ? text.slice(match[0].length) : (text ?? '')).trim()
	};
}

/** The shared half of reading a role file and a skill file. */
function parseFile(text: string, slug: string): ParsedFile {
	const { front, body } = splitFrontmatter(text);

	return {
		name: front.name?.trim() || deslugifyAgent(slug),
		...(front.description?.trim() ? { description: front.description.trim() } : {}),
		types: parseTypes(front.types),
		instruction: body
	};
}

export function parseSkill(
	text: string,
	slug: string,
	resources: SkillResource[] = []
): AgentSkill {
	const file = parseFile(text, slug);
	const front = splitFrontmatter(text).front;
	const kind = parseKind(front.kind) ?? kindFromSlug(slug);
	const style = kind === 'design' ? front.style?.trim() || styleFromSlug(slug) : undefined;
	// Only a design skill has a label and a prefix — and, reading forgivingly, a
	// label it does not state comes from its style id, while a missing prefix is
	// left for `stylesFromAgents` to say cannot be used.
	const label = style ? front.label?.trim() || labelFromStyleId(style) : undefined;
	const prefix = style ? front.prefix?.trim().toUpperCase() || undefined : undefined;

	return {
		slug,
		...file,
		// The Agent Skill format requires `name` to be the folder name, so the
		// folder wins over whatever the frontmatter says — the same rule the
		// tracker follows when a ticket's id disagrees with its nesting. The human
		// sentence belongs in `description`; `skillLabel` is what the UI shows.
		name: slug,
		// A skill named after its type needs no frontmatter to say so, which is
		// what makes `epic/SKILL.md` a complete file on its own.
		// A design skill's slug names a style, not a ticket type, so `typesFromSlug`
		// finds nothing — and a skill covering nothing would be a skill that never
		// runs. `DESIGN_TYPES` is what keeps a `SKILL.md` stripped of its
		// frontmatter working, the invariant the other kinds get for free.
		types:
			file.types.length > 0
				? file.types
				: kind === 'design'
					? [...DESIGN_TYPES]
					: typesFromSlug(slug),
		// Spread rather than assigned, so a write skill round-trips through
		// `serializeSkill` byte-identical and without gaining a key.
		...(kind === 'write' ? {} : { kind }),
		...(style ? { style } : {}),
		...(label ? { label } : {}),
		...(prefix ? { prefix } : {}),
		resources
	};
}

/** What a ticket type is called in a sentence. */
const TYPE_LABEL: Record<TicketType, string> = {
	epic: 'Epic',
	story: 'Story',
	ac: 'Acceptance criterion',
	testcase: 'Test case'
};

export function ticketTypeLabel(type: TicketType): string {
	return TYPE_LABEL[type];
}

/**
 * A skill's name for humans: `write-acceptance-criterion` → "Write acceptance
 * criterion".
 *
 * Only the first word is capitalised, unlike an agent's name — a skill is a
 * verb phrase, not a job title, so title case would read as a heading rather
 * than an action. Derived from the slug rather than looked up, so what the UI
 * shows is always the folder the user would go and edit.
 */
export function skillLabel(skill: Pick<AgentSkill, 'name'>): string {
	const words = skill.name.split(/[-_]+/).filter((word) => word.length > 0);
	if (words.length === 0) {
		return skill.name;
	}
	const sentence = words.join(' ');
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Reads a role file. `slug` comes from the filename, so it is the one field
 * that cannot be wrong — everything else falls back to a default.
 */
export function parseAgent(text: string, slug: string, skills: AgentSkill[] = []): AgentDefinition {
	const file = parseFile(text, slug);

	// Skills decide what the agent can write; the role's own `types` is the
	// fallback for a hand-written agent that has no skills folder. Only **write**
	// skills count: a plan skill declares the type it reads, so counting it would
	// make an agent offer to write a type it has no skill for.
	const fromSkills = TICKET_TYPES.filter((type) =>
		skills.some((skill) => skillKind(skill) === 'write' && skill.types.includes(type))
	);
	const declared = fromSkills.length > 0 ? fromSkills : file.types;

	return {
		slug,
		name: file.name,
		...(file.description ? { description: file.description } : {}),
		// An agent that names no valid type would otherwise be invisible
		// everywhere, which reads as the agent having silently vanished.
		types: declared.length > 0 ? declared : [...TICKET_TYPES],
		instruction: file.instruction,
		skills
	};
}

// `slug` is the filename and `skills` are the folder beside it, so neither is
// ever written into the file — which is why these take everything but those.
export function serializeAgent(agent: Omit<AgentDefinition, 'slug' | 'skills'>): string {
	return serializeFile(agent.name, agent.description, agent.types, agent.instruction);
}

export function serializeSkill(
	skill: Omit<AgentSkill, 'slug' | 'resources' | 'path'>
): string {
	return serializeFile(
		skill.name,
		skill.description,
		skill.types,
		skill.instruction,
		// Omitted only when it is `write`: such a skill has to serialise exactly as
		// it did before the key existed, or every skill file gains a line on its
		// next save. Anything else must survive the round trip — a `design` skill
		// silently written back as a `write` one would become the board's skill for
		// its ticket types.
		skillKind(skill) === 'write' ? undefined : skillKind(skill),
		{ style: skill.style, label: skill.label, prefix: skill.prefix }
	);
}

function serializeFile(
	name: string,
	description: string | undefined,
	types: readonly TicketType[],
	instruction: string,
	kind?: SkillKind,
	design: { style?: string; label?: string; prefix?: string } = {}
): string {
	const front = serializeYamlMap(
		{
			name,
			...(description ? { description } : {}),
			...(kind ? { kind } : {}),
			...(design.style ? { style: design.style } : {}),
			...(design.label ? { label: design.label } : {}),
			...(design.prefix ? { prefix: design.prefix } : {}),
			types: types.join(', ')
		},
		{ order: KEY_ORDER }
	);

	return `---\n${front}---\n\n${instruction.trim()}\n`;
}

/** `kind: plan` / `kind: design` — anything else, including a typo, means `write`. */
function parseKind(raw: string | undefined): SkillKind | undefined {
	const value = raw?.trim().toLowerCase();
	return value === 'plan' || value === 'write' || value === 'design' ? value : undefined;
}

/**
 * `break-down-epic/` is a plan skill without having to say so, the same way
 * `write-epic/` finds its type from its folder — so a `SKILL.md` stripped of its
 * frontmatter keeps working.
 */
function kindFromSlug(slug: string): SkillKind {
	if (/^design[-_]/i.test(slug)) {
		return 'design';
	}
	return /(^|[-_])(break|breaks|breaking|plan|plans|split|splits)([-_]|$)/i.test(slug)
		? 'plan'
		: 'write';
}

/**
 * `design-sequence-diagram/` shapes the `sequence-diagram` style without having
 * to say so — the rule that makes a style's id the tail of its skill's slug, and
 * the reason the built-in ids are spelled out rather than abbreviated.
 */
function styleFromSlug(slug: string): string | undefined {
	const match = /^design[-_](.+)$/i.exec(slug);
	return match ? match[1].toLowerCase() : undefined;
}

/** `types: epic, story, ac` — comma or space separated, unknown names dropped. */
export function parseTypes(raw: string | undefined): TicketType[] {
	if (!raw) {
		return [];
	}
	const wanted = new Set(
		raw
			.split(/[,\s]+/)
			.map((part) => part.trim().toLowerCase())
			.filter((part) => part.length > 0)
	);
	// Filtered through TICKET_TYPES rather than cast, so the order is BFAST's and
	// a typo cannot invent a type.
	return TICKET_TYPES.filter((type) => wanted.has(type));
}

/**
 * What a filename can be called and still mean a ticket type, so `ac.md`,
 * `acceptance-criterion.md` and `Acceptance Criterion.md` all land on `ac`.
 * Non-letters are stripped first, so separators do not matter.
 */
const TYPE_ALIASES: Record<string, TicketType> = {
	epic: 'epic',
	epics: 'epic',
	story: 'story',
	stories: 'story',
	userstory: 'story',
	ac: 'ac',
	acs: 'ac',
	acceptancecriterion: 'ac',
	acceptancecriteria: 'ac',
	criterion: 'ac',
	testcase: 'testcase',
	testcases: 'testcase',
	tc: 'testcase',
	test: 'testcase'
};

/** `write-epic/` covers epics without having to say so. */
function typesFromSlug(slug: string): TicketType[] {
	const matched = typeFromName(slug);
	return matched ? [matched] : [];
}

/**
 * The ticket type a human-written name refers to, if any.
 *
 * Matched **by word**, not by substring: a skill is called `write-epic` now that
 * names start with a verb, so the type has to be found inside the name — but
 * `write-fact` contains the letters of `ac` and must not become an acceptance
 * criterion. Adjacent words are also tried joined, so `write-test-case` and
 * `write-acceptance-criterion` land where they should.
 */
export function typeFromName(name: string): TicketType | undefined {
	const words = name.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 0);

	// The whole thing first, so a bare `epic` or `testcase` still wins outright.
	const whole = TYPE_ALIASES[words.join('')];
	if (whole) {
		return whole;
	}

	// Then pairs before singles: `test case` must beat `case`, and
	// `acceptance criterion` must be tried before `criterion` alone.
	for (let i = 0; i < words.length - 1; i += 1) {
		const pair = TYPE_ALIASES[`${words[i]}${words[i + 1]}`];
		if (pair) {
			return pair;
		}
	}

	for (const word of words) {
		const single = TYPE_ALIASES[word];
		if (single) {
			return single;
		}
	}

	return undefined;
}

/** The agents that can write this ticket type, in the order they were listed. */
export function agentsForType(
	agents: readonly AgentDefinition[],
	type: TicketType
): AgentDefinition[] {
	return agents.filter((agent) => agent.types.includes(type));
}

/**
 * The agent a run should use: the one asked for when it still handles this
 * type, otherwise the first that does. Falls back rather than failing, because
 * the picker's choice can go stale when a file is edited mid-session.
 */
export function resolveAgent(
	agents: readonly AgentDefinition[],
	type: TicketType,
	slug?: string
): AgentDefinition | undefined {
	const usable = agentsForType(agents, type);
	return usable.find((agent) => agent.slug === slug) ?? usable[0];
}

/** The skill this agent writes that ticket type with, if it has one. */
export function resolveSkill(
	agent: AgentDefinition | undefined,
	type: TicketType
): AgentSkill | undefined {
	return agent?.skills.find(
		(skill) => skillKind(skill) === 'write' && skill.types.includes(type)
	);
}

/**
 * The skill this agent proposes the children of a `parentType` ticket with.
 *
 * The parent's type chooses this one, where the *child's* type chooses the
 * write skill — a breakdown reads an epic and produces stories, so it is filed
 * under the thing it reads.
 *
 * Unlike `resolveSkill`, a missing one is **not** "run on the role alone": the
 * plan skill is what states the list contract, and without it the answer is
 * prose nothing can parse. `AgentStore.planSkill` falls back to the bundled one.
 */
export function resolvePlanSkill(
	agent: AgentDefinition | undefined,
	parentType: TicketType
): AgentSkill | undefined {
	return agent?.skills.find(
		(skill) => skillKind(skill) === 'plan' && skill.types.includes(parentType)
	);
}

/**
 * The skill this agent shapes one design style with.
 *
 * Keyed by **style alone** — deliberately not by ticket type as well. Two design
 * skills cover the same types (an epic and a story both take an ERD and a
 * sequence diagram), so the type separates nothing; it only says which tickets
 * the skill may be seeded onto.
 *
 * Like `resolvePlanSkill` and unlike `resolveSkill`, a missing one is **not**
 * "run on the role alone": the skill is what states the "exactly one mermaid
 * fence" contract, and without it the answer is prose nothing can render.
 * `AgentStore.designSkill` falls back to the bundled one.
 */
export function resolveDesignSkill(
	agent: AgentDefinition | undefined,
	style: string
): AgentSkill | undefined {
	return agent?.skills.find(
		(skill) => skillKind(skill) === 'design' && skill.style === style
	);
}

/**
 * Every design style a workspace offers: the built-in ones, then each style some
 * agent's design skill declares.
 *
 * A style *is* a design skill — adding one to a workspace is adding the skill
 * that knows how to draw it — so there is no list of styles anywhere else, and
 * this is the single address the board's "+" menu, the store and the settings
 * form all read. Reading is forgiving: agents are walked in name order and the
 * first declaration of an id or a prefix wins, a skill whose prefix collides
 * with another style's or with a ticket prefix is dropped (a warning names it),
 * and one that states no prefix at all cannot be offered, because its documents
 * would have no file name.
 */
export function stylesFromAgents(agents: readonly AgentDefinition[]): {
	styles: DesignStyle[];
	warnings: string[];
} {
	const styles: DesignStyle[] = [...BUILT_IN_STYLES];
	const warnings: string[] = [];

	for (const agent of agents) {
		for (const skill of agent.skills) {
			if (skillKind(skill) !== 'design' || !skill.style) {
				continue;
			}
			if (styles.some((style) => style.id === skill.style)) {
				// A built-in, or a style another agent declared first — the same
				// style, offered once.
				continue;
			}

			const where = `${agent.slug}/${skill.slug}`;
			if (!skill.prefix) {
				warnings.push(`${where} states no prefix, so “${skill.label ?? skill.style}” cannot be offered.`);
				continue;
			}
			const problem = validateStylePrefix(skill.prefix, styles.map((style) => style.prefix));
			if (problem) {
				warnings.push(`${where}: ${problem}`);
				continue;
			}

			styles.push({
				id: skill.style,
				label: skill.label ?? labelFromStyleId(skill.style),
				prefix: skill.prefix,
				skill: skill.slug
			});
		}
	}

	return { styles, warnings };
}

/**
 * The instruction a run is given: the role, then the skill for this ticket type.
 *
 * Composed here rather than in the panel so the two providers, the tests and
 * any future caller all get the same text, and so "what actually gets sent" has
 * one address.
 */
export function composeInstruction(agent: AgentDefinition, skill?: AgentSkill): string {
	const role = agent.instruction.trim();
	const how = skill?.instruction.trim();

	// The skill's own name, which now starts with a verb, so it reads as a
	// heading without anything being added to it.
	const heading = skill ? skillLabel(skill) : 'How to write this';
	const parts = [role, how ? `## ${heading}\n\n${how}` : '']
		.filter((part) => part.length > 0)
		.join('\n\n---\n\n');

	const examples = renderResources(skill?.resources ?? []);
	return examples ? `${parts}\n\n---\n\n${examples}` : parts;
}

/**
 * The `resources/` folder as a prompt section.
 *
 * Each example is fenced, with a fence longer than any run of backticks inside
 * it — the same rule `historyFile.ts` follows — so an example that contains
 * code cannot close its own block and spill back into the instructions.
 */
function renderResources(resources: readonly SkillResource[]): string {
	if (resources.length === 0) {
		return '';
	}

	const lines = [
		'## Expected output',
		'',
		'This is the shape your answer must take. Keep its headings, its order and',
		'its level of detail, and replace every `<…>` placeholder with the real',
		'thing. Drop a placeholder line entirely when this ticket genuinely has',
		'nothing to put there — never leave a `<…>` in your answer.',
		''
	];

	let budget = MAX_RESOURCE_CHARS;
	for (const resource of resources) {
		const content = resource.content.trim();
		if (content.length === 0) {
			continue;
		}

		if (content.length > budget) {
			// Too big to inline. Name it instead: the agent has `Read`, so it can
			// fetch this itself if it judges it worth a turn.
			lines.push(`- \`${resource.path}\` — too long to include here; read it if useful.`, '');
			continue;
		}

		budget -= content.length;
		const runs = [...content.matchAll(/`+/g)].map((match) => match[0].length);
		const fence = '`'.repeat(Math.max(3, Math.max(0, ...runs) + 1));
		lines.push(`### ${resource.name}`, '', `${fence}markdown`, content, fence, '');
	}

	return lines.join('\n').trim();
}

/** A filename-safe slug. Lower case and hyphenated, unlike a ticket folder's. */
export function slugifyAgentName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '');
	return slug.length > 0 ? slug : 'agent';
}

/** `business-analyst` → `Business Analyst`, for a file with no `name:`. */
export function deslugifyAgent(slug: string): string {
	return slug
		.split(/[-_]+/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}
