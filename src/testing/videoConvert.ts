// A recording the editor cannot decode, re-encoded as one it can.
//
// The board's player has three routes (testRuns.tsx `VideoFigure`) and all
// three are the editor's own decoders: some builds have none for the codec a
// test tool records in. VS Code on Windows reports no VP9 at all — neither
// `<video>` nor WebCodecs — while Playwright records VP9 from 1.65 on
// (`-c:v libvpx-vp9`, hard-coded, no option to change it). So the last route
// converts the file to VP8 WebM, the one codec every build decodes through
// BFAST's own WebM demuxer and `VideoDecoder`.
//
// It runs `ffmpeg` from the PATH of the machine the extension host is on — on
// a remote, the remote one, which is also where the file is. Playwright's own
// bundled ffmpeg cannot do it: from 1.65 it carries a VP9 encoder and no VP8
// one. `vscode`-free, runner injected, so the arguments are assertable.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProcessError, type ProcessRunner } from '../platform/runProcess';
import { errorMessage } from '../platform/errors';

/**
 * Silence, not age, stops a conversion — the `idleWatchdog` doctrine. ffmpeg
 * writes a `-progress` block about twice a second, so this is generous.
 */
const CONVERT_IDLE_MS = 30_000;

/**
 * The ffmpeg arguments that turn `source` into VP8 WebM at `target`.
 * `realtime` / `cpu-used 8` because a person is waiting on a board, and a test
 * recording is a screen capture that compresses easily. No alt-ref frames
 * (`auto-alt-ref 0`): an invisible frame is one more thing a hand-rolled
 * demuxer and a seek would have to get right, for no gain at this bitrate.
 * `-g 50` keeps a keyframe close to any seek target, since the player restarts
 * decoding from the keyframe before it. Audio is dropped: test recordings have
 * none, and the board's player draws frames only.
 */
export function vp8ConvertArgs(source: string, target: string): string[] {
	return [
		'-hide_banner',
		'-nostdin',
		'-loglevel',
		'error',
		'-nostats',
		'-progress',
		'pipe:1',
		'-i',
		source,
		'-an',
		'-c:v',
		'libvpx',
		'-pix_fmt',
		'yuv420p',
		'-deadline',
		'realtime',
		'-cpu-used',
		'8',
		'-auto-alt-ref',
		'0',
		'-g',
		'50',
		'-crf',
		'10',
		'-b:v',
		'2M',
		'-f',
		'webm',
		'-y',
		target
	];
}

/** What a missing ffmpeg is told, by platform: the install line a person would type. */
export function ffmpegInstallHint(platform: NodeJS.Platform): string {
	switch (platform) {
		case 'linux':
			return 'for example `sudo apt install ffmpeg`';
		case 'darwin':
			return 'for example `brew install ffmpeg`';
		case 'win32':
			return 'for example `winget install ffmpeg`';
		default:
			return 'from ffmpeg.org';
	}
}

/**
 * Converts `source` to VP8 WebM and returns the bytes. The output goes to a
 * temporary folder of its own, removed whatever happens — never beside the
 * original, since the run folder's listing is what the board shows as the
 * run's evidence. Throws an `Error` whose message is the sentence the board
 * shows.
 */
export async function convertToVp8(
	source: string,
	runner: ProcessRunner,
	platform: NodeJS.Platform = process.platform
): Promise<Buffer> {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bfast-video-'));
	const target = path.join(folder, 'converted.webm');
	try {
		const run = runner({
			executable: 'ffmpeg',
			args: vp8ConvertArgs(source, target),
			idleTimeoutMs: CONVERT_IDLE_MS,
			maxBufferedOutput: 4_096
		});
		try {
			await run.completed;
		} catch (error) {
			if (error instanceof ProcessError && error.code === 'not-installed') {
				throw new Error(
					'ffmpeg was not found on the machine the extension runs on. ' +
						`Install it there (${ffmpegInstallHint(platform)}) and open the run again — BFAST uses it to convert a recording the editor cannot play.`
				);
			}
			throw new Error(`ffmpeg could not convert the file: ${errorMessage(error)}`);
		}
		return await fs.readFile(target);
	} finally {
		await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
	}
}
