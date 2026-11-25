import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { demuxWebm, WebmError } from '../shared/webmDemux';

// ffmpeg -f lavfi -i testsrc=size=64x48:rate=10 -t 1 -c:v libvpx -g 4: ten VP8
// frames, a keyframe every four, one second long.
// Compiled tests run from out/, so the fixture is reached through the source tree.
const fixture = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tiny-vp8.webm');

suite('WebM demuxer', () => {
	test('reads the track, the frames and their timestamps from a VP8 WebM', () => {
		const video = demuxWebm(new Uint8Array(fs.readFileSync(fixture)));
		assert.strictEqual(video.codec, 'vp8');
		assert.strictEqual(video.codecId, 'V_VP8');
		assert.strictEqual(video.width, 64);
		assert.strictEqual(video.height, 48);
		assert.strictEqual(video.durationMs, 1000);
		assert.strictEqual(video.frames.length, 10);
		assert.deepStrictEqual(
			video.frames.map((frame) => frame.timestampUs),
			[0, 100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000, 900_000]
		);
		assert.deepStrictEqual(
			video.frames.map((frame) => frame.keyframe),
			[true, false, false, false, true, false, false, false, true, false]
		);
		for (const frame of video.frames) {
			assert.ok(frame.data.length > 0);
		}
		// A VP8 keyframe starts with the frame tag's keyframe bit clear.
		assert.strictEqual(video.frames[0].data[0] & 0x01, 0);
	});

	test('a file cut short yields the frames before the cut', () => {
		const whole = new Uint8Array(fs.readFileSync(fixture));
		const video = demuxWebm(whole.subarray(0, Math.floor(whole.length * 0.6)));
		assert.ok(video.frames.length > 0 && video.frames.length < 10, String(video.frames.length));
		assert.ok(video.frames[0].keyframe);
	});

	test('refuses what is not WebM with a WebmError, never anything else', () => {
		for (const bytes of [
			new Uint8Array(0),
			new Uint8Array([0x00, 0x01, 0x02]),
			new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 7) & 0xff)),
			new Uint8Array(fs.readFileSync(fixture)).subarray(0, 200)
		]) {
			assert.throws(() => demuxWebm(bytes), (error: unknown) => error instanceof WebmError);
		}
	});

	test('an EBML document of another kind is named', () => {
		const whole = new Uint8Array(fs.readFileSync(fixture));
		const other = whole.slice();
		// DocType "webm" → "mkvx" in place.
		const at = Buffer.from(other).indexOf('webm');
		other.set([0x6d, 0x6b, 0x76, 0x78], at);
		assert.throws(() => demuxWebm(other), /mkvx, not WebM/);
	});
});
