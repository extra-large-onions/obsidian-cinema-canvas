import { ringsPath } from '../media/raster';
import { LightZone, ZoneMap } from '../media/zones';

let filterIds = 0;

/**
 * Light zones drawn over the picture: a fine outline around each, a label
 * at its heart, and — while one is pointed at — everything else dimmed
 * behind a feathered veil.
 *
 * Outlines are vectors in the zone map's own grid, stretched onto the
 * picture; `non-scaling-stroke` keeps them hairline at any size.
 */
export class ZoneLayer {
	private readonly svg: SVGSVGElement;
	private readonly chips: HTMLElement;
	private map: ZoneMap | null = null;
	private hovered: number | null = null;
	private readonly filterId = `cine-zone-feather-${++filterIds}`;

	constructor(
		parent: HTMLElement,
		private readonly onHover: (id: number | null) => void,
	) {
		this.svg = parent.createSvg('svg', {
			cls: 'cine-zones',
			attr: { preserveAspectRatio: 'none' },
		});
		this.chips = parent.createDiv({ cls: 'cine-zone-chips' });
	}

	setMap(map: ZoneMap | null): void {
		this.map = map;
		if (this.hovered !== null && !map?.zones[this.hovered]) this.hovered = null;
		this.render();
	}

	setVisible(on: boolean): void {
		this.svg.style.display = on ? '' : 'none';
		this.chips.toggle(on);
	}

	/** Lights up one zone and veils the rest; null shows them all evenly. */
	setHovered(id: number | null): void {
		if (id === this.hovered) return;
		this.hovered = id;
		this.render();
	}

	get hoveredZone(): LightZone | null {
		return this.hovered === null ? null : (this.map?.zones[this.hovered] ?? null);
	}

	zoneAt(fx: number, fy: number): LightZone | null {
		const map = this.map;
		if (!map || fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
		const x = Math.floor(fx * map.width);
		const y = Math.floor(fy * map.height);
		return map.zones[map.labels[y * map.width + x] ?? -1] ?? null;
	}

	private render(): void {
		this.svg.empty();
		this.chips.empty();
		const map = this.map;
		if (!map) return;
		const { width: W, height: H } = map;
		this.svg.setAttr('viewBox', `0 0 ${W} ${H}`);

		const defs = this.svg.createSvg('defs');
		const filter = defs.createSvg('filter', {
			attr: { id: this.filterId, x: '-10%', y: '-10%', width: '120%', height: '120%' },
		});
		filter.createSvg('feGaussianBlur', { attr: { stdDeviation: '1.6' } });

		const hovered = this.hoveredZone;
		if (hovered) {
			// The whole frame with the zone cut out: a veil with a soft hole.
			this.svg.createSvg('path', {
				cls: 'cine-zone-veil',
				attr: {
					d: `M-2,-2H${W + 2}V${H + 2}H-2Z${ringsPath(hovered.rings)}`,
					'fill-rule': 'evenodd',
					filter: `url(#${this.filterId})`,
				},
			});
		}

		for (const zone of map.zones) {
			// A dark line under the light one, so outlines read on any tone.
			if (!hovered || zone === hovered)
				this.svg.createSvg('path', {
					cls: 'cine-zone-shadow',
					attr: { d: ringsPath(zone.rings) },
				});
			const path = this.svg.createSvg('path', {
				cls: 'cine-zone-line',
				attr: { d: ringsPath(zone.rings), 'fill-rule': 'evenodd' },
			});
			if (zone === hovered) {
				path.addClass('is-hovered');
				path.style.setProperty('--zone-color', zone.color);
			} else if (hovered) {
				path.addClass('is-faded');
			}
		}

		for (const zone of map.zones) {
			// A sliver of frame gets no label; hovering it still names it.
			if (zone.share < 0.025 && zone !== hovered) continue;
			const chip = this.chips.createDiv({ cls: 'cine-zone-chip' });
			chip.toggleClass('is-hovered', zone === hovered);
			chip.toggleClass('is-faded', hovered !== null && zone !== hovered);
			chip.style.left = `${zone.anchor.x * 100}%`;
			chip.style.top = `${zone.anchor.y * 100}%`;
			const dot = chip.createSpan({ cls: 'cine-zone-dot' });
			dot.style.backgroundColor = zone.color;
			chip.createSpan({ cls: 'cine-zone-name', text: zone.name });
			chip.createSpan({ cls: 'cine-zone-stops', text: signedStops(zone.stops) });
			chip.addEventListener('pointerenter', () => this.onHover(zone.id));
			chip.addEventListener('pointerleave', () => this.onHover(null));
		}
	}

	destroy(): void {
		this.svg.remove();
		this.chips.remove();
	}
}

/** `+1.4`, `−2.0`, `±0` */
export function signedStops(value: number): string {
	if (Math.abs(value) < 0.05) return '±0';
	return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}

export function warmthLabel(warmth: number): string {
	if (warmth > 1.3) return 'warm';
	if (warmth < 0.85) return 'cool';
	return 'neutral';
}
