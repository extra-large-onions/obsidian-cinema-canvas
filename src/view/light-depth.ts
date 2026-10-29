import { DepthMap, DepthPlane, depthAt } from '../media/depth';
import { linesPath, ringsPath } from '../media/raster';

let filterIds = 0;

/** The mist's colour, and the black-level line's in the chart. */
const MIST: [number, number, number] = [110, 170, 255];
export const MIST_CSS = `rgb(${MIST.join(', ')})`;

/**
 * Depth drawn over the picture, like a contour map laid on the scene: fine
 * lines of equal depth that grow fainter toward the back, a mist over the
 * planes where the blacks lift with distance, and — while one is pointed
 * at — everything but that plane dimmed.
 *
 * Drawn over the part of the frame the model read, which leaves out any
 * letterbox bars.
 */
export class DepthLayer {
	private readonly box: HTMLElement;
	private readonly mist: HTMLCanvasElement;
	private readonly svg: SVGSVGElement;
	private readonly chips: HTMLElement;
	private map: DepthMap | null = null;
	private hovered: number | null = null;
	private readonly filterId = `cine-depth-feather-${++filterIds}`;

	constructor(
		parent: HTMLElement,
		private readonly onHover: (id: number | null) => void,
	) {
		this.box = parent.createDiv({ cls: 'cine-depth' });
		this.mist = this.box.createEl('canvas', { cls: 'cine-depth-mist' });
		this.svg = this.box.createSvg('svg', {
			cls: 'cine-depth-lines',
			attr: { preserveAspectRatio: 'none' },
		});
		this.chips = this.box.createDiv({ cls: 'cine-depth-chips' });
	}

	setMap(map: DepthMap | null): void {
		this.map = map;
		if (this.hovered !== null && !map?.planes.some((p) => p.id === this.hovered)) this.hovered = null;
		this.paintMist();
		this.render();
	}

	setVisible(on: boolean): void {
		this.box.toggle(on);
	}

	setHovered(id: number | null): void {
		if (id === this.hovered) return;
		this.hovered = id;
		this.render();
	}

	get hoveredPlane(): DepthPlane | null {
		return this.map?.planes.find((p) => p.id === this.hovered) ?? null;
	}

	/** The plane and depth (0 near, 1 far) under a point of the frame. */
	at(fx: number, fy: number): { depth: number; plane: DepthPlane | null } | null {
		return this.map ? depthAt(this.map, fx, fy) : null;
	}

	destroy(): void {
		this.box.remove();
	}

	/**
	 * Where the haze is, as a blue tint: its own colour would be grey on grey
	 * and only add fog to fog. Blurred by CSS.
	 */
	private paintMist(): void {
		const map = this.map;
		const canvas = this.mist;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		if (!map || !map.mist.some((v) => v > 0)) {
			canvas.width = 1;
			canvas.height = 1;
			ctx.clearRect(0, 0, 1, 1);
			return;
		}
		canvas.width = map.width;
		canvas.height = map.height;
		const image = ctx.createImageData(map.width, map.height);
		const [r, g, b] = MIST;
		for (let i = 0; i < map.mist.length; i++) {
			// Eased, so the mist gathers in the distance rather than
			// lying evenly over the middle ground.
			const m = map.mist[i]!;
			image.data[i * 4] = r;
			image.data[i * 4 + 1] = g;
			image.data[i * 4 + 2] = b;
			image.data[i * 4 + 3] = Math.round(255 * 0.42 * m * m * (3 - 2 * m));
		}
		ctx.putImageData(image, 0, 0);
	}

	private render(): void {
		this.svg.empty();
		this.chips.empty();
		const map = this.map;
		if (!map) return;
		const style = this.box.style;
		style.left = `${map.crop.x * 100}%`;
		style.top = `${map.crop.y * 100}%`;
		style.width = `${map.crop.w * 100}%`;
		style.height = `${map.crop.h * 100}%`;
		const { width: W, height: H } = map;
		this.svg.setAttr('viewBox', `0 0 ${W} ${H}`);

		const defs = this.svg.createSvg('defs');
		const filter = defs.createSvg('filter', {
			attr: { id: this.filterId, x: '-10%', y: '-10%', width: '120%', height: '120%' },
		});
		filter.createSvg('feGaussianBlur', { attr: { stdDeviation: '1.6' } });

		const hovered = this.hoveredPlane;
		if (hovered)
			this.svg.createSvg('path', {
				cls: 'cine-depth-veil',
				attr: {
					d: `M-2,-2H${W + 2}V${H + 2}H-2Z${ringsPath(hovered.rings)}`,
					'fill-rule': 'evenodd',
					filter: `url(#${this.filterId})`,
				},
			});

		// Nearer lines heavier and brighter, farther ones finer and fainter:
		// the lines recede the way the scene does.
		for (const { level, lines } of map.contours) {
			if (!lines.length) continue;
			const path = this.svg.createSvg('path', {
				cls: 'cine-depth-contour',
				attr: { d: linesPath(lines) },
			});
			path.style.setProperty('--depth-opacity', (0.75 - 0.5 * level).toFixed(2));
			path.style.setProperty('--depth-width', `${(1.5 - 0.8 * level).toFixed(2)}px`);
		}

		// Where one plane stands in front of another: drawn once, firmly.
		for (const plane of map.planes) {
			if (hovered && plane !== hovered) continue;
			this.svg.createSvg('path', {
				cls: 'cine-depth-shadow',
				attr: { d: linesPath(plane.edges) },
			});
			const outline = this.svg.createSvg('path', {
				cls: 'cine-depth-outline',
				attr: { d: linesPath(plane.edges) },
			});
			outline.toggleClass('is-hovered', plane === hovered);
		}

		for (const plane of map.planes) {
			if (plane.share < 0.03 && plane !== hovered) continue;
			const chip = this.chips.createDiv({ cls: 'cine-zone-chip cine-depth-chip' });
			chip.toggleClass('is-hovered', plane === hovered);
			chip.toggleClass('is-faded', hovered !== null && plane !== hovered);
			chip.style.left = `${plane.anchor.x * 100}%`;
			chip.style.top = `${plane.anchor.y * 100}%`;
			chip.createSpan({ cls: 'cine-zone-name', text: plane.name });
			chip.createSpan({ cls: 'cine-zone-stops', text: `${plane.contrast.toFixed(1)} st` });
			chip.addEventListener('pointerenter', () => this.onHover(plane.id));
			chip.addEventListener('pointerleave', () => this.onHover(null));
		}
	}
}

/**
 * Contrast front to back as bars, with the black level as a line over them
 * in the haze's colour: where the line climbs as the bars shrink, the air is
 * showing.
 */
export function depthChart(parent: HTMLElement, map: DepthMap): void {
	const W = 246;
	const H = 58;
	const PAD = 4;
	const svg = parent.createSvg('svg', {
		cls: 'cine-depth-chart',
		attr: { viewBox: `0 0 ${W} ${H + 14}`, width: String(W), height: String(H + 14) },
	});
	const maxStops = Math.max(6, ...map.bins.map((b) => b.contrast));
	const maxBlack = Math.max(0.15, ...map.bins.map((b) => b.black));
	const slot = (W - 2 * PAD) / 10;
	const x = (depth: number) => PAD + depth * (W - 2 * PAD);
	for (const bin of map.bins) {
		const h = Math.max(1, (bin.contrast / maxStops) * (H - PAD));
		svg.createSvg('rect', {
			cls: 'cine-depth-bar',
			attr: {
				x: (x(bin.depth) - slot / 2 + 1.5).toFixed(1),
				y: (H - h).toFixed(1),
				width: (slot - 3).toFixed(1),
				height: h.toFixed(1),
				rx: '1.5',
			},
		});
	}
	const points = map.bins.map(
		(b) => `${x(b.depth).toFixed(1)},${(H - (b.black / maxBlack) * (H - PAD)).toFixed(1)}`,
	);
	if (points.length > 1) {
		const line = svg.createSvg('polyline', {
			cls: 'cine-depth-black',
			attr: { points: points.join(' ') },
		});
		line.style.stroke = MIST_CSS;
	}
	svg.createSvg('line', {
		cls: 'cine-depth-axis',
		attr: { x1: String(PAD), y1: String(H + 0.5), x2: String(W - PAD), y2: String(H + 0.5) },
	});
	const label = (text: string, at: number, anchor: string) => {
		const t = svg.createSvg('text', {
			cls: 'cine-depth-tick',
			attr: { x: String(at), y: String(H + 12), 'text-anchor': anchor },
		});
		t.textContent = text;
	};
	label('near', PAD, 'start');
	label('far', W - PAD, 'end');
}
