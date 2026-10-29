import { App, Notice, TFile, setIcon, setTooltip } from 'obsidian';
import type { DepthEstimator } from '../media/depth-model';
import type { FaceDetector } from '../media/faces';
import type { SceneStore } from '../media/scene-store';
import { MediaItem, Shot } from '../types';
import { formatShotRange } from '../utils/timecode';
import {
	FramingGuides,
	GuideControl,
	GuideState,
	buildGuideButtons,
	containRect,
} from './framing';
import { MarkChange, MarkLayer } from './frame-marks';
import { LightMeter } from './light-meter';
import { SegmentPlayer } from './segment-player';

export interface LightboxOptions {
	loopVideos: boolean;
	guides: GuideState;
	onGuide: (control: GuideControl) => void;
	/** Shows the lighting readout over the picture. */
	lighting: boolean;
	onToggleLighting: () => void;
	faces: FaceDetector;
	/** Whether the readout also reads faces; checked on every reading. */
	readFaces: () => boolean;
	depth: DepthEstimator;
	/** Whether the readout also reads depth; checked on every reading. */
	readDepth: () => boolean;
	/** Where frame marks are read from and saved to: the film's note. */
	notes: SceneStore;
	/** The film's cuts, for the "whole cut" mark ranges; null when not known. */
	shotsFor: (item: MediaItem) => readonly Shot[] | null;
	onIndexChange: (index: number) => void;
	onClose: () => void;
}

/**
 * Full-screen viewer layered over the canvas. Two levels of "full screen":
 * this overlay always fills the workspace leaf, and the expand button hands
 * the same element to the browser's Fullscreen API for a true borderless view.
 */
export class Lightbox {
	private readonly root: HTMLElement;
	private readonly stage: HTMLElement;
	private readonly caption: HTMLElement;
	private readonly counter: HTMLElement;
	private items: MediaItem[] = [];
	private index = 0;
	/** Confines the shown shot's playback, to the frame. */
	private segment: SegmentPlayer | null = null;
	private open = false;
	private readonly guides: FramingGuides;
	private readonly syncGuideButtons: (state: GuideState) => void;
	private readonly meter: LightMeter;
	private readonly lightButton: HTMLButtonElement;
	private readonly marks: MarkLayer;
	private readonly drawButton: HTMLButtonElement;
	/** The film whose marks are shown; null for a still. */
	private markFile: TFile | null = null;
	/** Saves not yet on disk; the note's copy is behind until they land. */
	private pendingSaves = 0;
	private readonly stopWatchingNotes: () => void;
	/** Follows the shown picture, so the guides stay on it through resizes. */
	private mediaObserver: ResizeObserver | null = null;

	constructor(
		private readonly app: App,
		parent: HTMLElement,
		private options: LightboxOptions,
	) {
		this.root = parent.createDiv({ cls: 'cine-lightbox' });
		this.root.tabIndex = -1;
		this.root.hide();

		this.stage = this.root.createDiv({ cls: 'cine-lightbox-stage' });

		const prev = this.root.createEl('button', {
			cls: 'cine-lightbox-nav cine-lightbox-prev',
			attr: { 'aria-label': 'Previous' },
		});
		setIcon(prev, 'chevron-left');
		prev.addEventListener('click', (e) => {
			e.stopPropagation();
			this.step(-1);
		});

		const next = this.root.createEl('button', {
			cls: 'cine-lightbox-nav cine-lightbox-next',
			attr: { 'aria-label': 'Next' },
		});
		setIcon(next, 'chevron-right');
		next.addEventListener('click', (e) => {
			e.stopPropagation();
			this.step(1);
		});

		const bar = this.root.createDiv({ cls: 'cine-lightbox-bar' });
		this.caption = bar.createDiv({ cls: 'cine-lightbox-caption' });
		this.counter = bar.createDiv({ cls: 'cine-lightbox-counter' });

		const actions = bar.createDiv({ cls: 'cine-lightbox-actions' });
		this.syncGuideButtons = buildGuideButtons(actions, '', (control) =>
			this.options.onGuide(control),
		);

		this.drawButton = actions.createEl('button');
		setIcon(this.drawButton, 'pencil');
		setTooltip(this.drawButton, 'Draw on the frame (D)', { placement: 'bottom' });
		this.drawButton.addEventListener('click', (e) => {
			e.stopPropagation();
			this.marks.setDrawing(!this.marks.isDrawing);
		});

		this.lightButton = actions.createEl('button');
		setIcon(this.lightButton, 'sun');
		setTooltip(this.lightButton, 'Lighting readout (L)', { placement: 'bottom' });
		this.lightButton.addEventListener('click', (e) => {
			e.stopPropagation();
			this.options.onToggleLighting();
		});

		const expand = actions.createEl('button', {
			attr: { 'aria-label': 'Toggle native full screen' },
		});
		setIcon(expand, 'expand');
		expand.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.toggleNativeFullscreen();
		});

		const close = actions.createEl('button', {
			attr: { 'aria-label': 'Close' },
		});
		setIcon(close, 'x');
		close.addEventListener('click', (e) => {
			e.stopPropagation();
			this.hide();
		});

		// After the stage, so the lines sit over the picture.
		this.guides = new FramingGuides(this.root);
		this.applyGuides();
		this.meter = new LightMeter(this.root, {
			faces: options.faces,
			readFaces: options.readFaces,
			depth: options.depth,
			readDepth: options.readDepth,
		});
		this.applyLighting();
		// Last, so marks sit over the guides and the lighting tints.
		this.marks = new MarkLayer(this.root, {
			onEdit: (change) => void this.saveMarks(change),
			onDrawingChange: (on) => this.drawButton.toggleClass('is-active', on),
		});
		this.stopWatchingNotes = options.notes.onChange(() => this.syncMarks());

		// Clicking the backdrop (but not the media itself) closes; while
		// drawing, a click that misses the picture is only a miss.
		this.root.addEventListener('click', (e) => {
			if (this.marks.isDrawing) return;
			if (e.target === this.root || e.target === this.stage) this.hide();
		});
	}

	get isOpen(): boolean {
		return this.open;
	}

	get currentIndex(): number {
		return this.index;
	}

	setOptions(options: Partial<LightboxOptions>): void {
		this.options = { ...this.options, ...options };
		if (options.guides) this.applyGuides();
		if (options.lighting !== undefined) this.applyLighting();
	}

	private applyLighting(): void {
		this.meter.setEnabled(this.options.lighting);
		this.lightButton.toggleClass('is-active', this.options.lighting);
	}

	private applyGuides(): void {
		this.guides.setState(this.options.guides);
		this.syncGuideButtons(this.options.guides);
	}

	show(items: MediaItem[], index: number): void {
		if (items.length === 0) return;
		this.items = items;
		this.index = Math.min(Math.max(index, 0), items.length - 1);
		this.open = true;
		this.root.show();
		this.render();
		this.root.focus();
	}

	hide(): void {
		if (!this.open) return;
		this.open = false;
		this.clearStage();
		this.root.hide();
		if (activeDocument.fullscreenElement === this.root)
			void activeDocument.exitFullscreen();
		this.options.onClose();
	}

	/**
	 * Pauses what is playing and keeps the overlay open on the same frame.
	 *
	 * Used when the tab is left: closing the viewer would lose the place, and
	 * `clearStage` would throw the element away.
	 */
	pauseForNow(): void {
		const video = this.stage.querySelector('video');
		if (video instanceof HTMLVideoElement && !video.paused) video.pause();
	}

	step(delta: number): void {
		if (!this.open || this.items.length === 0) return;
		const count = this.items.length;
		this.index = (this.index + delta + count) % count;
		this.render();
		this.options.onIndexChange(this.index);
	}

	async toggleNativeFullscreen(): Promise<void> {
		try {
			if (activeDocument.fullscreenElement === this.root)
				await activeDocument.exitFullscreen();
			else await this.root.requestFullscreen();
		} catch {
			// Fullscreen can be refused (embedded contexts, user gesture
			// rules); the overlay already covers the leaf, so this is cosmetic.
		}
	}

	/** Keeps the viewer pointing at the same file after the index changes. */
	refresh(items: MediaItem[]): void {
		if (!this.open) return;
		const current = this.items[this.index];
		this.items = items;
		if (items.length === 0) {
			this.hide();
			return;
		}
		const found = current
			? items.findIndex((i) => i.key === current.key)
			: -1;
		this.index = found >= 0 ? found : Math.min(this.index, items.length - 1);
		this.render();
	}

	/** Keys for the drawing layer, asked before the viewer's own. */
	handleKey(e: KeyboardEvent): boolean {
		return this.open && this.marks.handleKey(e);
	}

	destroy(): void {
		this.clearStage();
		this.stopWatchingNotes();
		this.marks.destroy();
		this.meter.destroy();
		this.root.remove();
	}

	private clearStage(): void {
		this.segment?.destroy();
		this.segment = null;
		this.mediaObserver?.disconnect();
		this.mediaObserver = null;
		this.meter.attach(null);
		this.marks.attach(null, null);
		this.markFile = null;
		this.drawButton.hide();
		const video = this.stage.querySelector('video');
		if (video instanceof HTMLVideoElement) video.pause();
		this.stage.empty();
	}

	private render(): void {
		const item = this.items[this.index];
		if (!item) return;
		this.clearStage();

		const src = this.app.vault.getResourcePath(item.file);
		if (item.kind === 'video') {
			const video = this.stage.createEl('video', {
				cls: 'cine-lightbox-media',
			});
			video.src = src;
			video.controls = true;
			video.autoplay = true;
			video.playsInline = true;

			const shot = item.shot;
			if (shot) {
				// Native controls still scrub the whole file, deliberately —
				// seeing what surrounds a shot is the point of opening it big.
				// Playback is what gets confined to the shot.
				// Scrubbing out of the shot releases it.
				video.loop = false;
				this.segment = new SegmentPlayer(video, {
					loop: () => this.options.loopVideos,
				});
				this.segment.play(shot);
			} else {
				video.loop = this.options.loopVideos;
			}
			video.addEventListener('loadedmetadata', () => {
				if (video.videoHeight > 0)
					this.fitGuides(video, video.videoWidth / video.videoHeight);
			});
			this.watchMedia(video);
			this.markFile = item.file;
			this.drawButton.show();
			this.marks.attach(video, this.options.shotsFor(item) ?? (shot ? [shot] : null));
			this.syncMarks();
		} else {
			const img = this.stage.createEl('img', {
				cls: 'cine-lightbox-media',
			});
			img.src = src;
			img.alt = item.file.name;
			img.draggable = false;
			img.addEventListener('load', () => {
				if (img.naturalHeight > 0)
					this.fitGuides(img, img.naturalWidth / img.naturalHeight);
			});
			this.watchMedia(img);
		}

		const shot = item.shot;
		this.caption.setText(
			shot
				? `${item.path}  ·  shot ${shot.index + 1}  ·  ${formatShotRange(shot.start, shot.end)}`
				: item.path,
		);
		this.counter.setText(`${this.index + 1} / ${this.items.length}`);
	}

	private watchMedia(media: HTMLImageElement | HTMLVideoElement): void {
		// The previous picture's shape is not this one's; hide until measured.
		this.guides.setAspect(0);
		this.mediaObserver = new ResizeObserver(() => this.fitGuides(media));
		this.mediaObserver.observe(media);
		this.meter.attach(media);
	}

	/**
	 * Lays the guides over the picture inside `media`. The element can be
	 * larger than what it shows — a `<video>` letterboxes — so the picture
	 * is found by fitting its aspect into the element's box.
	 */
	private fitGuides(
		media: HTMLImageElement | HTMLVideoElement,
		aspect?: number,
	): void {
		if (aspect !== undefined) this.guides.setAspect(aspect);
		if (!this.guides.hasAspect) return;
		const box = media.getBoundingClientRect();
		const origin = this.root.getBoundingClientRect();
		const fit = containRect(box.width, box.height, this.guides.aspectRatio);
		const picture = {
			x: box.left - origin.left + fit.x,
			y: box.top - origin.top + fit.y,
			w: fit.w,
			h: fit.h,
		};
		this.guides.place(picture);
		this.meter.place(picture);
		this.marks.place(picture);
	}

	/** Shows the film's marks as its note has them. */
	private syncMarks(): void {
		// While a save is on its way the note is behind what is drawn.
		if (!this.markFile || this.pendingSaves > 0) return;
		this.marks.setMarks(this.options.notes.get(this.markFile).marks);
	}

	private async saveMarks(change: MarkChange): Promise<void> {
		const file = this.markFile;
		if (!file) return;
		this.pendingSaves++;
		let saved = false;
		try {
			saved = await this.options.notes.update(file, (notes) => ({
				...notes,
				marks: change(notes.marks),
			}));
		} catch (err) {
			console.error('Cinema canvas: could not save frame marks', err);
		} finally {
			this.pendingSaves--;
		}
		if (!saved)
			new Notice(
				this.options.notes.errorFor(file) ??
					"Frame marks could not be saved to the film's note.",
			);
		this.syncMarks();
	}
}
