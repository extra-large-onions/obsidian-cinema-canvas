import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type CinemaCanvasPlugin from '../main';
import { DETECTOR_LABELS, Detector } from '../media/shots';
import { MediaItem, Shot } from '../types';
import { formatTimecode } from '../utils/timecode';
import {
	ParamHost,
	renderDetectorButtons,
	renderParams,
	shotStats,
} from './shot-controls';

export const VIEW_TYPE_CINEMA_CLIP = 'cinema-clip';

/** Thumbnail tier is picked from this; the grid cards are about this wide. */
const CARD_SCREEN_WIDTH = 240;

/**
 * A whole tab given over to one clip and its segments.
 *
 * The canvas answers "which file", and the strip along its bottom answers
 * "where in the file" while you are still looking at everything else. This view
 * answers neither: it assumes you have already chosen the clip, and spends the
 * entire tab on its structure — the player, the shape of the edit, and every
 * segment laid out at once rather than in a row you have to scroll.
 *
 * Three things share one playhead:
 *
 * - the player, which you can scrub freely,
 * - the ribbon, where each segment is as wide as it is long, so the cutting
 *   rhythm is visible as a shape rather than as a list of numbers,
 * - the grid, one card per segment.
 *
 * Whatever is under the playhead is highlighted in all three, wherever the
 * playhead came from.
 */
export class CinemaClipView extends ItemView {
	private readonly plugin: CinemaCanvasPlugin;

	private headerEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private actionEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private video: HTMLVideoElement | null = null;
	private ribbonEl!: HTMLElement;
	private playheadEl!: HTMLElement;
	private bodyEl!: HTMLElement;

	private path: string | null = null;
	private item: MediaItem | null = null;
	/** The segment playback is confined to, if any. */
	private confined: Shot | null = null;
	/** The segment under the playhead, confined or not. */
	private activeIndex: number | null = null;
	private loopSegment = false;

	private unsubscribe: (() => void) | null = null;
	private unsubscribeIndex: (() => void) | null = null;
	private cancels: (() => void)[] = [];
	private frame: number | null = null;
	/** True while a cutting slider is being dragged; see ShotStrip. */
	private adjusting = false;

	private readonly paramHost: ParamHost;

	constructor(leaf: WorkspaceLeaf, plugin: CinemaCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
		this.loopSegment = plugin.settings.loopLightboxVideos;
		this.paramHost = {
			getParams: () => ({
				shotThreshold: this.plugin.settings.shotThreshold,
				transnetThreshold: this.plugin.settings.transnetThreshold,
				minShotLength: this.plugin.settings.minShotLength,
			}),
			setParam: (key, value) => this.plugin.setShotParam(key, value),
			hold: () => {
				this.adjusting = true;
			},
			release: () => {
				if (!this.adjusting) return;
				this.adjusting = false;
				this.render();
			},
		};
	}

	getViewType(): string {
		return VIEW_TYPE_CINEMA_CLIP;
	}

	getDisplayText(): string {
		return this.item ? this.item.file.name : 'Clip';
	}

	override getIcon(): string {
		return 'film';
	}

	// --- lifecycle --------------------------------------------------------

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('cine-clip-view');
		root.tabIndex = 0;

		this.headerEl = root.createDiv({ cls: 'cine-clip-header' });
		this.summaryEl = this.headerEl.createDiv({ cls: 'cine-clip-summary' });
		this.actionEl = this.headerEl.createDiv({ cls: 'cine-clip-actions' });

		this.stageEl = root.createDiv({ cls: 'cine-clip-stage' });

		this.ribbonEl = root.createDiv({ cls: 'cine-clip-ribbon' });
		this.playheadEl = this.ribbonEl.createDiv({
			cls: 'cine-clip-playhead',
		});

		this.bodyEl = root.createDiv({ cls: 'cine-clip-body' });

		this.registerDomEvent(root, 'keydown', (e) => this.onKeyDown(e));

		this.unsubscribe = this.plugin.shots.onChange(() =>
			this.scheduleRender(),
		);
		// A rename or delete invalidates the item this view is pointed at, and
		// the path is the only thing it holds across a restart.
		this.unsubscribeIndex = this.plugin.index.onChange(() => {
			this.resolveItem();
			this.scheduleRender();
		});

		this.render();
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeIndex?.();
		this.unsubscribeIndex = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.clearCards();
		this.video?.pause();
		this.video = null;
	}

	/**
	 * The leaf stores the vault path, not the item.
	 *
	 * Obsidian restores view state from disk on restart, long before the media
	 * index has scanned anything, so the item is resolved lazily and re-resolved
	 * whenever the index changes.
	 */
	override getState(): Record<string, unknown> {
		return { path: this.path ?? undefined };
	}

	override async setState(
		state: unknown,
		result: { history: boolean },
	): Promise<void> {
		const path =
			typeof state === 'object' && state !== null
				? (state as { path?: unknown }).path
				: undefined;
		if (typeof path === 'string' && path !== this.path) {
			this.path = path;
			this.confined = null;
			this.activeIndex = null;
			this.video = null;
			this.resolveItem();
			this.render();
		}
		await super.setState(state, result);
	}

	/** Points this view at a clip. */
	setClip(item: MediaItem): void {
		if (item.path === this.path) return;
		this.path = item.path;
		this.item = item;
		this.confined = null;
		this.activeIndex = null;
		this.video = null;
		this.render();
	}

	private resolveItem(): void {
		if (!this.path) return;
		this.item = this.plugin.index.getItem(this.path) ?? null;
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
		if (!this.item) this.resolveItem();
		const item = this.item;
		if (!item) {
			this.renderMissing();
			return;
		}

		const shots = this.plugin.shots.get(item);

		// Mid-drag the header has to survive: the slider being dragged is in
		// it. Only the parts below are redrawn.
		if (!this.adjusting) {
			this.actionEl.empty();
			this.renderActions(item, shots);
		}
		this.renderSummary(item, shots);
		this.ensureVideo(item);
		this.renderRibbon(item, shots);
		this.renderCards(item, shots);
	}

	private renderMissing(): void {
		this.actionEl.empty();
		this.stageEl.empty();
		this.ribbonEl.hide();
		this.clearCards();
		this.summaryEl.setText(
			this.path
				? `${this.path} is not in the index.`
				: 'No clip. Open one from the canvas.',
		);
		this.bodyEl.createDiv({
			cls: 'cine-clip-placeholder',
			text: this.path
				? 'The file may have been renamed, deleted, or excluded by the folder scope in settings.'
				: 'Select a clip on the canvas and press the segments button in the strip along the bottom.',
		});
	}

	private renderSummary(item: MediaItem, shots: Shot[] | null): void {
		const pending = this.plugin.shots.pendingDetector(item);
		if (pending) {
			const progress = this.plugin.shots.progressFor(item);
			const percent =
				progress === null ? '' : ` ${Math.round(progress * 100)}%`;
			this.summaryEl.setText(
				`${item.file.name} — ${DETECTOR_LABELS[pending]} is finding cuts…${percent}`,
			);
			return;
		}
		if (!shots || shots.length === 0) {
			const error = this.plugin.shots.errorFor(item);
			this.summaryEl.setText(
				error ? `${item.file.name} — ${error}` : item.file.name,
			);
			return;
		}
		const stats = shotStats(shots);
		const detector = this.plugin.shots.detectorFor(item);
		this.summaryEl.setText(
			[
				item.file.name,
				...(detector ? [DETECTOR_LABELS[detector]] : []),
				`${shots.length} segment${shots.length === 1 ? '' : 's'}`,
				`${stats.average.toFixed(1)}s avg`,
				`${stats.shortest.toFixed(1)}s – ${stats.longest.toFixed(1)}s`,
				formatTimecode(stats.total),
			].join('  ·  '),
		);
		setTooltip(this.summaryEl, item.path, { placement: 'bottom' });
	}

	private renderActions(item: MediaItem, shots: Shot[] | null): void {
		const detector = this.plugin.shots.detectorFor(item);
		const cut = shots !== null && shots.length > 0;

		if (cut) renderParams(this.actionEl, detector, this.paramHost);

		renderDetectorButtons(this.actionEl, item, detector, !cut, {
			shots: this.plugin.shots,
			run: (target, next) => void this.detect(target, next, false),
			show: (target, next) => {
				this.plugin.shots.prefer(target, next);
				this.activeIndex = null;
			},
		});

		if (!cut) return;

		const loop = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		loop.toggleClass('is-active', this.loopSegment);
		setIcon(loop, 'repeat');
		setTooltip(
			loop,
			this.loopSegment
				? 'A segment repeats until you pick another one'
				: 'A segment plays once and pauses at its last frame',
			{ placement: 'bottom' },
		);
		loop.addEventListener('click', () => {
			this.loopSegment = !this.loopSegment;
			this.render();
		});

		const again = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(again, 'refresh-cw');
		setTooltip(
			again,
			detector
				? `Run ${DETECTOR_LABELS[detector]} over this clip again`
				: 'Find cuts again',
			{ placement: 'bottom' },
		);
		again.addEventListener('click', () => {
			if (detector) void this.detect(item, detector, true);
		});

		const expand = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(expand, 'expand');
		setTooltip(expand, 'Full screen player', { placement: 'bottom' });
		expand.addEventListener('click', () => void this.toggleFullscreen());
	}

	/**
	 * Builds the player once per clip and keeps it.
	 *
	 * Re-creating it on every render would restart the video every time a
	 * slider moved, which is the one thing this view must never do: the whole
	 * point is watching the same frame while the cuts around it change.
	 */
	private ensureVideo(item: MediaItem): void {
		if (this.video && this.video.dataset.path === item.path) return;
		this.stageEl.empty();
		const video = this.stageEl.createEl('video', {
			cls: 'cine-clip-video',
		});
		video.dataset.path = item.path;
		video.src = this.app.vault.getResourcePath(item.file);
		video.controls = true;
		video.playsInline = true;
		video.preload = 'metadata';
		video.addEventListener('timeupdate', () => this.onTimeUpdate());
		video.addEventListener('seeked', () => this.onTimeUpdate());
		this.video = video;
	}

	/**
	 * The ribbon: every segment as wide as it is long.
	 *
	 * This is the one place in the plugin where shot length is drawn to scale.
	 * The grid below deliberately gives a 0.4s shot and a 40s shot the same
	 * card, because there it is a thing to click; here it is the edit itself,
	 * and a run of quick cuts should *look* like a run of quick cuts.
	 */
	private renderRibbon(item: MediaItem, shots: Shot[] | null): void {
		this.ribbonEl.empty();
		this.playheadEl = this.ribbonEl.createDiv({ cls: 'cine-clip-playhead' });
		if (!shots || shots.length === 0) {
			this.ribbonEl.hide();
			return;
		}
		this.ribbonEl.show();

		const duration = shots[shots.length - 1]?.end ?? 0;
		if (duration <= 0) return;

		for (const shot of shots) {
			const block = this.ribbonEl.createDiv({ cls: 'cine-clip-block' });
			block.dataset.index = String(shot.index);
			const width = ((shot.end - shot.start) / duration) * 100;
			block.style.width = `${width}%`;
			setTooltip(
				block,
				`Segment ${shot.index + 1} · ${formatTimecode(shot.start)} · ${(shot.end - shot.start).toFixed(2)}s`,
				{ placement: 'top' },
			);
			block.addEventListener('click', () => this.playShot(item, shot));
		}
		// The playhead element is new, so its position has to be restored now
		// rather than on the next timeupdate a quarter of a second later.
		this.syncPlayhead(this.video?.currentTime ?? 0);
		this.applyActive();
	}

	private renderCards(item: MediaItem, shots: Shot[] | null): void {
		this.clearCards();

		const pending = this.plugin.shots.pendingDetector(item);
		if (pending) {
			this.bodyEl.createDiv({ cls: 'cine-clip-spinner-row' }).createDiv({
				cls: 'cine-strip-spinner',
			});
			return;
		}
		if (!shots || shots.length === 0) {
			this.bodyEl.createDiv({
				cls: 'cine-clip-placeholder',
				text: 'No segments yet. Pick a detector above: ffmpeg is seconds, TransNetV2 is about a minute and a half per six minutes of video and far fewer false cuts.',
			});
			return;
		}

		const grid = this.bodyEl.createDiv({ cls: 'cine-clip-grid' });
		for (const shot of shots) this.renderCard(grid, item, shot);
		this.applyActive();
	}

	private renderCard(
		parent: HTMLElement,
		item: MediaItem,
		shot: Shot,
	): void {
		const el = parent.createDiv({ cls: 'cine-clip-card' });
		el.dataset.index = String(shot.index);

		const frame = el.createDiv({ cls: 'cine-clip-frame' });
		const img = frame.createEl('img', { cls: 'cine-clip-thumb' });
		img.alt = `Segment ${shot.index + 1}`;
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
		const resolved = this.plugin.thumbnails.resolve(
			shotItem,
			CARD_SCREEN_WIDTH,
		);
		if (resolved.url) {
			img.src = resolved.url;
			img.show();
		} else {
			this.cancels.push(
				this.plugin.thumbnails.request(
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
			cls: 'cine-clip-number',
			text: String(shot.index + 1),
		});
		frame.createDiv({
			cls: 'cine-clip-duration',
			text: `${(shot.end - shot.start).toFixed(1)}s`,
		});

		const meta = el.createDiv({ cls: 'cine-clip-meta' });
		meta.createSpan({
			cls: 'cine-clip-time',
			text: formatTimecode(shot.start),
		});
		if (shot.score > 0)
			meta.createSpan({
				cls: 'cine-clip-score',
				text: shot.score.toFixed(0),
			});

		setTooltip(
			el,
			`Segment ${shot.index + 1} · ${formatTimecode(shot.start)} to ${formatTimecode(shot.end)} · ${(shot.end - shot.start).toFixed(2)}s${shot.score > 0 ? ` · cut score ${shot.score.toFixed(1)}` : ''}`,
			{ placement: 'top' },
		);

		el.addEventListener('click', () => this.playShot(item, shot));
	}

	// --- playback ---------------------------------------------------------

	/** Seeks to a segment and plays it, confined to its own range. */
	private playShot(item: MediaItem, shot: Shot): void {
		const video = this.video;
		if (!video) return;
		this.confined = shot;
		this.setActive(shot.index);
		const start = (): void => {
			video.currentTime = shot.start;
			void video.play().catch(() => {
				// Autoplay can be refused before any user gesture reaches the
				// document; the seek still happened, so the frame is right.
			});
		};
		if (video.readyState >= 1) start();
		else video.addEventListener('loadedmetadata', start, { once: true });
	}

	private onTimeUpdate(): void {
		const video = this.video;
		if (!video) return;
		const shot = this.confined;
		if (shot && video.currentTime >= shot.end) {
			if (this.loopSegment) video.currentTime = shot.start;
			else video.pause();
		}
		this.syncPlayhead(video.currentTime);
	}

	/**
	 * Moves the playhead and the highlight to wherever the video actually is.
	 *
	 * Scrubbing the player is deliberately not confined to the current segment
	 * — seeing what surrounds a cut is most of why you would open this view —
	 * so the highlight follows the playhead rather than the last thing clicked.
	 */
	private syncPlayhead(time: number): void {
		const item = this.item;
		const shots = item ? this.plugin.shots.get(item) : null;
		if (!shots || shots.length === 0) return;

		const duration = shots[shots.length - 1]?.end ?? 0;
		if (duration > 0)
			this.playheadEl.style.left = `${Math.min(100, Math.max(0, (time / duration) * 100))}%`;

		const found = shots.findIndex((s) => time >= s.start && time < s.end);
		if (found >= 0 && found !== this.activeIndex) {
			// A playhead that walked out of the confined segment means the user
			// scrubbed away from it; confinement should not drag them back.
			if (this.confined && this.confined.index !== found)
				this.confined = null;
			this.setActive(found);
		}
	}

	private setActive(index: number | null): void {
		if (this.activeIndex === index) return;
		this.activeIndex = index;
		this.applyActive();
	}

	private applyActive(): void {
		const mark = (el: Element, scroll: boolean): void => {
			if (!el.instanceOf(HTMLElement)) return;
			const active = Number(el.dataset.index) === this.activeIndex;
			el.toggleClass('is-active', active);
			if (active && scroll)
				el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		};
		for (const block of Array.from(this.ribbonEl.children))
			mark(block, false);
		const grid = this.bodyEl.querySelector('.cine-clip-grid');
		if (grid) for (const card of Array.from(grid.children)) mark(card, true);
	}

	/** Steps to the next or previous segment and plays it. */
	step(delta: number): boolean {
		const item = this.item;
		const shots = item ? this.plugin.shots.get(item) : null;
		if (!item || !shots || shots.length === 0) return false;
		const next =
			this.activeIndex === null
				? delta > 0
					? 0
					: shots.length - 1
				: (this.activeIndex + delta + shots.length) % shots.length;
		const shot = shots[next];
		if (!shot) return false;
		this.playShot(item, shot);
		return true;
	}

	togglePlayback(): void {
		const video = this.video;
		if (!video) return;
		if (video.paused) void video.play().catch(() => undefined);
		else video.pause();
	}

	async toggleFullscreen(): Promise<void> {
		try {
			if (activeDocument.fullscreenElement === this.stageEl)
				await activeDocument.exitFullscreen();
			else await this.stageEl.requestFullscreen();
		} catch {
			// Fullscreen can be refused (embedded contexts, gesture rules).
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		// The player's own controls own the arrow keys once it has focus.
		if (e.target instanceof HTMLVideoElement) return;
		if (e.target instanceof HTMLInputElement) return;
		switch (e.key) {
			case 'ArrowRight':
			case 'j':
				if (this.step(1)) e.preventDefault();
				break;
			case 'ArrowLeft':
			case 'k':
				if (this.step(-1)) e.preventDefault();
				break;
			case ' ':
				this.togglePlayback();
				e.preventDefault();
				break;
			case 'l':
				this.loopSegment = !this.loopSegment;
				this.render();
				break;
			case 'f':
				void this.toggleFullscreen();
				break;
			default:
				break;
		}
	}

	// --- detection --------------------------------------------------------

	private async detect(
		item: MediaItem,
		detector: Detector,
		force: boolean,
	): Promise<void> {
		if (detector === 'transnet' && !(await this.plugin.shots.hasModel())) {
			new Notice(
				'Cinema canvas: the TransNetV2 model is not downloaded yet. Settings → Shot detection → Download.',
				10000,
			);
			return;
		}
		this.render();
		const shots = await this.plugin.shots.detect(item, detector, force);
		if (!shots) {
			const reason = this.plugin.shots.errorFor(item, detector);
			new Notice(
				reason
					? `Cinema canvas: ${DETECTOR_LABELS[detector]} failed on ${item.file.name}. ${reason}`
					: `Cinema canvas: ${DETECTOR_LABELS[detector]} found no cuts in ${item.file.name} — it may be a single take.`,
				12000,
			);
		}
	}

	private clearCards(): void {
		for (const cancel of this.cancels) cancel();
		this.cancels = [];
		this.bodyEl.empty();
	}
}
