import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runProcess } from '../platform/runProcess';
import { demuxWebm } from '../shared/webmDemux';
import { convertToVp8, vp8ConvertArgs } from '../testing/videoConvert';
import { FakeProcessRunner } from './fakeProcessRunner';

suite('Video conversion to VP8', () => {
	test('asks ffmpeg for VP8 WebM, no audio, written to a temporary folder', async () => {
		const runner = new FakeProcessRunner({
			respond: (request) => {
				// What ffmpeg would have left at the target.
				writeFileSync(request.args[request.args.length - 1], 'webm bytes');
				return undefined;
			}
		});
		const bytes = await convertToVp8('/runs/TC-1/run/TC-1.webm', runner.runner);
		assert.strictEqual(bytes.toString(), 'webm bytes');
		const request = runner.requests[0];
		assert.strictEqual(request.executable, 'ffmpeg');
		const args = request.args;
		assert.strictEqual(args[args.indexOf('-i') + 1], '/runs/TC-1/run/TC-1.webm');
		assert.strictEqual(args[args.indexOf('-c:v') + 1], 'libvpx');
		assert.ok(args.includes('-an'));
		assert.ok(!args.includes('libvpx-vp9'));
		// Nothing lands beside the original — the run folder's listing is its evidence.
		const target = args[args.length - 1];
		assert.ok(target.startsWith(os.tmpdir()));
		await assert.rejects(fs.stat(path.dirname(target)), 'the temporary folder is removed');
	});

	test('a missing ffmpeg says where to install it', async () => {
		const runner = new FakeProcessRunner({ missingAt: [0] });
		await assert.rejects(convertToVp8('/x.webm', runner.runner, 'linux'), (error: Error) => {
			assert.ok(error.message.includes('ffmpeg was not found'));
			assert.ok(error.message.includes('apt install ffmpeg'));
			return true;
		});
	});

	test('a failed conversion carries ffmpeg’s own complaint', async () => {
		const runner = new FakeProcessRunner({ failAt: [0], stderr: 'Invalid data found when processing input' });
		await assert.rejects(convertToVp8('/x.webm', runner.runner), /Invalid data found/);
	});

	test('the argument list names the source once and ends in the target', () => {
		const args = vp8ConvertArgs('in.webm', 'out.webm');
		assert.strictEqual(args.filter((arg) => arg === 'in.webm').length, 1);
		assert.strictEqual(args[args.length - 1], 'out.webm');
	});

	// The real thing, when this machine has an ffmpeg with both encoders: a VP9
	// recording — what Playwright 1.65 writes — comes back as VP8 that BFAST's
	// own demuxer reads, which is the route the board then plays it through.
	test('converts a VP9 WebM to VP8 that the board’s demuxer reads', async function () {
		this.timeout(30_000);
		const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bfast-vp9-'));
		try {
			const source = path.join(folder, 'TC-1.webm');
			try {
				await runProcess({
					executable: 'ffmpeg',
					args: [
						'-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-t', '1',
						'-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-y', source
					]
				}).completed;
			} catch {
				this.skip();
			}
			assert.strictEqual(demuxWebm(new Uint8Array(await fs.readFile(source))).codecId, 'V_VP9');
			const video = demuxWebm(new Uint8Array(await convertToVp8(source, runProcess)));
			assert.strictEqual(video.codec, 'vp8');
			assert.strictEqual(video.width, 64);
			assert.ok(video.frames.length >= 9);
			assert.ok(video.frames[0].keyframe);
		} finally {
			await fs.rm(folder, { recursive: true, force: true });
		}
	});
});
