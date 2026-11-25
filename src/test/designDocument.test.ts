import * as assert from 'assert';
import {
	BUILT_IN_STYLES,
	compareDesigns,
	designFileName,
	designId,
	designSkillSlug,
	ensureMermaidFence,
	nextDesignOrdinal,
	parseDesignDocument,
	parseDesignFileName,
	parseDesignId,
	resolveStyle,
	serializeDesignDocument,
	type DesignStyle,
	type DesignSummary
} from '../design/designDocument';
import { parseFolderName, TYPE_PREFIX } from '../data/trackerPaths';

const STYLES: DesignStyle[] = [...BUILT_IN_STYLES];

function summary(prefix: string, ordinal: number): DesignSummary {
	return {
		id: designId(prefix, ordinal),
		ticketId: 'ST-1.2',
		style: resolveStyle(STYLES, prefix).id,
		prefix,
		ordinal,
		title: 'Whatever',
		fileName: designFileName(prefix, ordinal, 'Whatever')
	};
}

suite('Design documents', () => {
	test('the file name carries the style, the ordinal and the title', () => {
		assert.strictEqual(
			designFileName('ERD', 1, 'Account model'),
			'ERD-1-Account_model.mdx'
		);
		assert.deepStrictEqual(parseDesignFileName('ERD-1-Account_model.mdx'), {
			prefix: 'ERD',
			ordinal: 1,
			slug: 'Account_model'
		});
		assert.deepStrictEqual(parseDesignId('SEQ-12'), { prefix: 'SEQ', ordinal: 12 });
	});

	test('a ticket file is not a design document', () => {
		for (const name of ['Story.mdx', 'Epic.mdx', 'AC.mdx', 'TestCase.mdx', 'history.md']) {
			assert.strictEqual(parseDesignFileName(name), undefined, name);
		}
	});

	// The file name grammar has to stay out of the tracker's way: a design file
	// sits in the same folder as the ticket's own, and folder names are parsed
	// by a regex anchored on the ticket prefixes.
	test('no built-in style can be mistaken for a ticket', () => {
		const ticketPrefixes = Object.values(TYPE_PREFIX);
		for (const style of BUILT_IN_STYLES) {
			assert.ok(
				!ticketPrefixes.includes(style.prefix),
				`${style.prefix} is a ticket prefix`
			);
			const name = designFileName(style.prefix, 1, 'Account model');
			assert.strictEqual(parseFolderName(name).id, undefined, name);
		}
	});

	test('ordinals are counted per style, and never reused', () => {
		const existing = [summary('ERD', 1), summary('SEQ', 1), summary('SEQ', 2)];
		assert.strictEqual(nextDesignOrdinal(existing, 'ERD'), 2);
		assert.strictEqual(nextDesignOrdinal(existing, 'SEQ'), 3);
		assert.strictEqual(nextDesignOrdinal(existing, 'C4'), 1);

		// A gap left by a delete stays a gap.
		assert.strictEqual(nextDesignOrdinal([summary('SEQ', 7)], 'SEQ'), 8);
	});

	test('tabs are ordered by style then ordinal', () => {
		const designs = [summary('SEQ', 2), summary('ERD', 1), summary('SEQ', 1)];
		designs.sort((a, b) => compareDesigns(STYLES, a, b));
		assert.deepStrictEqual(
			designs.map((design) => design.id),
			['ERD-1', 'SEQ-1', 'SEQ-2']
		);
	});

	test('a style removed from settings still resolves, from its prefix', () => {
		const style = resolveStyle(STYLES, 'C4');
		assert.deepStrictEqual(style, { id: 'c4', label: 'C4', prefix: 'C4' });
		// And its documents sort after every configured style rather than vanishing.
		const designs = [summary('C4', 1), summary('SEQ', 1)];
		designs.sort((a, b) => compareDesigns(STYLES, a, b));
		assert.deepStrictEqual(
			designs.map((design) => design.id),
			['SEQ-1', 'C4-1']
		);
	});

	test('the skill slug defaults to the style id', () => {
		assert.strictEqual(
			designSkillSlug({ id: 'sequence-diagram', label: 'S', prefix: 'SEQ' }),
			'design-sequence-diagram'
		);
		assert.strictEqual(
			designSkillSlug({ id: 'c4', label: 'C', prefix: 'C4', skill: 'design-context' }),
			'design-context'
		);
	});

	test('a document round-trips through the frontmatter', () => {
		const text = [
			'---',
			'title: Fix: the login bug',
			'style: entity-relationship-diagram',
			'createdBy: ada',
			'updatedAt: 2026-09-06T10:00:00.000Z',
			'reviewer: grace',
			'---',
			'',
			'```mermaid',
			'erDiagram',
			'  ACCOUNT ||--o{ SESSION : has',
			'```',
			''
		].join('\n');

		const document = parseDesignDocument(text, 'ERD-1-Fix_the_login_bug.mdx', 'ST-1.2', STYLES);
		assert.ok(document);
		assert.strictEqual(document.id, 'ERD-1');
		assert.strictEqual(document.ticketId, 'ST-1.2');
		// A colon in a title survives: the first colon is the separator.
		assert.strictEqual(document.title, 'Fix: the login bug');
		assert.strictEqual(document.style, 'entity-relationship-diagram');
		assert.strictEqual(document.updatedAt, '2026-09-06T10:00:00.000Z');
		// A key BFAST does not own rides through untouched.
		assert.deepStrictEqual(document.extra, { reviewer: 'grace' });
		assert.ok(document.body.startsWith('```mermaid'));

		const written = serializeDesignDocument(document);
		const again = parseDesignDocument(written, document.fileName, 'ST-1.2', STYLES);
		assert.deepStrictEqual(again, document);
		assert.ok(written.includes('reviewer: grace'));
	});

	test('a document with no frontmatter still loads', () => {
		const document = parseDesignDocument(
			'```mermaid\nsequenceDiagram\n```\n',
			'SEQ-3-Login_flow.mdx',
			'ST-1.2',
			STYLES
		);
		assert.ok(document);
		assert.strictEqual(document.title, 'Login flow');
		assert.strictEqual(document.style, 'sequence-diagram');
		assert.strictEqual(document.ordinal, 3);
		assert.strictEqual(document.updatedAt, undefined);
	});

	test('the file name wins when the frontmatter claims another style', () => {
		const document = parseDesignDocument(
			'---\nstyle: sequence-diagram\n---\n\nbody\n',
			'ERD-1-Account.mdx',
			'ST-1.2',
			STYLES
		);
		assert.ok(document);
		assert.strictEqual(document.style, 'entity-relationship-diagram');
		// The next write heals the file.
		assert.ok(serializeDesignDocument(document).includes('style: entity-relationship-diagram'));
	});

	suite('ensureMermaidFence', () => {
		test('strips a markdown wrapper the description sanitiser cannot', () => {
			const wrapped = '```markdown\nSome prose.\n\n```mermaid\nerDiagram\n```\n```';
			assert.strictEqual(
				ensureMermaidFence(wrapped),
				'Some prose.\n\n```mermaid\nerDiagram\n```'
			);
		});

		test('fences a bare diagram', () => {
			assert.strictEqual(
				ensureMermaidFence('sequenceDiagram\n  A->>B: hi'),
				'```mermaid\nsequenceDiagram\n  A->>B: hi\n```'
			);
		});

		test('leaves a well-formed answer alone', () => {
			const good = 'Prose first.\n\n```mermaid\nerDiagram\n```';
			assert.strictEqual(ensureMermaidFence(good), good);

			const fenceOnly = '```mermaid\nerDiagram\n```';
			assert.strictEqual(ensureMermaidFence(fenceOnly), fenceOnly);
		});

		test('leaves prose that is not a diagram alone', () => {
			assert.strictEqual(ensureMermaidFence('Just a note.'), 'Just a note.');
		});
	});
});
