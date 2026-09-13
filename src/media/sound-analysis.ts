import { spawn } from 'child_process';
import { AUDIOSET_LABELS } from './audioset-labels';
import { loadOrt, loadSession } from './onnx';

/**
 * What is on a film's soundtrack, second by second: dialogue, music, effects,
 * and silence.
 *
 * A film's audio is mixed down to one track, so the three are rarely heard
 * alone — a line is spoken over score, a door slams under a line. Nothing here
 * pretends otherwise: each is its own lane and any number can be on at once.
 *
 * One ffmpeg decode to 16 kHz mono feeds three readings:
 *
 * - **Silero VAD** (2.3 MB) says whether someone is speaking, per 32 ms. It is
 *   a dedicated speech detector, far sharper at the edges of a line than a
 *   general tagger.
 * - **PANNs CNN14** (327 MB), trained on Google's AudioSet, scores 527 kinds of
 *   sound over a 2 s window every second. Music is read from its music classes,
 *   effects from everything that is neither music, speech nor a description of
 *   the room.
 * - **RMS loudness** per 100 ms, which is what silence is judged from.
 *
 * Measured on a 185 s test track of known content (synthesised speech, digital
 * silence, solo piano, rain and thunder, gunshots, and speech over piano at
 * -12 dB): 178 of 185 seconds labelled exactly right. The misses were five
 * seconds where the piano under the speech was too quiet to register, and two
 * seconds at the edge of an effect.
 *
 * As with shots, the raw readings are cached and the thresholds are applied
 * afterwards, so the sliders re-label a two-hour film without decoding it
 * again.
 */

export const SAMPLE_RATE = 16000;
/** Loudness and speech are kept per bin of this many seconds. */
export const BIN_SECONDS = 0.1;
const BIN_SAMPLES = SAMPLE_RATE * BIN_SECONDS;

/** Silero VAD reads 512 samples at 16 kHz, with the 64 before them as context. */
const VAD_CHUNK = 512;
const VAD_CONTEXT = 64;

/** PANNs reads 2 s and is run every 1 s, so every second is heard twice. */
const TAG_WINDOW = 2 * SAMPLE_RATE;
const TAG_HOP = SAMPLE_RATE;
/** How many of the 527 classes are remembered per second, for the tooltip. */
export const TAGS_PER_SECOND = 3;

/** Bump when the cached readings change meaning; older files are re-analysed. */
export const ANALYSIS_FORMAT = 1;

const inclusive = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Singing (27-37) and every instrument, genre and mood of music (137-282). */
const MUSIC_CLASSES = [...inclusive(27, 37), ...inclusive(137, 282)];
/** Speech, shouting, whispering, laughter, crying (0-26), chatter and babble. */
const SPEECH_CLASSES = new Set([...inclusive(0, 26), 68, 70]);
/**
 * Silence, test tones and descriptions of the space rather than of a sound:
 * "Inside, small room", "Reverberation", "Noise" (500-526).
 */
const SCENE_CLASSES = new Set(inclusive(500, 526));
const MUSIC_SET = new Set(MUSIC_CLASSES);
const EFFECT_CLASSES = AUDIOSET_LABELS.map((_, i) => i).filter(
	(i) => !MUSIC_SET.has(i) && !SPEECH_CLASSES.has(i) && !SCENE_CLASSES.has(i),
);

/** The readings for one file, exactly as cached. Integers, to keep it small. */
export interface SoundAnalysis {
	format: number;
	/** Vault path at the time of analysis, for tracing a stray cache file. */
	path: string;
	/** Seconds of audio actually decoded. */
	duration: number;
	/** RMS level per bin, whole dBFS, floored at -100. */
	loudness: number[];
	/** Mean speech probability per bin, 0-100. */
	speech: number[];
	/** Strongest music class per second, 0-100. */
	music: number[];
	/** Strongest effect class per second, 0-100. */
	effects: number[];
	/** Per second, `TAGS_PER_SECOND` pairs of [class id, score 0-100]. */
	tags: number[];
}

export interface SoundRequest {
	ffmpegPath: string;
	vadModelPath: string;
	taggerModelPath: string;
	/** Absolute path of the plugin folder, which is where the runtime lives. */
	runtimeDir: string;
	/** Absolute path of the file on disk. */
	filePath: string;
	/** 0-1; called about once per second of audio. */
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
}

export class AnalysisCancelled extends Error {
	constructor() {
		super('Sound analysis was stopped.');
	}
}

const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Decodes the first audio track of `filePath` and reads it three ways. */
export async function analyseSound(
	request: SoundRequest,
): Promise<Omit<SoundAnalysis, 'path'>> {
	const ort = loadOrt(request.runtimeDir);
	// Both run on the CPU. Each call is small — 32 ms or 2 s of audio — and
	// handing that to DirectML costs more than the run: measured 42 ms per
	// PANNs window on the CPU against 298 ms through the GPU. Spinning is off
	// so the two thread pools do not burn cores waiting on each other.
	const vad = await loadSession(request.vadModelPath, request.runtimeDir, {
		providers: ['cpu'],
		threads: 1,
		spin: false,
	});
	const tagger = await loadSession(
		request.taggerModelPath,
		request.runtimeDir,
		{ providers: ['cpu'], spin: false },
	);

	const signal = request.signal;
	if (signal?.aborted) throw new AnalysisCancelled();

	const child = spawn(
		request.ffmpegPath.trim() || 'ffmpeg',
		[
			'-nostdin',
			'-nostats',
			'-i',
			request.filePath,
			// The first audio track: on a film with a commentary or a second
			// language, that is the main mix.
			'-map',
			'0:a:0',
			'-vn',
			'-sn',
			'-dn',
			'-ac',
			'1',
			'-ar',
			String(SAMPLE_RATE),
			'-f',
			'f32le',
			'-',
		],
		{ windowsHide: true },
	);
	const kill = (): void => {
		child.kill();
	};
	signal?.addEventListener('abort', kill, { once: true });

	let stderr = '';
	child.stderr?.on('data', (d: Buffer) => {
		if (stderr.length < 64 * 1024) stderr += d.toString();
	});
	const closed = new Promise<number | null>((resolve) =>
		child.on('close', (code) => resolve(code)),
	);

	const loudness: number[] = [];
	const speechSum: number[] = [];
	const speechCount: number[] = [];
	const music: number[] = [];
	const effects: number[] = [];
	const tags: number[] = [];

	const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
	let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
	const vadInput = new Float32Array(VAD_CONTEXT + VAD_CHUNK);
	const vadChunk = new Float32Array(VAD_CHUNK);
	let vadFill = 0;
	let vadChunks = 0;

	/** The last `TAG_WINDOW` samples, as a ring. */
	const ring = new Float32Array(TAG_WINDOW);
	const heard = new Float32Array(TAG_WINDOW);
	let total = 0;
	let nextWindowAt = TAG_WINDOW;
	/** Scores of the previous window, which also covers the current second. */
	let previous: Float32Array | null = null;
	/** Seconds whose scores are final. */
	let secondsDone = 0;

	let rmsSum = 0;
	let rmsCount = 0;
	let expected = 0;

	const pushBinLoudness = (): void => {
		const level = rmsCount > 0 ? rmsSum / rmsCount : 0;
		loudness.push(
			Math.max(-100, Math.round(10 * Math.log10(level + 1e-10))),
		);
		rmsSum = 0;
		rmsCount = 0;
	};

	const runVad = async (): Promise<void> => {
		vadInput.set(vadInput.subarray(VAD_CONTEXT + VAD_CHUNK - VAD_CONTEXT), 0);
		vadInput.set(vadChunk, VAD_CONTEXT);
		const out = await vad.run({
			input: new ort.Tensor('float32', vadInput, [1, vadInput.length]),
			state,
			sr,
		});
		const next = out.stateN;
		if (next) state = next;
		const probability = out.output?.data[0] ?? 0;
		// Credited to the bin its first sample falls in.
		const bin = Math.floor((vadChunks * VAD_CHUNK) / BIN_SAMPLES);
		speechSum[bin] = (speechSum[bin] ?? 0) + probability;
		speechCount[bin] = (speechCount[bin] ?? 0) + 1;
		vadChunks++;
	};

	/** Scores the last two seconds, which ends at sample `total`. */
	const score = async (): Promise<Float32Array> => {
		const start = total % TAG_WINDOW;
		heard.set(ring.subarray(start), 0);
		heard.set(ring.subarray(0, start), TAG_WINDOW - start);
		const out = await tagger.run({
			input_audio: new ort.Tensor('float32', heard, [1, TAG_WINDOW]),
		});
		const name = tagger.outputNames[0];
		const scores = name ? out[name]?.data : undefined;
		return scores ? Float32Array.from(scores) : new Float32Array(527);
	};

	/** Settles one second from the mean of the windows that heard it. */
	const settle = (a: Float32Array, b: Float32Array | null): void => {
		const mean = new Float32Array(a.length);
		for (let i = 0; i < a.length; i++)
			mean[i] = b ? ((a[i] ?? 0) + (b[i] ?? 0)) / 2 : (a[i] ?? 0);
		music.push(percent(maxOf(mean, MUSIC_CLASSES)));
		effects.push(percent(maxOf(mean, EFFECT_CLASSES)));
		for (const [id, value] of topClasses(mean, TAGS_PER_SECOND))
			tags.push(id, percent(value));
		secondsDone++;
	};

	let lastYield = performance.now();

	try {
		let tail: Buffer = Buffer.alloc(0);
		for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
			if (signal?.aborted) throw new AnalysisCancelled();
			if (expected === 0) expected = parseDuration(stderr);
			tail = tail.length ? Buffer.concat([tail, chunk]) : chunk;
			const count = Math.floor(tail.length / 4);
			// Copied out, because a Buffer's offset into its pool is not
			// guaranteed to be a multiple of four.
			const samples = new Float32Array(
				tail.buffer.slice(tail.byteOffset, tail.byteOffset + count * 4),
			);
			tail = tail.subarray(count * 4);

			for (let i = 0; i < samples.length; i++) {
				const sample = samples[i] ?? 0;
				ring[total % TAG_WINDOW] = sample;
				total++;

				rmsSum += sample * sample;
				rmsCount++;
				if (rmsCount === BIN_SAMPLES) pushBinLoudness();

				vadChunk[vadFill++] = sample;
				if (vadFill === VAD_CHUNK) {
					await runVad();
					vadFill = 0;
				}

				if (total === nextWindowAt) {
					nextWindowAt += TAG_HOP;
					const scores = await score();
					// Window k covers seconds k and k+1: second k now has both
					// of its windows, second k+1 waits for the next one.
					settle(scores, previous);
					previous = scores;
					if (expected > 0)
						request.onProgress?.(
							Math.min(1, total / SAMPLE_RATE / expected),
						);
					if (performance.now() - lastYield > 250) {
						await yieldToUi();
						lastYield = performance.now();
					}
				}
			}
		}
	} catch (err) {
		child.kill();
		signal?.removeEventListener('abort', kill);
		if (signal?.aborted) throw new AnalysisCancelled();
		throw new Error(`Reading audio from ffmpeg failed: ${String(err)}`);
	}
	await closed;
	signal?.removeEventListener('abort', kill);
	if (signal?.aborted) throw new AnalysisCancelled();

	if (total === 0) {
		if (/matches no streams|does not contain any stream/i.test(stderr))
			throw new Error('This file has no audio track.');
		throw new Error(`ffmpeg decoded no audio from this file. ${lastLines(stderr)}`);
	}

	// The tail: a last partial bin, a last partial VAD chunk, and the seconds
	// no full window reached.
	if (rmsCount > 0) pushBinLoudness();
	if (vadFill > 0) {
		vadChunk.fill(0, vadFill);
		await runVad();
	}
	const seconds = Math.ceil(total / SAMPLE_RATE);
	if (previous) {
		// The last window heard the final second on its own.
		if (secondsDone < seconds) settle(previous, null);
	}
	if (secondsDone < seconds) {
		// Shorter than a window, or a stub past the last hop: score the last
		// two seconds (zero-padded when the file is shorter) for what is left.
		const scores = await score();
		while (secondsDone < seconds) settle(scores, null);
	}

	const speech = loudness.map((_, bin) => {
		const count = speechCount[bin] ?? 0;
		return count > 0 ? percent((speechSum[bin] ?? 0) / count) : 0;
	});

	return {
		format: ANALYSIS_FORMAT,
		duration: total / SAMPLE_RATE,
		loudness,
		speech,
		music: music.slice(0, seconds),
		effects: effects.slice(0, seconds),
		tags: tags.slice(0, seconds * TAGS_PER_SECOND * 2),
	};
}

// --- turning readings into lanes -------------------------------------------

/** The three thresholds, which live next to the lanes rather than in settings. */
export interface SoundParams {
	/** RMS level under which a bin is silent, dBFS. */
	soundSilenceDb: number;
	/** Speech probability x100 a bin must reach to be dialogue. */
	soundDialogue: number;
	/** Music score x100 a second must reach to be music. */
	soundMusic: number;
}

export type SoundParamKey = keyof SoundParams;

/** One flag per bin, per lane. */
export interface SoundLanes {
	bins: number;
	dialogue: Uint8Array;
	music: Uint8Array;
	effects: Uint8Array;
	silence: Uint8Array;
}

export type LaneName = 'dialogue' | 'music' | 'effects' | 'silence';

export interface SoundRun {
	/** Seconds. */
	start: number;
	end: number;
}

/**
 * An effect this sure is shown even under dialogue or music. Below it, anything
 * audible that is neither counts as effects — which is how room tone and
 * backgrounds end up in that lane, where a mixer would also put them.
 */
const EFFECT_ALONGSIDE = 20;

/**
 * Smoothing, in bins. A pause between two words is not the end of a line; a
 * rest in the score is not the end of a cue; a single quiet bin is not a
 * silence anyone would hear.
 */
const SMOOTHING: Record<LaneName, { gap: number; min: number }> = {
	dialogue: { gap: 4, min: 3 },
	music: { gap: 20, min: 20 },
	effects: { gap: 3, min: 3 },
	silence: { gap: 0, min: 5 },
};

/** Pure: applies the thresholds to cached readings. Cheap enough for a slider. */
export function classifySound(
	analysis: SoundAnalysis,
	params: SoundParams,
): SoundLanes {
	const bins = analysis.loudness.length;
	const silence = new Uint8Array(bins);
	const dialogue = new Uint8Array(bins);
	const music = new Uint8Array(bins);
	const effects = new Uint8Array(bins);
	const binsPerSecond = Math.round(1 / BIN_SECONDS);

	for (let i = 0; i < bins; i++)
		silence[i] = (analysis.loudness[i] ?? -100) < params.soundSilenceDb ? 1 : 0;
	smooth(silence, SMOOTHING.silence);

	for (let i = 0; i < bins; i++) {
		if (silence[i]) continue;
		const second = Math.floor(i / binsPerSecond);
		if ((analysis.speech[i] ?? 0) >= params.soundDialogue) dialogue[i] = 1;
		if ((analysis.music[second] ?? 0) >= params.soundMusic) music[i] = 1;
	}
	smooth(dialogue, SMOOTHING.dialogue);
	smooth(music, SMOOTHING.music);

	for (let i = 0; i < bins; i++) {
		if (silence[i]) continue;
		const second = Math.floor(i / binsPerSecond);
		const sure = (analysis.effects[second] ?? 0) >= EFFECT_ALONGSIDE;
		if (sure || (!dialogue[i] && !music[i])) effects[i] = 1;
	}
	smooth(effects, SMOOTHING.effects);

	return { bins, dialogue, music, effects, silence };
}

/** Closes gaps up to `gap` bins, then drops runs shorter than `min` bins. */
function smooth(mask: Uint8Array, { gap, min }: { gap: number; min: number }): void {
	if (gap > 0) {
		let lastOn = -1;
		for (let i = 0; i < mask.length; i++) {
			if (!mask[i]) continue;
			if (lastOn >= 0 && i - lastOn - 1 <= gap) mask.fill(1, lastOn + 1, i);
			lastOn = i;
		}
	}
	if (min > 1) {
		let start = -1;
		for (let i = 0; i <= mask.length; i++) {
			const on = i < mask.length && mask[i] === 1;
			if (on && start < 0) start = i;
			if (!on && start >= 0) {
				if (i - start < min) mask.fill(0, start, i);
				start = -1;
			}
		}
	}
}

/** Contiguous on-runs of a lane, in seconds. */
export function runsOf(mask: Uint8Array, value: 0 | 1 = 1): SoundRun[] {
	const runs: SoundRun[] = [];
	let start = -1;
	for (let i = 0; i <= mask.length; i++) {
		const on = i < mask.length && mask[i] === value;
		if (on && start < 0) start = i;
		if (!on && start >= 0) {
			runs.push({ start: start * BIN_SECONDS, end: i * BIN_SECONDS });
			start = -1;
		}
	}
	return runs;
}

/** Seconds a lane is on. */
export function laneSeconds(mask: Uint8Array): number {
	let on = 0;
	for (let i = 0; i < mask.length; i++) on += mask[i] ?? 0;
	return on * BIN_SECONDS;
}

/** The strongest classes PANNs heard in `second`, most confident first. */
export function tagsAt(
	analysis: SoundAnalysis,
	second: number,
): { label: string; score: number }[] {
	const out: { label: string; score: number }[] = [];
	const base = Math.floor(second) * TAGS_PER_SECOND * 2;
	for (let k = 0; k < TAGS_PER_SECOND; k++) {
		const id = analysis.tags[base + k * 2];
		const value = analysis.tags[base + k * 2 + 1];
		if (id === undefined || value === undefined) break;
		out.push({ label: AUDIOSET_LABELS[id] ?? `Class ${id}`, score: value });
	}
	return out;
}

// --- helpers ----------------------------------------------------------------

function percent(probability: number): number {
	return Math.max(0, Math.min(100, Math.round(probability * 100)));
}

function maxOf(scores: Float32Array, classes: readonly number[]): number {
	let best = 0;
	for (const id of classes) best = Math.max(best, scores[id] ?? 0);
	return best;
}

function topClasses(scores: Float32Array, count: number): [number, number][] {
	const best: [number, number][] = [];
	for (let id = 0; id < scores.length; id++) {
		const value = scores[id] ?? 0;
		if (best.length < count) {
			best.push([id, value]);
			best.sort((a, b) => b[1] - a[1]);
		} else if (value > (best[count - 1]?.[1] ?? 0)) {
			best[count - 1] = [id, value];
			best.sort((a, b) => b[1] - a[1]);
		}
	}
	return best;
}

function parseDuration(stderr: string): number {
	const m = DURATION_LINE.exec(stderr);
	if (!m) return 0;
	const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	return Number.isFinite(total) ? total : 0;
}

function lastLines(stderr: string, count = 2): string {
	return stderr.trim().split(/\r?\n/).slice(-count).join(' ').trim();
}

/**
 * Hands the thread back to Obsidian.
 *
 * A message channel rather than `setTimeout`: Chromium throttles timers in a
 * hidden window to one per second, which would turn a ten-minute analysis into
 * hours if Obsidian were minimised while it ran.
 */
function yieldToUi(): Promise<void> {
	return new Promise<void>((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(null);
	});
}
