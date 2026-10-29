import { RgbaFrame } from './lighting';
import {
	Ring,
	boxBlur,
	contours,
	deepestPoint,
	downscale,
	pictureMask,
	trace,
	withoutBorder,
} from './raster';

/**
 * Depth and haze: the frame split into near, middle and far planes by a depth
 * model, and how contrast and the black level change from front to back.
 *
 * Air between the lens and a far wall scatters light into the picture: the
 * far plane's shadows lift toward the colour of that light and its contrast
 * falls. So the reading compares the planes' darkest tones and tonal range.
 * A lift the same near and far is the grade, or haze through the whole room,
 * not distance.
 *
 * Depth Anything V2 gives relative inverse depth: which things are nearer,
 * not in metres. Every number here is about the order of the planes, never
 * their distance.
 *
 * Pure: no DOM, no model.
 */

/** The model's patch size: both sides of its input are a multiple of it. */
const PATCH = 14;
/** Short side of the model's input, as it was trained. */
const INPUT_SHORT = 518;
/** Longest side, so a scope frame stays near three seconds on the CPU. */
const INPUT_LONG = 1246;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

const WORK_WIDTH = 320;
/** Contour lines at these fractions of the way from nearest to farthest. */
const CONTOUR_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
/**
 * Depth change per work pixel past which a slope is a cliff: the edge of
 * something in front of something else. Contour lines stack up there into a
 * halo, so they stop, and the plane outlines draw that edge once.
 */
const CLIFF = 0.035;
/** Strips of depth for the front-to-back chart. */
const BINS = 10;
/** Planes whose depths are closer than this (0 near, 1 far) are one plane. */
const SAME_PLANE = 0.2;
/** A black level this much higher (as encoded) counts as lifted. */
const LIFT = 0.035;
/**
 * Air scatters light of every colour, so real haze is near grey, or tinted
 * by the light in it. A strongly coloured "veil" is a flat, bright surface,
 * such as a red wall, that has no dark tones to lose.
 */
const HAZE_SATURATION = 0.4;
const FLOOR = 1 / 4096;

export type PlaneName = 'Near' | 'Middle' | 'Far';

export interface DepthPlane {
	/** Index into `DepthMap.planes`, also the value in `DepthMap.labels`. */
	id: number;
	name: PlaneName;
	/** Mean depth, 0 nearest to 1 farthest. */
	depth: number;
	share: number;
	/** Tonal range, the 10th to the 90th percentile, in stops. */
	contrast: number;
	/** Darkest tones (3rd percentile of the lowest channel), 0–1 as encoded. */
	black: number;
	/** Colour of its darkest tones, as CSS: the colour of any haze. */
	veil: string;
	/** How pure that colour is, 0 grey to 1 a single primary. */
	veilSaturation: number;
	anchor: { x: number; y: number };
	/** Outline rings in work pixels, for the veil (draw even-odd). */
	rings: Ring[];
	/** The outline without its runs along the picture's border, for drawing. */
	edges: Ring[];
}

/** One strip of depth, for the front-to-back chart. */
export interface DepthBin {
	/** Middle of the strip, 0 near to 1 far. */
	depth: number;
	share: number;
	contrast: number;
	black: number;
	veil: string;
	veilSaturation: number;
}

/**
 * - haze: the far plane's blacks lift and its contrast falls
 * - lifted: its blacks lift, its contrast holds
 * - surface: its blacks lift, but toward a strong colour: a bright wall, not air
 * - even: blacks lifted near and far alike
 * - clear: blacks hold to the back
 */
export type Atmosphere = 'haze' | 'lifted' | 'surface' | 'even' | 'clear';

export interface DepthMap {
	/** The part of the frame read, without letterbox bars, as fractions. */
	crop: { x: number; y: number; w: number; h: number };
	/** Work grid over the crop. */
	width: number;
	height: number;
	/** Depth per work pixel, 0 nearest to 1 farthest. */
	depth: Float32Array;
	/** Plane id per work pixel. */
	labels: Uint8Array;
	planes: DepthPlane[];
	bins: DepthBin[];
	contours: { level: number; lines: Ring[] }[];
	atmosphere: Atmosphere;
	/** Far plane's black level over the near plane's, as encoded. */
	lift: number;
	/** Stops of contrast the far plane loses against the near one. */
	drop: number;
	/** How strong the mist is per work pixel, 0–1: where blacks lift with depth. */
	mist: Float32Array;
	/** The haze's own colour, at full brightness: the far plane's darkest tones. */
	hazeColor: string;
}

// --- the model's side -----------------------------------------------------------

/** The picture inside any letterbox bars, in frame pixels. */
export function pictureBox(frame: RgbaFrame): { x: number; y: number; w: number; h: number } {
	const scale = Math.min(1, WORK_WIDTH / frame.width);
	const W = Math.max(2, Math.round(frame.width * scale));
	const H = Math.max(2, Math.round(frame.height * scale));
	const mask = pictureMask(downscale(frame, W, H).luma, W, H);
	let x0 = W;
	let y0 = H;
	let x1 = 0;
	let y1 = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			if (!mask[y * W + x]) continue;
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x + 1);
			y1 = Math.max(y1, y + 1);
		}
	if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: frame.width, h: frame.height };
	// One work pixel in from any bar, so its soft edge is not read as picture.
	const sx = frame.width / W;
	const sy = frame.height / H;
	const inset = (edge: number, at: number, bar: boolean) => (bar ? edge + at : edge);
	const left = Math.round(inset(x0, 1, x0 > 0) * sx);
	const top = Math.round(inset(y0, 1, y0 > 0) * sy);
	const right = Math.round(inset(x1, -1, x1 < W) * sx);
	const bottom = Math.round(inset(y1, -1, y1 < H) * sy);
	return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
}

/** The model's input size for a picture: short side 518, both multiples of 14. */
export function depthInputSize(w: number, h: number): { width: number; height: number } {
	let k = INPUT_SHORT / Math.min(w, h);
	if (Math.max(w, h) * k > INPUT_LONG) k = INPUT_LONG / Math.max(w, h);
	const snap = (v: number) => Math.max(PATCH, Math.round((v * k) / PATCH) * PATCH);
	return { width: snap(w), height: snap(h) };
}

/** RGBA pixels as the planar, ImageNet-normalized floats the model takes. */
export function depthInput(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
	const plane = width * height;
	const out = new Float32Array(3 * plane);
	for (let p = 0; p < plane; p++)
		for (let c = 0; c < 3; c++)
			out[c * plane + p] = ((rgba[p * 4 + c] ?? 0) / 255 - MEAN[c]!) / STD[c]!;
	return out;
}

// --- reading ------------------------------------------------------------------

/**
 * Reads depth and haze from the model's output.
 *
 * @param frame the analysed frame, whole
 * @param box the part of it the model saw, in frame pixels (see `pictureBox`)
 * @param disparity the model's output over that part, `dw` x `dh`; larger is nearer
 */
export function readDepth(
	frame: RgbaFrame,
	box: { x: number; y: number; w: number; h: number },
	disparity: Float32Array,
	dw: number,
	dh: number,
): DepthMap {
	const scale = Math.min(1, WORK_WIDTH / box.w);
	const W = Math.max(2, Math.round(box.w * scale));
	const H = Math.max(2, Math.round(box.h * scale));
	const n = W * H;
	const small = downscale(cropFrame(frame, box), W, H);

	// Depth from 0 nearest to 1 farthest, the extremes trimmed so one stray
	// pixel does not squash the rest.
	const raw = resample(disparity, dw, dh, W, H);
	const sorted = Float32Array.from(raw).sort();
	const lo = sorted[Math.floor(0.02 * (n - 1))]!;
	const hi = sorted[Math.floor(0.98 * (n - 1))]!;
	const span = Math.max(hi - lo, 1e-6);
	const depth = new Float32Array(n);
	for (let i = 0; i < n; i++) depth[i] = Math.min(1, Math.max(0, (hi - raw[i]!) / span));

	// Per pixel: stops, and the lowest channel as encoded (dark channel).
	const stops = new Float32Array(n);
	const low = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		stops[i] = Math.log2(Math.max(small.luma[i]!, FLOOR));
		low[i] = encode(Math.min(small.rgb[i * 3]!, small.rgb[i * 3 + 1]!, small.rgb[i * 3 + 2]!));
	}

	const labels = planeLabels(depth, W, H);
	const planeCount = Math.max(...labels) + 1;
	const names: PlaneName[] =
		planeCount >= 3 ? ['Near', 'Middle', 'Far'] : planeCount === 2 ? ['Near', 'Far'] : ['Near'];
	const planes: DepthPlane[] = [];
	for (let id = 0; id < planeCount; id++) {
		const pick: number[] = [];
		for (let i = 0; i < n; i++) if (labels[i] === id) pick.push(i);
		if (pick.length === 0) continue;
		const tones = toneOf(pick, stops, low, small.rgb);
		const rings = trace(labels, id, W, H);
		planes.push({
			id,
			name: names[id] ?? 'Far',
			depth: pick.reduce((a, i) => a + depth[i]!, 0) / pick.length,
			share: pick.length / n,
			...tones,
			anchor: deepestPoint(labels, id, W, H),
			rings,
			edges: withoutBorder(rings, W, H),
		});
	}

	const bins: DepthBin[] = [];
	for (let b = 0; b < BINS; b++) {
		const pick: number[] = [];
		for (let i = 0; i < n; i++) if (Math.min(BINS - 1, Math.floor(depth[i]! * BINS)) === b) pick.push(i);
		if (pick.length < n * 0.005) continue;
		bins.push({ depth: (b + 0.5) / BINS, share: pick.length / n, ...toneOf(pick, stops, low, small.rgb) });
	}

	const near = planes[0];
	const far = planes[planes.length - 1];
	const lift = near && far && far !== near ? far.black - near.black : 0;
	const drop = near && far && far !== near ? near.contrast - far.contrast : 0;
	const neutral = (far?.veilSaturation ?? 1) < HAZE_SATURATION;
	const atmosphere: Atmosphere =
		!neutral && lift >= LIFT
			? 'surface'
			: lift >= LIFT && drop >= 0.8
			? 'haze'
			: lift >= LIFT
				? 'lifted'
				: (near?.black ?? 0) >= 0.08
					? 'even'
					: 'clear';

	// The mist follows the black level's rise along depth: none where the
	// blacks sit at the near plane's, full where they have lifted most.
	const mist = new Float32Array(n);
	if (atmosphere === 'haze' || atmosphere === 'lifted') {
		const base = near?.black ?? 0;
		const top = Math.max(...bins.map((b) => b.black)) - base;
		const curve = (t: number) => {
			const at = t * BINS - 0.5;
			let a = bins[0]!;
			let z = bins[bins.length - 1]!;
			for (const b of bins) {
				if (b.depth * BINS - 0.5 <= at) a = b;
				if (b.depth * BINS - 0.5 >= at) {
					z = b;
					break;
				}
			}
			const da = a.depth * BINS - 0.5;
			const dz = z.depth * BINS - 0.5;
			const f = dz > da ? (at - da) / (dz - da) : 0;
			return a.black + (z.black - a.black) * Math.min(1, Math.max(0, f));
		};
		for (let i = 0; i < n; i++)
			mist[i] = Math.min(1, Math.max(0, (curve(depth[i]!) - base) / Math.max(top, LIFT)));
	}

	const soft = boxBlur(boxBlur(depth, W, H), W, H);
	return {
		crop: {
			x: box.x / frame.width,
			y: box.y / frame.height,
			w: box.w / frame.width,
			h: box.h / frame.height,
		},
		width: W,
		height: H,
		depth,
		labels,
		planes,
		bins,
		contours: CONTOUR_LEVELS.map((level) => ({
			level,
			lines: offCliffs(contours(soft, W, H, level), slope(soft, W, H), W, H),
		})),
		atmosphere,
		lift,
		drop,
		mist,
		hazeColor: far?.veil ?? 'rgb(170, 200, 255)',
	};
}

/** Where a point of the frame (fractions) falls in the map, or null outside it. */
export function depthAt(map: DepthMap, fx: number, fy: number): { depth: number; plane: DepthPlane | null } | null {
	const { crop, width: W, height: H } = map;
	const lx = (fx - crop.x) / crop.w;
	const ly = (fy - crop.y) / crop.h;
	if (lx < 0 || ly < 0 || lx >= 1 || ly >= 1) return null;
	const i = Math.floor(ly * H) * W + Math.floor(lx * W);
	return { depth: map.depth[i] ?? 0, plane: map.planes.find((p) => p.id === map.labels[i]) ?? null };
}

/**
 * Near, middle and far: depths grouped (k-means, three at most), groups
 * closer than `SAME_PLANE` joined, and then a majority filter so a plane's
 * edge follows the objects instead of speckling. Ids run near to far.
 */
function planeLabels(depth: Float32Array, W: number, H: number): Uint8Array {
	const n = W * H;
	let centres = [1 / 6, 1 / 2, 5 / 6];
	for (let round = 0; round < 12; round++) {
		const sum = centres.map(() => 0);
		const count = centres.map(() => 0);
		for (let i = 0; i < n; i++) {
			const k = nearest(centres, depth[i]!);
			sum[k]! += depth[i]!;
			count[k]!++;
		}
		centres = centres.map((c, k) => (count[k] ? sum[k]! / count[k] : c));
	}
	centres.sort((a, b) => a - b);
	// Join the two closest while any pair is too close to tell apart.
	for (;;) {
		let at = -1;
		let gap = Infinity;
		for (let k = 0; k + 1 < centres.length; k++) {
			const d = centres[k + 1]! - centres[k]!;
			if (d < gap) {
				gap = d;
				at = k;
			}
		}
		if (at < 0 || gap >= SAME_PLANE) break;
		centres.splice(at, 2, (centres[at]! + centres[at + 1]!) / 2);
	}
	let labels: Uint8Array = new Uint8Array(n);
	for (let i = 0; i < n; i++) labels[i] = nearest(centres, depth[i]!);
	for (let pass = 0; pass < 2; pass++) labels = majority(labels, W, H, centres.length, 3);
	// A plane the filter swallowed would leave a gap in the ids.
	const used = [...new Set(labels)].sort((a, b) => a - b);
	const remap = new Map(used.map((id, k) => [id, k]));
	for (let i = 0; i < n; i++) labels[i] = remap.get(labels[i]!) ?? 0;
	return labels;
}

function nearest(centres: number[], v: number): number {
	let best = 0;
	for (let k = 1; k < centres.length; k++)
		if (Math.abs(v - centres[k]!) < Math.abs(v - centres[best]!)) best = k;
	return best;
}

/** Each pixel takes the most common label within `radius`. */
function majority(labels: Uint8Array, W: number, H: number, count: number, radius: number): Uint8Array {
	const out = new Uint8Array(W * H);
	const votes = new Uint16Array(count);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			votes.fill(0);
			for (let dy = -radius; dy <= radius; dy++)
				for (let dx = -radius; dx <= radius; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					votes[labels[yy * W + xx]!]!++;
				}
			let best = labels[y * W + x]!;
			for (let k = 0; k < count; k++) if (votes[k]! > votes[best]!) best = k;
			out[y * W + x] = best;
		}
	return out;
}

/** Tonal range, black level and the colour of the darkest tones of some pixels. */
function toneOf(
	pick: number[],
	stops: Float32Array,
	low: Float32Array,
	rgb: Float32Array,
): { contrast: number; black: number; veil: string; veilSaturation: number } {
	const s = pick.map((i) => stops[i]!).sort((a, b) => a - b);
	const l = pick.map((i) => low[i]!).sort((a, b) => a - b);
	const at = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))] ?? 0;
	const black = at(l, 0.03);
	// The colour of the darkest tenth: in haze, the colour of the air's light.
	const cut = at(l, 0.1);
	let r = 0;
	let g = 0;
	let b = 0;
	for (const i of pick) {
		if (low[i]! > cut) continue;
		r += rgb[i * 3]!;
		g += rgb[i * 3 + 1]!;
		b += rgb[i * 3 + 2]!;
	}
	const top = Math.max(r, g, b, 1e-9);
	const veilSaturation = 1 - encode(Math.min(r, g, b) / top);
	return { contrast: at(s, 0.9) - at(s, 0.1), black, veil: fullColor(r, g, b), veilSaturation };
}

/** A linear colour at full brightness, so only its hue and tint show. */
function fullColor(r: number, g: number, b: number): string {
	const max = Math.max(r, g, b, 1e-9);
	const c = (v: number) => Math.round(encode(v / max) * 255);
	return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

function encode(v: number): number {
	const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
	return Math.min(1, Math.max(0, s));
}

/** How steeply depth changes at each work pixel (central differences). */
function slope(field: Float32Array, W: number, H: number): Float32Array {
	const out = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const at = (xx: number, yy: number) =>
				field[Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))]!;
			const gx = (at(x + 1, y) - at(x - 1, y)) / 2;
			const gy = (at(x, y + 1) - at(x, y - 1)) / 2;
			out[y * W + x] = Math.hypot(gx, gy);
		}
	return out;
}

/** Lines cut wherever they cross a cliff, keeping the runs on gentle ground. */
function offCliffs(lines: Ring[], steep: Float32Array, W: number, H: number): Ring[] {
	const out: Ring[] = [];
	for (const line of lines) {
		let run: Ring = [];
		const flush = () => {
			let length = 0;
			for (let i = 1; i < run.length; i++)
				length += Math.hypot(run[i]![0] - run[i - 1]![0], run[i]![1] - run[i - 1]![1]);
			if (run.length >= 2 && length >= 6) out.push(run);
			run = [];
		};
		for (const p of line) {
			const x = Math.min(W - 1, Math.max(0, Math.round(p[0])));
			const y = Math.min(H - 1, Math.max(0, Math.round(p[1])));
			if (steep[y * W + x]! > CLIFF) flush();
			else run.push(p);
		}
		flush();
	}
	return out;
}

/** A window of the frame as a frame of its own. */
function cropFrame(frame: RgbaFrame, box: { x: number; y: number; w: number; h: number }): RgbaFrame {
	const data = new Uint8ClampedArray(box.w * box.h * 4);
	for (let y = 0; y < box.h; y++) {
		const from = ((box.y + y) * frame.width + box.x) * 4;
		data.set(frame.data.subarray(from, from + box.w * 4), y * box.w * 4);
	}
	return { data, width: box.w, height: box.h };
}

/** Bilinear resize of a single-channel image. */
function resample(src: Float32Array, sw: number, sh: number, W: number, H: number): Float32Array {
	const out = new Float32Array(W * H);
	for (let y = 0; y < H; y++) {
		const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / H - 0.5));
		const y0 = Math.floor(fy);
		const y1 = Math.min(sh - 1, y0 + 1);
		const ty = fy - y0;
		for (let x = 0; x < W; x++) {
			const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / W - 0.5));
			const x0 = Math.floor(fx);
			const x1 = Math.min(sw - 1, x0 + 1);
			const tx = fx - x0;
			const top = src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx;
			const bottom = src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx;
			out[y * W + x] = top * (1 - ty) + bottom * ty;
		}
	}
	return out;
}
