import * as assert from 'assert';
import { parseMetadata, serializeMetadata } from '../data/ticketMetadata';

const FALLBACK = { id: 'AC-1.1.1', title: 'From the folder name' };

suite('Ticket metadata', () => {
	test('reads a full file', () => {
		const meta = parseMetadata(
			[
				'id: AC-1.1.2',
				"title: 'Five failures lock the account'",
				'status: in-progress',
				'assignee: Duy Khang',
				'createdBy: Hanh Thong',
				'createdAt: 2026-07-05T10:00:00.000Z',
				'updatedAt: 2026-07-09T16:20:00.000Z'
			].join('\n'),
			FALLBACK
		);

		assert.deepStrictEqual(meta, {
			id: 'AC-1.1.2',
			title: 'Five failures lock the account',
			status: 'in-progress',
			assignee: 'Duy Khang',
			createdBy: 'Hanh Thong',
			createdAt: '2026-07-05T10:00:00.000Z',
			updatedAt: '2026-07-09T16:20:00.000Z',
			links: [],
			extra: {}
		});
	});

	test('a test case’s service round-trips, and a ticket without one has no key', () => {
		const meta = parseMetadata('id: TC-1.1\ntitle: Journey\nservice: orders', FALLBACK);
		assert.strictEqual(meta.service, 'orders');
		assert.match(serializeMetadata(meta), /^service: orders$/m);
		const none = parseMetadata('id: TC-1.1\ntitle: Journey', FALLBACK);
		assert.ok(!('service' in none));
		assert.ok(!serializeMetadata(none).includes('service'));
	});

	test('falls back rather than failing on a missing or broken file', () => {
		for (const text of [undefined, '', 'nonsense', 'status: whatever']) {
			const meta = parseMetadata(text, FALLBACK);

			assert.strictEqual(meta.id, FALLBACK.id, String(text));
			assert.strictEqual(meta.title, FALLBACK.title, String(text));
			assert.strictEqual(meta.status, 'todo', String(text));
			assert.strictEqual(meta.assignee, undefined, String(text));
		}
	});

	test('treats a blank field as absent', () => {
		const meta = parseMetadata('title:\nassignee:   \nstatus: DONE', FALLBACK);

		assert.strictEqual(meta.title, FALLBACK.title);
		assert.strictEqual(meta.assignee, undefined);
		// Status is matched case-insensitively.
		assert.strictEqual(meta.status, 'done');
	});

	test('accepts a hand-typed key in the wrong case', () => {
		assert.strictEqual(parseMetadata('Title: Typed by hand', FALLBACK).title, 'Typed by hand');
	});

	test('keeps a timestamp it cannot parse rather than rewriting it', () => {
		assert.strictEqual(parseMetadata('createdAt: last tuesday', FALLBACK).createdAt, 'last tuesday');
	});

	test('carries unknown keys through a rewrite', () => {
		const meta = parseMetadata('id: EP-1\ntitle: Billing\nsprint: 12', FALLBACK);

		assert.deepStrictEqual(meta.extra, { sprint: '12' });
		assert.strictEqual(parseMetadata(serializeMetadata(meta), FALLBACK).extra.sprint, '12');
	});

	test('leaves out what is not known instead of writing blanks', () => {
		const text = serializeMetadata(parseMetadata('id: EP-1\ntitle: Billing', FALLBACK));

		assert.ok(!text.includes('assignee'), text);
		assert.ok(text.includes('status: todo'), text);
	});

	test('round-trips', () => {
		const meta = parseMetadata(
			'id: EP-1\ntitle: "Fix: the login bug"\nstatus: blocked\nassignee: Thu Ha\nsprint: 12',
			FALLBACK
		);

		assert.deepStrictEqual(parseMetadata(serializeMetadata(meta), FALLBACK), meta);
	});
});
