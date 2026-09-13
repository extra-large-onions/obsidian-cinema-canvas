import { spawn } from 'child_process';
import { loadOrt, loadSession } from './onnx';
import type { Candidate } from './shots';

/**
 * TransNetV2 — a learned shot-boundary detector, as an alternative to ffmpeg's
 * `scdet`.
 *
 * scdet compares each frame to the one before it and scores how much that
 * difference *changed*. That is why it survives a steady pan and why it fires
 * on a handheld jolt: it has no idea what a shot is, only what a frame-to-frame
 * difference looks like. TransNetV2 reads a 100-frame window at a time and was
 * trained on labelled cuts, so it answers the actual question — and it rejects
 * the camera-movement false positives scdet cannot tell apart from cuts.
 *
 * Measured on a 370 s clip: scdet at sensitivity 4 found 83 cuts, TransNetV2
 * confirmed 62 of them, rejected 21 (all inside three handheld passages), and
 * added 3 that scdet had scored too low to reach. It took 83 s against scdet's
 * 6 s.
 */

/** Frames are fed to the network at this size, and it accepts no other. */
const W = 48;
const H = 27;
const C = 3;
const FRAME_BYTES = W * H * C;

/**
 * The network reads 100 frames and only its middle 50 predictions are kept, so
 * every frame is judged with 25 frames of past and 25 of future around it. This
 * is the author's own inference protocol; changing it changes the scores.
 */
const WINDOW = 100;
const STRIDE = 50;
const PAD = 25;

/** Where the ONNX export lives, when the plugin has to fetch it itself. */
export const MODEL_URL =
	'https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx';
/** Size of that download, for a progress message. */
export const MODEL_BYTES = 31250929;

export interface TransNetResult {
	duration: number;
	candidates: Candidate[];
}

export interface TransNetRequest {
	ffmpegPath: string;
	modelPath: string;
	/** Absolute path of the plugin folder, which is where the runtime lives. */
	runtimeDir: string;
	/** Absolute path of the clip on disk. */
	filePath: string;
	/** Score under which a frame is not worth caching, 0-100. */
	floor: number;
	/** 0-1, for a progress readout; called at most once per window. */
	onProgress?: (fraction: number) => void;
}

const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;
const FPS_LINE = /,\s*([\d.]+)\s*fps\b/;

/**
 * Runs TransNetV2 over one file and returns the frames it thinks are cuts.
 *
 * Like the ffmpeg path, this reports everything above a low floor rather than
 * above the user's sensitivity, so the sensitivity slider re-cuts the clip
 * without running the network again.
 */
export async function detectWithTransNet(
	request: TransNetRequest,
): Promise<TransNetResult> {
	// DirectML runs on any Direct3D 12 GPU, the integrated one included,
	// and was measured 3.7x faster than the CPU provider with identical
	// output for this model's 100-frame window.
	const session = await loadSession(request.modelPath, request.runtimeDir, {
		providers: ['dml', 'cpu'],
	});
	const ort = loadOrt(request.runtimeDir);

	const child = spawn(
		request.ffmpegPath.trim() || 'ffmpeg',
		[
			'-nostdin',
			'-nostats',
			'-i',
			request.filePath,
			'-vf',
			`scale=${W}:${H}:flags=bilinear`,
			'-pix_fmt',
			'rgb24',
			'-an',
			'-sn',
			'-f',
			'rawvideo',
			'-',
		],
		{ windowsHide: true },
	);

	let stderr = '';
	child.stderr?.on('data', (d: Buffer) => {
		// The banner is all that is wanted; a long decode log would otherwise
		// grow without bound.
		if (stderr.length < 64 * 1024) stderr += d.toString();
	});

	const probabilities: number[] = [];
	/** The window being filled, oldest frame first. */
	const frames: Uint8Array[] = [];
	const scratch = new Float32Array(WINDOW * H * W * C);
	let realFrames = 0;
	let primed = false;
	let lastFrame: Uint8Array | null = null;
	let expectedFrames = 0;

	const runWindow = async (): Promise<void> => {
		for (let f = 0; f < WINDOW; f++) {
			const src = frames[f];
			if (!src) return;
			// The graph divides by 255 itself, so frames go in as raw 0-255
			// values widened to float, not normalised.
			scratch.set(src, f * FRAME_BYTES);
		}
		const out = await session.run({
			input: new ort.Tensor('float32', scratch, [1, WINDOW, H, W, C]),
		});
		const name = session.outputNames[0];
		const single = name ? out[name]?.data : undefined;
		if (single)
			for (let f = PAD; f < PAD + STRIDE; f++)
				probabilities.push(single[f] ?? 0);
		frames.splice(0, STRIDE);
		if (expectedFrames > 0)
			request.onProgress?.(
				Math.min(1, probabilities.length / expectedFrames),
			);
		// Inference holds the thread for a few hundred milliseconds at a time;
		// this is where Obsidian gets to repaint.
		await yieldToUi();
	};

	const push = async (frame: Uint8Array): Promise<void> => {
		if (!primed) {
			// The first real frame needs 25 frames of "past" that do not
			// exist, so it stands in as its own history.
			for (let i = 0; i < PAD; i++) frames.push(frame);
			primed = true;
		}
		frames.push(frame);
		realFrames++;
		lastFrame = frame;
		if (frames.length >= WINDOW) await runWindow();
	};

	try {
		let tail: Buffer = Buffer.alloc(0);
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			if (expectedFrames === 0) expectedFrames = estimateFrames(stderr);
			tail = tail.length ? Buffer.concat([tail, chunk]) : chunk;
			let offset = 0;
			while (tail.length - offset >= FRAME_BYTES) {
				await push(
					new Uint8Array(tail.subarray(offset, offset + FRAME_BYTES)),
				);
				offset += FRAME_BYTES;
			}
			tail = tail.subarray(offset);
		}
	} catch (err) {
		child.kill();
		throw new Error(`Reading frames from ffmpeg failed: ${String(err)}`);
	}
	await new Promise<void>((resolve) => child.on('close', () => resolve()));

	if (realFrames === 0 || !lastFrame)
		throw new Error(
			`ffmpeg decoded no frames from this file. ${lastLines(stderr)}`,
		);

	// The tail of the file needs 25 frames of "future" it does not have, and
	// the last window has to be full before it can be run at all.
	const trailing: Uint8Array = lastFrame;
	while (probabilities.length < realFrames) {
		while (frames.length < WINDOW) frames.push(trailing);
		await runWindow();
	}
	probabilities.length = realFrames;

	const parsed = parseDuration(stderr);
	// Frames per second taken from the count is exact for a constant frame
	// rate and closer than the banner for anything else.
	const fps = parsed > 0 ? realFrames / parsed : (parseFps(stderr) ?? 25);
	const duration = parsed > 0 ? parsed : realFrames / fps;

	return {
		duration,
		candidates: peaks(probabilities, fps, request.floor),
	};
}

/**
 * Turns per-frame probabilities into one candidate per transition.
 *
 * A cut usually lights up two or three neighbouring frames and a dissolve lights
 * up a whole run of them, so only local maxima are kept. Suppressing the
 * shoulders here rather than in `buildShots` leaves the shortest-shot setting
 * free to be zero.
 */
export function peaks(
	probabilities: number[],
	fps: number,
	floor: number,
): Candidate[] {
	const candidates: Candidate[] = [];
	for (let i = 0; i < probabilities.length; i++) {
		const score = (probabilities[i] ?? 0) * 100;
		if (score < floor) continue;
		const before = (probabilities[i - 1] ?? 0) * 100;
		const after = (probabilities[i + 1] ?? 0) * 100;
		// `>` against the frame before and `>=` against the one after keeps
		// exactly one frame out of a plateau of equal values.
		if (score <= before || score < after) continue;
		candidates.push({
			// TransNetV2 marks the last frame of the outgoing shot; its authors'
			// own scene splitter puts the marked frame at the end of the earlier
			// scene. A cut here is the first frame of the incoming shot, which
			// is what scdet reports and what a segment's `start` has to be —
			// measured, 60 of the 62 cuts both detectors found sat exactly one
			// frame before scdet's until this was added.
			time: Math.round(((i + 1) / fps) * 1000) / 1000,
			score: Math.round(score * 100) / 100,
		});
	}
	return candidates;
}

function estimateFrames(stderr: string): number {
	const duration = parseDuration(stderr);
	const fps = parseFps(stderr);
	if (!duration || !fps) return 0;
	return Math.round(duration * fps);
}

function parseDuration(stderr: string): number {
	const m = DURATION_LINE.exec(stderr);
	if (!m) return 0;
	const hours = Number(m[1]);
	const minutes = Number(m[2]);
	const seconds = Number(m[3]);
	if (![hours, minutes, seconds].every((n) => Number.isFinite(n))) return 0;
	return hours * 3600 + minutes * 60 + seconds;
}

function parseFps(stderr: string): number | null {
	const m = FPS_LINE.exec(stderr);
	if (!m) return null;
	const fps = Number(m[1]);
	return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** The tail of an ffmpeg log, which is where it says what went wrong. */
export function lastLines(stderr: string, count = 2): string {
	return stderr
		.trim()
		.split(/\r?\n/)
		.slice(-count)
		.join(' ')
		.trim();
}

function yieldToUi(): Promise<void> {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, 0);
	});
}
