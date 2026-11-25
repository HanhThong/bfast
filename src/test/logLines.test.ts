import * as assert from 'assert';
import { LogLineBuffer, MAX_BUFFERED_LINES, MAX_PARTIAL_CHARS } from '../environments/logLines';

/**
 * The two things a log follow gets wrong if nobody thinks about them: a chunk
 * cut in the middle of a line, and a container printing faster than the bridge
 * can carry. docs/environments/container-logs.md §Volume is the contract.
 */
suite('BFAST container log buffering', () => {
	test('a line split across two chunks arrives once, whole', () => {
		const buffer = new LogLineBuffer();
		buffer.push('listening on ');
		// Nothing is whole yet, so nothing may be handed over — half a line on
		// screen followed by its other half would be two lines that never were.
		assert.deepStrictEqual(buffer.take(), []);

		buffer.push('port 3000\n');
		assert.deepStrictEqual(buffer.take(), ['listening on port 3000']);
	});

	test('several lines in one chunk keep their order, and the buffer empties', () => {
		const buffer = new LogLineBuffer();
		buffer.push('one\ntwo\nthree\n');
		assert.deepStrictEqual(buffer.take(), ['one', 'two', 'three']);
		assert.deepStrictEqual(buffer.take(), []);
	});

	test('a trailing CR is not content', () => {
		const buffer = new LogLineBuffer();
		buffer.push('windows line\r\nnext\r\n');
		assert.deepStrictEqual(buffer.take(), ['windows line', 'next']);
	});

	test('an unterminated last line is kept back until the stream ends', () => {
		const buffer = new LogLineBuffer();
		buffer.push('done\nsegfault');

		assert.deepStrictEqual(buffer.take(), ['done']);
		// A container's last word is often the one that says why it died, so it
		// is not lost just because nothing wrote the newline.
		assert.deepStrictEqual(buffer.takeAll(), ['segfault']);
		assert.deepStrictEqual(buffer.takeAll(), []);
	});

	test('a flood past the cap drops the oldest, never the newest', () => {
		const buffer = new LogLineBuffer();
		const total = MAX_BUFFERED_LINES + 500;
		for (let index = 0; index < total; index++) {
			buffer.push(`line ${index}\n`);
		}

		const lines = buffer.take();
		assert.strictEqual(lines.length, MAX_BUFFERED_LINES);
		// Back-pressure here would stall the very stack the log is watching, so
		// the buffer is a deliberate lossy tail — and the tail is what matters.
		assert.strictEqual(lines[lines.length - 1], `line ${total - 1}`);
		assert.strictEqual(lines[0], `line ${total - MAX_BUFFERED_LINES}`);
	});

	test('a line that never ends is broken rather than swallowed', () => {
		const buffer = new LogLineBuffer();
		// A serialized blob with no newline would otherwise grow the pending
		// tail for ever while the tab rendered nothing at all.
		buffer.push('x'.repeat(MAX_PARTIAL_CHARS + 10));

		const lines = buffer.take();
		assert.strictEqual(lines.length, 1);
		assert.strictEqual(lines[0].length, MAX_PARTIAL_CHARS);
		assert.deepStrictEqual(buffer.takeAll(), ['x'.repeat(10)]);
	});
});
