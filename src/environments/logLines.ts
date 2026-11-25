// Raw process output → whole lines, in batches.
//
// A container in a restart loop, or one with debug logging on, prints faster
// than any view can render — and the cost is the **message**, not the text:
// posting each chunk across the webview bridge as it arrives is what would
// make the editor unusable. So the log panel collects into one of these and
// flushes on a timer.
//
// Pure and Node-free, so the two things worth getting right can be tested
// without a process: a chunk cut in the middle of a line, and a flood between
// two flushes. Both are string maths.

/**
 * The most lines one buffer holds. Past this the **oldest** go: the tab keeps
 * only a bounded tail anyway, so anything above the cap would be scrolled off
 * the moment it arrived. Dropping is deliberate — back-pressure here would
 * stall the very stack the log is watching.
 */
export const MAX_BUFFERED_LINES = 5_000;

/**
 * The most an unterminated line may grow to before it is broken and emitted.
 * Without it a container printing megabytes with no newline — a serialized blob,
 * a binary — would render nothing at all while the buffer swallowed it.
 */
export const MAX_PARTIAL_CHARS = 32_000;

export class LogLineBuffer {
	private lines: string[] = [];
	/** The tail of the last chunk, when it did not end on a line break. */
	private partial = '';

	/** Adds raw output. Only lines a newline completed become lines. */
	push(text: string): void {
		const parts = (this.partial + text).split('\n');
		// The last piece is whatever came after the final newline — possibly
		// empty, and possibly the start of a line the next chunk finishes.
		this.partial = parts.pop() ?? '';
		for (const part of parts) {
			// Docker writes `\r\n` on Windows; a trailing `\r` is not content.
			this.add(part.endsWith('\r') ? part.slice(0, -1) : part);
		}
		if (this.partial.length > MAX_PARTIAL_CHARS) {
			this.add(this.partial.slice(0, MAX_PARTIAL_CHARS));
			this.partial = this.partial.slice(MAX_PARTIAL_CHARS);
		}
	}

	/** Every completed line since the last take, oldest first. Empties the buffer. */
	take(): string[] {
		const taken = this.lines;
		this.lines = [];
		return taken;
	}

	/**
	 * `take()` plus any unterminated tail — for when the stream has ended and
	 * no newline is ever going to arrive. A container's last word is often the
	 * one that says why it died.
	 */
	takeAll(): string[] {
		if (this.partial.length > 0) {
			this.add(this.partial);
			this.partial = '';
		}
		return this.take();
	}

	private add(line: string): void {
		this.lines.push(line);
		if (this.lines.length > MAX_BUFFERED_LINES) {
			this.lines = this.lines.slice(-MAX_BUFFERED_LINES);
		}
	}
}
