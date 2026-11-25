// The board's own video player: WebCodecs over the pure WebM demuxer.
//
// The third route for a run's video, after the editor's `<video>` has refused
// the file both from its resource loader and from a blob of the same bytes.
// That happens where the editor's demuxer, not its decoder, is the part that
// says no — VS Code on Windows and VP8 WebM (microsoft/vscode#195758) — so
// this player demuxes in JavaScript (`webmDemux.ts`), hands each frame to a
// `VideoDecoder`, and draws what comes out on a canvas. No dependency, no
// transcoding, nothing on disk.
//
// The controls are deliberately few: play/pause, a scrubber, the time. What a
// test recording is for is watching it and stopping at the moment it went
// wrong, and both work; frame stepping and volume have no audio to serve. They
// sit over the bottom of the frame the way the browser's own do — visible while
// paused, on hover or focus, fading while it plays — so the board's player
// reads as a player and not as a picture with a form under it.

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { demuxWebm, WebmError, type WebmFrame, type WebmVideo } from '../../shared/webmDemux';
import { errorMessage } from '../../platform/errors';

/** Frames handed to the decoder ahead of the one on screen. */
const LOOKAHEAD = 6;
/** A drag on the scrubber seeks this long after the last move, not on every one. */
const SEEK_SETTLE_MS = 60;

interface EngineHooks {
	onTime: (timestampUs: number) => void;
	onEnded: () => void;
	onError: (message: string) => void;
}

/**
 * Decoding and presentation, outside React: the frame clock is
 * `requestAnimationFrame`, and a `VideoFrame` must be closed by whoever drew
 * or dropped it, which is bookkeeping no render cycle should own.
 *
 * Two WebCodecs rules shape it. Output arrives asynchronously, so a seek
 * marks the target and drops what comes out before it rather than waiting.
 * And after `flush()` the decoder wants a keyframe next, so every pause that
 * flushed (to get the last frames, or a seek target, out) restarts from the
 * nearest keyframe when play resumes — `restartFrom` — instead of feeding on.
 */
class Engine {
	private readonly decoder: VideoDecoder;
	private readonly config: VideoDecoderConfig;
	private readonly frames: WebmFrame[];
	private readonly context: CanvasRenderingContext2D;
	private readonly endUs: number;
	/** Index of the next frame to hand the decoder. */
	private feed = 0;
	/** Decoded, in order, not yet on screen. */
	private ready: VideoFrame[] = [];
	private playing = false;
	private raf = 0;
	/** Media time at `wall`, both taken when play started or a seek landed. */
	private originUs = 0;
	private wall = 0;
	/** The frame on the canvas. */
	private shownUs = 0;
	/** Drop output before this; draw the first frame at or past it. */
	private seekUs: number | undefined;
	/** A flush ran since the last restart: the decoder wants a keyframe next. */
	private needsRestart = true;
	private flushing = false;
	private destroyed = false;

	constructor(
		private readonly video: WebmVideo,
		canvas: HTMLCanvasElement,
		private readonly hooks: EngineHooks
	) {
		canvas.width = video.width || 1;
		canvas.height = video.height || 1;
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('The canvas has no 2d context.');
		}
		this.context = context;
		this.frames = video.frames;
		this.endUs = (video.durationMs ?? 0) * 1000;
		this.config = {
			codec: video.codec,
			codedWidth: video.width || undefined,
			codedHeight: video.height || undefined,
			description: video.description
		};
		this.decoder = new VideoDecoder({
			output: (frame) => this.onFrame(frame),
			error: (error) => this.hooks.onError(error.message)
		});
	}

	get durationUs(): number {
		return this.endUs;
	}

	/** The first frame, as the poster. */
	showFirstFrame(): void {
		this.restartFrom(0, true);
	}

	play(): void {
		if (this.playing || this.destroyed) {
			return;
		}
		if (this.shownUs >= this.lastFrameUs() && this.feed >= this.frames.length) {
			// At the end: play means from the top.
			this.shownUs = 0;
			this.needsRestart = true;
		}
		this.playing = true;
		if (this.needsRestart) {
			this.restartFrom(this.shownUs, false);
		}
		this.originUs = this.shownUs;
		this.wall = performance.now();
		this.raf = requestAnimationFrame(this.tick);
	}

	pause(): void {
		if (!this.playing) {
			return;
		}
		this.playing = false;
		cancelAnimationFrame(this.raf);
	}

	seek(targetUs: number): void {
		if (this.destroyed) {
			return;
		}
		this.restartFrom(targetUs, !this.playing);
	}

	destroy(): void {
		this.destroyed = true;
		this.playing = false;
		cancelAnimationFrame(this.raf);
		this.dropReady();
		if (this.decoder.state !== 'closed') {
			this.decoder.close();
		}
	}

	private lastFrameUs(): number {
		return this.frames[this.frames.length - 1].timestampUs;
	}

	private dropReady(): void {
		for (const frame of this.ready) {
			frame.close();
		}
		this.ready = [];
	}

	private decode(index: number): void {
		const frame = this.frames[index];
		try {
			this.decoder.decode(
				new EncodedVideoChunk({
					type: frame.keyframe ? 'key' : 'delta',
					timestamp: frame.timestampUs,
					data: frame.data
				})
			);
		} catch (error) {
			this.hooks.onError(errorMessage(error));
		}
	}

	/**
	 * Reset the decoder and feed from the keyframe at or before `targetUs`
	 * up to the last frame at or before it. When `flush` (paused), the
	 * decoder is drained so the target frame comes out now; when playing,
	 * the loop keeps feeding and the target comes out in its turn.
	 */
	private restartFrom(targetUs: number, flush: boolean): void {
		this.dropReady();
		let target = 0;
		for (let i = 0; i < this.frames.length && this.frames[i].timestampUs <= targetUs; i++) {
			target = i;
		}
		let key = target;
		while (key > 0 && !this.frames[key].keyframe) {
			key--;
		}
		this.seekUs = this.frames[target].timestampUs;
		try {
			this.decoder.reset();
			this.decoder.configure(this.config);
		} catch (error) {
			this.hooks.onError(errorMessage(error));
			return;
		}
		this.needsRestart = false;
		for (let i = key; i <= target; i++) {
			this.decode(i);
		}
		this.feed = target + 1;
		if (flush) {
			this.flush();
		}
	}

	private flush(): void {
		this.needsRestart = true;
		this.flushing = true;
		this.decoder
			.flush()
			.catch(() => undefined) // a reset() mid-flush rejects it; nothing to do
			.finally(() => {
				this.flushing = false;
			});
	}

	private onFrame(frame: VideoFrame): void {
		if (this.destroyed) {
			frame.close();
			return;
		}
		if (this.seekUs !== undefined) {
			if (frame.timestamp < this.seekUs) {
				frame.close();
				return;
			}
			this.seekUs = undefined;
			this.draw(frame);
			this.originUs = this.shownUs;
			this.wall = performance.now();
			return;
		}
		this.ready.push(frame);
	}

	private draw(frame: VideoFrame): void {
		this.context.drawImage(frame, 0, 0, this.context.canvas.width, this.context.canvas.height);
		this.shownUs = frame.timestamp;
		frame.close();
		this.hooks.onTime(frame.timestamp);
	}

	private readonly tick = (): void => {
		if (!this.playing || this.destroyed) {
			return;
		}
		const nowUs = this.originUs + (performance.now() - this.wall) * 1000;

		while (
			this.feed < this.frames.length &&
			this.decoder.decodeQueueSize + this.ready.length < LOOKAHEAD
		) {
			this.decode(this.feed++);
		}
		if (this.feed >= this.frames.length && !this.needsRestart) {
			// Everything is in; drain what the decoder still holds.
			this.flush();
		}

		let show: VideoFrame | undefined;
		while (this.ready.length > 0 && this.ready[0].timestamp <= nowUs) {
			show?.close();
			show = this.ready.shift();
		}
		if (show) {
			this.draw(show);
		}

		const drained =
			this.feed >= this.frames.length &&
			this.ready.length === 0 &&
			!this.flushing &&
			this.seekUs === undefined;
		if (drained && nowUs >= Math.max(this.endUs, this.lastFrameUs())) {
			this.playing = false;
			this.hooks.onEnded();
			return;
		}
		this.raf = requestAnimationFrame(this.tick);
	};
}

function formatClock(us: number): string {
	const total = Math.max(0, Math.floor(us / 1_000_000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Whether this file could go through the board's own player here. */
export function canDecodeHere(name: string): boolean {
	return /\.(webm|mkv)$/i.test(name) && typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

export function WebCodecsPlayer({
	bytes,
	name,
	onFailure
}: {
	bytes: Uint8Array;
	name: string;
	/** The file cannot be played this way either — with the reason. */
	onFailure: (message: string) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const engineRef = useRef<Engine | undefined>(undefined);
	const failureRef = useRef(onFailure);
	failureRef.current = onFailure;
	const [playing, setPlaying] = useState(false);
	const [timeUs, setTimeUs] = useState(0);
	const [durationUs, setDurationUs] = useState(0);
	const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
	const seekTimer = useRef<number | undefined>(undefined);

	useEffect(() => {
		let live = true;
		let engine: Engine | undefined;
		const fail = (message: string) => {
			if (live) {
				failureRef.current(message);
			}
		};
		void (async () => {
			let video: WebmVideo;
			try {
				video = demuxWebm(bytes);
			} catch (error) {
				fail(error instanceof WebmError ? error.message : `The file could not be read: ${String(error)}`);
				return;
			}
			let supported = false;
			try {
				supported =
					(
						await VideoDecoder.isConfigSupported({
							codec: video.codec,
							codedWidth: video.width || undefined,
							codedHeight: video.height || undefined,
							description: video.description
						})
					).supported === true;
			} catch {
				supported = false;
			}
			if (!supported) {
				fail(`this editor's WebCodecs has no decoder for ${video.codecId} (${video.codec})`);
				return;
			}
			if (!live || !canvasRef.current) {
				return;
			}
			try {
				engine = new Engine(video, canvasRef.current, {
					onTime: (us) => setTimeUs(us),
					onEnded: () => setPlaying(false),
					onError: (message) => fail(`decoding failed: ${message}`)
				});
			} catch (error) {
				fail(errorMessage(error));
				return;
			}
			engineRef.current = engine;
			setSize({ width: video.width, height: video.height });
			setDurationUs(engine.durationUs);
			engine.showFirstFrame();
		})();
		return () => {
			live = false;
			engine?.destroy();
			engineRef.current = undefined;
			if (seekTimer.current !== undefined) {
				window.clearTimeout(seekTimer.current);
			}
		};
	}, [bytes]);

	const toggle = () => {
		const engine = engineRef.current;
		if (!engine) {
			return;
		}
		if (playing) {
			engine.pause();
			setPlaying(false);
		} else {
			engine.play();
			setPlaying(true);
		}
	};

	const onScrub = (event: ChangeEvent<HTMLInputElement>) => {
		const target = Number(event.currentTarget.value);
		setTimeUs(target);
		if (seekTimer.current !== undefined) {
			window.clearTimeout(seekTimer.current);
		}
		seekTimer.current = window.setTimeout(() => {
			seekTimer.current = undefined;
			engineRef.current?.seek(target);
		}, SEEK_SETTLE_MS);
	};

	return (
		<div className={playing ? 'test-run-player is-playing' : 'test-run-player is-paused'} data-file={name}>
			<canvas
				ref={canvasRef}
				className="test-run-player-canvas"
				style={size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}
				onClick={toggle}
				title={playing ? 'Pause' : 'Play'}
			/>
			<div className="test-run-player-bar">
				<button
					type="button"
					className="test-run-player-toggle"
					onClick={toggle}
					aria-label={playing ? 'Pause' : 'Play'}
					title={playing ? 'Pause' : 'Play'}
				>
					{playing ? (
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
							<rect x="3" y="2" width="4" height="12" fill="currentColor" />
							<rect x="9" y="2" width="4" height="12" fill="currentColor" />
						</svg>
					) : (
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
							<path d="M4 2.5v11l9-5.5z" fill="currentColor" />
						</svg>
					)}
				</button>
				<input
					type="range"
					min={0}
					max={Math.max(durationUs, 1)}
					step={1000}
					value={Math.min(timeUs, Math.max(durationUs, 1))}
					onChange={onScrub}
					aria-label="Seek"
				/>
				<span className="test-run-player-time">
					{formatClock(timeUs)} / {formatClock(durationUs)}
				</span>
			</div>
		</div>
	);
}
