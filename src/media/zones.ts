import { RgbaFrame } from './lighting';
import { Ring, Small, deepestPoint, downscale, pictureMask, trace } from './raster';

/**
 * Light zones: the frame split into a handful of areas that are lit alike,
 * each with a name, how bright it is and the colour of its light.
 *
 * 1. The frame is read small (`WORK_WIDTH` across) as log luminance, in stops.
 * 2. An edge-preserving blur (bilateral, in stops) smooths texture and grain
 *    away but keeps the step where a shadow falls or a lamp's pool ends.
 * 3. The levels are grouped (k-means in stops), the groups split into
 *    connected areas, and areas merged into their closest neighbour until
 *    every area is big enough and there are few of them.
 * 4. Each area's outline is traced (marching squares on a softened mask) and
 *    rounded, for drawing.
 *
 * Names come from the zone system: middle grey (18% linear) is zone V, and
 * each stop up or down is one zone. They describe the graded image, so a
 * night scene printed dark reads dark.
 *
 * Pure: no DOM.
 */

const WORK_WIDTH = 320;
/** Zones smaller than this share of the frame are merged away. */
const MIN_SHARE = 0.012;
const MAX_ZONES = 6;
/** Neighbouring areas closer than this, in stops, are one area. */
const SAME_LEVEL = 0.4;
/** Areas anywhere in frame closer than this, in stops, are one zone. */
const SAME_BAND = 0.6;
/** Label of letterbox and pillarbox bars: no zone. */
export const BARS = 255;
/** Floor for the log: 12 stops under white. */
const FLOOR = 1 / 4096;
const MIDDLE_GREY = 0.18;

export type ZoneName = 'Blown' | 'Hot' | 'Lit' | 'Mid' | 'Shade' | 'Shadow' | 'Crushed';

/**
 * One zone: every part of the frame lit to about the same level, wherever it
 * is. Its pieces need not touch; the pointer lights them all up together.
 */
export interface LightZone {
	/** Index into `ZoneMap.zones`, also the value in `ZoneMap.labels`. */
	id: number;
	name: ZoneName;
	/** Mean brightness in stops over the frame's median. */
	stops: number;
	/** Zone system number (0–10) of the mean: V is middle grey. */
	zone: number;
	/** Darkest and brightest tenth of the area, in stops over the median. */
	low: number;
	high: number;
	/** Share of the frame. */
	share: number;
	/** Share of the area at the top of the scale on any channel. */
	clipped: number;
	/** Share of the area within a hair of black. */
	crushed: number;
	/** The light's colour: the area's mean, at full brightness, as CSS. */
	color: string;
	/** Red over blue of the mean colour; 1 is neutral. */
	warmth: number;
	/** Where its label goes: the point deepest inside it, as fractions. */
	anchor: { x: number; y: number };
	/** Outline rings in work pixels; holes are rings too (draw even-odd). */
	rings: Ring[];
}

export interface ZoneMap {
	width: number;
	height: number;
	/** Zone id per work pixel; `BARS` on letterbox bars. */
	labels: Uint8Array;
	zones: LightZone[];
	/** The frame's median linear luminance, the 0 of every `stops`. */
	median: number;
}

export function findZones(frame: RgbaFrame): ZoneMap {
	const scale = Math.min(1, WORK_WIDTH / frame.width);
	const W = Math.max(2, Math.round(frame.width * scale));
	const H = Math.max(2, Math.round(frame.height * scale));
	const n = W * H;
	const small = downscale(frame, W, H);

	const level = new Float32Array(n);
	for (let i = 0; i < n; i++) level[i] = Math.log2(Math.max(small.luma[i]!, FLOOR));
	const smooth = bilateral(bilateral(level, W, H, 5, 3, 0.5), W, H, 5, 3, 0.5);

	// Letterbox bars are not part of the picture: no zone, and no say in
	// the median.
	const inside = pictureMask(small.luma, W, H);
	const insideLevels: number[] = [];
	for (let i = 0; i < n; i++) if (inside[i]) insideLevels.push(level[i]!);
	if (insideLevels.length === 0) return { width: W, height: H, labels: new Uint8Array(n).fill(BARS), zones: [], median: MIDDLE_GREY };
	insideLevels.sort((a, b) => a - b);
	const medianStops = insideLevels[insideLevels.length >> 1] ?? Math.log2(MIDDLE_GREY);

	const groups = kmeans(smooth, inside, 5);
	const regions = mergeRegions(smooth, groups, W, H);

	// Areas lit alike become one zone wherever they are: brightness bands,
	// built from the areas' true (unsmoothed) levels.
	const rawSum = new Map<number, number>();
	const rawCount = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		if (!inside[i]) continue;
		const r = regions.find(i);
		rawSum.set(r, (rawSum.get(r) ?? 0) + level[i]!);
		rawCount.set(r, (rawCount.get(r) ?? 0) + 1);
	}
	const bands = bandsOf(
		regions.ids.map((r) => ({ root: r, sum: rawSum.get(r) ?? 0, count: rawCount.get(r) ?? 0 })),
	);
	// Darkest first, so ids read low to high.
	const bandOf = new Map<number, number>();
	bands.forEach((band, id) => {
		for (const root of band) bandOf.set(root, id);
	});
	const labels = new Uint8Array(n);
	for (let i = 0; i < n; i++) labels[i] = inside[i] ? (bandOf.get(regions.find(i)) ?? 0) : BARS;

	const zones = bands.map((_, id) => describe(id, labels, small, level, W, H, medianStops));
	return { width: W, height: H, labels, zones, median: Math.pow(2, medianStops) };
}

/**
 * Areas grouped into brightness bands: sorted by level, the two neighbouring
 * bands closest in level joined until all are at least `SAME_BAND` apart and
 * there are no more than `MAX_ZONES`. Returns the roots in each band,
 * darkest band first.
 */
function bandsOf(areas: { root: number; sum: number; count: number }[]): number[][] {
	const bands = areas
		.filter((a) => a.count > 0)
		.map((a) => ({ roots: [a.root], sum: a.sum, count: a.count }))
		.sort((a, b) => a.sum / a.count - b.sum / b.count);
	const mean = (b: { sum: number; count: number }) => b.sum / b.count;
	while (bands.length > 1) {
		let at = -1;
		let gap = Infinity;
		for (let i = 0; i + 1 < bands.length; i++) {
			const d = mean(bands[i + 1]!) - mean(bands[i]!);
			if (d < gap) {
				gap = d;
				at = i;
			}
		}
		if (gap >= SAME_BAND && bands.length <= MAX_ZONES) break;
		const a = bands[at]!;
		const b = bands[at + 1]!;
		bands.splice(at, 2, { roots: [...a.roots, ...b.roots], sum: a.sum + b.sum, count: a.count + b.count });
	}
	return bands.map((b) => b.roots);
}

/** Zone system number of a linear luminance: middle grey is V. */
export function zoneNumber(luma: number): number {
	const z = Math.round(5 + Math.log2(Math.max(luma, FLOOR) / MIDDLE_GREY));
	return Math.min(10, Math.max(0, z));
}

const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export function romanZone(zone: number): string {
	return ROMAN[Math.min(10, Math.max(0, Math.round(zone)))] ?? '';
}

/**
 * Named by where the zone sits in this frame's own range, not on an absolute
 * scale: a night scene graded dark still has its lit parts and its shadows.
 */
function nameFor(stops: number, clipped: number, crushed: number): ZoneName {
	if (clipped > 0.3) return 'Blown';
	if (crushed > 0.5) return 'Crushed';
	if (stops >= 2.5) return 'Hot';
	if (stops >= 0.9) return 'Lit';
	if (stops > -0.9) return 'Mid';
	if (stops > -2.5) return 'Shade';
	return 'Shadow';
}

// --- reading ------------------------------------------------------------------

/**
 * Bilateral filter: each pixel becomes the mean of its neighbours, weighted
 * by distance and by how close their level is, so texture melts and steps in
 * the light stay.
 */
function bilateral(
	src: Float32Array,
	W: number,
	H: number,
	radius: number,
	sigmaSpace: number,
	sigmaRange: number,
): Float32Array {
	const out = new Float32Array(W * H);
	const spatial: number[] = [];
	for (let dy = -radius; dy <= radius; dy++)
		for (let dx = -radius; dx <= radius; dx++)
			spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaSpace * sigmaSpace)));
	const k = -1 / (2 * sigmaRange * sigmaRange);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const c = src[y * W + x]!;
			let sum = 0;
			let weight = 0;
			let s = 0;
			for (let dy = -radius; dy <= radius; dy++) {
				const yy = Math.min(H - 1, Math.max(0, y + dy));
				for (let dx = -radius; dx <= radius; dx++, s++) {
					const xx = Math.min(W - 1, Math.max(0, x + dx));
					const v = src[yy * W + xx]!;
					const d = v - c;
					const w = spatial[s]! * Math.exp(d * d * k);
					sum += v * w;
					weight += w;
				}
			}
			out[y * W + x] = sum / weight;
		}
	return out;
}

/** 1-D k-means on the picture's levels; each pixel's group, `BARS` outside. */
function kmeans(values: Float32Array, inside: Uint8Array, k: number): Uint8Array {
	const sorted = Float32Array.from(values.filter((_, i) => inside[i])).sort();
	const centers: number[] = [];
	for (let j = 0; j < k; j++)
		centers.push(sorted[Math.floor(((j + 0.5) / k) * (sorted.length - 1))] ?? 0);
	const group = new Uint8Array(values.length).fill(BARS);
	for (let iter = 0; iter < 12; iter++) {
		const sum = new Float64Array(k);
		const count = new Float64Array(k);
		for (let i = 0; i < values.length; i++) {
			if (!inside[i]) continue;
			const v = values[i]!;
			let best = 0;
			let bestD = Infinity;
			for (let j = 0; j < k; j++) {
				const d = Math.abs(v - centers[j]!);
				if (d < bestD) {
					bestD = d;
					best = j;
				}
			}
			group[i] = best;
			sum[best]! += v;
			count[best]! += 1;
		}
		for (let j = 0; j < k; j++) if (count[j]) centers[j] = sum[j]! / count[j]!;
	}
	return group;
}

interface Regions {
	/** Root of every area of the picture (bars excluded). */
	ids: number[];
	find: (pixel: number) => number;
}

/**
 * Connected areas of one group each, then merged: every area too small joins
 * the neighbour closest to it in level, then neighbours too alike join up.
 */
function mergeRegions(level: Float32Array, group: Uint8Array, W: number, H: number): Regions {
	const n = W * H;
	const parent = new Int32Array(n);
	for (let i = 0; i < n; i++) parent[i] = i;
	const find = (i: number): number => {
		let r = i;
		while (parent[r] !== r) r = parent[r]!;
		while (parent[i] !== r) {
			const next = parent[i]!;
			parent[i] = r;
			i = next;
		}
		return r;
	};
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (x + 1 < W && group[i] === group[i + 1]) parent[find(i + 1)] = find(i);
			if (y + 1 < H && group[i] === group[i + W]) parent[find(i + W)] = find(i);
		}
	const isBars = (r: number) => group[r] === BARS;

	const count = new Map<number, number>();
	const sum = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (isBars(r)) continue;
		count.set(r, (count.get(r) ?? 0) + 1);
		sum.set(r, (sum.get(r) ?? 0) + level[i]!);
	}
	// Shared border length between each pair of neighbouring areas.
	const border = new Map<number, Map<number, number>>();
	const touch = (a: number, b: number) => {
		if (a === b || isBars(a) || isBars(b)) return;
		for (const [p, q] of [
			[a, b],
			[b, a],
		] as const) {
			let m = border.get(p);
			if (!m) border.set(p, (m = new Map<number, number>()));
			m.set(q, (m.get(q) ?? 0) + 1);
		}
	};
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (x + 1 < W) touch(find(i), find(i + 1));
			if (y + 1 < H) touch(find(i), find(i + W));
		}

	const mean = (r: number) => (sum.get(r) ?? 0) / Math.max(1, count.get(r) ?? 1);
	const merge = (from: number, into: number) => {
		parent[from] = into;
		count.set(into, (count.get(into) ?? 0) + (count.get(from) ?? 0));
		sum.set(into, (sum.get(into) ?? 0) + (sum.get(from) ?? 0));
		count.delete(from);
		sum.delete(from);
		const intoBorder = border.get(into) ?? new Map<number, number>();
		border.set(into, intoBorder);
		for (const [other, length] of border.get(from) ?? []) {
			const otherBorder = border.get(other);
			otherBorder?.delete(from);
			if (other === into) continue;
			intoBorder.set(other, (intoBorder.get(other) ?? 0) + length);
			otherBorder?.set(into, (otherBorder.get(into) ?? 0) + length);
		}
		intoBorder.delete(from);
		border.delete(from);
	};
	const closestNeighbour = (r: number): number | null => {
		let best: number | null = null;
		let bestGap = Infinity;
		const m = mean(r);
		for (const other of (border.get(r) ?? new Map<number, number>()).keys()) {
			const gap = Math.abs(mean(other) - m);
			if (gap < bestGap) {
				bestGap = gap;
				best = other;
			}
		}
		return best;
	};

	// Small areas first, smallest first; an area that grows past the limit
	// by taking in others is left alone.
	const minCount = Math.max(4, MIN_SHARE * n);
	for (let changed = true; changed; ) {
		changed = false;
		const small = [...count.keys()]
			.filter((r) => (count.get(r) ?? 0) < minCount)
			.sort((a, b) => (count.get(a) ?? 0) - (count.get(b) ?? 0));
		for (const r of small) {
			if (!count.has(r) || (count.get(r) ?? 0) >= minCount) continue;
			const into = closestNeighbour(r);
			if (into === null) continue;
			merge(r, into);
			changed = true;
		}
	}
	// Then neighbours too alike, the most alike pair first.
	for (;;) {
		let from: number | null = null;
		let into: number | null = null;
		let bestGap = SAME_LEVEL;
		for (const [r, neighbours] of border)
			for (const other of neighbours.keys()) {
				const gap = Math.abs(mean(other) - mean(r));
				if (gap < bestGap) {
					bestGap = gap;
					const smaller = (count.get(r) ?? 0) < (count.get(other) ?? 0);
					from = smaller ? r : other;
					into = smaller ? other : r;
				}
			}
		if (from === null || into === null) break;
		merge(from, into);
	}
	for (let i = 0; i < n; i++) find(i);
	return { ids: [...count.keys()], find };
}

// --- describing ---------------------------------------------------------------

function describe(
	id: number,
	labels: Uint8Array,
	small: Small,
	level: Float32Array,
	W: number,
	H: number,
	medianStops: number,
): LightZone {
	const n = W * H;
	const levels: number[] = [];
	let r = 0;
	let g = 0;
	let b = 0;
	let clipped = 0;
	let crushed = 0;
	for (let i = 0; i < n; i++) {
		if (labels[i] !== id) continue;
		levels.push(level[i]!);
		r += small.rgb[i * 3]!;
		g += small.rgb[i * 3 + 1]!;
		b += small.rgb[i * 3 + 2]!;
		clipped += small.clip[i]!;
		crushed += small.crush[i]!;
	}
	const count = Math.max(1, levels.length);
	levels.sort((p, q) => p - q);
	// The mean in stops (a geometric mean), so a few bright pixels in a dark
	// zone do not pull its number up; the name and order follow the same.
	const meanStops = levels.reduce((a, v) => a + v, 0) / count;
	const zone = zoneNumber(Math.pow(2, meanStops));
	const clipShare = clipped / count;
	const crushShare = crushed / count;
	const at = (p: number) => (levels[Math.floor(p * (levels.length - 1))] ?? 0) - medianStops;
	return {
		id,
		name: nameFor(meanStops - medianStops, clipShare, crushShare),
		stops: meanStops - medianStops,
		zone,
		low: at(0.1),
		high: at(0.9),
		share: levels.length / n,
		clipped: clipShare,
		crushed: crushShare,
		color: lightColor(r, g, b),
		warmth: r / Math.max(b, 1e-6),
		anchor: deepestPoint(labels, id, W, H),
		rings: trace(labels, id, W, H),
	};
}

/** A mean linear colour shown at full brightness, so only its hue and tint read. */
function lightColor(r: number, g: number, b: number): string {
	const max = Math.max(r, g, b, 1e-6);
	const enc = (v: number) => {
		const c = v / max;
		const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, s)) * 255);
	};
	return `rgb(${enc(r)}, ${enc(g)}, ${enc(b)})`;
}
