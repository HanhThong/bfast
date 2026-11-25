// What a `<video>` element's failure means, and what a person can do about it.
//
// Bundled into the webview, so no `vscode` and no `node:` import. The codes are
// the DOM's `MediaError` codes; the messages are Chromium's pipeline strings,
// which are the only detail the element ever gives. Two kinds of failure hide
// behind the same grey box, and they call for opposite advice: the bytes never
// arrived (the editor's resource loader, which BFAST can route around), or the
// bytes arrived and are a format the editor's player does not decode (which no
// setting or codec install changes — the player is the editor's own build).
//
// The two cannot be told apart from the first failure alone: the wording is
// Chromium's, differs between builds, and a loader that served nothing reports
// `DEMUXER_ERROR_COULD_NOT_OPEN`, which reads exactly like a bad file. So the
// first failure of any kind but an abort is treated as transport, the bytes
// are fetched straight from the extension host, and only a failure on *that*
// route is blamed on the file.

export type MediaFailureKind = 'aborted' | 'transport' | 'format' | 'unknown';

export interface MediaFailure {
	kind: MediaFailureKind;
	/** One sentence naming what went wrong, for the line under the player. */
	summary: string;
	/** What to do, in order — the first is the one BFAST does by itself. */
	advice: string[];
}

/** `MediaError.code` values, as the DOM defines them. */
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** Pipeline messages that say outright the player got no usable data. */
const NO_DATA_MESSAGES = /DEMUXER_ERROR_COULD_NOT_OPEN|open context failed|PIPELINE_ERROR_NETWORK|PIPELINE_ERROR_READ|PIPELINE_ERROR_URL_NOT_FOUND/i;

export const OPEN_IN_EDITOR_ADVICE = 'Open in editor plays the same file with VS Code’s own media preview.';
export const REVEAL_ADVICE = 'Reveal the folder and open the file with a desktop player.';

export const FORMAT_ADVICE = [
	'Which codecs VS Code decodes depends on its build and OS — the line below says what this one reports. Installing codecs on this machine does not change that: the player is the editor’s own build.',
	'BFAST converts a recording the editor cannot decode to VP8 with ffmpeg on the machine the extension runs on (on a remote, the remote one), so installing ffmpeg there is usually enough — Playwright records VP9 from 1.65, which VS Code on Windows cannot decode. Or convert the file yourself: ffmpeg -i input.webm -c:v libvpx -b:v 2M output.webm.',
	REVEAL_ADVICE
];

/**
 * Reads a media element's failure. `fallbackTried` says the bytes were already
 * fetched straight from the extension host (the blob route), so a failure now
 * is about the file, not the transport.
 */
export function describeMediaFailure(
	code: number | undefined,
	message: string | undefined,
	fallbackTried: boolean
): MediaFailure {
	const detail = message ? ` (${message})` : '';
	if (code === MEDIA_ERR_ABORTED) {
		return {
			kind: 'aborted',
			summary: `Loading the video was aborted${detail}.`,
			advice: ['Press play again.']
		};
	}

	if (!fallbackTried) {
		const noData = code === MEDIA_ERR_NETWORK || (message !== undefined && NO_DATA_MESSAGES.test(message));
		return {
			kind: 'transport',
			summary: noData
				? `The player received no usable data from the editor’s resource loader${detail}.`
				: `The player could not load the file through the editor’s resource loader${detail}.`,
			advice: [
				'BFAST is loading the file directly from the extension host instead — this usually happens over a remote connection, and is not a codec problem.',
				OPEN_IN_EDITOR_ADVICE
			]
		};
	}

	if (code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED) {
		return {
			kind: 'format',
			summary: `The file was delivered in full but the editor’s player cannot decode it${detail}.`,
			advice: FORMAT_ADVICE
		};
	}

	return {
		kind: 'unknown',
		summary: `The video could not be played${detail}.`,
		advice: [OPEN_IN_EDITOR_ADVICE, REVEAL_ADVICE]
	};
}

/** The MIME a blob for one of the board's video files should carry. */
export function videoMime(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) {
		return 'video/mp4';
	}
	if (lower.endsWith('.ogg') || lower.endsWith('.ogv')) {
		return 'video/ogg';
	}
	if (lower.endsWith('.mov')) {
		return 'video/quicktime';
	}
	return 'video/webm';
}

// ---- What the player says about itself -------------------------------------
//
// When a file handed over in full still fails, the useful question is no
// longer "what is wrong with the file" but "what does this player claim to
// play" — the answer differs by editor build and OS (VS Code on Windows
// refuses VP8 WebM that Chrome plays: microsoft/vscode#195758), and it is
// what decides whether converting the recording would help at all.

/** The container/codec pairs the player is asked about, in the order shown. */
export const PROBE_TYPES: readonly { label: string; type: string }[] = [
	{ label: 'WebM/VP8', type: 'video/webm; codecs="vp8"' },
	{ label: 'WebM/VP9', type: 'video/webm; codecs="vp9"' },
	{ label: 'WebM/AV1', type: 'video/webm; codecs="av01.0.05M.08"' },
	{ label: 'MP4/H.264', type: 'video/mp4; codecs="avc1.42E01E"' },
	{ label: 'Ogg/Theora', type: 'video/ogg; codecs="theora"' }
];

/** The WebCodecs decoders asked about — a route that needs no demuxer of the editor's. */
export const PROBE_DECODERS: readonly { label: string; codec: string }[] = [
	{ label: 'VP8', codec: 'vp8' },
	{ label: 'VP9', codec: 'vp09.00.10.08' },
	{ label: 'H.264', codec: 'avc1.42E01E' }
];

export interface PlayerProbe {
	/** `canPlayType` per `PROBE_TYPES` label: `probably`, `maybe` or `no`. */
	canPlay: Record<string, string>;
	/** `VideoDecoder.isConfigSupported` per `PROBE_DECODERS` label; absent when WebCodecs is missing. */
	decoders?: Record<string, boolean>;
	/** The Chromium major version from the user agent, when it says. */
	chromium?: string;
	/** The platform from the user agent, when it says. */
	platform?: string;
}

/** One line a bug report can quote: what this player claims, and on what. */
export function probeSentence(probe: PlayerProbe): string {
	const plays = PROBE_TYPES.map(({ label }) => `${label} ${probe.canPlay[label] ?? '?'}`).join(' · ');
	const decoders = probe.decoders
		? ' WebCodecs decoders: ' +
			PROBE_DECODERS.map(({ label }) => `${label} ${probe.decoders?.[label] ? 'yes' : 'no'}`).join(' · ') +
			'.'
		: ' WebCodecs: not available.';
	const where = [probe.platform, probe.chromium ? `Chromium ${probe.chromium}` : undefined].filter(Boolean).join(', ');
	return `This player reports: ${plays}.${decoders}${where ? ` (${where})` : ''}`;
}

/**
 * The line that follows the probe — the one thing it can settle: whether the
 * player *claims* the file's own format, which says where the fault lies.
 */
export function probeVerdict(probe: PlayerProbe, fileName: string): string {
	const webm = fileName.toLowerCase().endsWith('.webm');
	if (webm && probe.canPlay['WebM/VP9'] === 'no' && probe.decoders?.VP9 !== true) {
		return 'It has no VP9 decoder at all, and Playwright records VP9 from 1.65 on — so a recording from it can only be shown converted to VP8. Install ffmpeg on the machine the extension runs on, or watch the file outside the editor.';
	}
	if (webm && probe.canPlay['WebM/VP8'] === 'probably') {
		return 'It claims WebM/VP8 and still refused the file at the container level, which is the editor’s own build, not the recording — VS Code on Windows is known to do this (microsoft/vscode#195758). Convert to a format it lists as playable, or watch the file outside the editor.';
	}
	if (webm && probe.canPlay['WebM/VP8'] === 'no') {
		return 'It does not claim WebM/VP8 at all, so no WebM this test tool records will play here. Convert to a format it lists as playable, or watch the file outside the editor.';
	}
	return 'Convert to a format it lists as playable, or watch the file outside the editor.';
}
