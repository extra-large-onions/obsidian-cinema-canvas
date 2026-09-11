import { Rect } from '../types';
import { clamp } from '../utils/debounce';

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 4;

type RegisterDomEvent = <K extends keyof HTMLElementEventMap>(
	el: HTMLElement,
	type: K,
	handler: (ev: HTMLElementEventMap[K]) => void,
	options?: AddEventListenerOptions,
) => void;

/**
 * The pan/zoom camera over the world layer.
 *
 * World coordinates are the layout's pixel space at scale 1. The world element
 * is positioned with `translate(x, y) scale(s)` from a 0,0 origin, so the
 * mapping is just `screen = world * scale + offset`.
 */
export class Viewport {
	scale = 1;
	x = 0;
	y = 0;

	private panPointer: number | null = null;
	private panStart = { x: 0, y: 0, ox: 0, oy: 0 };
	private pinch: { ids: number[]; distance: number } | null = null;
	private readonly pointers = new Map<number, { x: number; y: number }>();
	private animationTimer: number | null = null;

	constructor(
		private readonly viewportEl: HTMLElement,
		private readonly worldEl: HTMLElement,
		private readonly onChange: () => void,
		/** Returns true when a pointerdown should start a pan. */
		private readonly isPanTarget: (target: EventTarget | null) => boolean,
	) {}

	bind(register: RegisterDomEvent): void {
		register(this.viewportEl, 'wheel', (e) => this.onWheel(e), {
			passive: false,
		});
		register(this.viewportEl, 'pointerdown', (e) => this.onPointerDown(e));
		register(this.viewportEl, 'pointermove', (e) => this.onPointerMove(e));
		register(this.viewportEl, 'pointerup', (e) => this.onPointerUp(e));
		register(this.viewportEl, 'pointercancel', (e) => this.onPointerUp(e));
		// Middle-click on Linux/Windows otherwise triggers autoscroll.
		register(this.viewportEl, 'auxclick', (e) => {
			if (e.button === 1) e.preventDefault();
		});
	}

	get size(): { width: number; height: number } {
		return {
			width: this.viewportEl.clientWidth,
			height: this.viewportEl.clientHeight,
		};
	}

	/** The world rectangle currently on screen. */
	get visibleWorldRect(): Rect {
		const { width, height } = this.size;
		return {
			x: -this.x / this.scale,
			y: -this.y / this.scale,
			w: width / this.scale,
			h: height / this.scale,
		};
	}

	apply(): void {
		this.worldEl.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
		this.onChange();
	}

	panBy(dx: number, dy: number): void {
		this.x += dx;
		this.y += dy;
		this.apply();
	}

	/** Zooms by `factor` keeping the given client point pinned. */
	zoomAt(factor: number, clientX: number, clientY: number): void {
		const rect = this.viewportEl.getBoundingClientRect();
		const px = clientX - rect.left;
		const py = clientY - rect.top;
		const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
		if (next === this.scale) return;
		const wx = (px - this.x) / this.scale;
		const wy = (py - this.y) / this.scale;
		this.scale = next;
		this.x = px - wx * next;
		this.y = py - wy * next;
		this.apply();
	}

	/** Zooms around the middle of the viewport, for toolbar and keyboard. */
	zoomByStep(factor: number): void {
		const rect = this.viewportEl.getBoundingClientRect();
		this.animate(() =>
			this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2),
		);
	}

	/** Frames a world rect, with `padding` as a fraction of the rect size. */
	zoomToRect(rect: Rect, padding = 0.08, animate = true): void {
		const { width, height } = this.size;
		if (width === 0 || height === 0 || rect.w <= 0 || rect.h <= 0) return;
		const padX = rect.w * padding;
		const padY = rect.h * padding;
		const scale = clamp(
			Math.min(width / (rect.w + padX * 2), height / (rect.h + padY * 2)),
			MIN_SCALE,
			MAX_SCALE,
		);
		const cx = rect.x + rect.w / 2;
		const cy = rect.y + rect.h / 2;
		const run = () => {
			this.scale = scale;
			this.x = width / 2 - cx * scale;
			this.y = height / 2 - cy * scale;
			this.apply();
		};
		if (animate) this.animate(run);
		else run();
	}

	/** Runs a camera change with a short CSS transition. */
	animate(change: () => void): void {
		this.worldEl.addClass('is-animating');
		change();
		if (this.animationTimer !== null)
			window.clearTimeout(this.animationTimer);
		this.animationTimer = window.setTimeout(() => {
			this.worldEl.removeClass('is-animating');
			this.animationTimer = null;
			// Visibility is recomputed once more after the transition so any
			// cells that scrolled in mid-flight get their media.
			this.onChange();
		}, 260);
	}

	destroy(): void {
		if (this.animationTimer !== null)
			window.clearTimeout(this.animationTimer);
	}

	// --- input ------------------------------------------------------------

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			// Trackpad pinch and ctrl+wheel both arrive here.
			const factor = Math.exp(-e.deltaY * 0.01);
			this.zoomAt(factor, e.clientX, e.clientY);
			return;
		}
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
		let dx = e.deltaX * unit;
		let dy = e.deltaY * unit;
		if (e.shiftKey && dx === 0) {
			dx = dy;
			dy = 0;
		}
		this.panBy(-dx, -dy);
	}

	private onPointerDown(e: PointerEvent): void {
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (this.pointers.size === 2) {
			const ids = [...this.pointers.keys()];
			this.pinch = { ids, distance: this.pointerDistance(ids) };
			this.panPointer = null;
			return;
		}

		const isPan =
			e.button === 1 ||
			(e.button === 0 && (this.isPanTarget(e.target) || e.altKey));
		if (!isPan) return;
		this.panPointer = e.pointerId;
		this.panStart = { x: e.clientX, y: e.clientY, ox: this.x, oy: this.y };
		this.viewportEl.setPointerCapture(e.pointerId);
		this.viewportEl.addClass('is-panning');
		e.preventDefault();
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.pointers.has(e.pointerId))
			this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

		if (this.pinch) {
			const distance = this.pointerDistance(this.pinch.ids);
			if (distance > 0 && this.pinch.distance > 0) {
				const first = this.pointers.get(this.pinch.ids[0] ?? -1);
				const second = this.pointers.get(this.pinch.ids[1] ?? -1);
				if (first && second) {
					this.zoomAt(
						distance / this.pinch.distance,
						(first.x + second.x) / 2,
						(first.y + second.y) / 2,
					);
				}
			}
			this.pinch.distance = distance;
			return;
		}

		if (this.panPointer !== e.pointerId) return;
		this.x = this.panStart.ox + (e.clientX - this.panStart.x);
		this.y = this.panStart.oy + (e.clientY - this.panStart.y);
		this.apply();
	}

	private onPointerUp(e: PointerEvent): void {
		this.pointers.delete(e.pointerId);
		if (this.pinch && this.pointers.size < 2) this.pinch = null;
		if (this.panPointer === e.pointerId) {
			this.panPointer = null;
			if (this.viewportEl.hasPointerCapture(e.pointerId))
				this.viewportEl.releasePointerCapture(e.pointerId);
			this.viewportEl.removeClass('is-panning');
		}
	}

	private pointerDistance(ids: number[]): number {
		const a = this.pointers.get(ids[0] ?? -1);
		const b = this.pointers.get(ids[1] ?? -1);
		if (!a || !b) return 0;
		return Math.hypot(a.x - b.x, a.y - b.y);
	}
}
