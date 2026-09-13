/**
 * Frame-accurate playback of one segment of a `<video>`.
 *
 * Every player in the plugin used to confine a shot with `timeupdate`, which
 * Chromium fires about every 250 ms. Checking `currentTime >= end` there meant
 * playback ran anywhere from 0 to a quarter of a second into the next shot
 * before stopping — the cut was right and the playback still showed it wrong.
 *
 * `requestVideoFrameCallback` fires once per frame actually presented, with that
 * frame's own media time, so the boundary can be judged per frame instead.
 */

interface FrameMetadata {
	mediaTime: number;
	presentedFrames: number;
}

type FrameCallbackVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (
		callback: (now: number, metadata: FrameMetadata) => void,
	) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

export interface SegmentRange {
	start: number;
	end: number;
}

/** Assumed until two consecutive frames have been seen. */
const DEFAULT_FRAME = 1 / 30;

/**
 * How far inside a frame to aim a seek.
 *
 * Cut times are stored to the millisecond, and TransNetV2's are derived from an
 * average frame rate, so a stored time can sit a few milliseconds either side of
 * the real frame boundary. A seek that lands a hair before a frame shows the one
 * before it — the last frame of the previous shot, as a one-frame flash. Aiming
 * this far in absorbs that, and stays inside the frame up to 60 fps; above
 * that, half a frame is used instead.
 */
const SEEK_MARGIN = 1 / 120;

export function headOf(range: SegmentRange, frame: number): number {
	return range.start + Math.min(frame / 2, SEEK_MARGIN);
}

export function tailOf(range: SegmentRange, frame: number): number {
	return Math.max(range.start, range.end - Math.min(frame / 2, SEEK_MARGIN));
}

/**
 * True once the frame on screen is the last one of the segment.
 *
 * The callback reports a frame after it has been presented, so waiting for
 * `mediaTime >= end` would already be one frame into the next shot. The last
 * frame of the segment starts one frame before `end`; half a frame of slack
 * covers the rounding described at `SEEK_MARGIN`.
 */
export function isTail(time: number, range: SegmentRange, frame: number): boolean {
	return time >= range.end - frame * 1.5;
}

/** Calls `onFrame` once per presented frame, and learns the frame duration. */
class FrameClock {
	private handle: number | null = null;
	private fallback: number | null = null;
	private stopped = false;
	private lastTime = -1;
	private lastPresented = -1;
	private measured: number | null = null;

	constructor(
		private readonly video: HTMLVideoElement,
		private readonly onFrame: (time: number) => void,
	) {
		this.schedule();
	}

	get frameDuration(): number {
		return this.measured ?? DEFAULT_FRAME;
	}

	stop(): void {
		this.stopped = true;
		const video = this.video as FrameCallbackVideo;
		if (this.handle !== null) video.cancelVideoFrameCallback?.(this.handle);
		if (this.fallback !== null) window.cancelAnimationFrame(this.fallback);
		this.handle = null;
		this.fallback = null;
	}

	private schedule(): void {
		if (this.stopped) return;
		const video = this.video as FrameCallbackVideo;
		if (typeof video.requestVideoFrameCallback === 'function') {
			this.handle = video.requestVideoFrameCallback((_now, metadata) => {
				this.handle = null;
				this.measure(metadata.mediaTime, metadata.presentedFrames);
				this.onFrame(metadata.mediaTime);
				this.schedule();
			});
			return;
		}
		// Every Electron Obsidian ships has the callback. Polling per display
		// frame is the fallback: ~16 ms of error instead of ~250.
		this.fallback = window.requestAnimationFrame(() => {
			this.fallback = null;
			if (!this.video.paused) this.onFrame(this.video.currentTime);
			this.schedule();
		});
	}

	/**
	 * The shortest media-time step per presented frame seen so far.
	 *
	 * A dropped frame makes one step look two frames long and a seek makes it
	 * arbitrary, but neither can make it shorter than a real frame, so the
	 * minimum converges on the true duration within a couple of frames.
	 */
	private measure(time: number, presented: number): void {
		const frames = presented - this.lastPresented;
		const delta = time - this.lastTime;
		if (this.lastPresented >= 0 && frames >= 1 && delta > 0) {
			const each = delta / frames;
			if (each >= 1 / 240 && each <= 1 / 8)
				this.measured =
					this.measured === null ? each : Math.min(this.measured, each);
		}
		this.lastTime = time;
		this.lastPresented = presented;
	}
}

export interface SegmentPlayerOptions {
	/** Read at the tail of every pass: repeat the segment, or stop on it. */
	loop: () => boolean;
	/** Every presented frame, confined or not. */
	onFrame?: (time: number) => void;
	/** Playback reached the last frame and paused there. */
	onEnd?: () => void;
	/** The playhead left the segment some other way, such as a scrub. */
	onRelease?: () => void;
}

/**
 * Confines a video's playback to one segment, to the frame.
 *
 * At the last frame of the segment it either seeks back to the first or pauses
 * and pins the last frame — pinned by a seek, so that even if the decoder got
 * one frame further before the pause took effect, what stays on screen is the
 * outgoing shot and `currentTime` is still inside the segment.
 *
 * Stopping releases the confinement, so pressing play again carries on into
 * the next shot instead of stopping on the same frame forever.
 */
export class SegmentPlayer {
	private readonly clock: FrameClock;
	private current: SegmentRange | null = null;

	constructor(
		private readonly video: HTMLVideoElement,
		private readonly options: SegmentPlayerOptions,
	) {
		this.clock = new FrameClock(video, (time) => this.onFrame(time));
	}

	get range(): SegmentRange | null {
		return this.current;
	}

	/**
	 * Seeks into the first frame of `range`, confines playback to it, and then
	 * calls `then` — which is where the caller starts playback, once the seek
	 * has been issued rather than before it.
	 */
	play(range: SegmentRange, then?: () => void): void {
		this.current = range;
		const video = this.video;
		const start = (): void => {
			video.currentTime = headOf(range, this.clock.frameDuration);
			then?.();
		};
		if (video.readyState >= 1) start();
		else video.addEventListener('loadedmetadata', start, { once: true });
	}

	release(): void {
		this.current = null;
	}

	destroy(): void {
		this.clock.stop();
		this.current = null;
	}

	private onFrame(time: number): void {
		const video = this.video;
		const range = this.current;
		// While a seek is in flight the reported frame is the one from before
		// it, which says nothing about where playback is headed.
		if (range && !video.seeking) {
			const frame = this.clock.frameDuration;
			if (time < range.start - frame || time >= range.end + frame * 3) {
				this.current = null;
				this.options.onRelease?.();
			} else if (!video.paused && isTail(time, range, frame)) {
				if (this.options.loop()) {
					video.currentTime = headOf(range, frame);
				} else {
					video.pause();
					video.currentTime = tailOf(range, frame);
					this.current = null;
					this.options.onEnd?.();
				}
			}
		}
		this.options.onFrame?.(time);
	}
}
