import { getIcon, setIcon, setTooltip } from 'obsidian';
import { Rect } from '../types';

/**
 * Which way the triangle guide's long diagonal runs.
 *
 * `falling` goes top-left to bottom-right, `rising` bottom-left to top-right.
 */
export type TriangleGuide = 'off' | 'falling' | 'rising';

export interface GuideState {
	center: boolean;
	thirds: boolean;
	triangle: TriangleGuide;
	/** Width over height of the crop the mask leaves; 0 is no mask. */
	mask: number;
}

/** The mask button steps through these; 0 is off. */
export const MASK_RATIOS: readonly number[] = [
	0,
	2.39,
	1.85,
	16 / 9,
	4 / 3,
	1,
	9 / 16,
];

export function maskLabel(ratio: number): string {
	if (Math.abs(ratio - 16 / 9) < 0.001) return '16:9';
	if (Math.abs(ratio - 4 / 3) < 0.001) return '4:3';
	if (Math.abs(ratio - 9 / 16) < 0.001) return '9:16';
	if (ratio === 1) return '1:1';
	return `${ratio}:1`;
}

function nextMask(current: number): number {
	const at = MASK_RATIOS.findIndex((r) => Math.abs(r - current) < 0.001);
	return MASK_RATIOS[(at + 1) % MASK_RATIOS.length] ?? 0;
}

function nextTriangle(current: TriangleGuide): TriangleGuide {
	if (current === 'off') return 'falling';
	if (current === 'falling') return 'rising';
	return 'off';
}

/** One guide button, shared by the canvas toolbar and the viewer's bar. */
export interface GuideControl {
	/** Icon names, first one Obsidian has wins: Lucide renames between releases. */
	icon: string[];
	label: string;
	/** Plain key that presses it, with no modifier held. */
	key: string;
	next: (state: GuideState) => GuideState;
	active: (state: GuideState) => boolean;
	/** Mirrors the icon, for the triangle leaning the other way. */
	flipped?: (state: GuideState) => boolean;
	/** Short text beside the icon, for the mask's ratio. */
	badge?: (state: GuideState) => string;
}

export const GUIDE_CONTROLS: readonly GuideControl[] = [
	{
		icon: ['grid-3x3', 'grid'],
		label: 'Rule of thirds (G)',
		key: 'g',
		next: (s) => ({ ...s, thirds: !s.thirds }),
		active: (s) => s.thirds,
	},

	{
		icon: ['focus', 'crosshair'],
		label: 'Center guide (C)',
		key: 'c',
		next: (s) => ({ ...s, center: !s.center }),
		active: (s) => s.center,
	},
	{
		icon: ['triangle-right', 'triangle'],
		label: 'Triangle guide, again to flip (T)',
		key: 't',
		next: (s) => ({ ...s, triangle: nextTriangle(s.triangle) }),
		active: (s) => s.triangle !== 'off',
		flipped: (s) => s.triangle === 'rising',
	},
	{
		icon: ['crop'],
		label: 'Aspect mask, again for the next ratio (M)',
		key: 'm',
		next: (s) => ({ ...s, mask: nextMask(s.mask) }),
		active: (s) => s.mask > 0,
		badge: (s) => (s.mask > 0 ? maskLabel(s.mask) : ''),
	},
];

/** Adds one button per guide to `bar`; call `sync` with each new state. */
export function buildGuideButtons(
	bar: HTMLElement,
	cls: string,
	onPress: (control: GuideControl) => void,
): (state: GuideState) => void {
	const buttons = GUIDE_CONTROLS.map((control) => {
		const button = bar.createEl('button', { cls });
		setIcon(button, control.icon.find((name) => getIcon(name)) ?? 'square');
		setTooltip(button, control.label, { placement: 'bottom' });
		const badge = control.badge
			? button.createSpan({ cls: 'cine-guide-badge' })
			: null;
		button.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			onPress(control);
		});
		return { control, button, badge };
	});
	return (state) => {
		for (const { control, button, badge } of buttons) {
			button.toggleClass('is-active', control.active(state));
			button.toggleClass('is-flipped', control.flipped?.(state) ?? false);
			badge?.setText(control.badge?.(state) ?? '');
		}
	};
}

/** The guide a plain key press belongs to, if any. */
export function guideForKey(e: KeyboardEvent): GuideControl | null {
	if (e.ctrlKey || e.metaKey || e.altKey) return null;
	return GUIDE_CONTROLS.find((c) => c.key === e.key) ?? null;
}

export function anyGuide(state: GuideState): boolean {
	return (
		state.center || state.thirds || state.triangle !== 'off' || state.mask > 0
	);
}

/** Where media of `aspect` lands inside `w` x `h` under `object-fit: contain`. */
export function containRect(w: number, h: number, aspect: number): Rect {
	if (w <= 0 || h <= 0 || !(aspect > 0)) return { x: 0, y: 0, w, h };
	if (w / h > aspect) {
		const fw = h * aspect;
		return { x: (w - fw) / 2, y: 0, w: fw, h };
	}
	const fh = w / aspect;
	return { x: 0, y: (h - fh) / 2, w, h: fh };
}

type Line = [number, number, number, number];

/**
 * The golden triangle: one corner-to-corner diagonal, and a line from each of
 * the two other corners meeting it at a right angle.
 *
 * Coordinates are fractions of the frame. The right angles only hold in
 * pixels, so where the feet land depends on the aspect ratio.
 */
function triangleLines(aspect: number, direction: TriangleGuide): Line[] {
	const a2 = aspect * aspect;
	// Along the diagonal (0,0)-(1,1), the feet from (1,0) and from (0,1).
	const t1 = a2 / (a2 + 1);
	const t2 = 1 / (a2 + 1);
	const lines: Line[] = [
		[0, 0, 1, 1],
		[1, 0, t1, t1],
		[0, 1, t2, t2],
	];
	if (direction !== 'rising') return lines;
	return lines.map(([x1, y1, x2, y2]) => [1 - x1, y1, 1 - x2, y2]);
}

const CENTER_LINES: Line[] = [
	[0.5, 0, 0.5, 1],
	[0, 0.5, 1, 0.5],
];

function gridLines(at: number): Line[] {
	return [
		[at, 0, at, 1],
		[1 - at, 0, 1 - at, 1],
		[0, at, 1, at],
		[0, 1 - at, 1, 1 - at],
	];
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/**
 * Composition guides laid over one picture: an aspect mask, and the thirds,
 * the centre cross and the golden triangle drawn inside what the mask leaves.
 *
 * The owner positions it onto the picture itself, so letterboxing in the
 * frame around it never skews the lines. Two layers, because the lines invert
 * what is under them and the mask has to darken it.
 */
export class FramingGuides {
	private readonly maskEl: SVGSVGElement;
	private readonly linesEl: SVGSVGElement;
	private state: GuideState = {
		center: false,
		thirds: false,
		triangle: 'off',
		mask: 0,
	};
	private aspect = 0;

	constructor(parent: HTMLElement) {
		this.maskEl = parent.createSvg('svg', {
			cls: ['cine-guides', 'cine-guides-mask', 'is-hidden'],
		});
		this.linesEl = parent.createSvg('svg', {
			cls: ['cine-guides', 'cine-guides-lines', 'is-hidden'],
		});
	}

	get hasAspect(): boolean {
		return this.aspect > 0;
	}

	get aspectRatio(): number {
		return this.aspect;
	}

	/** Width over height of the picture, in pixels; 0 forgets it. */
	setAspect(aspect: number): void {
		if (!Number.isFinite(aspect) || aspect < 0 || aspect === this.aspect)
			return;
		this.aspect = aspect;
		this.render();
	}

	setState(state: GuideState): void {
		const s = this.state;
		if (
			state.center === s.center &&
			state.thirds === s.thirds &&
			state.triangle === s.triangle &&
			state.mask === s.mask
		)
			return;
		this.state = { ...state };
		this.render();
	}

	/** Puts the overlay on `rect`, in the parent's own pixels. */
	place(rect: Rect): void {
		for (const el of [this.maskEl, this.linesEl]) {
			el.style.left = `${rect.x}px`;
			el.style.top = `${rect.y}px`;
			el.style.width = `${rect.w}px`;
			el.style.height = `${rect.h}px`;
		}
	}

	destroy(): void {
		this.maskEl.remove();
		this.linesEl.remove();
	}

	/** What the mask leaves of the picture, in fractions of it. */
	private crop(): Rect {
		const { mask } = this.state;
		if (!(mask > 0) || !(this.aspect > 0)) return { x: 0, y: 0, w: 1, h: 1 };
		if (mask > this.aspect) {
			const h = this.aspect / mask;
			return { x: 0, y: (1 - h) / 2, w: 1, h };
		}
		const w = mask / this.aspect;
		return { x: (1 - w) / 2, y: 0, w, h: 1 };
	}

	private render(): void {
		const { center, thirds, triangle, mask } = this.state;
		// Without the picture's shape nothing can be drawn true, and a guide
		// in the wrong place is worse than none.
		const known = this.aspect > 0;
		const showMask = known && mask > 0;
		const showLines = known && (center || thirds || triangle !== 'off');
		this.maskEl.toggleClass('is-hidden', !showMask);
		this.linesEl.toggleClass('is-hidden', !showLines && !showMask);
		this.maskEl.empty();
		this.linesEl.empty();
		if (!known) return;

		const crop = this.crop();
		if (showMask) {
			// Four bars around the crop; two of them are always empty.
			const bars: [number, number, number, number][] = [
				[0, 0, 1, crop.y],
				[0, crop.y + crop.h, 1, 1 - crop.y - crop.h],
				[0, crop.y, crop.x, crop.h],
				[crop.x + crop.w, crop.y, 1 - crop.x - crop.w, crop.h],
			];
			for (const [x, y, w, h] of bars)
				if (w > 0 && h > 0)
					this.maskEl.createSvg('rect', {
						attr: { x: pct(x), y: pct(y), width: pct(w), height: pct(h) },
					});
		}

		// A nested viewport on the crop, so every guide is drawn in fractions
		// of what is left rather than of the whole picture.
		const frame = this.linesEl.createSvg('svg', {
			attr: {
				x: pct(crop.x),
				y: pct(crop.y),
				width: pct(crop.w),
				height: pct(crop.h),
				overflow: 'visible',
			},
		});
		if (showMask)
			frame.createSvg('rect', {
				attr: { x: '0', y: '0', width: '100%', height: '100%' },
			});
		if (thirds) for (const line of gridLines(1 / 3)) this.addLine(frame, line);
		if (center) {
			for (const line of CENTER_LINES) this.addLine(frame, line);
			frame.createSvg('circle', {
				attr: { cx: '50%', cy: '50%', r: '2.5%' },
			});
		}
		if (triangle !== 'off') {
			const frameAspect = mask > 0 ? mask : this.aspect;
			for (const line of triangleLines(frameAspect, triangle))
				this.addLine(frame, line);
		}
	}

	private addLine(parent: SVGElement, [x1, y1, x2, y2]: Line): void {
		parent.createSvg('line', {
			attr: { x1: pct(x1), y1: pct(y1), x2: pct(x2), y2: pct(y2) },
		});
	}
}
