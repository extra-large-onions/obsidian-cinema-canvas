import { Notice, setIcon, setTooltip } from 'obsidian';
import { DETECTOR_LABELS, Detector, ShotIndex } from '../media/shots';
import { ThumbnailStore } from '../media/thumbnails';
import { MediaItem, Shot } from '../types';
import { formatTimecode } from '../utils/timecode';
import {
	ParamHost,
	ShotParamKey,
	ShotParams,
	renderDetectorButtons,
	renderParams,
	summarize,
} from './shot-controls';

/**
 * Width of one strip item in CSS pixels. Fixed, so the strip reads as a
 * filmstrip rather than as a proportional timeline: a 0.4s shot and a 40s shot
 * are equally clickable, which is what you want when the strip is for
 * navigating rather than for judging rhythm.
 */
const ITEM_WIDTH = 132;

/** Thumbnail tier is picked from this, not from the canvas zoom. */
const ITEM_SCREEN_WIDTH = ITEM_WIDTH;

export interface ShotStripOptions {
	/** Play just this shot in the canvas cell for the current clip. */
	onPlayShot: (item: MediaItem, shot: Shot) => void;
	/** Open the lightbox on this shot. */
	onOpenShot: (item: MediaItem, shot: Shot) => void;
	/** Open the clip in its own tab, with every segment laid out. */
	onOpenClip: (item: MediaItem) => void;
	/** Current cutting parameters, read fresh on every render. */
	getParams: () => ShotParams;
	/** Applies one immediately and persists it; re-cutting is the caller's job. */
	setParam: (key: ShotParamKey, value: number) => void;
}

/**
 * The sticky strip along the bottom of the canvas.
 *
 * Shows the cuts of whichever clip is selected, one cell per shot, scrolling
 * sideways. The canvas above stays one cell per file — the strip is the only
 * place a clip is ever broken up, which keeps "which file is this" and "where
 * in the file is this" as two separate questions.
 *
 * Four states: hidden (nothing selected, or an image is), uncut (two detector
 * buttons), detecting (a progress readout), and cut (the strip itself, with the
 * cutting parameters in its header).
 *
 * For one clip and nothing else, the dedicated clip view shows the same cuts
 * wrapped over a whole tab instead of in one scrolling row.
 */
export class ShotStrip {
	readonly el: HTMLElement;

	private readonly headerEl: HTMLElement;
	private readonly summaryEl: HTMLElement;
	private readonly actionEl: HTMLElement;
	private readonly bodyEl: HTMLElement;

	private item: MediaItem | null = null;
	private activeIndex: number | null = null;
	private unsubscribe: (() => void) | null = null;
	/** Cancels for the thumbnail requests of the items currently rendered. */
	private cancels: (() => void)[] = [];
	private collapsed = false;
	/**
	 * True while a parameter slider is being dragged.
	 *
	 * Each drag step re-cuts the clip, which fires a change event, which would
	 * rebuild the header and destroy the slider under the pointer. While this is
	 * set, only the shots below are redrawn.
	 */
	private adjusting = false;
	private frame: number | null = null;

	private readonly paramHost: ParamHost;

	constructor(
		parent: HTMLElement,
		private readonly shots: ShotIndex,
		private readonly thumbnails: ThumbnailStore,
		private readonly options: ShotStripOptions,
	) {
		this.el = parent.createDiv({ cls: 'cine-strip' });
		this.el.hide();

		this.headerEl = this.el.createDiv({ cls: 'cine-strip-header' });
		this.summaryEl = this.headerEl.createDiv({ cls: 'cine-strip-summary' });
		this.actionEl = this.headerEl.createDiv({ cls: 'cine-strip-actions' });

		this.bodyEl = this.el.createDiv({ cls: 'cine-strip-body' });
		// A horizontal strip gets vertical wheel events from a normal mouse;
		// turning them sideways is the only way it is scrollable without a
		// trackpad.
		this.bodyEl.addEventListener(
			'wheel',
			(e) => {
				if (e.deltaY === 0 || e.ctrlKey || e.metaKey) return;
				e.preventDefault();
				e.stopPropagation();
				this.bodyEl.scrollLeft += e.deltaY;
			},
			{ passive: false },
		);

		this.paramHost = {
			getParams: () => this.options.getParams(),
			setParam: (key, value) => this.options.setParam(key, value),
			hold: () => {
				this.adjusting = true;
			},
			release: () => {
				if (!this.adjusting) return;
				this.adjusting = false;
				this.render();
			},
		};

		// Detection progress fires a change per window; coalescing to a frame
		// keeps that from costing more than the inference does.
		this.unsubscribe = this.shots.onChange(() => this.scheduleRender());
	}

	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.clearItems();
		this.el.remove();
	}

	/** Points the strip at a clip, or at nothing. */
	setClip(item: MediaItem | null): void {
		const next = item?.kind === 'video' ? item : null;
		if (next?.key === this.item?.key) return;
		this.item = next;
		this.activeIndex = null;
		this.adjusting = false;
		this.render();
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		this.el.toggleClass('is-collapsed', this.collapsed);
	}

	/** Selects the next or previous shot and plays it. */
	step(delta: number): boolean {
		const item = this.item;
		const shots = item ? this.shots.get(item) : null;
		if (!item || !shots || shots.length === 0) return false;
		const next =
			this.activeIndex === null
				? delta > 0
					? 0
					: shots.length - 1
				: (this.activeIndex + delta + shots.length) % shots.length;
		const shot = shots[next];
		if (!shot) return false;
		this.setActive(next);
		this.options.onPlayShot(item, shot);
		return true;
	}

	/** Runs `detector` over the selected clip, cached result or not. */
	detectSelected(detector: Detector, force = false): void {
		if (this.item) void this.detect(this.item, detector, force);
	}

	// --- rendering --------------------------------------------------------

	private scheduleRender(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.render();
		});
	}

	private render(): void {
		const item = this.item;
		if (!item) {
			this.el.hide();
			this.clearItems();
			return;
		}
		this.el.show();

		const shots = this.shots.get(item);
		// Mid-drag the header must survive, because the slider being dragged
		// lives in it.
		if (this.adjusting && shots && shots.length > 0) {
			this.clearItems();
			this.summaryEl.setText(
				summarize(item, shots, this.shots.detectorFor(item)),
			);
			for (const shot of shots) this.renderItem(item, shot);
			this.applyActive();
			return;
		}

		this.clearItems();
		this.actionEl.empty();

		const pending = this.shots.pendingDetector(item);
		if (pending) this.renderPending(item, pending);
		else if (shots && shots.length > 0) this.renderShots(item, shots);
		else this.renderPrompt(item);
	}

	private renderPending(item: MediaItem, detector: Detector): void {
		this.el.toggleClass('is-empty', true);
		const progress = this.shots.progressFor(item);
		const percent =
			progress === null ? '' : ` ${Math.round(progress * 100)}%`;
		this.summaryEl.setText(
			`${DETECTOR_LABELS[detector]} is finding cuts in ${item.file.name}…${percent}`,
		);
		this.actionEl.createDiv({ cls: 'cine-strip-spinner' });
	}

	private renderPrompt(item: MediaItem): void {
		this.el.toggleClass('is-empty', true);
		// A detector that ran and failed has a reason; one that ran and found a
		// single long take does not. Saying which is the whole point.
		const error = this.shots.errorFor(item);
		this.summaryEl.setText(
			error ? `${item.file.name} — ${error}` : item.file.name,
		);
		setTooltip(this.summaryEl, error ?? item.path, { placement: 'top' });
		renderDetectorButtons(this.actionEl, item, null, true, this.detectorHost);
	}

	private renderShots(item: MediaItem, shots: Shot[]): void {
		this.el.toggleClass('is-empty', false);
		const detector = this.shots.detectorFor(item);
		this.summaryEl.setText(summarize(item, shots, detector));
		setTooltip(this.summaryEl, item.path, { placement: 'top' });

		renderParams(this.actionEl, detector, this.paramHost);
		renderDetectorButtons(
			this.actionEl,
			item,
			detector,
			false,
			this.detectorHost,
		);

		const expand = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(expand, 'gallery-vertical-end');
		setTooltip(
			expand,
			'Open this clip in its own tab, with every segment laid out',
			{ placement: 'top' },
		);
		expand.addEventListener('click', () => this.options.onOpenClip(item));

		const again = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(again, 'refresh-cw');
		setTooltip(
			again,
			detector
				? `Run ${DETECTOR_LABELS[detector]} over this clip again`
				: 'Find cuts again',
			{ placement: 'top' },
		);
		again.addEventListener('click', () => {
			if (detector) void this.detect(item, detector, true);
		});

		for (const shot of shots) this.renderItem(item, shot);
		this.applyActive();
	}

	private get detectorHost() {
		return {
			shots: this.shots,
			run: (item: MediaItem, detector: Detector) =>
				void this.detect(item, detector, false),
			show: (item: MediaItem, detector: Detector) => {
				this.shots.prefer(item, detector);
				this.activeIndex = null;
			},
		};
	}

	private renderItem(item: MediaItem, shot: Shot): void {
		const el = this.bodyEl.createDiv({ cls: 'cine-shot' });
		el.dataset.index = String(shot.index);
		el.style.width = `${ITEM_WIDTH}px`;

		const frame = el.createDiv({ cls: 'cine-shot-frame' });
		const img = frame.createEl('img', { cls: 'cine-shot-media' });
		img.alt = `Shot ${shot.index + 1}`;
		img.draggable = false;
		img.decoding = 'async';
		img.hide();

		// The thumbnail store keys on `item.shot`, so a shot item is what has
		// to be handed to it — the frame it grabs is the middle of the shot.
		const shotItem: MediaItem = {
			...item,
			key: `${item.path}#t=${shot.start}`,
			shot,
		};
		const resolved = this.thumbnails.resolve(shotItem, ITEM_SCREEN_WIDTH);
		if (resolved.url) {
			img.src = resolved.url;
			img.show();
		} else {
			this.cancels.push(
				this.thumbnails.request(
					shotItem,
					resolved.upgrade ?? 0,
					shot.index,
					(url) => {
						if (!url) return;
						img.src = url;
						img.show();
					},
				),
			);
		}

		frame.createDiv({
			cls: 'cine-shot-number',
			text: String(shot.index + 1),
		});

		const meta = el.createDiv({ cls: 'cine-shot-meta' });
		meta.createDiv({
			cls: 'cine-shot-time',
			text: formatTimecode(shot.start),
		});
		meta.createDiv({
			cls: 'cine-shot-length',
			text: `${(shot.end - shot.start).toFixed(1)}s`,
		});

		setTooltip(
			el,
			`Shot ${shot.index + 1} · ${formatTimecode(shot.start)} to ${formatTimecode(shot.end)} · ${(shot.end - shot.start).toFixed(2)}s`,
			{ placement: 'top' },
		);

		el.addEventListener('click', () => {
			this.setActive(shot.index);
			this.options.onPlayShot(item, shot);
		});
		el.addEventListener('dblclick', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.setActive(shot.index);
			this.options.onOpenShot(item, shot);
		});
	}

	// --- state ------------------------------------------------------------

	private async detect(
		item: MediaItem,
		detector: Detector,
		force: boolean,
	): Promise<void> {
		if (detector === 'transnet' && !(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: the TransNetV2 model is not downloaded yet. Settings → Shot detection → Download.',
				10000,
			);
			return;
		}
		this.render();
		const shots = await this.shots.detect(item, detector, force);
		if (!shots) {
			const reason = this.shots.errorFor(item, detector);
			new Notice(
				reason
					? `Cinema canvas: ${DETECTOR_LABELS[detector]} failed on ${item.file.name}. ${reason}`
					: `Cinema canvas: ${DETECTOR_LABELS[detector]} found no cuts in ${item.file.name} — it may be a single take.`,
				12000,
			);
		}
		// `onChange` already re-rendered; nothing else to do here.
	}

	/** Highlights shot `index` without playing it. */
	setActive(index: number | null): void {
		if (this.activeIndex === index) return;
		this.activeIndex = index;
		this.applyActive();
	}

	private applyActive(): void {
		for (const child of Array.from(this.bodyEl.children)) {
			if (!child.instanceOf(HTMLElement)) continue;
			const active = Number(child.dataset.index) === this.activeIndex;
			child.toggleClass('is-active', active);
			if (active)
				child.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	private clearItems(): void {
		for (const cancel of this.cancels) cancel();
		this.cancels = [];
		this.bodyEl.empty();
	}
}
