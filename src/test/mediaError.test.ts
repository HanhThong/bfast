import * as assert from 'assert';
import {
	describeMediaFailure,
	MEDIA_ERR_ABORTED,
	MEDIA_ERR_DECODE,
	MEDIA_ERR_NETWORK,
	MEDIA_ERR_SRC_NOT_SUPPORTED,
	videoMime
} from '../shared/mediaError';

suite('Media failures', () => {
	// The one seen over Remote-SSH: FFmpeg opened nothing because nothing arrived.
	test('a demuxer that could not open is a transport failure until the bytes were fetched directly', () => {
		const message = 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed';
		const first = describeMediaFailure(MEDIA_ERR_SRC_NOT_SUPPORTED, message, false);
		assert.strictEqual(first.kind, 'transport');
		assert.ok(first.summary.includes('no usable data'));
		assert.ok(first.advice[0].includes('extension host'));
		assert.ok(first.advice[0].includes('not a codec problem'));

		const again = describeMediaFailure(MEDIA_ERR_SRC_NOT_SUPPORTED, message, true);
		assert.strictEqual(again.kind, 'format');
		assert.ok(again.summary.includes('delivered in full'));
	});

	// The wording is Chromium's and differs between builds, so no first failure
	// but an abort is blamed on the file before the bytes route has been tried.
	test('any other first failure is a transport failure too, and a format one only after the bytes route', () => {
		for (const [code, message] of [
			[MEDIA_ERR_NETWORK, undefined],
			[MEDIA_ERR_SRC_NOT_SUPPORTED, 'MEDIA_ELEMENT_ERROR: Format error'],
			[MEDIA_ERR_DECODE, 'DECODER_ERROR_NOT_SUPPORTED'],
			[undefined, undefined]
		] as const) {
			assert.strictEqual(describeMediaFailure(code, message, false).kind, 'transport', `${code} ${message}`);
		}
		assert.strictEqual(describeMediaFailure(MEDIA_ERR_DECODE, 'DECODER_ERROR_NOT_SUPPORTED', true).kind, 'format');
		assert.strictEqual(describeMediaFailure(MEDIA_ERR_SRC_NOT_SUPPORTED, 'MEDIA_ELEMENT_ERROR: Format error', true).kind, 'format');
		assert.strictEqual(describeMediaFailure(MEDIA_ERR_NETWORK, undefined, true).kind, 'unknown');
	});

	test('format advice says codecs cannot be installed into the editor, and how to convert', () => {
		const failure = describeMediaFailure(MEDIA_ERR_DECODE, undefined, true);
		assert.ok(failure.advice.some((line) => line.includes('Installing codecs')));
		assert.ok(failure.advice.some((line) => line.includes('ffmpeg')));
		assert.ok(failure.advice.some((line) => line.includes('Reveal')));
	});

	test('an abort is never retried through the bytes route', () => {
		assert.strictEqual(describeMediaFailure(MEDIA_ERR_ABORTED, undefined, false).kind, 'aborted');
		assert.strictEqual(describeMediaFailure(MEDIA_ERR_ABORTED, undefined, true).kind, 'aborted');
	});

	test('the blob mime follows the extension', () => {
		assert.strictEqual(videoMime('TC-1.webm'), 'video/webm');
		assert.strictEqual(videoMime('clip.MP4'), 'video/mp4');
		assert.strictEqual(videoMime('clip.mov'), 'video/quicktime');
		assert.strictEqual(videoMime('clip.ogv'), 'video/ogg');
	});
});

suite('Player probe', () => {
	// Deferred import so the suite above stays readable at the top of the file.
	const { probeSentence, probeVerdict } = require('../shared/mediaError') as typeof import('../shared/mediaError');

	test('the sentence names every pair, the decoders and the platform', () => {
		const line = probeSentence({
			canPlay: { 'WebM/VP8': 'probably', 'WebM/VP9': 'probably', 'WebM/AV1': 'no', 'MP4/H.264': 'no', 'Ogg/Theora': 'maybe' },
			decoders: { VP8: true, VP9: true, 'H.264': false },
			chromium: '148',
			platform: 'Windows'
		});
		assert.ok(line.includes('WebM/VP8 probably'));
		assert.ok(line.includes('MP4/H.264 no'));
		assert.ok(line.includes('WebCodecs decoders: VP8 yes'));
		assert.ok(line.includes('(Windows, Chromium 148)'));
		assert.ok(probeSentence({ canPlay: {} }).includes('WebCodecs: not available'));
	});

	test('the verdict blames the build when the player claims the format it refused', () => {
		assert.ok(probeVerdict({ canPlay: { 'WebM/VP8': 'probably' } }, 'TC-1.webm').includes('microsoft/vscode#195758'));
		assert.ok(probeVerdict({ canPlay: { 'WebM/VP8': 'no' } }, 'TC-1.webm').includes('does not claim WebM/VP8'));
		assert.ok(probeVerdict({ canPlay: {} }, 'TC-1.mp4').startsWith('Convert'));
	});

	// VS Code on Windows (Chromium 150) with a Playwright 1.65 recording: no VP9 anywhere.
	test('the verdict names VP9 when the player has no VP9 at all', () => {
		const verdict = probeVerdict(
			{ canPlay: { 'WebM/VP8': 'probably', 'WebM/VP9': 'no' }, decoders: { VP8: true, VP9: false } },
			'TC-1.webm'
		);
		assert.ok(verdict.includes('no VP9 decoder'));
		assert.ok(verdict.includes('ffmpeg'));
		// A player that decodes VP9 through WebCodecs is not blamed for it.
		assert.ok(
			!probeVerdict({ canPlay: { 'WebM/VP8': 'probably', 'WebM/VP9': 'no' }, decoders: { VP9: true } }, 'TC-1.webm').includes(
				'no VP9'
			)
		);
	});

	test('the format advice never suggests converting to VP9', () => {
		const { FORMAT_ADVICE } = require('../shared/mediaError') as typeof import('../shared/mediaError');
		assert.ok(FORMAT_ADVICE.some((line) => line.includes('-c:v libvpx ')));
		assert.ok(!FORMAT_ADVICE.some((line) => line.includes('libvpx-vp9')));
	});
});
