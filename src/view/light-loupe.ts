import { ratioLabel } from '../media/lighting';
import { romanZone } from '../media/zones';
import { Rect } from '../types';
import { signedStops, warmthLabel } from './light-zones';

/** What one spot of the frame reads. */
export interface SpotReading {
	/** Stops over the frame's median. */
	stops: number;
	/** Zone system number, 0–10. */
	zone: number;
	/** Luma as encoded, 0–1: what a waveform would show. */
	level: number;
	/** The spot's colour as CSS. */
	color: string;
	warmth: number;
	clipped: boolean;
	crushed: boolean;
}

export interface LoupeHooks {
	/** Reading at a point of the picture, in fractions; null before a reading. */
	sample: (fx: number, fy: number) => SpotReading | null;
	/** The picture to magnify: the live element, full resolution. */
	media: () => HTMLImageElement | HTMLVideoElement | null;
	/** Name of the zone or depth plane under a point, if read. */
	regionName: (fx: number, fy: number) => string | null;
}

/** Loupe diameter in CSS pixels, and how much it magnifies what is on screen. */
const SIZE = 168;
const ZOOM = 5;

type Pin = { x: number; y: number };

/**
 * A spot meter that follows the pointer over the picture: a round loupe of
 * magnified pixels with the spot's reading under it. Click to pin A, click
 * again to pin B and read one against the other; a third click starts over,
 * and right click clears.
 */
export class LightLoupe {
	private readonly loupe: HTMLElement;
	private readonly lens: HTMLCanvasElement;
	private readonly caption: HTMLElement;
	private readonly pinsSvg: SVGSVGElement;
	private readonly pinsLabel: HTMLElement;
	private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
	private pins: Pin[] = [];
	private at: Pin | null = null;

	constructor(
		root: HTMLElement,
		overlay: HTMLElement,
		private readonly hooks: LoupeHooks,
	) {
		this.loupe = root.createDiv({ cls: 'cine-loupe' });
		this.loupe.hide();
		this.lens = this.loupe.createEl('canvas', { cls: 'cine-loupe-lens' });
		this.loupe.createDiv({ cls: 'cine-loupe-reticle' });
		this.caption = this.loupe.createDiv({ cls: 'cine-loupe-caption' });
		this.pinsSvg = overlay.createSvg('svg', { cls: 'cine-loupe-pins' });
		this.pinsLabel = overlay.createDiv({ cls: 'cine-loupe-compare' });
		this.pinsLabel.hide();
	}

	place(rect: Rect): void {
		this.rect = rect;
		this.pinsSvg.setAttr('viewBox', `0 0 ${Math.max(1, rect.w)} ${Math.max(1, rect.h)}`);
		this.renderPins();
	}

	/** The pointer is at `fx, fy` of the picture. */
	move(fx: number, fy: number): void {
		this.at = { x: fx, y: fy };
		this.renderLoupe();
	}

	leave(): void {
		this.at = null;
		this.loupe.hide();
	}

	click(fx: number, fy: number): void {
		if (this.pins.length >= 2) this.pins = [];
		this.pins.push({ x: fx, y: fy });
		this.renderPins();
	}

	clearPins(): void {
		this.pins = [];
		this.renderPins();
	}

	/** A new reading landed: redraw with its numbers. */
	refresh(): void {
		this.renderPins();
		if (this.at) this.renderLoupe();
	}

	reset(): void {
		this.pins = [];
		this.leave();
		this.renderPins();
	}

	destroy(): void {
		this.loupe.remove();
		this.pinsSvg.remove();
		this.pinsLabel.remove();
	}

	private renderLoupe(): void {
		const at = this.at;
		const media = this.hooks.media();
		if (!at || !media) return this.leave();
		const reading = this.hooks.sample(at.x, at.y);
		this.loupe.show();

		// To the upper right of the pointer, or wherever it fits.
		const px = this.rect.x + at.x * this.rect.w;
		const py = this.rect.y + at.y * this.rect.h;
		const parent = this.loupe.parentElement;
		const pw = parent?.clientWidth ?? 0;
		const gap = 26;
		let left = px + gap;
		let top = py - gap - SIZE;
		if (left + SIZE > pw - 8) left = px - gap - SIZE;
		if (top < 8) top = py + gap;
		this.loupe.style.left = `${left}px`;
		this.loupe.style.top = `${top}px`;

		this.drawLens(media, at);

		this.caption.empty();
		if (!reading) {
			this.caption.createDiv({ cls: 'cine-loupe-muted', text: 'Reading…' });
			return;
		}
		const main = this.caption.createDiv({ cls: 'cine-loupe-main' });
		main.createSpan({ cls: 'cine-loupe-stops', text: signedStops(reading.stops) });
		main.createSpan({ cls: 'cine-loupe-unit', text: 'stops' });
		main.createSpan({ cls: 'cine-loupe-zone', text: `Zone ${romanZone(reading.zone)}` });
		const sub = this.caption.createDiv({ cls: 'cine-loupe-sub' });
		const swatch = sub.createSpan({ cls: 'cine-loupe-swatch' });
		swatch.style.backgroundColor = reading.color;
		sub.appendText(`${Math.round(reading.level * 100)}% · ${warmthLabel(reading.warmth)}`);
		const zone = this.hooks.regionName(at.x, at.y);
		if (zone) sub.appendText(` · ${zone}`);
		if (reading.clipped) this.caption.createDiv({ cls: 'cine-loupe-flag is-clipped', text: 'Clipped' });
		else if (reading.crushed) this.caption.createDiv({ cls: 'cine-loupe-flag is-crushed', text: 'Crushed' });
	}

	/** Magnified pixels around the point, straight from the picture. */
	private drawLens(media: HTMLImageElement | HTMLVideoElement, at: Pin): void {
		const nw = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
		const nh = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
		if (!nw || !nh || this.rect.w <= 0) return;
		const dpr = window.devicePixelRatio || 1;
		const side = Math.round(SIZE * dpr);
		if (this.lens.width !== side) {
			this.lens.width = side;
			this.lens.height = side;
		}
		const ctx = this.lens.getContext('2d');
		if (!ctx) return;
		// Source pixels per screen pixel, then the span the lens covers.
		const perScreen = nw / this.rect.w;
		const span = (SIZE / ZOOM) * perScreen;
		const sx = at.x * nw - span / 2;
		const sy = at.y * nh - span / 2;
		ctx.imageSmoothingEnabled = false;
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, side, side);
		try {
			ctx.drawImage(media, sx, sy, span, span, 0, 0, side, side);
		} catch {
			// A frame not decoded yet: leave the lens black.
		}
	}

	private renderPins(): void {
		this.pinsSvg.empty();
		this.pinsLabel.hide();
		const { w, h } = this.rect;
		if (this.pins.length === 0 || w <= 0) return;
		const points = this.pins.map((p) => ({ x: p.x * w, y: p.y * h }));
		const [a, b] = points;
		if (a && b)
			this.pinsSvg.createSvg('line', {
				cls: 'cine-loupe-link',
				attr: { x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y) },
			});
		points.forEach((p, i) => {
			const g = this.pinsSvg.createSvg('g', { cls: 'cine-loupe-pin' });
			g.createSvg('circle', { attr: { cx: String(p.x), cy: String(p.y), r: '7' } });
			g.createSvg('circle', { cls: 'cine-loupe-pin-dot', attr: { cx: String(p.x), cy: String(p.y), r: '1.6' } });
			const label = g.createSvg('text', {
				attr: { x: String(p.x + 11), y: String(p.y - 9) },
			});
			label.textContent = i === 0 ? 'A' : 'B';
		});

		const pa = this.pins[0];
		const pb = this.pins[1];
		if (!pa || !pb || !a || !b) return;
		const ra = this.hooks.sample(pa.x, pa.y);
		const rb = this.hooks.sample(pb.x, pb.y);
		if (!ra || !rb) return;
		const d = rb.stops - ra.stops;
		const text =
			Math.abs(d) < 0.1
				? 'A and B match'
				: `B is ${Math.abs(d).toFixed(1)} stops ${d < 0 ? 'under' : 'over'} A · ${ratioLabel(Math.abs(d))}`;
		this.pinsLabel.setText(text);
		this.pinsLabel.show();
		this.pinsLabel.style.left = `${((a.x + b.x) / 2 / w) * 100}%`;
		this.pinsLabel.style.top = `${((a.y + b.y) / 2 / h) * 100}%`;
	}
}
