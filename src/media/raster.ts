import { LINEAR, RgbaFrame } from './lighting';

/**
 * Pixel helpers shared by the zone and depth readings: reading a frame small,
 * finding its letterbox bars, and tracing areas and levels as smooth vector
 * lines for drawing.
 *
 * Pure: no DOM.
 */

export interface Small {
	/** Linear luminance. */
	luma: Float32Array;
	/** Linear RGB, interleaved. */
	rgb: Float32Array;
	/** Share of source pixels with a channel at 250 or over. */
	clip: Float32Array;
	/** Share of source pixels with luma under 2% as encoded. */
	crush: Float32Array;
}

export function downscale(frame: RgbaFrame, W: number, H: number): Small {
	const n = W * H;
	const out: Small = {
		luma: new Float32Array(n),
		rgb: new Float32Array(n * 3),
		clip: new Float32Array(n),
		crush: new Float32Array(n),
	};
	const { data, width, height } = frame;
	const sx = width / W;
	const sy = height / H;
	for (let y = 0; y < H; y++) {
		const y0 = Math.floor(y * sy);
		const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
		for (let x = 0; x < W; x++) {
			const x0 = Math.floor(x * sx);
			const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
			let r = 0;
			let g = 0;
			let b = 0;
			let clip = 0;
			let crush = 0;
			let count = 0;
			for (let fy = y0; fy < y1; fy++)
				for (let fx = x0; fx < x1; fx++) {
					const i = (fy * width + fx) * 4;
					const R = data[i]!;
					const G = data[i + 1]!;
					const B = data[i + 2]!;
					r += LINEAR[R]!;
					g += LINEAR[G]!;
					b += LINEAR[B]!;
					if (R >= 250 || G >= 250 || B >= 250) clip++;
					if (0.2126 * R + 0.7152 * G + 0.0722 * B < 5) crush++;
					count++;
				}
			const o = y * W + x;
			const c = Math.max(1, count);
			out.rgb[o * 3] = r / c;
			out.rgb[o * 3 + 1] = g / c;
			out.rgb[o * 3 + 2] = b / c;
			out.luma[o] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / c;
			out.clip[o] = clip / c;
			out.crush[o] = crush / c;
		}
	}
	return out;
}

/**
 * 1 for the picture, 0 for black bars along its edges: rows or columns, from
 * each edge inward, that are all but black and flat.
 */
export function pictureMask(luma: Float32Array, W: number, H: number): Uint8Array {
	const bar = (values: (k: number) => number, length: number) => {
		let sum = 0;
		let max = 0;
		for (let k = 0; k < length; k++) {
			const v = values(k);
			sum += v;
			if (v > max) max = v;
		}
		// About 3% and 10% as encoded.
		return sum / length < 0.0025 && max < 0.012;
	};
	const row = (y: number) => bar((x) => luma[y * W + x]!, W);
	const col = (x: number) => bar((y) => luma[y * W + x]!, H);
	let top = 0;
	while (top < H * 0.35 && row(top)) top++;
	let bottom = H;
	while (bottom > H * 0.65 && row(bottom - 1)) bottom--;
	let left = 0;
	while (left < W * 0.35 && col(left)) left++;
	let right = W;
	while (right > W * 0.65 && col(right - 1)) right--;
	const mask = new Uint8Array(W * H);
	for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) mask[y * W + x] = 1;
	return mask;
}

/** The pixel of the zone farthest from its edge (a chamfer distance). */
export function deepestPoint(labels: Uint8Array, id: number, W: number, H: number): { x: number; y: number } {
	const dist = new Float32Array(W * H);
	const BIG = 1e9;
	for (let i = 0; i < W * H; i++) dist[i] = labels[i] === id ? BIG : 0;
	const at = (x: number, y: number) =>
		x < 0 || y < 0 || x >= W || y >= H ? 0 : dist[y * W + x]!;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (!dist[i]) continue;
			dist[i] = Math.min(dist[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
		}
	let best = 0;
	let bx = 0;
	let by = 0;
	for (let y = H - 1; y >= 0; y--)
		for (let x = W - 1; x >= 0; x--) {
			const i = y * W + x;
			if (!dist[i]) continue;
			const d = Math.min(dist[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
			dist[i] = d;
			if (d > best) {
				best = d;
				bx = x;
				by = y;
			}
		}
	return { x: (bx + 0.5) / W, y: (by + 0.5) / H };
}

export type Ring = [number, number][];

/**
 * The outline of every pixel labelled `id`, as closed rings in work pixels.
 *
 * Marching squares on the mask softened by a small blur, so the rings follow
 * the edge smoothly instead of stepping pixel by pixel; then rounded further
 * (Chaikin) for drawing.
 */
export function trace(labels: Uint8Array, id: number, W: number, H: number): Ring[] {
	// Padded by one on each side, so every ring closes.
	const PW = W + 2;
	const PH = H + 2;
	let field: Float32Array = new Float32Array(PW * PH);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) field[(y + 1) * PW + x + 1] = labels[y * W + x] === id ? 1 : 0;
	field = boxBlur(field, PW, PH);
	return march(field, PW, PH, 0.5, W, H)
		.filter((ring) => ring.length >= 4 && Math.abs(area(ring)) >= 6)
		.map((ring) => chaikin(chaikin(ring)));
}

/**
 * Lines where `field` (W x H) crosses `level`, like the lines of a contour
 * map. Open where they run off the picture, so no line traces its border.
 */
export function contours(field: Float32Array, W: number, H: number, level: number): Ring[] {
	// Padded just under the level: every line closes along the border, where
	// it is then cut open.
	const PW = W + 2;
	const PH = H + 2;
	const padded = new Float32Array(PW * PH).fill(level - 1e-4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) padded[(y + 1) * PW + x + 1] = field[y * W + x]!;
	const lines: Ring[] = [];
	for (const ring of march(padded, PW, PH, level, W, H)) {
		for (const line of openAtBorder(ring, W, H)) {
			let length = 0;
			for (let i = 1; i < line.length; i++)
				length += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
			if (length >= 8) lines.push(chaikinOpen(chaikinOpen(line)));
		}
	}
	return lines;
}

/** Marching squares over a padded field, in unpadded work pixels. */
function march(field: Float32Array, PW: number, PH: number, level: number, W: number, H: number): Ring[] {
	// Corner values sit on pixel centres: corner (x, y) of the grid is padded
	// pixel (x, y), which is work pixel (x - 1, y - 1), centred at x - 0.5.
	const v = (x: number, y: number) => field[y * PW + x]!;
	const point = new Map<number, [number, number]>();
	const next = new Map<number, number>();
	const edgeKey = (x: number, y: number, vertical: boolean) => ((y * PW + x) << 1) | (vertical ? 1 : 0);
	const crossing = (x0: number, y0: number, x1: number, y1: number): [number, number] => {
		const a = v(x0, y0);
		const b = v(x1, y1);
		const t = a === b ? 0.5 : (level - a) / (b - a);
		return [x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5];
	};
	for (let y = 0; y < PH - 1; y++)
		for (let x = 0; x < PW - 1; x++) {
			const tl = v(x, y) > level ? 1 : 0;
			const tr = v(x + 1, y) > level ? 1 : 0;
			const br = v(x + 1, y + 1) > level ? 1 : 0;
			const bl = v(x, y + 1) > level ? 1 : 0;
			const kind = (tl << 3) | (tr << 2) | (br << 1) | bl;
			if (kind === 0 || kind === 15) continue;
			const top = edgeKey(x, y, false);
			const bottom = edgeKey(x, y + 1, false);
			const left = edgeKey(x, y, true);
			const right = edgeKey(x + 1, y, true);
			const at: Record<number, () => [number, number]> = {
				[top]: () => crossing(x, y, x + 1, y),
				[bottom]: () => crossing(x, y + 1, x + 1, y + 1),
				[left]: () => crossing(x, y, x, y + 1),
				[right]: () => crossing(x + 1, y, x + 1, y + 1),
			};
			const link = (from: number, to: number) => {
				if (!point.has(from)) point.set(from, at[from]!());
				if (!point.has(to)) point.set(to, at[to]!());
				next.set(from, to);
			};
			// Segments run with the inside on the right, so each edge point
			// has exactly one successor.
			const centre = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 > level;
			switch (kind) {
				case 1: link(left, bottom); break;
				case 2: link(bottom, right); break;
				case 3: link(left, right); break;
				case 4: link(right, top); break;
				case 5:
					if (centre) { link(left, top); link(right, bottom); }
					else { link(left, bottom); link(right, top); }
					break;
				case 6: link(bottom, top); break;
				case 7: link(left, top); break;
				case 8: link(top, left); break;
				case 9: link(top, bottom); break;
				case 10:
					if (centre) { link(top, right); link(bottom, left); }
					else { link(top, left); link(bottom, right); }
					break;
				case 11: link(top, right); break;
				case 12: link(right, left); break;
				case 13: link(right, bottom); break;
				case 14: link(bottom, left); break;
			}
		}

	const rings: Ring[] = [];
	const used = new Set<number>();
	for (const start of next.keys()) {
		if (used.has(start)) continue;
		const ring: Ring = [];
		let at: number | undefined = start;
		while (at !== undefined && !used.has(at)) {
			used.add(at);
			const p = point.get(at);
			if (p) ring.push([Math.min(W, Math.max(0, p[0])), Math.min(H, Math.max(0, p[1]))]);
			at = next.get(at);
		}
		if (ring.length >= 2) rings.push(ring);
	}
	return rings;
}

/**
 * Outline rings as lines to draw: the runs along the picture's border are
 * left out, so an area that reaches the edge is not boxed in.
 */
export function withoutBorder(rings: Ring[], W: number, H: number): Ring[] {
	return rings.flatMap((ring) => openAtBorder(ring, W, H, 1.2));
}

/** A closed ring cut into the runs that stay off the border. */
function openAtBorder(ring: Ring, W: number, H: number, EPS = 0.02): Ring[] {
	const onBorder = ([x, y]: [number, number]) =>
		x <= EPS || y <= EPS || x >= W - EPS || y >= H - EPS;
	const start = ring.findIndex(onBorder);
	if (start < 0) return [[...ring, ring[0]!]];
	const lines: Ring[] = [];
	let line: Ring = [];
	for (let k = 0; k <= ring.length; k++) {
		const p = ring[(start + k) % ring.length]!;
		if (onBorder(p)) {
			// A border point ends one run and starts the next.
			if (line.length) {
				line.push(p);
				if (line.length >= 3) lines.push(line);
			}
			line = [p];
		} else {
			line.push(p);
		}
	}
	return lines;
}

/** Chaikin on an open line: the two ends stay put. */
function chaikinOpen(line: Ring): Ring {
	if (line.length < 3) return line;
	const out: Ring = [line[0]!];
	for (let i = 0; i + 1 < line.length; i++) {
		const [x0, y0] = line[i]!;
		const [x1, y1] = line[i + 1]!;
		if (i > 0) out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
		if (i + 2 < line.length) out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
	}
	out.push(line[line.length - 1]!);
	return out;
}

export function boxBlur(src: Float32Array, W: number, H: number): Float32Array<ArrayBuffer> {
	const out = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			let s = 0;
			let c = 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					s += src[yy * W + xx]!;
					c++;
				}
			out[y * W + x] = s / c;
		}
	return out;
}

function area(ring: [number, number][]): number {
	let a = 0;
	for (let i = 0; i < ring.length; i++) {
		const [x0, y0] = ring[i]!;
		const [x1, y1] = ring[(i + 1) % ring.length]!;
		a += x0 * y1 - x1 * y0;
	}
	return a / 2;
}

/** One round of corner cutting on a closed ring. */
export function chaikin(ring: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < ring.length; i++) {
		const [x0, y0] = ring[i]!;
		const [x1, y1] = ring[(i + 1) % ring.length]!;
		out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1]);
		out.push([0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
	}
	return out;
}

/** Rings as one SVG path, for an even-odd fill. */
export function ringsPath(rings: Ring[]): string {
	return rings
		.map((ring) => ring.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('') + 'Z')
		.join('');
}

/** Open lines as one SVG path, for a stroke. */
export function linesPath(lines: Ring[]): string {
	return lines
		.map((line) => line.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(''))
		.join('');
}
