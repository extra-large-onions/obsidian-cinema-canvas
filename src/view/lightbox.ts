import { App, setIcon } from 'obsidian';
import { MediaItem } from '../types';
import { formatShotRange } from '../utils/timecode';
import { SegmentPlayer } from './segment-player';

export interface LightboxOptions {
	loopVideos: boolean;
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

		// Clicking the backdrop (but not the media itself) closes.
		this.root.addEventListener('click', (e) => {
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

	destroy(): void {
		this.clearStage();
		this.root.remove();
	}

	private clearStage(): void {
		this.segment?.destroy();
		this.segment = null;
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
		} else {
			const img = this.stage.createEl('img', {
				cls: 'cine-lightbox-media',
			});
			img.src = src;
			img.alt = item.file.name;
			img.draggable = false;
		}

		const shot = item.shot;
		this.caption.setText(
			shot
				? `${item.path}  ·  shot ${shot.index + 1}  ·  ${formatShotRange(shot.start, shot.end)}`
				: item.path,
		);
		this.counter.setText(`${this.index + 1} / ${this.items.length}`);
	}
}
