import * as assert from 'assert';
import { OutputTail, stripAnsi } from '../testing/outputTail';

suite('Output tail', () => {
	test('strips colour and cursor sequences, and OSC titles', () => {
		assert.strictEqual(stripAnsi('\x1b[32m✓\x1b[0m passed \x1b[1;31mFAIL\x1b[m'), '✓ passed FAIL');
		assert.strictEqual(stripAnsi('\x1b]0;title\x07plain \x1b[2K\x1b[1Gline'), 'plain line');
		assert.strictEqual(stripAnsi('no escapes'), 'no escapes');
	});

	test('keeps the tail and says when it cut', () => {
		const tail = new OutputTail(6);
		tail.append('abc');
		assert.strictEqual(tail.text, 'abc');
		assert.strictEqual(tail.truncated, false);
		tail.append('defgh');
		assert.strictEqual(tail.text, 'cdefgh');
		assert.strictEqual(tail.truncated, true);
	});

	test('never starts the tail on the low half of a surrogate pair', () => {
		const tail = new OutputTail(4);
		tail.append('a\u{1F389}bcd');
		assert.strictEqual(tail.text, 'bcd');
	});
});
