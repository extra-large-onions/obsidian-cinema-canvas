import type { RgbaFrame } from './lighting';

/**
 * Edge light: bright edges along a dark shape — a rim or kicker on hair,
 * shoulders or a cheek. Found without any model, so it works on any frame,
 * with or without faces.
 *
 * A pixel counts when it is:
 * - among the brightest in frame (top 15%), so an evenly lit edge does not;
 * - a narrow peak: brighter than the picture with every bright detail
 *   narrower than a rim shaved off (a grey opening). A rim against haze is
 *   only a little brighter than the haze, so the margin is small;
 * - beside a sizeable dark shape: within a short reach the picture, with
 *   small dark holes (nostrils, eye sockets, texture) filled in, falls to
 *   under half of it.
 * Connected pixels are then grouped, and short groups (catchlights, sparkles,
 * subtitle letters) are dropped.
 *
 * It sees any bright edge against dark, so a neon tube, a lit window frame or
 * the lit side of a face in a dark room reads as edge light too; the marks
 * show which is which.
 */

/** Width the frame is read at. */
const WORK_WIDTH = 640;
const TOP_SHARE = 0.85;
const MIN_LEVEL = 0.2;
/** How far above the opened picture a rim must be, absolute and relative. */
const MIN_ABOVE = 0.03;
const MIN_RATIO = 1.1;
/** The dark shape must fall below this share of the rim, and this level. */
const DARK_RATIO = 0.45;
const DARK_LEVEL = 0.25;

export interface EdgeLight {
	/** Work-size mask: 1 where the frame has edge light. */
	mask: Uint8Array;
	width: number;
	height: number;
	/** Share of the frame's pixels that are edge light. */
	share: number;
	/** How many separate streaks were kept. */
	streaks: number;
}

export function findEdgeLight(frame: RgbaFrame): EdgeLight {
	const scale = Math.min(1, WORK_WIDTH / frame.width);
	const W = Math.max(1, Math.round(frame.width * scale));
	const H = Math.max(1, Math.round(frame.height * scale));
	const luma = blur(downscale(frame, W, H), W, H);

	// Widest a rim can be; anything wider is a lit surface.
	const r = Math.max(2, Math.round(W / 90));
	const opened = dilate(erode(luma, W, H, r), W, H, r);
	// Closed first, so only a sizeable dark shape counts, then the darkest
	// point within reach of each pixel.
	const hole = Math.max(r + 1, Math.round(W / 40));
	const reach = r * 3;
	const darkest = erode(erode(dilate(luma, W, H, hole), W, H, hole), W, H, reach);
	const floor = Math.max(percentile(luma, TOP_SHARE), MIN_LEVEL);

	const candidate = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) {
		const v = luma[i]!;
		if (v < floor) continue;
		const o = opened[i]!;
		if (v - o < MIN_ABOVE || v < o * MIN_RATIO) continue;
		const d = darkest[i]!;
		if (d > v * DARK_RATIO || d > DARK_LEVEL) continue;
		candidate[i] = 1;
	}

	const mask = new Uint8Array(W * H);
	const minLength = Math.max(12, W * 0.045);
	let streaks = 0;
	let count = 0;
	const stack: number[] = [];
	const members: number[] = [];
	const seen = new Uint8Array(W * H);
	for (let start = 0; start < W * H; start++) {
		if (!candidate[start] || seen[start]) continue;
		members.length = 0;
		stack.push(start);
		seen[start] = 1;
		let x0 = W;
		let y0 = H;
		let x1 = 0;
		let y1 = 0;
		while (stack.length) {
			const i = stack.pop()!;
			members.push(i);
			const x = i % W;
			const y = (i - x) / W;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= H) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= W) continue;
					const j = yy * W + xx;
					if (candidate[j] && !seen[j]) {
						seen[j] = 1;
						stack.push(j);
					}
				}
			}
		}
		if (Math.hypot(x1 - x0 + 1, y1 - y0 + 1) < minLength) continue;
		streaks++;
		count += members.length;
		for (const i of members) mask[i] = 1;
	}

	return { mask, width: W, height: H, share: count / (W * H), streaks };
}

/** Box-averaged luma (0–1, as encoded) at `W` x `H`. */
function downscale(frame: RgbaFrame, W: number, H: number): Float32Array {
	const out = new Float32Array(W * H);
	const { data, width, height } = frame;
	const sx = width / W;
	const sy = height / H;
	for (let y = 0; y < H; y++) {
		const fy0 = Math.floor(y * sy);
		const fy1 = Math.min(height, Math.max(fy0 + 1, Math.floor((y + 1) * sy)));
		for (let x = 0; x < W; x++) {
			const fx0 = Math.floor(x * sx);
			const fx1 = Math.min(width, Math.max(fx0 + 1, Math.floor((x + 1) * sx)));
			let sum = 0;
			let n = 0;
			for (let fy = fy0; fy < fy1; fy++)
				for (let fx = fx0; fx < fx1; fx++) {
					const i = (fy * width + fx) * 4;
					sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
					n++;
				}
			out[y * W + x] = n ? sum / n / 255 : 0;
		}
	}
	return out;
}

/** 3 x 3 box blur, so film grain does not read as a bright edge. */
function blur(src: Float32Array, W: number, H: number): Float32Array {
	const tmp = new Float32Array(W * H);
	const out = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			tmp[i] = (src[x > 0 ? i - 1 : i]! + src[i]! + src[x < W - 1 ? i + 1 : i]!) / 3;
		}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			out[i] = (tmp[y > 0 ? i - W : i]! + tmp[i]! + tmp[y < H - 1 ? i + W : i]!) / 3;
		}
	return out;
}

function erode(src: Float32Array, W: number, H: number, r: number): Float32Array {
	return sweep(sweep(src, W, H, r, true, false), W, H, r, false, false);
}

function dilate(src: Float32Array, W: number, H: number, r: number): Float32Array {
	return sweep(sweep(src, W, H, r, true, true), W, H, r, false, true);
}

/**
 * Min (or max) over a run of 2r + 1 pixels along rows or columns, in constant
 * time per pixel (van Herk / Gil–Werman): prefix and suffix extremes within
 * blocks of that length, and each window spans at most two blocks.
 */
function sweep(
	src: Float32Array,
	W: number,
	H: number,
	r: number,
	alongRows: boolean,
	max: boolean,
): Float32Array {
	const out = new Float32Array(W * H);
	const n = alongRows ? W : H;
	const lines = alongRows ? H : W;
	const step = alongRows ? 1 : W;
	const k = 2 * r + 1;
	const pad = Math.ceil((n + 2 * r) / k) * k;
	const edge = max ? -Infinity : Infinity;
	const line = new Float32Array(pad);
	const pre = new Float32Array(pad);
	const suf = new Float32Array(pad);
	for (let l = 0; l < lines; l++) {
		const base = alongRows ? l * W : l;
		line.fill(edge);
		for (let i = 0; i < n; i++) line[i + r] = src[base + i * step]!;
		for (let b = 0; b < pad; b += k) {
			pre[b] = line[b]!;
			for (let i = b + 1; i < b + k; i++) {
				const a = pre[i - 1]!;
				const v = line[i]!;
				pre[i] = max ? (a > v ? a : v) : a < v ? a : v;
			}
			suf[b + k - 1] = line[b + k - 1]!;
			for (let i = b + k - 2; i >= b; i--) {
				const a = suf[i + 1]!;
				const v = line[i]!;
				suf[i] = max ? (a > v ? a : v) : a < v ? a : v;
			}
		}
		// Pixel i's window is padded [i, i + 2r]: the tail of one block and
		// the head of the next.
		for (let i = 0; i < n; i++) {
			const a = suf[i]!;
			const b = pre[i + k - 1]!;
			out[base + i * step] = max ? (a > b ? a : b) : a < b ? a : b;
		}
	}
	return out;
}

function percentile(values: Float32Array, q: number): number {
	const bins = new Uint32Array(256);
	for (const v of values) bins[Math.min(255, Math.max(0, Math.round(v * 255)))]!++;
	let seen = 0;
	const target = q * values.length;
	for (let b = 0; b < 256; b++) {
		seen += bins[b]!;
		if (seen >= target) return b / 255;
	}
	return 1;
}
