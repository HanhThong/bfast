import * as assert from 'assert';
import {
	inverseRelation,
	isLinkRelation,
	LINK_RELATION_INFO,
	LINK_RELATIONS,
	parseLinks,
	retargetLinks,
	serializeLinks,
	withLink,
	withoutLink
} from '../data/ticketLinks';
import { parseMetadata, serializeMetadata } from '../data/ticketMetadata';

const FALLBACK = { id: 'ST-1.1', title: 'Sign in' };

suite('Ticket links', () => {
	test('every relation’s inverse points back at it', () => {
		for (const relation of LINK_RELATIONS) {
			assert.strictEqual(inverseRelation(inverseRelation(relation)), relation, relation);
		}
		assert.strictEqual(inverseRelation('relates-to'), 'relates-to');
		assert.strictEqual(inverseRelation('blocks'), 'is-blocked-by');
		assert.strictEqual(inverseRelation('is-duplicated-by'), 'duplicates');
		assert.strictEqual(inverseRelation('is-cloned-by'), 'clones');
	});

	test('every relation has its own metadata key', () => {
		const keys = LINK_RELATIONS.map((relation) => LINK_RELATION_INFO[relation].key);
		assert.strictEqual(new Set(keys).size, keys.length);
		assert.ok(!keys.some((key) => ['id', 'title', 'status'].includes(key)));
	});

	test('reads lists forgivingly: any separator, any case, junk and repeats dropped', () => {
		const links = parseLinks((key) =>
			({ blocks: 'ST-1.2, st-1.3  ST-1.2', relatesTo: 'EP-1#2, not an id, AC-1.1.1' })[key]
		);
		assert.deepStrictEqual(links, [
			{ relation: 'blocks', id: 'ST-1.2' },
			{ relation: 'blocks', id: 'ST-1.3' },
			{ relation: 'relates-to', id: 'EP-1#2' },
			{ relation: 'relates-to', id: 'AC-1.1.1' }
		]);
		assert.deepStrictEqual(serializeLinks(links), [
			['blocks', 'ST-1.2, ST-1.3'],
			['relatesTo', 'EP-1#2, AC-1.1.1']
		]);
	});

	test('a link round-trips through metadata.yaml, and an emptied relation leaves no key', () => {
		const meta = parseMetadata('id: ST-1.1\ntitle: Sign in\nBlockedBy: ST-1.2\nsprint: 12\n', FALLBACK);
		assert.deepStrictEqual(meta.links, [{ relation: 'is-blocked-by', id: 'ST-1.2' }]);
		// A link key is BFAST's, not an unknown one carried through.
		assert.deepStrictEqual(meta.extra, { sprint: '12' });

		const text = serializeMetadata(meta);
		assert.ok(text.includes('blockedBy: ST-1.2'));
		assert.deepStrictEqual(parseMetadata(text, FALLBACK).links, meta.links);

		meta.links = withoutLink(meta.links, 'is-blocked-by', 'ST-1.2');
		assert.ok(!/blocked/i.test(serializeMetadata(meta)));
	});

	test('adding twice is one link; re-pointing an id merges a duplicate', () => {
		const once = withLink([], 'clones', 'ST-1.2');
		assert.deepStrictEqual(withLink(once, 'clones', 'ST-1.2'), once);

		const moved = retargetLinks(
			[
				{ relation: 'relates-to', id: 'EP-1.2' },
				{ relation: 'relates-to', id: 'ST-1.2' }
			],
			'EP-1.2',
			'ST-1.2'
		);
		assert.deepStrictEqual(moved, [{ relation: 'relates-to', id: 'ST-1.2' }]);
	});

	test('only a known relation passes', () => {
		assert.ok(isLinkRelation('is-blocked-by'));
		assert.ok(!isLinkRelation('blocked-by'));
		assert.ok(!isLinkRelation(undefined));
	});
});
