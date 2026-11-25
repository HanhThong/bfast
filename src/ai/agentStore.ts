// Reading and writing `.bfast/agents/`.
//
// The `vscode` half of `agent.ts`, split the same way `settingsService.ts` is
// split from `bfastSettings.ts`. It caches nothing: the files are meant to be
// edited in an ordinary editor tab, and a run has to pick up a save made a
// second earlier.
//
// A workspace holds a role file with a folder of skills beside it:
//
//   business-analyst.md         the role
//   business-analyst/epic/      its skill for an epic — SKILL.md and resources/
//
// What the extension ships is split differently; see TEMPLATES_FOLDER below.

import * as vscode from 'vscode';
import {
	AGENTS_FOLDER,
	AGENT_EXTENSION,
	RESOURCES_FOLDER,
	SKILL_FILE,
	parseAgent,
	parseSkill,
	resolveDesignSkill,
	resolvePlanSkill,
	skillKind,
	slugifyAgentName,
	stylesFromAgents,
	type AgentDefinition,
	type AgentSkill,
	type SkillKind,
	type SkillResource
} from './agent';
import type { TicketType } from '../data/types';
import { BUILT_IN_STYLES, type DesignStyle } from '../design/designDocument';

/**
 * What the extension ships, as files rather than strings in a `.ts`.
 *
 * A role, four skills and four worked examples are long prose, and prose is
 * unreadable and unreviewable once it is a `string[]` in source. As files they
 * are edited in an editor and diff like anything else.
 *
 * Roles and skills are separate folders here, and joined only when a workspace
 * is seeded, because **a skill belongs to no particular role**: how an epic is
 * shaped is the same whoever is writing it, and the built-in skills are written
 * voice-neutral for exactly that reason. One library beats copying `epic/` under
 * every agent that writes one.
 *
 *   templates/agents/AGENT-TEMPLATE.md    the role a new agent starts from
 *   templates/agents/<slug>.md            a shipped role
 *   templates/skills/<verb-phrase>/SKILL.md      how to shape one ticket type
 *   templates/skills/<verb-phrase>/resources/    the shape of the output
 *
 * A workspace gets them joined — `<agent>.md` beside `<agent>/<type>/` — which
 * is the layout `readAgents` walks, and is what lets one agent's skill be edited
 * without touching another's.
 */
const TEMPLATES_FOLDER = 'templates';
const TEMPLATE_AGENTS = 'agents';
const TEMPLATE_SKILLS = 'skills';

/** The role a newly created agent starts from; `{{name}}` is its job title. */
const AGENT_TEMPLATE_FILE = 'AGENT-TEMPLATE.md';
/**
 * The design skill a new style starts from — `{{label}}`, `{{style}}` and
 * `{{prefix}}` substituted as it is written, the `AGENT-TEMPLATE.md` rule.
 * Upper-case so it can never be read as a style's slug, and skipped by
 * `library()` for the same reason `readTemplates` skips the agent template.
 */
const DESIGN_TEMPLATE_FOLDER = 'DESIGN-TEMPLATE';

export class AgentStore {
	/** Read once: the bundled tree cannot change while the window is open. */
	private cached: Promise<AgentDefinition[]> | undefined;

	constructor(
		private readonly workspace: () => vscode.WorkspaceFolder | undefined,
		/** The extension's own directory, which is where `templates/` is shipped. */
		private readonly extensionUri: vscode.Uri
	) {}

	/** The `.bfast/agents` folder, or `undefined` with no folder open. */
	folderUri(): vscode.Uri | undefined {
		const root = this.workspace();
		return root ? vscode.Uri.joinPath(root.uri, ...AGENTS_FOLDER.split('/')) : undefined;
	}

	/** The agent's role file. */
	uriFor(slug: string): vscode.Uri | undefined {
		const folder = this.folderUri();
		return folder ? vscode.Uri.joinPath(folder, `${slug}${AGENT_EXTENSION}`) : undefined;
	}

	/**
	 * A skill's `SKILL.md`. The path is carried on the skill itself rather than
	 * rebuilt here, because a skill may be the folder form or the one-file form
	 * and only the read knows which. A bundled skill has no path — there is no
	 * file in the workspace to open until something is seeded.
	 */
	skillUri(skill: AgentSkill): vscode.Uri | undefined {
		const root = this.workspace();
		return root && skill.path
			? vscode.Uri.joinPath(root.uri, ...skill.path.split('/'))
			: undefined;
	}

	/**
	 * One of a skill's `resources/`, by name. `undefined` for the one-file skill
	 * form, which has no folder to hold any.
	 */
	skillResourceUri(skill: AgentSkill, name: string): vscode.Uri | undefined {
		const own = this.skillUri(skill);
		if (!own || !skill.path?.endsWith(`/${SKILL_FILE}`)) {
			return undefined;
		}
		return vscode.Uri.joinPath(own, '..', RESOURCES_FOLDER, name);
	}

	/** The agents shipped with the extension, roles joined to their skills. */
	private bundled(): Promise<AgentDefinition[]> {
		// A VSIX missing its own templates is a packaging fault, not something to
		// crash a board over: the assistant simply offers nothing until the user
		// writes an agent themselves.
		this.cached ??= this.readTemplates().catch(() => []);
		return this.cached;
	}

	private templateUri(...parts: string[]): vscode.Uri {
		return vscode.Uri.joinPath(this.extensionUri, TEMPLATES_FOLDER, ...parts);
	}

	/**
	 * Reads `templates/`, giving each role the skills its own `types:` names.
	 *
	 * This is the one place a role's frontmatter `types` is authoritative rather
	 * than a fallback: in the library there are no skills beside it to derive
	 * them from, so it is how a shipped role says what it should be seeded with.
	 */
	private async readTemplates(): Promise<AgentDefinition[]> {
		const entries = (await this.readDirectory(this.templateUri(TEMPLATE_AGENTS))) ?? [];
		const agents: AgentDefinition[] = [];

		for (const [name, kind] of entries) {
			if (kind === vscode.FileType.Directory || name === AGENT_TEMPLATE_FILE) {
				continue;
			}
			if (!name.endsWith(AGENT_EXTENSION)) {
				continue;
			}

			const text = await this.read(this.templateUri(TEMPLATE_AGENTS, name));
			if (text === undefined) {
				continue;
			}

			const slug = name.slice(0, -AGENT_EXTENSION.length);
			const skills: AgentSkill[] = [];
			const types = parseAgent(text, slug).types;
			for (const type of types) {
				// Both kinds: how this role writes that type, and how it breaks one
				// down into children. A role that writes no epics is not asked to
				// break one down either, which is what keeps QA Lead free of
				// `break-down-story` and Test Engineer free of both.
				for (const kind of ['write', 'plan'] as const) {
					const skill = await this.librarySkillFor(kind, type, slug);
					if (skill) {
						skills.push(skill);
					}
				}
			}

			// Design skills are keyed by style, not by type — and they cover epic
			// *and* story, so walking the role's types would match each of them
			// twice and seed the folder twice over. One pass per style instead,
			// gated on the role writing something a design can hang off.
			if (types.includes('epic') || types.includes('story')) {
				for (const style of BUILT_IN_STYLES) {
					const skill = await this.libraryDesignSkill(style.id, slug);
					if (skill) {
						skills.push(skill);
					}
				}
			}

			agents.push(parseAgent(text, slug, skills));
		}

		return agents.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * The skill library, keyed by nothing — a folder's name is a verb phrase
	 * (`write-epic`), not a ticket type, so which type it writes has to be read
	 * out of the file rather than assumed from where it sits.
	 */
	private async library(): Promise<AgentSkill[]> {
		const folder = this.templateUri(TEMPLATE_SKILLS);
		const skills: AgentSkill[] = [];

		for (const [name, kind] of (await this.readDirectory(folder)) ?? []) {
			if (kind !== vscode.FileType.Directory || name === DESIGN_TEMPLATE_FOLDER) {
				continue;
			}
			const skill = await this.librarySkill(name);
			if (skill) {
				skills.push(skill);
			}
		}

		return skills;
	}

	/**
	 * One skill out of the library, described as though it already sat under
	 * `agent` in a workspace — which is where it lands the moment anything is
	 * seeded, and the only path worth showing a reader.
	 */
	private async librarySkill(slug: string, agent = 'agent'): Promise<AgentSkill | undefined> {
		const text = await this.read(this.templateUri(TEMPLATE_SKILLS, slug, SKILL_FILE));
		if (text === undefined) {
			return undefined;
		}

		const resources: SkillResource[] = [];
		const folder = this.templateUri(TEMPLATE_SKILLS, slug, RESOURCES_FOLDER);
		for (const [name, kind] of (await this.readDirectory(folder)) ?? []) {
			if (kind === vscode.FileType.Directory) {
				continue;
			}
			const content = await this.read(vscode.Uri.joinPath(folder, name));
			if (content !== undefined) {
				resources.push({
					name,
					path: `${AGENTS_FOLDER}/${agent}/${slug}/${RESOURCES_FOLDER}/${name}`,
					content
				});
			}
		}

		return parseSkill(text, slug, resources);
	}

	/**
	 * The library's skill of one kind for one ticket type, if it ships one.
	 *
	 * The kind has to be part of the lookup, not filtered afterwards: the library
	 * is walked in directory order, so `break-down-epic` comes back before
	 * `write-epic` and a match on type alone would seed the wrong one.
	 */
	private async librarySkillFor(
		kind: SkillKind,
		type: TicketType,
		agent = 'agent'
	): Promise<AgentSkill | undefined> {
		const match = (await this.library()).find(
			(skill) => skillKind(skill) === kind && skill.types.includes(type)
		);
		return match && this.librarySkill(match.slug, agent);
	}

	/**
	 * The library's design skill for one style.
	 *
	 * A second lookup rather than a `style` parameter on `librarySkillFor`,
	 * because the two ask different questions: that one keys on (kind, type) and
	 * cannot tell two design skills apart at all — both cover epic and story.
	 */
	private async libraryDesignSkill(
		style: string,
		agent = 'agent'
	): Promise<AgentSkill | undefined> {
		const match = (await this.library()).find(
			(skill) => skillKind(skill) === 'design' && skill.style === style
		);
		return match && this.librarySkill(match.slug, agent);
	}

	/**
	 * How this agent writes one design style: its own skill, or the bundled one.
	 *
	 * The fallback matters more here than for plans, because `list()` seeds only
	 * when `.bfast/agents` has **never existed** — so a design skill shipped after
	 * a workspace was set up reaches it by no other route. A style the workspace
	 * invented has no bundled skill either, and `undefined` is the honest answer:
	 * the tab still edits, the AI button says why it cannot run.
	 */
	async designSkill(
		agent: AgentDefinition,
		style: string
	): Promise<AgentSkill | undefined> {
		return (
			resolveDesignSkill(agent, style) ?? (await this.libraryDesignSkill(style, agent.slug))
		);
	}

	/**
	 * Every design style this workspace offers — the built-in ones and each one
	 * an agent's design skill declares. `stylesFromAgents` is the rule; this is
	 * only the read behind it.
	 */
	async designStyles(): Promise<DesignStyle[]> {
		return stylesFromAgents(await this.list()).styles;
	}

	/**
	 * Scaffolds a new design style under an agent: a `SKILL.md` and its
	 * `resources/expected-output.md`, copied from `DESIGN-TEMPLATE` with the
	 * style's label, id and prefix substituted as they are written.
	 *
	 * A skill folder rather than a line in `bfast.json`, because a style *is* the
	 * skill that knows how to draw it — and the settings form lists it that way.
	 */
	async createDesignStyle(
		agent: string,
		spec: { id: string; label: string; prefix: string }
	): Promise<vscode.Uri> {
		const folder = this.folderUri();
		if (!folder) {
			throw new Error('Open a folder before creating a design style.');
		}

		const target = vscode.Uri.joinPath(folder, agent, `design-${spec.id}`);
		if ((await this.readDirectory(target)) !== undefined) {
			throw new Error(`“${agent}” already has a design-${spec.id} skill.`);
		}

		await this.copyTree(this.templateUri(TEMPLATE_SKILLS, DESIGN_TEMPLATE_FOLDER), target, (text) =>
			text
				.split('{{label}}')
				.join(spec.label.trim())
				.split('{{style}}')
				.join(spec.id)
				.split('{{prefix}}')
				.join(spec.prefix)
		);
		return vscode.Uri.joinPath(target, SKILL_FILE);
	}

	/**
	 * Gives an agent an existing style: the library's skill for a built-in one,
	 * otherwise a copy of the first agent's that has it. Copied whole — skill and
	 * resources — so the agent starts from something that already draws
	 * correctly and edits the voice.
	 */
	async addDesignStyle(agent: string, style: string): Promise<vscode.Uri> {
		const folder = this.folderUri();
		if (!folder) {
			throw new Error('Open a folder before adding a design style.');
		}

		const bundled = await this.libraryDesignSkill(style);
		let source: vscode.Uri | undefined = bundled
			? this.templateUri(TEMPLATE_SKILLS, bundled.slug)
			: undefined;
		let slug = bundled?.slug;

		if (!source) {
			for (const other of await this.list()) {
				const skill = resolveDesignSkill(other, style);
				const uri = skill && this.skillUri(skill);
				if (skill && uri && skill.path?.endsWith(`/${SKILL_FILE}`)) {
					source = vscode.Uri.joinPath(uri, '..');
					slug = skill.slug;
					break;
				}
			}
		}
		if (!source || !slug) {
			throw new Error(`No agent has a skill for the “${style}” style to copy.`);
		}

		const target = vscode.Uri.joinPath(folder, agent, slug);
		if ((await this.readDirectory(target)) !== undefined) {
			throw new Error(`“${agent}” already has the ${slug} skill.`);
		}
		await this.copyTree(source, target);
		return vscode.Uri.joinPath(target, SKILL_FILE);
	}

	/**
	 * How this agent proposes the children of a `parentType` ticket: its own plan
	 * skill, or the bundled one when it has none.
	 *
	 * The fallback is not optional the way `resolveSkill`'s absence is. A run with
	 * no plan skill has no list contract, so its answer is prose that
	 * `parseTitleList` would return nothing for — a silently empty breakdown. Only
	 * a VSIX shipped without its own `templates/` yields `undefined` here, the
	 * same condition `bundled()` already tolerates.
	 */
	async planSkill(
		agent: AgentDefinition,
		parentType: TicketType
	): Promise<AgentSkill | undefined> {
		return (
			resolvePlanSkill(agent, parentType) ??
			(await this.librarySkillFor('plan', parentType, agent.slug))
		);
	}

	/**
	 * Every agent on disk, seeding the bundled ones first if the folder has never
	 * existed.
	 *
	 * Seeding happens here rather than in `activate()` so it cannot run before a
	 * workspace is open, and it is keyed on the **folder** being absent, not
	 * empty: an empty folder means someone deleted the agents on purpose, and
	 * putting them back would be the extension arguing with the user.
	 */
	async list(): Promise<AgentDefinition[]> {
		const folder = this.folderUri();
		if (!folder) {
			return [];
		}

		if ((await this.readDirectory(folder)) === undefined) {
			await this.seed(folder);
		}

		// Read-only workspace, or a file sitting where the folder should be: the
		// bundled agents still work, they just cannot be edited.
		return (await this.readAgents(folder)) ?? this.bundled();
	}

	/**
	 * Parses every agent under a workspace's agents folder — a role file with a
	 * folder of skills beside it. `undefined` when the folder is not readable.
	 */
	private async readAgents(folder: vscode.Uri): Promise<AgentDefinition[] | undefined> {
		const entries = await this.readDirectory(folder);
		if (entries === undefined) {
			return undefined;
		}

		const agents: AgentDefinition[] = [];
		for (const [name, kind] of entries) {
			if (kind === vscode.FileType.Directory || !name.endsWith(AGENT_EXTENSION)) {
				continue;
			}

			const text = await this.read(vscode.Uri.joinPath(folder, name));
			if (text === undefined) {
				continue;
			}

			const slug = name.slice(0, -AGENT_EXTENSION.length);
			agents.push(parseAgent(text, slug, await this.skills(folder, slug)));
		}

		// By name, so the board's picker has a stable order whatever the
		// filesystem hands back.
		return agents.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * The skills in `<agents>/<slug>/`, or none when the agent has no folder.
	 *
	 * Two shapes are read: a folder holding `SKILL.md` and an optional
	 * `resources/`, which is the Agent Skill layout and what BFAST writes; and a
	 * bare `<name>.md`, which is what a hand-written skill looks like. Neither is
	 * preferred — they simply both work.
	 */
	private async skills(folder: vscode.Uri, slug: string): Promise<AgentSkill[]> {
		const own = vscode.Uri.joinPath(folder, slug);
		const entries = await this.readDirectory(own);
		if (entries === undefined) {
			return [];
		}

		const skills: AgentSkill[] = [];
		for (const [name, kind] of entries) {
			const skill =
				kind === vscode.FileType.Directory
					? await this.skillFolder(own, slug, name)
					: await this.skillFile(own, slug, name);

			if (skill) {
				skills.push(skill);
			}
		}

		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async skillFolder(
		own: vscode.Uri,
		agent: string,
		name: string
	): Promise<AgentSkill | undefined> {
		const text = await this.read(vscode.Uri.joinPath(own, name, SKILL_FILE));
		if (text === undefined) {
			// A folder with no SKILL.md is not a skill — most likely something the
			// user parked there.
			return undefined;
		}

		const resources = await this.resources(own, agent, name);
		return {
			...parseSkill(text, name, resources),
			path: `${AGENTS_FOLDER}/${agent}/${name}/${SKILL_FILE}`
		};
	}

	private async skillFile(
		own: vscode.Uri,
		agent: string,
		name: string
	): Promise<AgentSkill | undefined> {
		if (!name.endsWith(AGENT_EXTENSION)) {
			return undefined;
		}

		const text = await this.read(vscode.Uri.joinPath(own, name));
		if (text === undefined) {
			return undefined;
		}

		return {
			...parseSkill(text, name.slice(0, -AGENT_EXTENSION.length)),
			path: `${AGENTS_FOLDER}/${agent}/${name}`
		};
	}

	/** Everything in a skill's `resources/`, in name order. */
	private async resources(
		own: vscode.Uri,
		agent: string,
		skill: string
	): Promise<SkillResource[]> {
		const folder = vscode.Uri.joinPath(own, skill, RESOURCES_FOLDER);
		const entries = await this.readDirectory(folder);
		if (entries === undefined) {
			return [];
		}

		const resources: SkillResource[] = [];
		for (const [name, kind] of entries) {
			if (kind === vscode.FileType.Directory) {
				continue;
			}
			const content = await this.read(vscode.Uri.joinPath(folder, name));
			if (content !== undefined) {
				resources.push({
					name,
					path: `${AGENTS_FOLDER}/${agent}/${skill}/${RESOURCES_FOLDER}/${name}`,
					content
				});
			}
		}

		return resources.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Writes a new agent and one skill per ticket type it covers, returning the
	 * role file's uri.
	 *
	 * Every file is **copied from the templates the extension ships**, not built
	 * from strings: the point of creating one here rather than by hand is that
	 * the user starts from something that already reads correctly and edits it
	 * down. Refuses to overwrite — a slug that is taken picks up a `-2` suffix,
	 * the same rule ticket folders follow.
	 */
	async create(name: string, types: readonly TicketType[]): Promise<vscode.Uri> {
		const folder = this.folderUri();
		if (!folder) {
			throw new Error('Open a folder before creating an agent.');
		}

		const template = await this.read(this.templateUri(TEMPLATE_AGENTS, AGENT_TEMPLATE_FILE));
		if (template === undefined) {
			throw new Error('BFAST is missing its agent template.');
		}

		await vscode.workspace.fs.createDirectory(folder);

		const slug = await this.freeSlug(folder, slugifyAgentName(name));
		const uri = vscode.Uri.joinPath(folder, `${slug}${AGENT_EXTENSION}`);

		// Substituted as the file is written, unlike the `{{title}}`-style
		// placeholders in the body, which are substituted per run.
		await this.write(
			uri,
			template.split('{{name}}').join(name.trim()).split('{{types}}').join(types.join(', '))
		);

		for (const type of types) {
			await this.createSkill(slug, type);
		}

		return uri;
	}

	/**
	 * Copies the library's skill for one ticket type under an existing agent.
	 *
	 * Takes a type rather than a free-text name because a skill *is* "how this
	 * role writes a story" — naming it anything else and then guessing the type
	 * from that name is how a new skill ended up covering epics whatever it was
	 * called.
	 */
	async createSkill(agent: string, type: TicketType): Promise<vscode.Uri> {
		const folder = this.folderUri();
		if (!folder) {
			throw new Error('Open a folder before creating a skill.');
		}

		const source = await this.librarySkillFor('write', type);
		if (!source) {
			throw new Error(`BFAST ships no skill for a ${type}.`);
		}

		// Keeps the library's folder name, which `typeFromName` can still read the
		// type out of — so the skill stays correct even if someone deletes its
		// frontmatter.
		const target = vscode.Uri.joinPath(folder, agent, source.slug);
		if ((await this.readDirectory(target)) !== undefined) {
			throw new Error(`That agent already has a skill for a ${type}.`);
		}

		await this.copyTree(this.templateUri(TEMPLATE_SKILLS, source.slug), target);
		return vscode.Uri.joinPath(target, SKILL_FILE);
	}

	/**
	 * Joins the two template folders into the layout a workspace uses: each
	 * shipped role, with a copy of every skill its `types:` names.
	 */
	private async seed(folder: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(folder);

			for (const agent of await this.bundled()) {
				const role = await this.read(this.templateUri(TEMPLATE_AGENTS, `${agent.slug}${AGENT_EXTENSION}`));
				if (role === undefined) {
					continue;
				}

				await this.write(
					vscode.Uri.joinPath(folder, `${agent.slug}${AGENT_EXTENSION}`),
					role
				);

				for (const skill of agent.skills) {
					await this.copyTree(
						this.templateUri(TEMPLATE_SKILLS, skill.slug),
						vscode.Uri.joinPath(folder, agent.slug, skill.slug)
					);
				}
			}
		} catch {
			// Nothing to do about it here — `list()` falls back to the bundled ones.
		}
	}

	/**
	 * Copies one directory into another, file by file.
	 *
	 * `workspace.fs.copy` would do it in one call, but it refuses a target that
	 * exists — and seeding writes into a folder the caller may have just created.
	 * Everything here is small text, so doing it by hand costs nothing.
	 */
	private async copyTree(
		from: vscode.Uri,
		to: vscode.Uri,
		transform: (text: string) => string = (text) => text
	): Promise<void> {
		await vscode.workspace.fs.createDirectory(to);

		for (const [name, kind] of (await this.readDirectory(from)) ?? []) {
			const source = vscode.Uri.joinPath(from, name);
			const target = vscode.Uri.joinPath(to, name);

			if (kind === vscode.FileType.Directory) {
				await this.copyTree(source, target, transform);
				continue;
			}

			const text = await this.read(source);
			if (text !== undefined) {
				await this.write(target, transform(text));
			}
		}
	}

	/** `<base>`, else `<base>-2`, `<base>-3`… An existing file is never overwritten. */
	private async freeSlug(folder: vscode.Uri, base: string): Promise<string> {
		let slug = base;
		for (let attempt = 2; await this.exists(folder, slug); attempt += 1) {
			slug = `${base}-${attempt}`;
		}
		return slug;
	}

	private async exists(folder: vscode.Uri, slug: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, `${slug}${AGENT_EXTENSION}`));
			return true;
		} catch {
			return false;
		}
	}

	/** `undefined` when the folder is not there, which is how seeding is decided. */
	private async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][] | undefined> {
		try {
			return await vscode.workspace.fs.readDirectory(uri);
		} catch {
			return undefined;
		}
	}

	private async read(uri: vscode.Uri): Promise<string | undefined> {
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return undefined;
		}
	}

	private async write(uri: vscode.Uri, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	}
}
