// The tail of a command's output, kept for `output.log`.
//
// Two jobs, both pure. `stripAnsi` removes colour and cursor sequences before
// anything keeps the text: the extension host inherits the user's shell
// environment, where `FORCE_COLOR` is common, and a log full of escape codes
// is unreadable in an editor and in `git diff`. `OutputTail` keeps the last
// `maxChars` of what was appended — a CLI puts its complaint at the end, and a
// verbose suite must not be held whole in memory — cutting the way
// `runProcess.keepTail` does: never at a surrogate pair's low half.

/** CSI (`ESC [ … m`) and OSC (`ESC ] … BEL`) sequences, which is what tools emit. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

export class OutputTail {
	private buffer = '';
	private cut = false;

	constructor(private readonly maxChars: number) {}

	append(text: string): void {
		this.buffer += text;
		if (this.buffer.length > this.maxChars) {
			let kept = this.buffer.slice(this.buffer.length - this.maxChars);
			const head = kept.charCodeAt(0);
			if (head >= 0xdc00 && head <= 0xdfff) {
				kept = kept.slice(1);
			}
			this.buffer = kept;
			this.cut = true;
		}
	}

	/** What was kept. */
	get text(): string {
		return this.buffer;
	}

	/** Whether anything was dropped from the front. */
	get truncated(): boolean {
		return this.cut;
	}
}
