import * as assert from 'assert';
import { markReviewStale, needsReview, openReview } from '../shared/aiReview';

suite('AI answer review', () => {
	test('there is nothing to review when the text being replaced is empty', () => {
		assert.strictEqual(needsReview(''), false);
		assert.strictEqual(needsReview('   \n\t'), false);
		assert.strictEqual(needsReview('As a user…'), true);
	});

	test('the first answer is reviewed against the text on disk', () => {
		const review = openReview(undefined, 'the original', 'the answer', 'by Claude');
		assert.deepStrictEqual(review, {
			base: 'the original',
			proposal: 'the answer',
			note: 'by Claude',
			round: 1,
			stale: false
		});
	});

	// The invariant the whole feature turns on: a rewrite is compared with the
	// original, never with the answer it is replacing.
	test('a rewrite keeps the original as its base and only replaces the answer', () => {
		const first = openReview(undefined, 'the original', 'first answer');
		const second = openReview(first, 'first answer', 'second answer');

		assert.strictEqual(second.base, 'the original');
		assert.strictEqual(second.proposal, 'second answer');
		assert.strictEqual(second.round, 2);

		const third = openReview(second, 'second answer', 'third answer');
		assert.strictEqual(third.base, 'the original');
		assert.strictEqual(third.round, 3);
	});

	test('a note is carried per answer, and an answer without one drops it', () => {
		const first = openReview(undefined, 'base', 'one', 'by Claude');
		assert.strictEqual(first.note, 'by Claude');
		assert.strictEqual(openReview(first, 'base', 'two').note, undefined);
	});

	// The file moving underneath does not move the base: the answer really was
	// written against what the diff shows.
	test('going stale is recorded, and survives the next answer', () => {
		const first = markReviewStale(openReview(undefined, 'the original', 'first answer'));
		assert.strictEqual(first?.stale, true);
		assert.strictEqual(first?.base, 'the original');

		const second = openReview(first, 'moved on', 'second answer');
		assert.strictEqual(second.base, 'the original');
		assert.strictEqual(second.stale, true);
	});

	test('marking an already stale review returns the same object, so nothing repaints', () => {
		const stale = markReviewStale(openReview(undefined, 'base', 'answer'));
		assert.strictEqual(markReviewStale(stale), stale);
		assert.strictEqual(markReviewStale(undefined), undefined);
	});
});
