import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type CinemaCanvasPlugin from '../main';
import { GroupBox, ItemBox, LayoutResult, MediaItem, Rect, Shot } from '../types';
import { computeLayout, expand, intersects, layoutMetrics } from './layout';
import { Lightbox } from './lightbox';
import { CellContext, MediaCell } from './media-cell';
import { SpatialIndex } from './spatial-index';
import { ShotStrip } from './shot-strip';
import { Viewport } from './viewport';

export const VIEW_TYPE_CINEMA_CANVAS = 'cinema-canvas';

/** Hard ceiling on live cells, so a fully zoomed-out vault stays responsive. */
const MAX_MOUNTED_ITEMS = 600;
/** New cells built per animation frame; the rest come on later frames. */
const MOUNT_BUDGET = 40;
/** Extra world margin around the viewport that still gets mounted. */
const OVERSCAN = 0.3;

const EMPTY_LAYOUT: LayoutResult = {
	groups: [],
	items: [],
	bounds: { x: 0, y: 0, w: 0, h: 0 },
};

export class CinemaCanvasView extends ItemView {
	private readonly plugin: CinemaCanvasPlugin;

	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private groupLayerEl!: HTMLElement;
	private itemLayerEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private strip!: ShotStrip;

	private viewport!: Viewport;
	private lightbox!: Lightbox;

	private layout: LayoutResult = EMPTY_LAYOUT;
	private spatial = new SpatialIndex([], 1);
	/** Live cells, keyed by item key so relayouts recycle them. */
	private readonly cells = new Map<string, MediaCell>();
	private selectedIndex: number | null = null;
	private frameHandle: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private unsubscribe: (() => void) | null = null;
	private hasFitOnce = false;
	private pendingThumbnails = 0;
	/** Clips whose shot detection has not finished. */
	private pendingShots = 0;
	/** Shared by every cell; rebuilt when display settings change. */
	private cellContext!: CellContext;
	/** At most one clip plays inline at a time. */
	private playingCell: MediaCell | null = null;
	/** True while the lightbox is showing one clip's shots, not the canvas. */
	private shotLightbox = false;

	constructor(leaf: WorkspaceLeaf, plugin: CinemaCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE_CINEMA_CANVAS;
	}

	getDisplayText(): string {
		return 'Cinema canvas';
	}

	override getIcon(): string {
		return 'clapperboard';
	}

	// --- lifecycle --------------------------------------------------------

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('cine-view');

		// The strip below takes real height rather than floating over the
		// canvas, so the viewport and its overlays share a stage that shrinks.
		const stage = root.createDiv({ cls: 'cine-stage' });

		this.viewportEl = stage.createDiv({ cls: 'cine-viewport' });
		this.viewportEl.tabIndex = 0;
		this.worldEl = this.viewportEl.createDiv({ cls: 'cine-world' });
		this.groupLayerEl = this.worldEl.createDiv({
			cls: 'cine-layer cine-group-layer',
		});
		this.itemLayerEl = this.worldEl.createDiv({
			cls: 'cine-layer cine-item-layer',
		});

		this.emptyEl = stage.createDiv({ cls: 'cine-empty' });
		this.emptyEl.hide();

		this.buildToolbar(stage);
		this.statusEl = stage.createDiv({ cls: 'cine-status' });

		this.viewport = new Viewport(
			this.viewportEl,
			this.worldEl,
			() => this.scheduleRefresh(),
			(target) => this.isBackground(target),
		);
		this.viewport.bind((el, type, handler, options) =>
			this.registerDomEvent(el, type, handler, options),
		);

		this.lightbox = new Lightbox(this.app, root, {
			loopVideos: this.plugin.settings.loopLightboxVideos,
			onIndexChange: (index) => this.onLightboxIndex(index),
			onClose: () => this.viewportEl.focus(),
		});

		this.strip = new ShotStrip(
			root,
			this.plugin.shots,
			this.plugin.thumbnails,
			{
				onPlayShot: (item, shot) => this.playShot(item, shot),
				onOpenShot: (item, shot) => this.openShot(item, shot),
				onOpenClip: (item) => void this.plugin.openClip(item),
				getParams: () => ({
					shotThreshold: this.plugin.settings.shotThreshold,
					transnetThreshold: this.plugin.settings.transnetThreshold,
					minShotLength: this.plugin.settings.minShotLength,
				}),
				setParam: (key, value) => this.plugin.setShotParam(key, value),
			},
		);

		this.registerDomEvent(this.viewportEl, 'click', (e) => this.onClick(e));
		this.registerDomEvent(this.viewportEl, 'dblclick', (e) =>
			this.onDoubleClick(e),
		);
		this.registerDomEvent(root, 'keydown', (e) => this.onKeyDown(e));

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.hasFitOnce) this.fitAll(false);
			else this.scheduleRefresh();
		});
		this.resizeObserver.observe(this.viewportEl);

		this.cellContext = this.buildCellContext();

		this.plugin.thumbnails.onProgress((pending) => {
			this.pendingThumbnails = pending;
			this.updateStatus();
		});

		this.plugin.shots.onProgress((pending) => {
			this.pendingShots = pending;
			this.updateStatus();
		});

		this.unsubscribe = this.plugin.index.onChange(() => this.rebuild(false));
		this.rebuild(false);
		this.viewportEl.focus();
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.strip?.destroy();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.frameHandle !== null)
			window.cancelAnimationFrame(this.frameHandle);
		this.frameHandle = null;
		this.viewport?.destroy();
		this.lightbox?.destroy();
		this.destroyAllCells();
		this.contentEl.empty();
	}

	override onResize(): void {
		this.scheduleRefresh();
	}

	/** Called by the plugin when display settings change. */
	refreshSettings(): void {
		this.lightbox.setOptions({
			loopVideos: this.plugin.settings.loopLightboxVideos,
		});
		// Cell geometry and caption state are baked in at construction.
		this.cellContext = this.buildCellContext();
		this.rebuild(true);
	}

	private buildCellContext(): CellContext {
		return {
			app: this.app,
			settings: this.plugin.settings,
			metrics: layoutMetrics(this.plugin.settings),
			thumbnails: this.plugin.thumbnails,
			onPlaybackStopped: (cell) => {
				if (this.playingCell === cell) this.playingCell = null;
			},
		};
	}

	// --- data -------------------------------------------------------------

	private rebuild(dropCells: boolean): void {
		const previousKey = this.selectedItem()?.key ?? null;
		this.layout = computeLayout(
			this.plugin.index.getGroups(),
			this.plugin.settings,
		);
		const m = layoutMetrics(this.plugin.settings);
		this.spatial = new SpatialIndex(
			this.layout.items,
			Math.max(m.cellWidth, m.cellHeight) * 4,
		);

		this.selectedIndex = previousKey
			? (this.layout.items.find((b) => b.item.key === previousKey)
					?.index ?? null)
			: null;

		this.strip.setClip(this.selectedItem());

		this.renderGroups();
		if (dropCells) this.destroyAllCells();
		else this.dropStaleCells();
		this.updateEmptyState();

		if (!this.hasFitOnce && this.layout.items.length > 0) this.fitAll(false);
		else this.scheduleRefresh();

		if (this.lightbox.isOpen)
			this.lightbox.refresh(this.layout.items.map((b) => b.item));
	}

	/** Removes cells whose item left the index; keeps the rest mounted. */
	private dropStaleCells(): void {
		const live = new Set(this.layout.items.map((b) => b.item.key));
		for (const [key, cell] of this.cells) {
			if (live.has(key)) continue;
			cell.destroy();
			this.cells.delete(key);
		}
	}

	private destroyAllCells(): void {
		for (const cell of this.cells.values()) cell.destroy();
		this.cells.clear();
		this.itemLayerEl.empty();
	}

	private updateEmptyState(): void {
		const empty = this.layout.items.length === 0;
		this.emptyEl.toggle(empty);
		if (!empty) return;
		this.emptyEl.empty();
		this.emptyEl.createEl('h3', { text: 'No media found' });
		this.emptyEl.createEl('p', {
			text: `Scanning ${this.plugin.index.scopeDescription}. Drop images or clips into the vault, or widen the folder list in the plugin settings.`,
		});
	}

	// --- rendering --------------------------------------------------------

	private renderGroups(): void {
		this.groupLayerEl.empty();
		const m = layoutMetrics(this.plugin.settings);
		for (const box of this.layout.groups) {
			const el = this.groupLayerEl.createDiv({ cls: 'cine-group' });
			el.dataset.groupIndex = String(box.groupIndex);
			el.style.left = `${box.x}px`;
			el.style.top = `${box.y}px`;
			el.style.width = `${box.w}px`;
			el.style.height = `${box.h}px`;

			const header = el.createDiv({ cls: 'cine-group-header' });
			header.style.height = `${box.headerHeight}px`;
			header.style.fontSize = `${Math.round(box.headerHeight * 0.42)}px`;
			header.style.paddingInline = `${m.groupPadding}px`;
			header.createSpan({ cls: 'cine-group-name', text: box.group.label });
			header.createSpan({
				cls: 'cine-group-count',
				text: String(box.group.items.length),
			});
		}
	}

	private scheduleRefresh(): void {
		if (this.frameHandle !== null) return;
		this.frameHandle = window.requestAnimationFrame(() => {
			this.frameHandle = null;
			const more = this.refreshVisible();
			this.updateStatus();
			// Mounting is budgeted per frame, so keep going next frame.
			if (more) this.scheduleRefresh();
		});
	}

	/** @returns true when cells were left unmounted by the frame budget. */
	private refreshVisible(): boolean {
		const view = this.viewport.visibleWorldRect;
		if (view.w === 0 || view.h === 0) return false;
		const margin = Math.max(view.w, view.h) * OVERSCAN;
		const region = expand(view, margin);

		const cx = view.x + view.w / 2;
		const cy = view.y + view.h / 2;
		const candidates = this.spatial
			.query(region)
			.filter((b) => intersects(b, region))
			.map((b) => ({
				box: b,
				distance: Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy),
			}))
			.sort((a, z) => a.distance - z.distance)
			.slice(0, MAX_MOUNTED_ITEMS);

		// Unmount first so the memory is back before new cells allocate.
		const wanted = new Set(candidates.map((c) => c.box.item.key));
		for (const [key, cell] of this.cells) {
			if (wanted.has(key)) continue;
			cell.destroy();
			this.cells.delete(key);
		}

		const screenWidth = this.cellScreenWidth();
		let budget = MOUNT_BUDGET;
		let deferred = false;
		for (const { box, distance } of candidates) {
			let cell = this.cells.get(box.item.key);
			if (!cell) {
				if (budget <= 0) {
					deferred = true;
					break;
				}
				budget--;
				cell = new MediaCell(box, this.cellContext);
				this.cells.set(box.item.key, cell);
				this.itemLayerEl.appendChild(cell.el);
			}
			cell.place(box);
			cell.setSelected(this.selectedIndex === box.index);
			cell.update(screenWidth, distance);
		}
		return deferred;
	}

	private cellScreenWidth(): number {
		return (
			layoutMetrics(this.plugin.settings).cellWidth * this.viewport.scale
		);
	}

	private updateStatus(): void {
		const total = this.layout.items.length;
		const groups = this.layout.groups.length;
		const zoom = Math.round(this.viewport.scale * 100);
		const selected = this.selectedItem();
		const parts = [
			`${total} item${total === 1 ? '' : 's'}`,
			`${groups} folder${groups === 1 ? '' : 's'}`,
			`${zoom}%`,
		];
		if (this.pendingShots > 0)
			parts.push(`detecting shots in ${this.pendingShots} clip(s)`);
		if (this.pendingThumbnails > 0)
			parts.push(`${this.pendingThumbnails} thumbnails queued`);
		if (selected) parts.push(selected.file.name);
		this.statusEl.setText(parts.join(' · '));
	}

	// --- toolbar ----------------------------------------------------------

	private buildToolbar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: 'cine-toolbar' });
		const add = (
			icon: string,
			tooltip: string,
			action: () => void,
		): HTMLButtonElement => {
			const button = bar.createEl('button', {
				cls: 'cine-toolbar-button',
			});
			setIcon(button, icon);
			setTooltip(button, tooltip, { placement: 'bottom' });
			button.addEventListener('click', (e) => {
				e.preventDefault();
				action();
				this.viewportEl.focus();
			});
			return button;
		};

		add('maximize', 'Fit all (0)', () => this.fitAll());
		add('zoom-in', 'Zoom in (+)', () => this.viewport.zoomByStep(1.25));
		add('zoom-out', 'Zoom out (−)', () => this.viewport.zoomByStep(1 / 1.25));
		bar.createDiv({ cls: 'cine-toolbar-divider' });
		add('crosshair', 'Zoom to current (Z)', () => this.zoomToCurrent());
		add('folder-open', 'Zoom to parent folder (Shift+Z)', () =>
			this.zoomToParent(),
		);
		bar.createDiv({ cls: 'cine-toolbar-divider' });
		add('gallery-horizontal-end', 'Show or hide the shot strip (S)', () =>
			this.strip.toggleCollapsed(),
		);
		bar.createDiv({ cls: 'cine-toolbar-divider' });
		add('chevron-left', 'Previous (←)', () => this.step(-1));
		add('chevron-right', 'Next (→)', () => this.step(1));
		add('expand', 'Full screen (F)', () => this.openLightbox());
		bar.createDiv({ cls: 'cine-toolbar-divider' });
		add('refresh-cw', 'Rescan vault', () => {
			this.plugin.thumbnails.resetFailures();
			this.plugin.index.rebuild();
			new Notice(`Cinema canvas: ${this.plugin.index.size} media files`);
		});
	}

	// --- interaction ------------------------------------------------------

	private isBackground(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return true;
		return (
			!target.closest('.cine-item') &&
			!target.closest('.cine-group-header')
		);
	}

	private boxFromEvent(e: Event): ItemBox | null {
		const target = e.target;
		if (!(target instanceof HTMLElement)) return null;
		const itemEl = target.closest('.cine-item');
		if (!(itemEl instanceof HTMLElement)) return null;
		const index = Number(itemEl.dataset.index);
		return this.layout.items[index] ?? null;
	}

	private groupFromEvent(e: Event): GroupBox | null {
		const target = e.target;
		if (!(target instanceof HTMLElement)) return null;
		const header = target.closest('.cine-group-header');
		if (!header) return null;
		const groupEl = header.closest('.cine-group');
		if (!(groupEl instanceof HTMLElement)) return null;
		const index = Number(groupEl.dataset.groupIndex);
		return this.layout.groups[index] ?? null;
	}

	private onClick(e: MouseEvent): void {
		const group = this.groupFromEvent(e);
		if (group) {
			this.viewport.zoomToRect(group, 0.05);
			return;
		}
		const box = this.boxFromEvent(e);
		if (!box) return;
		this.select(box.index, false);
		// Clicking a clip swaps its still for real playback, and back again.
		if (box.item.kind === 'video') this.togglePlaybackAt(box);
	}

	private onDoubleClick(e: MouseEvent): void {
		const box = this.boxFromEvent(e);
		if (box) {
			this.select(box.index, false);
			this.openLightbox();
			return;
		}
		if (this.isBackground(e.target)) this.fitAll();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (this.lightbox.isOpen) {
			switch (e.key) {
				case 'Escape':
					this.lightbox.hide();
					break;
				case 'ArrowRight':
				case 'ArrowDown':
				case 'n':
					this.lightbox.step(1);
					break;
				case 'ArrowLeft':
				case 'ArrowUp':
				case 'p':
					this.lightbox.step(-1);
					break;
				case 'f':
				case 'F11':
					void this.lightbox.toggleNativeFullscreen();
					break;
				default:
					return;
			}
			e.preventDefault();
			return;
		}

		switch (e.key) {
			case 'ArrowRight':
				// Shift walks the shots of the selected clip; plain arrows walk
				// the canvas, which is still one cell per file.
				if (!e.shiftKey || !this.strip.step(1)) this.step(1);
				break;
			case 'ArrowLeft':
				if (!e.shiftKey || !this.strip.step(-1)) this.step(-1);
				break;
			case 'ArrowDown':
				this.stepRow(1);
				break;
			case 'ArrowUp':
				this.stepRow(-1);
				break;
			case 'Home':
				this.select(0, true);
				break;
			case 'End':
				this.select(this.layout.items.length - 1, true);
				break;
			case ' ':
				this.togglePlayback();
				break;
			case 'Enter':
			case 'f':
				this.openLightbox();
				break;
			case 'z':
				if (e.shiftKey) this.zoomToParent();
				else this.zoomToCurrent();
				break;
			case 's':
				this.strip.toggleCollapsed();
				break;
			case '0':
				this.fitAll();
				break;
			case '+':
			case '=':
				this.viewport.zoomByStep(1.25);
				break;
			case '-':
			case '_':
				this.viewport.zoomByStep(1 / 1.25);
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	// --- selection and camera --------------------------------------------

	selectedItem(): MediaItem | null {
		if (this.selectedIndex === null) return null;
		return this.layout.items[this.selectedIndex]?.item ?? null;
	}

	private selectedBox(): ItemBox | null {
		if (this.selectedIndex === null) return null;
		return this.layout.items[this.selectedIndex] ?? null;
	}

	select(index: number, center: boolean): void {
		if (this.layout.items.length === 0) return;
		const next = Math.min(Math.max(index, 0), this.layout.items.length - 1);
		const previous = this.selectedBox();
		if (previous)
			this.cells.get(previous.item.key)?.setSelected(false);
		this.selectedIndex = next;

		const box = this.layout.items[next];
		if (box) {
			this.cells.get(box.item.key)?.setSelected(true);
			if (center) this.centerOn(box);
			else this.ensureVisible(box);
		}
		if (this.lightbox.isOpen && !this.shotLightbox && this.lightbox.currentIndex !== next)
			this.lightbox.show(
				this.layout.items.map((b) => b.item),
				next,
			);
		this.strip.setClip(box?.item ?? null);
		this.updateStatus();
	}

	step(delta: number): void {
		if (this.layout.items.length === 0) return;
		if (this.selectedIndex === null) {
			this.select(delta > 0 ? 0 : this.layout.items.length - 1, false);
			return;
		}
		const count = this.layout.items.length;
		this.select((this.selectedIndex + delta + count) % count, false);
	}

	/** Moves one grid row within the current folder, spilling over at the edges. */
	private stepRow(delta: number): void {
		const box = this.selectedBox();
		if (!box) {
			this.step(delta);
			return;
		}
		const target = this.layout.items.find(
			(b) =>
				b.groupIndex === box.groupIndex &&
				b.row === box.row + delta &&
				b.col === box.col,
		);
		if (target) this.select(target.index, false);
		else this.step(delta > 0 ? box.cols : -box.cols);
	}

	fitAll(animate = true): void {
		if (this.layout.items.length === 0) return;
		const { width, height } = this.viewport.size;
		// A leaf opened in the background has no size yet; leave `hasFitOnce`
		// false so the first real resize still frames the canvas.
		if (width === 0 || height === 0) return;
		this.hasFitOnce = true;
		this.viewport.zoomToRect(this.layout.bounds, 0.03, animate);
	}

	zoomToCurrent(): void {
		const box = this.selectedBox() ?? this.layout.items[0];
		if (!box) return;
		if (this.selectedIndex === null) this.select(box.index, false);
		this.viewport.zoomToRect(box, 0.12);
	}

	zoomToParent(): void {
		const box = this.selectedBox();
		const group = box
			? this.layout.groups[box.groupIndex]
			: this.groupNearestCenter();
		if (group) this.viewport.zoomToRect(group, 0.05);
	}

	openLightbox(): void {
		if (this.layout.items.length === 0) return;
		// The overlay has its own player; do not leave one running underneath.
		this.stopPlayback();
		this.shotLightbox = false;
		if (this.selectedIndex === null) this.select(0, false);
		this.lightbox.show(
			this.layout.items.map((b) => b.item),
			this.selectedIndex ?? 0,
		);
	}

	toggleLightbox(): void {
		if (this.lightbox.isOpen) this.lightbox.hide();
		else this.openLightbox();
	}

	/** Plays or pauses the selected clip in place. */
	togglePlayback(): void {
		const box = this.selectedBox();
		if (box?.item.kind === 'video') this.togglePlaybackAt(box);
	}

	stopPlayback(): void {
		this.playingCell?.stopPlayback();
		this.playingCell = null;
	}

	/**
	 * Plays one shot of `item` in its canvas cell.
	 *
	 * The cell has to exist to play, and it only exists while it is on screen,
	 * so the camera is moved to it first. Nothing is seeked on the file itself —
	 * the cell parks its `<video>` at the shot and pauses at the end.
	 */
	private playShot(item: MediaItem, shot: Shot): void {
		const box = this.layout.items.find((b) => b.item.key === item.key);
		if (!box) return;
		if (this.selectedIndex !== box.index) this.select(box.index, false);
		else this.ensureVisible(box);
		// A cell scrolled off screen is not mounted yet; one refresh pass fixes
		// that, and playback starts on the frame after.
		this.refreshVisible();
		const cell = this.cells.get(box.item.key);
		if (!cell?.isVideo) return;
		if (this.playingCell && this.playingCell !== cell)
			this.playingCell.stopPlayback();
		this.playingCell = cell.playShot(shot) ? cell : null;
	}

	/** Opens the lightbox on one shot, with the clip's other shots as siblings. */
	private openShot(item: MediaItem, shot: Shot): void {
		const shots = this.plugin.shots.get(item);
		if (!shots) return;
		this.stopPlayback();
		this.shotLightbox = true;
		this.lightbox.show(
			shots.map((s) => ({
				...item,
				key: `${item.path}#t=${s.start}`,
				shot: s,
			})),
			shot.index,
		);
	}

	/**
	 * The lightbox reports the index it moved to. That index is a canvas item
	 * normally, but a shot of one clip when opened from the strip, so the two
	 * cases update different things.
	 */
	private onLightboxIndex(index: number): void {
		if (this.shotLightbox) this.strip.setActive(index);
		else this.select(index, false);
	}

	private togglePlaybackAt(box: ItemBox): void {
		const cell = this.cells.get(box.item.key);
		if (!cell?.isVideo) return;
		if (this.playingCell && this.playingCell !== cell)
			this.playingCell.stopPlayback();
		this.playingCell = cell.togglePlayback() ? cell : null;
	}

	private groupNearestCenter(): GroupBox | null {
		const view = this.viewport.visibleWorldRect;
		const cx = view.x + view.w / 2;
		const cy = view.y + view.h / 2;
		let best: GroupBox | null = null;
		let bestDistance = Infinity;
		for (const g of this.layout.groups) {
			const d = Math.hypot(g.x + g.w / 2 - cx, g.y + g.h / 2 - cy);
			if (d < bestDistance) {
				bestDistance = d;
				best = g;
			}
		}
		return best;
	}

	private centerOn(box: Rect): void {
		const { width, height } = this.viewport.size;
		this.viewport.animate(() => {
			this.viewport.x =
				width / 2 - (box.x + box.w / 2) * this.viewport.scale;
			this.viewport.y =
				height / 2 - (box.y + box.h / 2) * this.viewport.scale;
			this.viewport.apply();
		});
	}

	/** Pans the minimum amount needed to bring a cell fully on screen. */
	private ensureVisible(box: Rect): void {
		const view = this.viewport.visibleWorldRect;
		const pad = Math.min(view.w, view.h) * 0.06;
		let dx = 0;
		let dy = 0;
		if (box.x - pad < view.x) dx = view.x - (box.x - pad);
		else if (box.x + box.w + pad > view.x + view.w)
			dx = view.x + view.w - (box.x + box.w + pad);
		if (box.y - pad < view.y) dy = view.y - (box.y - pad);
		else if (box.y + box.h + pad > view.y + view.h)
			dy = view.y + view.h - (box.y + box.h + pad);
		if (dx === 0 && dy === 0) return;

		// A cell larger than the viewport can never fit; centre it instead.
		if (box.w > view.w || box.h > view.h) {
			this.centerOn(box);
			return;
		}
		this.viewport.animate(() =>
			this.viewport.panBy(
				dx * this.viewport.scale,
				dy * this.viewport.scale,
			),
		);
	}
}
