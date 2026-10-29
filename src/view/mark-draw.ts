import type { FrameMark } from '../media/marks';

/**
 * Draws one frame mark as SVG, in the picture's own pixels.
 *
 * Pixels rather than a 0–1 viewBox: under a stretched viewBox an arrowhead,
 * a circle and a line of text would all be squashed to the picture's shape.
 * The layer redraws on every resize instead, which is cheap.
 */

export interface PictureSize {
	w: number;
	h: number;
}

type Pt = [number, number];

/** Stroke width: 3 px on a small viewer, up to 6 on a large one. */
function strokeWidth(size: PictureSize): number {
	return Math.round(Math.min(6, Math.max(3, size.h / 200)) * 2) / 2;
}
/** Invisible stroke laid over each mark, so a thin line is easy to click. */
const HIT_STROKE = 16;

export function toPixels(mark: FrameMark, size: PictureSize): Pt[] {
	return mark.points.map(([x, y]) => [x * size.w, y * size.h]);
}

/** Text height: readable on a small viewer, not huge on a large one. */
export function textSize(size: PictureSize): number {
	return Math.round(Math.min(40, Math.max(14, size.h * 0.034)));
}

/**
 * Adds `mark` to `parent` as a group tagged with its id.
 *
 * Every shape gets a wide transparent twin (`cine-mark-hit`) that takes the
 * clicks; for a circle or box that is the outline only, so the inside stays
 * free to draw in.
 */
export function drawMark(
	parent: SVGElement,
	mark: FrameMark,
	size: PictureSize,
): SVGGElement {
	const g = parent.createSvg('g', {
		cls: 'cine-mark',
		attr: { 'data-id': mark.id },
	});
	const pts = toPixels(mark, size);
	const color = mark.color;
	const width = strokeWidth(size);

	const stroke = (el: SVGElement): SVGElement => {
		el.setAttr('fill', 'none');
		el.setAttr('stroke', color);
		el.setAttr('stroke-width', String(width));
		el.setAttr('stroke-linecap', 'round');
		el.setAttr('stroke-linejoin', 'round');
		return el;
	};
	const hit = (tag: 'path' | 'ellipse' | 'rect', attr: Record<string, string>) =>
		g.createSvg(tag, {
			cls: 'cine-mark-hit',
			attr: { ...attr, 'stroke-width': String(HIT_STROKE) },
		});

	switch (mark.shape) {
		case 'arrow': {
			const [a, b] = pts as [Pt, Pt];
			const { shaft, head } = arrowPaths(a, b, width);
			stroke(g.createSvg('path', { attr: { d: shaft } }));
			g.createSvg('path', {
				attr: { d: head, fill: color, stroke: color, 'stroke-width': '1', 'stroke-linejoin': 'round' },
			});
			hit('path', { d: `M${a[0]},${a[1]}L${b[0]},${b[1]}` });
			break;
		}
		case 'line': {
			const [a, b] = pts as [Pt, Pt];
			const d = `M${a[0]},${a[1]}L${b[0]},${b[1]}`;
			stroke(g.createSvg('path', { attr: { d } }));
			hit('path', { d });
			break;
		}
		case 'free': {
			const d = smoothPath(pts);
			stroke(g.createSvg('path', { attr: { d } }));
			hit('path', { d });
			break;
		}
		case 'circle': {
			const [a, b] = pts as [Pt, Pt];
			const attr = {
				cx: String((a[0] + b[0]) / 2),
				cy: String((a[1] + b[1]) / 2),
				rx: String(Math.abs(b[0] - a[0]) / 2),
				ry: String(Math.abs(b[1] - a[1]) / 2),
			};
			stroke(g.createSvg('ellipse', { attr }));
			hit('ellipse', attr);
			break;
		}
		case 'box': {
			const [a, b] = pts as [Pt, Pt];
			const attr = {
				x: String(Math.min(a[0], b[0])),
				y: String(Math.min(a[1], b[1])),
				width: String(Math.abs(b[0] - a[0])),
				height: String(Math.abs(b[1] - a[1])),
				rx: '3',
			};
			stroke(g.createSvg('rect', { attr }));
			hit('rect', attr);
			break;
		}
		case 'text': {
			const [a] = pts as [Pt];
			drawLabel(g, a, mark.text ?? '', color, textSize(size));
			break;
		}
	}
	return g;
}

/**
 * A label: the text on a pill of the mark's colour, its top-left corner at
 * `at`.
 *
 * The pill is sized from the text's measured box, so the group has to be in a
 * shown SVG when this runs; hidden, the pill falls back to an estimate.
 */
function drawLabel(
	g: SVGGElement,
	at: Pt,
	text: string,
	color: string,
	fontSize: number,
): void {
	const padX = Math.round(fontSize * 0.5);
	const padY = Math.round(fontSize * 0.28);
	const pill = g.createSvg('rect', {
		cls: 'cine-mark-pill',
		attr: { fill: color, rx: String(Math.round(fontSize * 0.35)) },
	});
	const label = g.createSvg('text', {
		cls: 'cine-mark-text',
		attr: {
			x: String(at[0] + padX),
			y: String(at[1] + padY + fontSize * 0.8),
			'font-size': String(fontSize),
		},
	});
	label.textContent = text || ' ';
	let width = text.length * fontSize * 0.55;
	try {
		const box = label.getBBox();
		if (box.width > 0) width = box.width;
	} catch {
		// Not rendered (display: none): keep the estimate.
	}
	pill.setAttr('x', String(at[0]));
	pill.setAttr('y', String(at[1]));
	pill.setAttr('width', String(width + padX * 2));
	pill.setAttr('height', String(fontSize + padY * 2));
}

/**
 * An arrow's shaft and head.
 *
 * The head's back edge curves in towards the tip, like a drawn arrow rather
 * than a flat triangle, and the shaft stops inside the head so its round cap
 * never shows past the point.
 */
function arrowPaths(a: Pt, b: Pt, width: number): { shaft: string; head: string } {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length = Math.hypot(dx, dy) || 1;
	const ux = dx / length;
	const uy = dy / length;
	const headLength = Math.min(width * 7, Math.max(width * 4.5, length * 0.18), length * 0.6);
	const halfWidth = headLength * 0.55;
	const bx = b[0] - ux * headLength;
	const by = b[1] - uy * headLength;
	const left: Pt = [bx - uy * halfWidth, by + ux * halfWidth];
	const right: Pt = [bx + uy * halfWidth, by - ux * halfWidth];
	const notch: Pt = [bx + ux * headLength * 0.3, by + uy * headLength * 0.3];
	const shaftEnd: Pt = [bx + ux * headLength * 0.4, by + uy * headLength * 0.4];
	return {
		shaft: `M${a[0]},${a[1]}L${shaftEnd[0]},${shaftEnd[1]}`,
		head: `M${b[0]},${b[1]}L${left[0]},${left[1]}Q${notch[0]},${notch[1]} ${right[0]},${right[1]}Z`,
	};
}

/** A freehand stroke through its points' midpoints, so it reads as one curve. */
function smoothPath(pts: Pt[]): string {
	const first = pts[0];
	if (!first) return '';
	if (pts.length < 3)
		return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
	let d = `M${first[0]},${first[1]}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const [x, y] = pts[i]!;
		const [nx, ny] = pts[i + 1]!;
		d += `Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`;
	}
	const last = pts[pts.length - 1]!;
	return `${d}L${last[0]},${last[1]}`;
}

/**
 * Drops points closer than `tolerance` pixels to the line through their
 * neighbours (Ramer–Douglas–Peucker), so a stroke is stored in tens of points
 * rather than hundreds.
 */
export function simplify(pts: Pt[], tolerance: number): Pt[] {
	if (pts.length < 3) return pts;
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [lo, hi] = stack.pop()!;
		const [ax, ay] = pts[lo]!;
		const [bx, by] = pts[hi]!;
		const len = Math.hypot(bx - ax, by - ay);
		let worst = -1;
		let far = 0;
		for (let i = lo + 1; i < hi; i++) {
			const [px, py] = pts[i]!;
			const d =
				len === 0
					? Math.hypot(px - ax, py - ay)
					: Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
			if (d > far) {
				far = d;
				worst = i;
			}
		}
		if (worst >= 0 && far > tolerance) {
			keep[worst] = 1;
			stack.push([lo, worst], [worst, hi]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}
