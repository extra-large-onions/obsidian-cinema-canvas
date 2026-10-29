/**
 * Reads the lighting of one frame from its pixels.
 *
 * Pure: RGBA in, numbers out, no DOM and no model. Faces come from the caller
 * (see `faces.ts`), because the only thing here that needs a network is
 * knowing where a face is. Everything else is arithmetic on light.
 *
 * All comparisons are made on *linear* light — sRGB decoded — because a stop
 * is a doubling of light, and the encoded values are not proportional to it.
 * What is measured is the graded image, as the audience saw it, not the set.
 */

export interface RgbaFrame {
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface Face {
	x: number;
	y: number;
	w: number;
	h: number;
	score: number;
	/** Two eyes, the nose tip, two mouth corners — YuNet's order. */
	landmarks: Point[];
}

export type Side = 'left' | 'right';

export interface FrameReading {
	/** From the darkest 2% to the brightest 2%, in stops. */
	contrastStops: number;
	/** Median brightness as displayed, 0-1. */
	median: number;
	tone: 'low key' | 'mid key' | 'high key';
	/** Share of pixels with a channel at the top of the range. */
	clipped: number;
	/** Share of pixels at the floor. */
	crushed: number;
	/** Displayed level of the darkest 1%, 0-1; high means lifted blacks. */
	blackLevel: number;
	/** The brightest area, in fractions of the frame. */
	brightest: { x: number; y: number; w: number; h: number; blown: boolean };
}

export interface FaceReading {
	face: Face;
	/** Midline of the face, eyes to mouth, stretched to the face's height. */
	axis: [Point, Point];
	/** Too small in frame to read more than its position. */
	small: boolean;
	/** Turned far enough that one half is mostly hidden. */
	turned: boolean;
	/** Screen side the key light comes from; null when the face is even. */
	keySide: Side | null;
	/** Lit half over shadow half, in stops. */
	ratioStops: number;
	/** Width of the light-to-shadow edge, as a share of the face's width. */
	edge: number | null;
	hardness: 'hard' | 'medium' | 'soft' | null;
	/** Displayed colour of each side, brightness evened out to show hue. */
	keyColor: string;
	fillColor: string;
	/** Key warmth minus fill warmth; positive means the key is warmer. */
	warmthShift: number;
	/**
	 * A bright edge around the head: brighter than the face's own highlights
	 * and than the background just beyond it, on the same side.
	 */
	rim: { sides: ('left' | 'right' | 'top')[]; stops: number } | null;
	/** Lit side of the face over the surround, in stops. */
	separationStops: number;
}

export interface LightReading {
	frame: FrameReading;
	faces: FaceReading[];
}

// --- light ------------------------------------------------------------------

/** sRGB 8-bit to linear light, 0-1. */
export const LINEAR = (() => {
	const table = new Float32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	}
	return table;
})();

/** Floor for anything a log is taken of: 12 stops under white. */
const FLOOR = 1 / 4096;

export function linearLuma(d: Uint8ClampedArray, i: number): number {
	return (
		0.2126 * (LINEAR[d[i] ?? 0] ?? 0) +
		0.7152 * (LINEAR[d[i + 1] ?? 0] ?? 0) +
		0.0722 * (LINEAR[d[i + 2] ?? 0] ?? 0)
	);
}

function stops(a: number, b: number): number {
	return Math.log2(Math.max(a, FLOOR) / Math.max(b, FLOOR));
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, z) => a - z);
	const at = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
	return sorted[at] ?? 0;
}

// --- the frame --------------------------------------------------------------

const LOG_BINS = 1024;

export function readFrame(frame: RgbaFrame): FrameReading {
	const { data, width, height } = frame;
	// Every second pixel both ways is plenty for percentiles.
	const step = width * height > 400_000 ? 2 : 1;
	const logHist = new Uint32Array(LOG_BINS);
	const displayHist = new Uint32Array(256);
	let clipped = 0;
	let crushed = 0;
	let count = 0;

	const cols = 16;
	const rows = 9;
	const cellSum = new Float64Array(cols * rows);
	const cellClip = new Uint32Array(cols * rows);
	const cellCount = new Uint32Array(cols * rows);

	for (let y = 0; y < height; y += step) {
		const row = Math.min(rows - 1, Math.floor((y / height) * rows));
		for (let x = 0; x < width; x += step) {
			const i = (y * width + x) * 4;
			const r = data[i] ?? 0;
			const g = data[i + 1] ?? 0;
			const b = data[i + 2] ?? 0;
			const lin = linearLuma(data, i);
			const bin = Math.min(
				LOG_BINS - 1,
				Math.max(0, Math.floor(((Math.log2(Math.max(lin, FLOOR)) + 12) / 12) * LOG_BINS)),
			);
			logHist[bin] = (logHist[bin] ?? 0) + 1;
			const shown = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
			displayHist[shown] = (displayHist[shown] ?? 0) + 1;
			const isClipped = Math.max(r, g, b) >= 252;
			if (isClipped) clipped++;
			if (shown <= 6) crushed++;
			count++;

			const cell = row * cols + Math.min(cols - 1, Math.floor((x / width) * cols));
			cellSum[cell] = (cellSum[cell] ?? 0) + lin;
			cellCount[cell] = (cellCount[cell] ?? 0) + 1;
			if (isClipped) cellClip[cell] = (cellClip[cell] ?? 0) + 1;
		}
	}

	const logAt = (p: number): number => {
		const target = p * count;
		let seen = 0;
		for (let b = 0; b < LOG_BINS; b++) {
			seen += logHist[b] ?? 0;
			if (seen >= target) return Math.pow(2, ((b + 0.5) / LOG_BINS) * 12 - 12);
		}
		return 1;
	};
	const displayAt = (p: number): number => {
		const target = p * count;
		let seen = 0;
		for (let v = 0; v < 256; v++) {
			seen += displayHist[v] ?? 0;
			if (seen >= target) return v / 255;
		}
		return 1;
	};

	let best = 0;
	let bestMean = -1;
	for (let c = 0; c < cols * rows; c++) {
		const n = cellCount[c] ?? 0;
		const mean = n > 0 ? (cellSum[c] ?? 0) / n : 0;
		if (mean > bestMean) {
			bestMean = mean;
			best = c;
		}
	}
	const bestN = cellCount[best] ?? 1;
	const median = displayAt(0.5);

	return {
		contrastStops: stops(logAt(0.98), logAt(0.02)),
		median,
		tone: median < 0.22 ? 'low key' : median > 0.6 ? 'high key' : 'mid key',
		clipped: count ? clipped / count : 0,
		crushed: count ? crushed / count : 0,
		blackLevel: displayAt(0.01),
		brightest: {
			x: (best % cols) / cols,
			y: Math.floor(best / cols) / rows,
			w: 1 / cols,
			h: 1 / rows,
			blown: (cellClip[best] ?? 0) / bestN > 0.5,
		},
	};
}

// --- one face ---------------------------------------------------------------

/** Faces shorter than this, in analysis pixels, are only located. */
const MIN_FACE_PX = 48;
/** Columns the light-to-shadow profile across a face is cut into. */
const PROFILE_BINS = 24;

function sub(a: Point, b: Point): Point {
	return { x: a.x - b.x, y: a.y - b.y };
}
function mid(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function dot(a: Point, b: Point): number {
	return a.x * b.x + a.y * b.y;
}
function length(a: Point): number {
	return Math.hypot(a.x, a.y);
}

interface Rgb {
	r: number;
	g: number;
	b: number;
	n: number;
}

function addRgb(acc: Rgb, d: Uint8ClampedArray, i: number): void {
	acc.r += LINEAR[d[i] ?? 0] ?? 0;
	acc.g += LINEAR[d[i + 1] ?? 0] ?? 0;
	acc.b += LINEAR[d[i + 2] ?? 0] ?? 0;
	acc.n++;
}

/** Warmth of a linear colour: red over blue, independent of brightness. */
function warmth(c: Rgb): number {
	const sum = c.r + c.g + c.b;
	return sum > 0 ? (c.r - c.b) / sum : 0;
}

/** The colour's hue at an even brightness, as a CSS hex. */
function swatch(c: Rgb): string {
	const top = Math.max(c.r, c.g, c.b);
	if (top <= 0) return '#000000';
	const hex = (v: number): string => {
		const lin = (v / top) * 0.6;
		const enc = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
		return Math.round(Math.min(1, enc) * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

export function readFace(frame: RgbaFrame, face: Face): FaceReading {
	const { data, width, height } = frame;
	const [eyeA, eyeB, nose, mouthA, mouthB] = face.landmarks;
	const fallback: Point = { x: face.x + face.w / 2, y: face.y + face.h / 2 };
	const eyeMid = eyeA && eyeB ? mid(eyeA, eyeB) : fallback;
	const mouthMid = mouthA && mouthB ? mid(mouthA, mouthB) : fallback;

	// Down the face, and across it toward screen right.
	let down = sub(mouthMid, eyeMid);
	const em = Math.max(1, length(down));
	down = { x: down.x / em, y: down.y / em };
	const across: Point = { x: down.y, y: -down.x };
	const eyeGap = eyeA && eyeB ? length(sub(eyeA, eyeB)) : face.w * 0.4;

	const center: Point = { x: face.x + face.w / 2, y: face.y + face.h / 2 };
	const halfW = face.w * 0.42;
	const halfH = face.h * 0.5;
	const axisTop = { x: eyeMid.x - down.x * halfH * 0.9, y: eyeMid.y - down.y * halfH * 0.9 };
	const axisBottom = { x: eyeMid.x + down.x * halfH * 1.35, y: eyeMid.y + down.y * halfH * 1.35 };
	const turned = nose ? Math.abs(dot(sub(nose, eyeMid), across)) / eyeGap > 0.28 : false;

	const left: number[] = [];
	const right: number[] = [];
	const leftRgb: Rgb = { r: 0, g: 0, b: 0, n: 0 };
	const rightRgb: Rgb = { r: 0, g: 0, b: 0, n: 0 };
	const profile: number[][] = Array.from({ length: PROFILE_BINS }, () => []);
	// Just outside the face, and further out, split by side; the part of the
	// surround below the chin is left out, since that is the body.
	const ring = { left: [] as number[], right: [] as number[], top: [] as number[] };
	const outer = { left: [] as number[], right: [] as number[], top: [] as number[] };

	// About 20,000 samples of the face and its surround, whatever its size.
	const reach = 2.5;
	const x0 = Math.max(0, Math.floor(center.x - halfW * reach));
	const x1 = Math.min(width - 1, Math.ceil(center.x + halfW * reach));
	const y0 = Math.max(0, Math.floor(center.y - halfH * reach));
	const y1 = Math.min(height - 1, Math.ceil(center.y + halfH * reach));
	const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));

	for (let y = y0; y <= y1; y += step) {
		for (let x = x0; x <= x1; x += step) {
			const p = { x, y };
			const fromCenter = sub(p, center);
			const a = dot(fromCenter, across) / halfW;
			const d = dot(fromCenter, down) / halfH;
			const r2 = a * a + d * d;
			const i = (y * width + x) * 4;
			const lum = linearLuma(data, i);

			if (r2 <= 1) {
				// Across from the midline, not from the box: a turned head
				// puts its midline off the box's centre.
				const side = dot(sub(p, eyeMid), across) / halfW;
				const along = dot(sub(p, eyeMid), down) / em;
				if (Math.abs(side) > 0.06) {
					if (side < 0) {
						left.push(lum);
						addRgb(leftRgb, data, i);
					} else {
						right.push(lum);
						addRgb(rightRgb, data, i);
					}
				}
				if (along > 0.1 && along < 0.9) {
					const bin = Math.floor(((side + 1) / 2) * PROFILE_BINS);
					if (bin >= 0 && bin < PROFILE_BINS) profile[bin]?.push(lum);
				}
			} else if (d < 0.4) {
				const rho = Math.sqrt(r2);
				const ua = a / rho;
				const side = ua < -0.5 ? 'left' : ua > 0.5 ? 'right' : 'top';
				if (rho >= 1.05 && rho <= 1.6) ring[side].push(lum);
				else if (rho >= 1.8 && rho <= reach) outer[side].push(lum);
			}
		}
	}

	const leftLevel = percentile(left, 0.6);
	const rightLevel = percentile(right, 0.6);
	const ratioStops = Math.abs(stops(leftLevel, rightLevel));
	const keySide: Side | null =
		ratioStops < 0.35 ? null : leftLevel > rightLevel ? 'left' : 'right';
	const keyLevel = Math.max(leftLevel, rightLevel);
	const keyRgb = leftLevel >= rightLevel ? leftRgb : rightRgb;
	const fillRgb = leftLevel >= rightLevel ? rightRgb : leftRgb;

	// The light-to-shadow edge: how many profile bins it takes to fall from
	// 80% to 20% of the way between the two sides, in log light.
	let edge: number | null = null;
	if (keySide && ratioStops >= 0.8) {
		const hi = Math.log2(Math.max(keyLevel, FLOOR));
		const lo = Math.log2(Math.max(Math.min(leftLevel, rightLevel), FLOOR));
		const levels = profile.map((bin) =>
			bin.length ? Math.log2(Math.max(percentile(bin, 0.5), FLOOR)) : null,
		);
		const ordered = keySide === 'left' ? levels : [...levels].reverse();
		let start = -1;
		let end = -1;
		for (let k = 0; k < ordered.length; k++) {
			const v = ordered[k];
			if (v === null || v === undefined) continue;
			if (start < 0 && v <= lo + 0.8 * (hi - lo)) start = k;
			if (start >= 0 && v <= lo + 0.2 * (hi - lo)) {
				end = k;
				break;
			}
		}
		if (start >= 0 && end >= start) edge = (end - start + 1) / PROFILE_BINS;
	}

	// Rim, per side: the brightest of the band beside the head against the
	// face's own highlights and against the background just beyond. Judged
	// per side because a rim is most often cut against a bright background —
	// haze, a window — which a single test over the whole surround calls
	// "bright background" and misses the edge.
	const faceTop = percentile([...left, ...right], 0.9);
	const rimSides: ('left' | 'right' | 'top')[] = [];
	let rimLevel = 0;
	for (const side of ['left', 'right', 'top'] as const) {
		if (ring[side].length < 12 || outer[side].length < 12) continue;
		const edgeLevel = percentile(ring[side], 0.95);
		const beyond = percentile(outer[side], 0.75);
		// Far above the face, a thin margin over the background is enough:
		// that is a rim against haze. Barely above it, the margin has to be
		// clear, or a bright wall beside the head would pass.
		const overFace = stops(edgeLevel, faceTop);
		const overBeyond = stops(edgeLevel, beyond);
		// And a rim is a thin line: a window behind the head fills the band.
		const cut = Math.sqrt(edgeLevel * beyond);
		const share = ring[side].filter((v) => v > cut).length / ring[side].length;
		if (
			share < 0.35 &&
			((overFace > 1.5 && overBeyond > 0.25) || (overFace > 0.25 && overBeyond > 0.6))
		) {
			rimSides.push(side);
			rimLevel = Math.max(rimLevel, edgeLevel);
		}
	}
	const rim: FaceReading['rim'] = rimSides.length
		? { sides: rimSides, stops: stops(rimLevel, keyLevel) }
		: null;
	const surround = percentile([...outer.left, ...outer.right, ...outer.top], 0.5);

	const small = face.h < MIN_FACE_PX;
	return {
		face,
		axis: [axisTop, axisBottom],
		small,
		turned,
		keySide: small ? null : keySide,
		ratioStops: small ? 0 : ratioStops,
		edge,
		hardness:
			small || edge === null ? null : edge <= 0.17 ? 'hard' : edge >= 0.34 ? 'soft' : 'medium',
		keyColor: swatch(keyRgb),
		fillColor: swatch(fillRgb),
		warmthShift: warmth(keyRgb) - warmth(fillRgb),
		rim: small ? null : rim,
		separationStops: stops(keyLevel, surround),
	};
}

export function readLight(frame: RgbaFrame, faces: Face[]): LightReading {
	// The three largest faces: past that the panel is a wall of numbers.
	const biggest = [...faces].sort((a, z) => z.h - a.h).slice(0, 3);
	return {
		frame: readFrame(frame),
		faces: biggest.map((f) => readFace(frame, f)),
	};
}

/** "4:1", from a difference in stops. */
export function ratioLabel(stopsValue: number): string {
	const r = Math.pow(2, stopsValue);
	return `${r < 10 ? r.toFixed(1).replace(/\.0$/, '') : Math.round(r)}:1`;
}
