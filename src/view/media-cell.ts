import { App, setIcon } from 'obsidian';
import { ThumbnailStore } from '../media/thumbnails';
import { CinemaCanvasSettings } from '../settings';
import { ItemBox, Shot } from '../types';
import { LayoutMetrics } from './layout';
import { SegmentPlayer } from './segment-player';

/** Below this on-screen width a hover preview is not worth a decoder. */
const HOVER_PREVIEW_MIN_WIDTH = 160;

export interface CellContext {
	app: App;
	settings: CinemaCanvasSettings;
	metrics: LayoutMetrics;
	thumbnails: ThumbnailStore;
	/** Told whenever a cell stops inline playback, for any reason. */
	onPlaybackStopped: (cell: MediaCell) => void;
}

/**
 * What the cell is currently showing.
 *
 * `still` is the cached thumbnail. `preview` is the muted, looping hover
 * scrub. `playing` is real inline playback started by a click — it survives
 * the pointer leaving and ends on pause, on end, or when the cell unmounts.
 */
type CellMode = 'still' | 'preview' | 'playing';

/**
 * One cell on the canvas.
 *
 * Owns its element, its outstanding thumbnail request and — only while
 * previewing or playing — a `<video>`. Cells are recycled by item key across
 * relayouts, so an unrelated file change does not re-trigger decode for
 * everything on screen.
 *
 * A cell is always a whole file. Playback can be confined to one shot for the
 * duration of a click — see `playShot` — but the cell's identity, thumbnail and
 * caption never change.
 */
export class MediaCell {
	readonly el: HTMLElement;
	private readonly frame: HTMLElement;
	private readonly img: HTMLImageElement;
	private stub: HTMLElement | null = null;
	private video: HTMLVideoElement | null = null;
	/** Confines inline playback to `activeShot`, to the frame. */
	private segment: SegmentPlayer | null = null;
	private progressFill: HTMLElement | null = null;
	private mode: CellMode = 'still';
	private cancelRequest: (() => void) | null = null;
	/** Tier currently displayed; -1 means nothing loaded yet. */
	private loadedTier = -1;
	private lastScreenWidth = 0;
	/** Tier currently queued, so a pan does not cancel and re-queue it. */
	private pendingTier: number | null = null;
	private destroyed = false;
	private item: ItemBox;
	/** Set while playback is confined to one shot; cleared when it stops. */
	private activeShot: Shot | null = null;

	constructor(
		box: ItemBox,
		private readonly ctx: CellContext,
	) {
		this.el = createDiv({ cls: 'cine-item' });
		this.el.dataset.path = box.item.path;
		this.el.dataset.key = box.item.key;
		this.el.dataset.index = String(box.index);

		this.frame = this.el.createDiv({ cls: 'cine-item-frame' });
		this.img = this.frame.createEl('img', { cls: 'cine-item-media' });
		this.img.alt = box.item.file.name;
		this.img.draggable = false;
		this.img.decoding = 'async';
		this.img.hide();

		if (box.item.kind === 'video') {
			this.el.addClass('is-video');
			const badge = this.frame.createDiv({ cls: 'cine-item-badge' });
			setIcon(badge, 'play');
			if (ctx.settings.hoverPlayVideos) this.attachHoverPreview();
		}

		if (ctx.settings.showFileNames && ctx.metrics.captionHeight > 0) {
			const caption = this.el.createDiv({
				cls: 'cine-item-caption',
				text: box.item.file.name,
			});
			caption.style.height = `${ctx.metrics.captionHeight}px`;
			caption.style.fontSize = `${Math.round(ctx.metrics.captionHeight * 0.46)}px`;
		}

		this.item = box;
		this.place(box);
	}

	get key(): string {
		return this.item.item.key;
	}

	get isVideo(): boolean {
		return this.item.item.kind === 'video';
	}

	get isPlaying(): boolean {
		return this.mode === 'playing';
	}

	/** Moves the cell after a relayout without touching its media. */
	place(box: ItemBox): void {
		this.item = box;
		this.el.dataset.index = String(box.index);
		this.el.style.left = `${box.x}px`;
		this.el.style.top = `${box.y}px`;
		this.el.style.width = `${box.w}px`;
		this.el.style.height = `${box.h}px`;
		this.frame.style.height = `${this.ctx.metrics.cellHeight}px`;
	}

	setSelected(selected: boolean): void {
		this.el.toggleClass('is-selected', selected);
	}

	/**
	 * Points the cell at the best source for its current on-screen size, and
	 * queues a sharper one if the cache is cold.
	 *
	 * @param priority distance from the viewport centre; lower renders first.
	 */
	update(screenWidth: number, priority: number): void {
		if (this.destroyed) return;
		// Ignore jitter; only react to a real change of scale.
		if (
			this.loadedTier > 0 &&
			Math.abs(screenWidth - this.lastScreenWidth) < screenWidth * 0.25
		)
			return;
		this.lastScreenWidth = screenWidth;

		const { url, tier, upgrade } = this.ctx.thumbnails.resolve(
			this.item.item,
			screenWidth,
		);
		if (url && tier >= this.loadedTier) this.showImage(url, tier);
		else if (!url) this.showStub();

		if (upgrade === null) {
			this.cancelRequest?.();
			this.cancelRequest = null;
			this.pendingTier = null;
			return;
		}
		// Already waiting on exactly this tier: leave the job where it is.
		if (this.pendingTier === upgrade && this.cancelRequest) return;

		this.cancelRequest?.();
		this.pendingTier = upgrade;
		this.cancelRequest = this.ctx.thumbnails.request(
			this.item.item,
			upgrade,
			priority,
			(ready) => {
				this.cancelRequest = null;
				this.pendingTier = null;
				if (this.destroyed) return;
				if (ready) this.showImage(ready, upgrade);
				else if (this.loadedTier < 0) this.showStub();
			},
		);
	}

	// --- inline playback --------------------------------------------------

	/**
	 * Swaps the still for a playing `<video>`, or back again.
	 *
	 * A hover preview already on screen is promoted in place rather than
	 * restarted, so clicking mid-scrub keeps the position.
	 *
	 * @returns true when the cell is now playing.
	 */
	togglePlayback(): boolean {
		if (!this.isVideo || this.destroyed) return false;
		if (this.mode === 'playing') {
			this.stopPlayback();
			return false;
		}
		this.activeShot = null;

		const video =
			this.mode === 'preview' && this.video
				? this.video
				: this.createVideo();
		this.startPlaying(video);
		return true;
	}

	/**
	 * Plays just `shot`, then swaps back to the still.
	 *
	 * Restarts from the head of the shot even when the cell is already playing,
	 * so clicking the same strip item twice replays it rather than toggling.
	 *
	 * @returns true when the cell is now playing.
	 */
	playShot(shot: Shot): boolean {
		if (!this.isVideo || this.destroyed) return false;
		if (this.mode === 'playing') this.stopPlayback();
		this.activeShot = shot;

		const video =
			this.mode === 'preview' && this.video
				? this.video
				: this.createVideo();
		// `startPlaying` seeks into the shot's first frame, for a preview
		// video and a fresh one alike.
		this.startPlaying(video);
		return this.mode === 'playing';
	}

	/** Unmutes, wires the progress bar, and starts the given `<video>`. */
	private startPlaying(video: HTMLVideoElement): void {
		this.mode = 'playing';
		this.el.addClass('is-playing');
		this.img.hide();

		video.muted = false;
		video.loop = false;
		video.removeClass('cine-item-preview');
		// `pause` covers both an explicit stop and the end of the clip, which
		// is exactly the swap back to the still the grid should do.
		video.addEventListener('pause', () => this.stopPlayback());
		video.addEventListener('ended', () => this.stopPlayback());
		// A shot ends where the next one begins. Pausing on its last frame is
		// what swaps the cell back to its still — through the `pause` listener
		// above — and it has to be judged per frame: `timeupdate` arrives up to
		// a quarter of a second late, which is several frames of the next shot.
		this.segment?.destroy();
		this.segment = new SegmentPlayer(video, {
			loop: () => false,
			onFrame: () => this.renderProgress(video),
		});
		if (this.activeShot) this.segment.play(this.activeShot);

		this.progressFill = this.frame
			.createDiv({ cls: 'cine-item-progress' })
			.createDiv({ cls: 'cine-item-progress-fill' });

		void video.play().catch(() => {
			// A codec the runtime lacks, or the file went away mid-click.
			this.stopPlayback();
		});
	}

	/** Swaps back to the still. Safe to call when nothing is playing. */
	stopPlayback(): void {
		if (this.mode !== 'playing') return;
		// Set first: tearing the element down fires `pause` re-entrantly.
		this.mode = 'still';
		this.activeShot = null;
		this.el.removeClass('is-playing');
		this.teardownVideo();
		this.progressFill?.parentElement?.remove();
		this.progressFill = null;
		if (!this.destroyed && this.loadedTier >= 0) this.img.show();
		this.ctx.onPlaybackStopped(this);
	}

	destroy(): void {
		const wasPlaying = this.mode === 'playing';
		this.destroyed = true;
		this.mode = 'still';
		this.cancelRequest?.();
		this.cancelRequest = null;
		this.pendingTier = null;
		this.teardownVideo();
		// Dropping the src lets the decoded bitmap go straight away instead of
		// lingering until the element is collected.
		this.img.removeAttribute('src');
		this.el.remove();
		if (wasPlaying) this.ctx.onPlaybackStopped(this);
	}

	// --- internals --------------------------------------------------------

	private showImage(url: string, tier: number): void {
		if (this.img.src !== url) this.img.src = url;
		if (this.mode !== 'playing') this.img.show();
		this.loadedTier = tier;
		this.stub?.remove();
		this.stub = null;
		this.el.removeClass('is-loading');
	}

	private showStub(): void {
		if (this.stub) return;
		this.stub = this.frame.createDiv({ cls: 'cine-item-stub' });
		setIcon(this.stub, this.isVideo ? 'film' : 'image');
		this.el.addClass('is-loading');
	}

	private createVideo(): HTMLVideoElement {
		this.teardownVideo();
		const video = this.frame.createEl('video', {
			cls: 'cine-item-media cine-item-video',
		});
		video.src = this.ctx.app.vault.getResourcePath(this.item.item.file);
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.controls = false;
		this.video = video;
		return video;
	}

	private teardownVideo(): void {
		this.segment?.destroy();
		this.segment = null;
		const video = this.video;
		if (!video) return;
		this.video = null;
		video.pause();
		video.removeAttribute('src');
		video.load();
		video.remove();
	}

	private renderProgress(video: HTMLVideoElement): void {
		if (!this.progressFill) return;
		const shot = this.activeShot;
		const start = shot ? shot.start : 0;
		const end = shot
			? shot.end
			: Number.isFinite(video.duration)
				? video.duration
				: 0;
		const span = end - start;
		const ratio = span > 0 ? (video.currentTime - start) / span : 0;
		this.progressFill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
	}

	private attachHoverPreview(): void {
		this.el.addEventListener('pointerenter', () => {
			if (this.destroyed || this.mode !== 'still') return;
			if (this.lastScreenWidth < HOVER_PREVIEW_MIN_WIDTH) return;
			const video = this.createVideo();
			video.addClass('cine-item-preview');
			video.loop = true;
			this.mode = 'preview';
			void video.play().catch(() => {
				// Autoplay policy or a missing codec; the still stays put.
				if (this.mode === 'preview') {
					this.mode = 'still';
					this.teardownVideo();
				}
			});
		});
		this.el.addEventListener('pointerleave', () => {
			// Click-started playback deliberately outlives the pointer.
			if (this.mode !== 'preview') return;
			this.mode = 'still';
			this.teardownVideo();
		});
	}
}
