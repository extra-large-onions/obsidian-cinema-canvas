import {
	ItemView,
	Menu,
	Notice,
	TAbstractFile,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from 'obsidian';
import type CinemaCanvasPlugin from '../main';
import {
	CutLabel,
	FilmNotes,
	Scene,
	addCuts,
	addScene,
	anchorOf,
	buildScenes,
	deleteScene,
	findScene,
	hasMember,
	labelsByShot,
	newSceneId,
	playRanges,
	removeCuts,
	renameScene,
	restoreScene,
	sceneTitle,
	scenesByShot,
	setLabel,
	shotAt,
} from '../media/scenes';
import { DETECTOR_LABEL } from '../media/shots';
import { DETECTION_SECONDS_PER_SECOND } from '../media/transnet';
import { MediaItem, Shot } from '../types';
import { formatTimecode } from '../utils/timecode';
import { SceneBoard } from './scene-board';
import { ScenePickerModal } from './scene-picker';
import { SegmentPlayer } from './segment-player';
import {
	ParamHost,
	renderFindCuts,
	renderParams,
	shotStats,
} from './shot-controls';
import { SoundCta, SoundPane } from './sound-pane';
import { formatLength } from './sound-lanes';
import { TextPromptModal } from './text-prompt';

export const VIEW_TYPE_CINEMA_CLIP = 'cinema-clip';

/** Thumbnail tier is picked from this; the grid cards are about this wide. */
const CARD_SCREEN_WIDTH = 240;

/**
 * How far outside the scrolled body a card starts fetching its still.
 *
 * A film is a couple of thousand cuts, and every still is a seek into the
 * film. Asking for all of them on open would queue an hour of seeking before
 * the first card you can actually see.
 */
const THUMB_MARGIN = '600px 0px';

/**
 * A scene's colour, by its place in the note: Obsidian's own accent palette,
 * so every theme has already made them readable.
 */
const SCENE_COLORS = [
	'--color-blue',
	'--color-orange',
	'--color-green',
	'--color-purple',
	'--color-red',
	'--color-cyan',
	'--color-yellow',
	'--color-pink',
];

export function sceneColor(scene: Pick<Scene, 'index'>): string {
	return `var(${SCENE_COLORS[scene.index % SCENE_COLORS.length] ?? '--text-accent'})`;
}

/**
 * How the view shows the scene picked in the list: only its own cuts, or the
 * whole film with its cuts highlighted — the first to watch it, the second to
 * see where in the film it comes from and to pick more cuts for it.
 */
export type SceneMode = 'only' | 'all';

/**
 * Which question the tab is answering about the file: where the picture
 * changes, what kinds of scene it is made of, or what you are hearing.
 *
 * All three are about the same file at the same moment, so they are parts of
 * one tab sharing one player and one playhead, not tabs of their own. They
 * are still called halves: the scenes part came later, and it is the cuts
 * half seen another way.
 */
export type ViewHalf = 'cuts' | 'scenes' | 'sound';

/** What one render worked out, kept for the handlers that fire between renders. */
interface Derived {
	item: MediaItem;
	/** Empty until the film has been cut. */
	shots: Shot[];
	scenes: Scene[];
	notes: FilmNotes;
	/** The scene picked in the list; null on No Cut, the whole film. */
	scene: Scene | null;
	/** The scene whose cuts stand out among all the others, if any. */
	highlight: Scene | null;
	/** The cuts the ribbon and the grid show, in film order. */
	shown: Shot[];
	byShot: Map<number, Scene[]>;
	labels: Map<number, CutLabel[]>;
}

/** A card waiting to scroll near the viewport before it asks for its still. */
interface LazyThumb {
	start: () => () => void;
	cancel: (() => void) | null;
	done: boolean;
}

/** One card, and the parts of it a render updates in place. */
interface Card {
	el: HTMLElement;
	label: HTMLElement;
	chips: HTMLElement;
	chipsKey: string;
}

/**
 * Cuts on their way to a scene.
 *
 * Kept here rather than read back from the drag's `dataTransfer`, which the
 * browser only reveals on drop, so a scene row could not light up while the
 * cuts are held over it. A module variable also carries a drag from one cut
 * view tab to another. Times rather than indexes: the tab dropped on resolves
 * them against its own cut list.
 */
let activeDrag: {
	film: string;
	times: number[];
	source: CinemaClipView;
} | null = null;

/**
 * A whole tab given over to one film.
 *
 * The canvas answers "which file", and the strip along its bottom answers
 * "where in the file" while you are still looking at everything else. This view
 * assumes the film is chosen and spends the tab on its structure:
 *
 * - the player, which you can scrub freely,
 * - the ribbon, where every cut is as wide as it is long, so the cutting rhythm
 *   is a shape rather than a list,
 * - the grid, one card per cut, which you select from and drag out of,
 * - the scene list beside the grid: No Cut, meaning the whole film, and then
 *   every scene of it, each a set of cuts you chose.
 *
 * It opens any video in the vault, not only what the canvas indexes: a feature
 * film is usually one big file in a folder of its own.
 *
 * A film is one tab, never a tab per scene. Picking a scene in the list changes
 * what this view shows — only its cuts, or all of them with its own
 * highlighted — while the player, the ribbon and the list stay where they are.
 */
export class CinemaClipView extends ItemView {
	private readonly plugin: CinemaCanvasPlugin;

	private summaryEl!: HTMLElement;
	private actionEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private video: HTMLVideoElement | null = null;
	/** Confines playback to a clicked cut or scene, to the frame. */
	private player: SegmentPlayer | null = null;
	private ribbonEl!: HTMLElement;
	private playheadEl!: HTMLElement;
	private belowEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private panelEl!: HTMLElement;
	/** The two rows the sound half fills, empty until it is first shown. */
	private soundTimelineEl!: HTMLElement;
	private soundBodyEl!: HTMLElement;
	private sound: SoundPane | null = null;
	/** The scenes half, filed under tags; built the first time it is shown. */
	private boardEl!: HTMLElement;
	private board: SceneBoard | null = null;

	private path: string | null = null;
	/** The scene picked in the list, or null for No Cut: the whole film. */
	private sceneId: string | null = null;
	private mode: SceneMode = 'only';
	private half: ViewHalf = 'cuts';
	/** False for an audio file, which has a soundtrack but no picture to cut. */
	private isFilm = false;
	private panelOpen = true;
	private item: MediaItem | null = null;
	private current: Derived | null = null;

	/** The cut under the playhead, confined or not. */
	private activeIndex: number | null = null;
	private activeEls: HTMLElement[] = [];
	/** Cuts picked with Ctrl- and Shift-click, as indexes into the shot list. */
	private selected = new Set<number>();
	/** Where a Shift-click range starts. */
	private selectAnchor: number | null = null;
	/** The shot list the selection's indexes refer to. */
	private selectionShots: Shot[] | null = null;
	private loopSegment = false;
	/** A scene playing cut after cut, and which of its ranges is on. */
	private sequence: {
		ranges: { start: number; end: number }[];
		at: number;
	} | null = null;

	private unsubscribers: (() => void)[] = [];
	private cancels: (() => void)[] = [];
	private readonly lazy = new Map<Element, LazyThumb>();
	private observer: IntersectionObserver | null = null;
	private frame: number | null = null;
	/** True while a cutting slider is being dragged; see ShotStrip. */
	private adjusting = false;
	/** Rebuild key for the header buttons, so none is replaced under the pointer. */
	private actionsKey = '';
	/** Rebuild key for the panel, for the same reason and for drop targets. */
	private panelKey = '';
	private shownTitle = '';

	private readonly cards = new Map<number, Card>();
	/** The shot list and the kind of grid the cards were built for. */
	private cardShots: Shot[] | null = null;
	private cardsKey = '';
	/** Where each shown cut starts along the ribbon, in seconds of shown time. */
	private readonly ribbonAt = new Map<number, number>();
	private ribbonTotal = 0;

	private readonly paramHost: ParamHost;

	constructor(leaf: WorkspaceLeaf, plugin: CinemaCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
		this.loopSegment = plugin.settings.loopLightboxVideos;
		this.paramHost = {
			getParams: () => ({
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
		// The tab is the film. A scene is something shown inside it, and a tab
		// whose name changed every time a row was clicked would be a worse
		// handle on the film than the film's own name.
		return this.item?.file.name ?? this.path?.split('/').pop() ?? 'Cuts';
	}

	override getIcon(): string {
		return this.half === 'sound'
			? 'audio-waveform'
			: this.half === 'scenes'
				? 'tags'
				: 'film';
	}

	// --- lifecycle --------------------------------------------------------

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('cine-clip-view');
		root.tabIndex = 0;

		const header = root.createDiv({ cls: 'cine-clip-header' });
		this.summaryEl = header.createDiv({ cls: 'cine-clip-summary' });
		this.actionEl = header.createDiv({ cls: 'cine-clip-actions' });

		this.stageEl = root.createDiv({ cls: 'cine-clip-stage' });
		this.ribbonEl = root.createDiv({ cls: 'cine-clip-ribbon' });
		this.playheadEl = this.ribbonEl.createDiv({
			cls: 'cine-clip-playhead',
		});
		// The sound half's lanes go here, under the player and above the cards,
		// which is where the ribbon is on the other half. The pane fills this
		// the first time the switch is thrown.
		this.soundTimelineEl = root.createDiv({ cls: 'cine-sound-slot' });
		// The scene list stands beside the cards rather than down the side of
		// the tab: the player and the ribbon keep the full width, and the list
		// costs the grid a column instead of costing them their height.
		const below = root.createDiv({ cls: 'cine-clip-below' });
		this.belowEl = below;
		this.bodyEl = below.createDiv({ cls: 'cine-clip-body' });
		this.panelEl = below.createDiv({ cls: 'cine-scene-panel' });
		this.soundBodyEl = root.createDiv({ cls: 'cine-sound-slot' });
		this.boardEl = root.createDiv();
		this.boardEl.hide();

		// Showing one scene's cuts, the grid takes cuts dragged in from another
		// view of the same film.
		this.dropTarget(
			this.bodyEl,
			(drag) =>
				drag.source !== this &&
				(this.current?.scene ?? null) !== null &&
				this.mode === 'only',
			(cuts) => {
				const scene = this.current?.scene;
				if (scene) void this.addToScene(scene.id, cuts);
			},
		);

		this.registerDomEvent(root, 'keydown', (e) => this.onKeyDown(e));

		// Full screen changes the width of the lanes without resizing the leaf,
		// and the pane's own observer can miss the transition either way.
		this.registerDomEvent(root, 'fullscreenchange', () =>
			this.sound?.onResize(),
		);

		this.unsubscribers.push(
			this.plugin.shots.onChange(() => this.scheduleRender()),
			this.plugin.sound.onChange(() => this.scheduleRender()),
			this.plugin.scenes.onChange(() => this.scheduleRender()),
		);
		this.registerEvent(
			this.app.workspace.on('css-change', () => this.sound?.clearColors()),
		);
		// Leaving this tab pauses the film. A player going on under another tab
		// is never what you meant, and on a two-hour file it is a decoder and a
		// soundtrack running for nothing. The frame is kept, so coming back and
		// pressing space carries on from where you were.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf !== this.leaf) this.pauseForNow();
			}),
		);
		// The view holds a vault path, not a canvas item, so it follows the
		// file itself: a film is usually outside the canvas folders.
		const vault = this.app.vault;
		this.registerEvent(
			vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)),
		);
		const touched = (file: TAbstractFile): void => {
			if (file.path !== this.path) return;
			this.item = null;
			this.scheduleRender();
		};
		this.registerEvent(vault.on('delete', touched));
		this.registerEvent(vault.on('modify', touched));

		this.render();
	}

	override async onClose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers = [];
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		if (activeDrag?.source === this) activeDrag = null;
		this.sound?.destroy();
		this.sound = null;
		this.board?.destroy();
		this.board = null;
		this.clearCards();
		this.dropVideo();
	}

	/** Obsidian's own signal that the leaf changed size; the lanes need it. */
	override onResize(): void {
		this.sound?.onResize();
	}

	/**
	 * The leaf stores the vault path and, when a scene is picked, its id and
	 * how the view is showing it. Defaults are left out, so a film with nothing
	 * picked is only its path.
	 *
	 * Obsidian restores view state from disk on restart, before anything has
	 * been scanned, so the file is resolved lazily on every render.
	 */
	override getState(): Record<string, unknown> {
		return {
			path: this.path ?? undefined,
			half: this.half === 'cuts' ? undefined : this.half,
			scene: this.sceneId ?? undefined,
			mode: this.sceneId !== null && this.mode === 'all' ? 'all' : undefined,
			panel: this.panelOpen ? undefined : false,
		};
	}

	override async setState(
		state: unknown,
		result: { history: boolean },
	): Promise<void> {
		const { path, half, scene, mode, panel } = (
			typeof state === 'object' && state !== null ? state : {}
		) as {
			path?: unknown;
			half?: unknown;
			scene?: unknown;
			mode?: unknown;
			panel?: unknown;
		};
		const sceneId = typeof scene === 'string' && scene !== '' ? scene : null;
		const nextHalf: ViewHalf =
			half === 'sound' || half === 'scenes' ? half : 'cuts';
		const nextMode: SceneMode = mode === 'all' ? 'all' : 'only';
		const panelOpen = panel !== false;
		if (
			typeof path === 'string' &&
			(path !== this.path ||
				nextHalf !== this.half ||
				sceneId !== this.sceneId ||
				nextMode !== this.mode ||
				panelOpen !== this.panelOpen)
		) {
			if (path !== this.path) {
				this.dropVideo();
				this.item = null;
			}
			if (path !== this.path || sceneId !== this.sceneId) {
				this.activeIndex = null;
				this.clearSelection(false);
			}
			this.path = path;
			this.half = nextHalf;
			this.sceneId = sceneId;
			this.mode = nextMode;
			this.panelOpen = panelOpen;
			this.actionsKey = '';
			this.render();
		}
		await super.setState(state, result);
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		if (oldPath !== this.path) return;
		this.path = file.path;
		this.item = null;
		this.actionsKey = '';
		this.panelKey = '';
		// The resource URL names the old path.
		this.dropVideo();
		this.scheduleRender();
	}

	private dropVideo(): void {
		this.player?.destroy();
		this.player = null;
		this.sequence = null;
		this.video?.pause();
		this.video = null;
	}

	/**
	 * The file this tab is about, and which halves it has.
	 *
	 * The sound half opens anything with an audio track, a file with no picture
	 * included; the cuts half needs a video. An audio file therefore lands on
	 * the sound half and has no switch to throw.
	 */
	private resolveItem(): MediaItem | null {
		const file = this.path ? this.app.vault.getFileByPath(this.path) : null;
		this.isFilm = file !== null && this.plugin.isVideoFile(file);
		const usable = this.isFilm || (file !== null && this.plugin.isSoundFile(file));
		if (!this.isFilm && this.half !== 'sound') this.half = 'sound';
		this.item = usable && file ? this.plugin.itemForFile(file) : null;
		return this.item;
	}

	/** Changes something `getState` records, and asks Obsidian to save it. */
	private saveState(): void {
		this.actionsKey = '';
		this.panelKey = '';
		this.render();
		this.app.workspace.requestSaveLayout?.();
	}

	// --- rendering --------------------------------------------------------

	private scheduleRender(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.render();
		});
	}

	render(): void {
		const item = this.item ?? this.resolveItem();
		if (!item) {
			this.current = null;
			this.renderMissing();
			this.refreshHeader();
			return;
		}

		// One file, three questions, one player. The sound and scenes halves
		// keep the header and the picture, and swap everything under them.
		if (this.half === 'sound') {
			this.boardEl.hide();
			this.renderSoundHalf(item);
			return;
		}
		this.soundTimelineEl.hide();
		this.soundBodyEl.hide();
		this.stageEl.removeClass('cine-sound-stage');

		const shots = this.plugin.shots.get(item) ?? [];
		// Selected indexes name positions in one cut list; a re-cut renumbers.
		if (shots !== this.selectionShots) {
			this.selectionShots = shots;
			this.selected.clear();
			this.selectAnchor = null;
		}
		const notes = this.plugin.scenes.get(item.file);
		const loaded = this.plugin.scenes.isLoaded(item.file);
		const scenes = buildScenes(shots, notes.scenes);
		// A scene deleted from the note — in another view, or by hand — leaves
		// this one on No Cut, rather than on an empty grid it cannot explain.
		// Only once the note is in: on restart the state is restored first.
		if (loaded && this.sceneId !== null && !findScene(scenes, this.sceneId))
			this.sceneId = null;
		const scene = findScene(scenes, this.sceneId);
		const highlight = scene && this.mode === 'all' ? scene : null;
		const shown =
			scene && this.mode === 'only'
				? scene.members.flatMap((i) => (shots[i] ? [shots[i]] : []))
				: shots;
		const derived: Derived = {
			item,
			shots,
			scenes,
			notes,
			scene,
			highlight,
			shown,
			byShot: scenesByShot(scenes),
			labels: labelsByShot(shots, notes.labels),
		};
		this.current = derived;

		if (this.half === 'scenes') {
			this.renderScenesHalf(derived);
			return;
		}
		this.boardEl.hide();
		this.ribbonEl.show();
		this.belowEl.show();

		// Mid-drag the header has to survive: the slider being dragged is in
		// it. The cards wait for the release too — a film has thousands.
		if (!this.adjusting) this.renderActions(item, derived);
		this.renderSummary(derived);
		this.ensureVideo(item);
		this.renderRibbon(derived);
		if (!this.adjusting) this.renderCards(derived);
		this.renderPanel(derived);
		this.refreshHeader();
	}

	/**
	 * Obsidian reads the tab title from `getDisplayText` only when it redraws
	 * the header, and naming a scene is not something it knows to redraw for.
	 */
	private refreshHeader(): void {
		const title = this.getDisplayText();
		if (title === this.shownTitle) return;
		this.shownTitle = title;
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	private renderMissing(): void {
		this.actionEl.empty();
		this.actionsKey = '';
		this.dropVideo();
		this.stageEl.empty();
		this.ribbonEl.hide();
		this.soundTimelineEl.hide();
		this.soundBodyEl.hide();
		this.boardEl.hide();
		this.belowEl.show();
		this.panelEl.hide();
		this.panelKey = '';
		this.clearCards();
		this.summaryEl.setText(
			this.path
				? `${this.path} is not a video in this vault.`
				: 'No film. Right-click a video and choose Open in cut view.',
		);
		this.bodyEl.createDiv({
			cls: 'cine-clip-placeholder',
			text: this.path
				? 'The file may have been deleted, or moved outside the vault.'
				: 'Right-click any video in the file explorer and choose Open in cut view, or select a clip on the canvas and press the cuts button in the strip along the bottom.',
		});
	}

	private renderSummary(d: Derived): void {
		const { item, shots, scenes, scene } = d;
		const name = item.file.name;
		const store = this.plugin.shots;
		setTooltip(this.summaryEl, item.path, { placement: 'bottom' });

		if (store.isPending(item)) {
			const started = store.startedAt(item);
			if (started === null) {
				this.summaryEl.setText(
					`${name} — waiting for another clip to finish being cut`,
				);
				return;
			}
			const fraction = store.progressFor(item) ?? 0;
			const elapsed = (Date.now() - started) / 1000;
			const left =
				fraction > 0.02
					? ` · about ${formatLength((elapsed / fraction) * (1 - fraction))} left`
					: '';
			this.summaryEl.setText(
				`${name} — ${DETECTOR_LABEL} is finding cuts… ${Math.round(fraction * 100)}%${left}`,
			);
			return;
		}

		const noteError = this.plugin.scenes.errorFor(item.file);
		if (shots.length === 0) {
			const error = store.errorFor(item) ?? noteError;
			this.summaryEl.setText(error ? `${name} — ${error}` : name);
			return;
		}

		const parts: string[] = [];
		if (scene) {
			parts.push(
				sceneTitle(scene),
				plural(scene.members.length, 'cut'),
				formatLength(scene.duration),
			);
			if (scene.members.length > 0)
				parts.push(
					`${formatTimecode(scene.start)} – ${formatTimecode(scene.end)}`,
				);
			if (this.mode === 'all')
				parts.push(`highlighted among ${plural(shots.length, 'cut')}`);
			parts.push(name);
		} else {
			const stats = shotStats(shots);
			parts.push(
				name,
				plural(shots.length, 'cut'),
				plural(scenes.length, 'scene'),
				`${stats.average.toFixed(1)}s avg`,
				formatTimecode(stats.total),
			);
		}
		if (this.selected.size > 0) parts.push(`${this.selected.size} selected`);
		// A scene note that stopped parsing is worth a permanent mention: edits
		// are refused until it is fixed.
		if (noteError) parts.push(noteError);
		this.summaryEl.setText(parts.join('  ·  '));
	}

	/**
	 * The header: the switch, then the controls of whichever half is showing,
	 * then the one big button that half is offering.
	 *
	 * Nothing here repeats what the scene list already does. A scene is played,
	 * renamed and left from its own row, so the header carries none of those —
	 * it would be three more buttons saying what the row beside them says.
	 *
	 * @param d the cuts half's working state, or null on the sound half.
	 */
	private renderActions(item: MediaItem, d: Derived | null): void {
		const pane = this.sound;
		const pending = this.plugin.shots.isPending(item);
		const cut = (d?.shots.length ?? 0) > 0;
		const key = [
			item.path,
			this.half,
			this.isFilm,
			cut,
			pending,
			d?.scene?.id ?? '',
			this.mode,
			this.loopSegment,
			this.panelOpen,
			pane?.analysed() ?? false,
			pane?.cta()?.label ?? '',
		].join('|');
		if (key === this.actionsKey) return;
		this.actionsKey = key;
		this.actionEl.empty();

		this.renderHalfSwitch(item, d);

		if (this.half === 'scenes') {
			this.iconButton('expand', 'Full screen, keeping every control (F)', () =>
				void this.toggleFullscreen(),
			);
			return;
		}

		if (this.half === 'sound') {
			pane?.renderParams(this.actionEl);
			if (pane?.analysed() && !pane.pending())
				this.iconButton('refresh-cw', 'Analyse this file again', () =>
					pane.again(),
				);
			this.iconButton('expand', 'Full screen, keeping every control (F)', () =>
				void this.toggleFullscreen(),
			);
			this.renderCta(pane?.cta() ?? null);
			return;
		}

		if (cut && !pending) renderParams(this.actionEl, this.paramHost);

		if (pending) this.actionEl.createDiv({ cls: 'cine-strip-spinner' });

		if (d?.scene) {
			const modes = this.actionEl.createDiv({ cls: 'cine-mode-switch' });
			const option = (mode: SceneMode, text: string, tooltip: string): void => {
				const button = modes.createEl('button', { text });
				button.dataset.mode = mode;
				button.toggleClass('is-active', this.mode === mode);
				setTooltip(button, tooltip, { placement: 'bottom' });
				button.addEventListener('click', () => this.setMode(mode));
			};
			option('only', 'Its cuts', 'Show only this scene’s cuts (V)');
			option(
				'all',
				'All cuts',
				'Show every cut in the film, with this scene’s highlighted — click the others to select them, and A to add them (V)',
			);
		}

		if (cut) {
			const loop = this.iconButton(
				'repeat',
				this.loopSegment
					? 'A cut or scene repeats until you pick another one'
					: 'A cut or scene plays once and pauses on its last frame',
				() => {
					this.loopSegment = !this.loopSegment;
					this.render();
				},
			);
			loop.toggleClass('is-active', this.loopSegment);

			this.iconButton('expand', 'Full screen, keeping every control (F)', () =>
				void this.toggleFullscreen(),
			);
		}

		const panel = this.iconButton(
			'panel-right',
			this.panelOpen ? 'Hide the scenes' : 'Show the scenes',
			() => {
				this.panelOpen = !this.panelOpen;
				this.saveState();
			},
		);
		panel.toggleClass('is-active', this.panelOpen);

		// Last, and on its own, where the sound half puts Analyse sound: the
		// button that fills this half, or stops it filling.
		if (pending)
			this.renderCta(
				{
					label: 'Stop',
					tooltip: `Stop ${DETECTOR_LABEL}. Nothing is kept, and Find cuts starts again from the beginning.`,
					run: () => this.plugin.shots.cancel(item),
				},
				'square',
			);
		else if (!cut)
			renderFindCuts(
				this.actionEl.createDiv({ cls: 'cine-clip-cta' }),
				item,
				true,
				{
					shots: this.plugin.shots,
					run: (target) => void this.detect(target, false),
				},
			);
		else
			this.renderCta(
				{
					label: 'Re-cut',
					// Worth saying both halves of it: what it costs, and what it
					// does not cost. Scenes and labels are anchored by time, not
					// by cut number, so they survive a film being cut again.
					tooltip: `Run ${DETECTOR_LABEL} over this film again, from the frames — about 27 minutes for two hours. Scenes and labels are kept. To change how it is cut without running anything, use the sliders.`,
					run: () => void this.detect(item, true),
				},
				'sparkles',
			);
	}

	/**
	 * Cuts or sound: one file, one player, two questions.
	 *
	 * A dot marks the half that has never been run for this file, so "there is
	 * nothing there" is visible without switching to find out. An audio file has
	 * no cuts half, and so no switch.
	 */
	private renderHalfSwitch(item: MediaItem, d: Derived | null): void {
		if (!this.isFilm) return;
		const tabs = this.actionEl.createDiv({ cls: 'cine-strip-tabs' });
		const option = (
			half: ViewHalf,
			icon: string,
			label: string,
			ran: boolean,
			hint: string,
		): void => {
			const button = tabs.createEl('button', { cls: 'cine-strip-tab' });
			button.dataset.half = half;
			button.toggleClass('is-active', this.half === half);
			setIcon(button.createSpan(), icon);
			button.createSpan({ text: label });
			if (!ran) button.createSpan({ cls: 'cine-strip-tab-dot' });
			setTooltip(button, ran ? hint : `${hint} Not run on this file yet.`, {
				placement: 'bottom',
			});
			button.addEventListener('click', () => this.setHalf(half));
		};
		option(
			'cuts',
			'film',
			'Cuts',
			d ? d.shots.length > 0 : this.plugin.shots.has(item),
			'Where the picture changes: the ribbon, the cards and the scenes.',
		);
		option(
			'scenes',
			'tags',
			'Scenes',
			(d?.scenes ?? this.plugin.scenes.get(item.file).scenes).length > 0,
			'Every scene, filed under tags you choose: over the shoulder, two shot, rapid cuts.',
		);
		option(
			'sound',
			'audio-waveform',
			'Sound',
			this.plugin.sound.get(item.file) !== null,
			'What you are hearing: dialogue, music, effects and silence.',
		);
	}

	/**
	 * The one big button, kept out of the row of icons and given the accent.
	 *
	 * Full screen keeps the header, so it is reachable there too — which is the
	 * point. The panel below carries the same offer, and the panel is the first
	 * thing a bigger player pushes off the screen.
	 */
	private renderCta(cta: SoundCta | null, icon?: string): void {
		if (!cta) return;
		const button = this.actionEl
			.createDiv({ cls: 'cine-clip-cta' })
			.createEl('button', { cls: 'mod-cta' });
		button.dataset.cta = cta.label;
		if (icon) setIcon(button.createSpan({ cls: 'cine-clip-cta-icon' }), icon);
		button.createSpan({ text: cta.label });
		setTooltip(button, cta.tooltip, { placement: 'bottom' });
		button.addEventListener('click', cta.run);
	}

	/**
	 * The sound half: the same player, the lanes under it, the lists under
	 * those. The ribbon, the cards and the scene list are hidden rather than
	 * torn down — they belong to the same film, one click away.
	 */
	private renderSoundHalf(item: MediaItem): void {
		this.ribbonEl.hide();
		this.belowEl.hide();
		this.stageEl.addClass('cine-sound-stage');
		this.soundTimelineEl.show();
		this.soundBodyEl.show();
		this.ensureVideo(item);
		const pane = this.ensureSound();
		pane.setFile(item.file);
		if (!this.adjusting) this.renderActions(item, null);
		pane.render();
		this.summaryEl.setText(pane.summary());
		setTooltip(this.summaryEl, item.path, { placement: 'bottom' });
		this.refreshHeader();
	}

	/**
	 * The scenes half: the same player, and every scene under it filed by
	 * tag. The ribbon and the cards are hidden rather than torn down.
	 */
	private renderScenesHalf(d: Derived): void {
		this.ribbonEl.hide();
		this.belowEl.hide();
		this.boardEl.show();
		this.ensureVideo(d.item);
		this.board ??= new SceneBoard(this.boardEl, {
			plugin: this.plugin,
			color: (scene) => sceneColor(scene),
			editNotes: (change) => this.editNotes(change),
			playScene: (scene) => this.playScene(scene),
			showInCuts: (scene) => {
				this.half = 'cuts';
				this.sceneId = scene.id;
				this.mode = 'only';
				this.activeIndex = null;
				this.clearSelection(false);
				this.saveState();
			},
		});
		const ctx = { item: d.item, shots: d.shots, scenes: d.scenes, notes: d.notes };
		if (!this.adjusting) this.renderActions(d.item, d);
		this.board.render(ctx);
		this.summaryEl.setText(this.board.summary(ctx));
		setTooltip(this.summaryEl, d.item.path, { placement: 'bottom' });
		this.refreshHeader();
	}

	/** Built the first time the switch is thrown, and kept after that. */
	private ensureSound(): SoundPane {
		this.sound ??= new SoundPane(this.soundTimelineEl, this.soundBodyEl, {
			plugin: this.plugin,
			video: () => this.video,
			refresh: () => this.scheduleRender(),
		});
		return this.sound;
	}

	private setHalf(half: ViewHalf): void {
		if (half === this.half || (half !== 'sound' && !this.isFilm)) return;
		this.half = half;
		this.saveState();
		// The lanes are laid out for the first time in this render, and a canvas
		// measured while its half was hidden has no width at all.
		this.sound?.onResize();
	}

	private iconButton(
		icon: string,
		tooltip: string,
		action: () => void,
	): HTMLButtonElement {
		const button = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(button, icon);
		setTooltip(button, tooltip, { placement: 'bottom' });
		button.addEventListener('click', action);
		return button;
	}

	/**
	 * Builds the player once per film and keeps it.
	 *
	 * Re-creating it on every render would restart the video every time a
	 * slider moved, which is the one thing this view must never do: the whole
	 * point is watching the same frame while the cuts around it change.
	 */
	private ensureVideo(item: MediaItem): void {
		if (this.video && this.video.dataset.path === item.path) return;
		this.dropVideo();
		this.stageEl.empty();
		const video = this.stageEl.createEl('video', {
			cls: 'cine-clip-video',
		});
		video.dataset.path = item.path;
		video.src = this.app.vault.getResourcePath(item.file);
		video.controls = true;
		video.playsInline = true;
		video.preload = 'metadata';
		// The frame callback drives the playhead as well as the cut boundary,
		// so the ribbon moves per frame rather than four times a second.
		// `seeked` covers a scrub while paused.
		this.player = new SegmentPlayer(video, {
			// A scene loops as a whole, not cut by cut.
			loop: () => this.loopSegment && this.sequence === null,
			onFrame: (time) => {
				this.syncPlayhead(time);
				if (this.half === 'sound') this.sound?.draw();
			},
			onEnd: () => this.nextInSequence(),
			onRelease: () => {
				this.sequence = null;
			},
		});
		video.addEventListener('seeked', () => {
			this.syncPlayhead(video.currentTime);
			this.sound?.draw();
		});
		// An uncut film's placeholder estimates the run from the duration,
		// which is only known once the metadata is in. A file with no picture
		// plays in the same element; it just needs no room.
		video.addEventListener('loadedmetadata', () => {
			this.stageEl.toggleClass('is-audio', video.videoHeight === 0);
			if (this.current?.shots.length === 0 || this.half === 'sound')
				this.scheduleRender();
		});
		this.video = video;
	}

	/**
	 * The ribbon: every shown cut as wide as it is long.
	 *
	 * In a scene tab showing only its cuts, those cuts are laid end to end, so
	 * the ribbon is the scene as it plays rather than the film with gaps.
	 *
	 * The blocks touch rather than being spaced apart, because a film's two
	 * thousand one-pixel gaps would add up to more than the ribbon is wide;
	 * each block draws its own left edge instead, so a run of quick cuts reads
	 * as a darker stretch.
	 */
	private renderRibbon(d: Derived): void {
		this.ribbonEl.empty();
		this.activeEls = this.activeEls.filter((el) => !this.ribbonEl.contains(el));
		this.playheadEl = this.ribbonEl.createDiv({ cls: 'cine-clip-playhead' });
		this.ribbonAt.clear();
		const shown = d.shown;
		let total = 0;
		for (const shot of shown) total += shot.end - shot.start;
		this.ribbonTotal = total;
		if (shown.length === 0 || total <= 0) {
			this.ribbonEl.hide();
			return;
		}
		this.ribbonEl.show();
		this.ribbonEl.toggleClass('has-highlight', d.highlight !== null);

		let offset = 0;
		for (const shot of shown) {
			const length = shot.end - shot.start;
			const block = this.ribbonEl.createDiv({ cls: 'cine-clip-block' });
			block.dataset.index = String(shot.index);
			block.style.width = `${(length / total) * 100}%`;
			this.ribbonAt.set(shot.index, offset);
			offset += length;
			const labels = d.labels.get(shot.index);
			if (labels) block.addClass('has-label');
			if (d.highlight && hasMember(d.highlight, shot.index))
				block.addClass('is-in-scene');
			setTooltip(
				block,
				`Cut ${shot.index + 1} · ${formatTimecode(shot.start)} · ${length.toFixed(2)}s${labels ? ` · ${joinLabels(labels)}` : ''}`,
				{ placement: 'top' },
			);
			block.addEventListener('click', () => this.playShot(shot));
		}
		// The playhead element is new, so its position has to be restored now
		// rather than on the next frame the video presents.
		this.syncPlayhead(this.video?.currentTime ?? 0);
		this.applyActive(false);
	}

	/**
	 * The grid. Cards are built when the cut list or the set of cards shown
	 * changes, and otherwise kept and updated in place: adding a cut to a scene
	 * or labelling one must not rebuild a thousand cards, lose the scroll
	 * position, and ask for their stills again.
	 */
	private renderCards(d: Derived): void {
		if (this.plugin.shots.isPending(d.item)) {
			if (this.cardsKey === 'pending') return;
			this.clearCards();
			this.cardsKey = 'pending';
			this.bodyEl.createDiv({ cls: 'cine-clip-spinner-row' }).createDiv({
				cls: 'cine-strip-spinner',
			});
			return;
		}
		if (d.shots.length === 0) {
			this.clearCards();
			this.bodyEl.createDiv({
				cls: 'cine-clip-placeholder',
				text: this.uncutHint(),
			});
			return;
		}
		const key =
			d.scene && this.mode === 'only'
				? `only:${d.scene.members.join(',')}`
				: 'all';
		if (d.shots !== this.cardShots || key !== this.cardsKey) {
			const scroll = this.bodyEl.scrollTop;
			this.clearCards();
			this.cardShots = d.shots;
			this.cardsKey = key;
			if (d.scene && this.mode === 'only' && d.shown.length === 0) {
				this.bodyEl.createDiv({
					cls: 'cine-clip-placeholder',
					text: 'No cuts in this scene yet. Switch to All cuts above, select some, and press A — or drag cards onto this scene in the list beside the grid.',
				});
			} else {
				const grid = this.bodyEl.createDiv({ cls: 'cine-clip-grid' });
				for (const shot of d.shown) this.renderCard(grid, d, shot);
			}
			this.bodyEl.scrollTop = scroll;
		}
		this.decorateCards(d);
		this.applyActive(false);
	}

	private uncutHint(): string {
		const duration =
			this.video && Number.isFinite(this.video.duration)
				? this.video.duration
				: 0;
		const estimate =
			duration > 0
				? `about ${formatLength(duration * DETECTION_SECONDS_PER_SECOND)} for this file`
				: 'about a minute and a half per six minutes of video';
		return `No cuts yet. Press Find cuts above: ${DETECTOR_LABEL} reads every frame, ${estimate}. Obsidian stays usable in the meantime, and the run can be stopped from the header.`;
	}

	/**
	 * Builds one card. Its handlers read `this.current` rather than the render
	 * they were built in, since the card outlives it.
	 */
	private renderCard(parent: HTMLElement, d: Derived, shot: Shot): void {
		const el = parent.createDiv({ cls: 'cine-clip-card' });
		el.dataset.index = String(shot.index);
		el.draggable = true;

		const frame = el.createDiv({ cls: 'cine-clip-frame' });
		const img = frame.createEl('img', { cls: 'cine-clip-thumb' });
		img.alt = `Cut ${shot.index + 1}`;
		img.draggable = false;
		img.decoding = 'async';
		img.hide();
		this.lazyThumb(el, d.item, shot, img);

		frame.createDiv({
			cls: 'cine-clip-number',
			text: String(shot.index + 1),
		});
		frame.createDiv({
			cls: 'cine-clip-duration',
			text: `${(shot.end - shot.start).toFixed(1)}s`,
		});
		const chips = frame.createDiv({ cls: 'cine-clip-chips' });

		if (d.scene && this.mode === 'only') {
			const scene = d.scene;
			const remove = frame.createEl('button', { cls: 'cine-clip-remove' });
			setIcon(remove, 'x');
			setTooltip(remove, `Take this cut out of ${sceneTitle(scene)}`, {
				placement: 'top',
			});
			remove.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.removeFromScene(scene.id, [shot.index]);
			});
		}

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
		const label = el.createDiv({ cls: 'cine-clip-label' });
		label.hide();

		setTooltip(
			el,
			`Cut ${shot.index + 1} · ${formatTimecode(shot.start)} to ${formatTimecode(shot.end)} · ${(shot.end - shot.start).toFixed(2)}s${shot.score > 0 ? ` · cut score ${shot.score.toFixed(1)}` : ''} · Ctrl-click or Shift-click to select, drag onto a scene, right-click for more`,
			{ placement: 'top' },
		);

		el.addEventListener('click', (e) => this.onCardClick(shot, e));
		el.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.openCutMenu(e, shot);
		});
		el.addEventListener('dragstart', (e) => this.startDrag(e, shot));
		el.addEventListener('dragend', () => this.endDrag());

		this.cards.set(shot.index, { el, label, chips, chipsKey: '' });
	}

	/** Labels, scene chips, the highlight and the selection, on the kept cards. */
	private decorateCards(d: Derived): void {
		const highlight = d.highlight;
		this.bodyEl.toggleClass('has-highlight', highlight !== null);
		for (const [index, card] of this.cards) {
			const labels = d.labels.get(index);
			const text = labels ? joinLabels(labels) : '';
			if (card.label.textContent !== text) card.label.setText(text);
			card.label.toggle(text !== '');
			card.el.toggleClass('has-label', text !== '');

			const scenes = d.byShot.get(index) ?? [];
			const chipsKey = scenes.map((s) => `${s.id}:${s.index}:${s.title}`).join('|');
			if (chipsKey !== card.chipsKey) {
				card.chipsKey = chipsKey;
				card.chips.empty();
				for (const scene of scenes) {
					const chip = card.chips.createSpan({ cls: 'cine-clip-chip' });
					chip.style.setProperty('--cine-scene-color', sceneColor(scene));
				}
				if (scenes.length > 0)
					setTooltip(card.chips, scenes.map(sceneTitle).join(' · '), {
						placement: 'top',
					});
			}

			card.el.toggleClass(
				'is-in-scene',
				highlight !== null && hasMember(highlight, index),
			);
			card.el.toggleClass('is-selected', this.selected.has(index));
		}
	}

	/**
	 * Shows a cached still at once; otherwise waits until the card is near the
	 * viewport to ask for one, and withdraws the request if it scrolls away
	 * again before the still is made.
	 */
	private lazyThumb(
		el: HTMLElement,
		item: MediaItem,
		shot: Shot,
		img: HTMLImageElement,
	): void {
		// The thumbnail store keys on `item.shot`, so a shot item is what has
		// to be handed to it — the frame it grabs is the middle of the cut.
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
			return;
		}
		const slot: LazyThumb = {
			cancel: null,
			done: false,
			start: () =>
				this.plugin.thumbnails.request(
					shotItem,
					resolved.upgrade ?? 0,
					shot.index,
					(url) => {
						if (!url) return;
						slot.done = true;
						img.src = url;
						img.show();
						this.observer?.unobserve(el);
					},
				),
		};
		const observer = this.ensureObserver();
		if (!observer) {
			this.cancels.push(slot.start());
			return;
		}
		this.lazy.set(el, slot);
		observer.observe(el);
	}

	private ensureObserver(): IntersectionObserver | null {
		if (typeof IntersectionObserver === 'undefined') return null;
		this.observer ??= new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const slot = this.lazy.get(entry.target);
					if (!slot || slot.done) continue;
					if (entry.isIntersecting) {
						slot.cancel ??= slot.start();
					} else if (slot.cancel) {
						slot.cancel();
						slot.cancel = null;
					}
				}
			},
			{ root: this.bodyEl, rootMargin: THUMB_MARGIN },
		);
		return this.observer;
	}

	// --- the scene list ---------------------------------------------------

	/**
	 * No Cut, then every scene of the film in the note's order: make one, drop
	 * cuts on one, show one here, rename or delete it.
	 *
	 * Rebuilt only when what it shows changes. Detection progress re-renders
	 * the view several times a second, and a row replaced under the pointer
	 * loses its hover, its tooltip and, mid-drag, its place as a drop target.
	 */
	private renderPanel(d: Derived): void {
		this.panelEl.toggle(this.panelOpen);
		if (!this.panelOpen) {
			this.panelKey = '';
			return;
		}
		const cut = d.shots.length > 0;
		const key = JSON.stringify([
			d.item.path,
			d.shots.length,
			d.scenes.map((s) => [s.id, s.title, s.tags, s.members.length, s.stored, Math.round(s.duration * 10)]),
			d.scene?.id ?? null,
			this.mode,
		]);
		if (key === this.panelKey) return;
		this.panelKey = key;
		this.panelEl.empty();

		const head = this.panelEl.createDiv({ cls: 'cine-scene-panel-head' });
		head.createSpan({ cls: 'cine-scene-panel-title', text: 'Scenes' });
		head.createSpan({
			cls: 'cine-scene-panel-count',
			text: String(d.scenes.length),
		});
		const add = head.createEl('button', { cls: 'cine-scene-new' });
		setIcon(add.createSpan({ cls: 'cine-scene-new-icon' }), 'plus');
		add.createSpan({ text: 'New scene' });
		setTooltip(
			add,
			'A new scene holding the selected cuts, if any (N). Drop cards here to make a scene of them.',
			{ placement: 'bottom' },
		);
		add.addEventListener('click', () => this.promptNewScene(this.targets()));
		this.dropTarget(add, () => true, (cuts) => this.promptNewScene(cuts));

		const list = this.panelEl.createDiv({ cls: 'cine-scene-list' });
		this.renderNoneRow(list, d);
		for (const scene of d.scenes) this.renderSceneRow(list, d, scene);

		if (d.scenes.length === 0)
			this.panelEl.createDiv({
				cls: 'cine-scene-panel-hint',
				text: cut
					? 'A scene is any cuts you choose — they need not be next to each other, and a cut can be in several scenes. Select cards with Ctrl-click or Shift-click and press N, or drag them onto New scene.'
					: 'Scenes are made from cuts. Find the cuts first.',
			});
	}

	/**
	 * No Cut: the whole film, with nothing picked. Where the view starts, and
	 * the way back from a scene.
	 */
	private renderNoneRow(list: HTMLElement, d: Derived): void {
		const row = list.createDiv({ cls: 'cine-scene-row is-none' });
		row.dataset.id = '';
		row.toggleClass('is-current', d.scene === null);
		row.createSpan({ cls: 'cine-scene-swatch' });
		const text = row.createDiv({ cls: 'cine-scene-row-text' });
		text.createDiv({ cls: 'cine-scene-row-title', text: 'No Cut' });
		text.createDiv({
			cls: 'cine-scene-row-meta',
			text:
				d.shots.length > 0
					? `the whole film  ·  ${plural(d.shots.length, 'cut')}`
					: 'the whole film',
		});
		// The same play button every scene row has: here it plays the film.
		if (d.shots.length > 0) {
			const tools = row.createDiv({ cls: 'cine-scene-row-tools' });
			const play = tools.createEl('button', { cls: 'cine-strip-icon' });
			play.dataset.tool = 'play';
			setIcon(play, 'play');
			setTooltip(play, 'Play the whole film, from its first cut', {
				placement: 'left',
			});
			play.addEventListener('click', (e) => {
				e.stopPropagation();
				this.playWholeFilm();
			});
		}

		setTooltip(row, 'Every cut in the film, with no scene picked', {
			placement: 'left',
		});
		row.addEventListener('click', () => this.selectScene(null));
	}

	private renderSceneRow(list: HTMLElement, d: Derived, scene: Scene): void {
		const row = list.createDiv({ cls: 'cine-scene-row' });
		row.dataset.id = scene.id;
		row.style.setProperty('--cine-scene-color', sceneColor(scene));
		row.toggleClass('is-current', d.scene?.id === scene.id);
		row.toggleClass('is-highlighted', d.highlight?.id === scene.id);

		row.createSpan({ cls: 'cine-scene-swatch' });
		const text = row.createDiv({ cls: 'cine-scene-row-text' });
		const title = text.createDiv({
			cls: 'cine-scene-row-title',
			text: sceneTitle(scene),
		});
		title.toggleClass('is-unnamed', scene.title === '');
		text.createDiv({
			cls: 'cine-scene-row-meta',
			text:
				d.shots.length > 0
					? `${plural(scene.members.length, 'cut')}  ·  ${formatLength(scene.duration)}`
					: plural(scene.stored, 'cut'),
		});
		// Tags are filed on the scenes half; here they only say what the scene is.
		if (scene.tags.length > 0)
			text.createDiv({ cls: 'cine-scene-row-tags', text: scene.tags.join(' · ') });

		const tools = row.createDiv({ cls: 'cine-scene-row-tools' });
		const tool = (icon: string, tooltip: string, action: () => void): void => {
			const button = tools.createEl('button', { cls: 'cine-strip-icon' });
			button.dataset.tool = icon;
			setIcon(button, icon);
			setTooltip(button, tooltip, { placement: 'left' });
			button.addEventListener('click', (e) => {
				e.stopPropagation();
				action();
			});
		};
		if (scene.members.length > 0)
			tool('play', 'Play it, cut after cut', () => this.playScene(scene));
		tool('pencil', 'Rename', () => this.promptRename(scene));
		tool('trash-2', 'Delete this scene. Its cuts stay in the film.', () =>
			void this.deleteSceneWithUndo(scene),
		);

		setTooltip(
			row,
			'Click to show this scene here; click it again for the whole film. Drop cards on it to add them.',
			{ placement: 'left' },
		);
		row.addEventListener('click', () => this.selectScene(scene.id));
		title.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			this.promptRename(scene);
		});
		this.dropTarget(row, () => true, (cuts) => void this.addToScene(scene.id, cuts));
	}

	/**
	 * Shows a scene here, or the whole film with null. A row is a toggle:
	 * clicking the scene already shown goes back to No Cut.
	 *
	 * The selection and the playhead are left alone — the film and its cut
	 * numbering have not changed, only what is drawn.
	 */
	private selectScene(id: string | null): void {
		const next = id !== null && id === this.sceneId ? null : id;
		if (next === this.sceneId) return;
		this.sceneId = next;
		this.saveState();
		const scene = findScene(this.current?.scenes ?? [], next);
		const first = scene?.members[0];
		if (first !== undefined)
			this.cards.get(first)?.el.scrollIntoView({ block: 'nearest' });
	}

	private setMode(mode: SceneMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.saveState();
	}

	// --- selection --------------------------------------------------------

	/**
	 * A plain click plays the cut and selects only it; Ctrl- or Cmd-click adds
	 * or removes one cut; Shift-click selects everything from the last cut
	 * clicked, in the order the grid shows them.
	 */
	private onCardClick(shot: Shot, e: MouseEvent): void {
		const index = shot.index;
		if (e.ctrlKey || e.metaKey) {
			if (this.selected.has(index)) this.selected.delete(index);
			else this.selected.add(index);
			this.selectAnchor = index;
			this.applySelection();
			return;
		}
		const shown = this.current?.shown ?? [];
		if (e.shiftKey && this.selectAnchor !== null) {
			const from = shown.findIndex((s) => s.index === this.selectAnchor);
			const to = shown.findIndex((s) => s.index === index);
			if (from >= 0 && to >= 0) {
				const [lo, hi] = from < to ? [from, to] : [to, from];
				this.selected = new Set(shown.slice(lo, hi + 1).map((s) => s.index));
				this.applySelection();
				return;
			}
		}
		this.selectOnly(index);
		this.playShot(shot);
	}

	private selectOnly(index: number): void {
		this.selected = new Set([index]);
		this.selectAnchor = index;
		this.applySelection();
	}

	private clearSelection(apply = true): void {
		this.selected = new Set();
		this.selectAnchor = null;
		if (apply) this.applySelection();
	}

	private applySelection(): void {
		for (const [index, card] of this.cards)
			card.el.toggleClass('is-selected', this.selected.has(index));
		if (this.current) this.renderSummary(this.current);
	}

	/**
	 * What an action applies to: the selection, or else the cut under the
	 * playhead. With neither, nothing.
	 */
	private targets(): number[] {
		if (this.selected.size > 0)
			return [...this.selected].sort((a, b) => a - b);
		return this.activeIndex === null ? [] : [this.activeIndex];
	}

	// --- drag and drop ----------------------------------------------------

	/** Drags the selection if the card is in it, otherwise the card alone. */
	private startDrag(e: DragEvent, shot: Shot): void {
		const d = this.current;
		if (!d) return;
		const indexes = this.selected.has(shot.index)
			? [...this.selected].sort((a, b) => a - b)
			: [shot.index];
		const times = indexes.flatMap((i) => {
			const s = d.shots[i];
			return s ? [anchorOf(s)] : [];
		});
		activeDrag = { film: d.item.path, times, source: this };
		// A drag carries no data unless some is set, and Chromium refuses to
		// start one then.
		e.dataTransfer?.setData(
			'text/plain',
			`${plural(times.length, 'cut')} of ${d.item.file.name}`,
		);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
		this.contentEl.addClass('is-dragging-cuts');
	}

	endDrag(): void {
		if (activeDrag?.source === this) activeDrag = null;
		this.contentEl.removeClass('is-dragging-cuts');
		for (const el of Array.from(
			this.contentEl.querySelectorAll('.is-drop-target'),
		))
			el.removeClass('is-drop-target');
	}

	/**
	 * Makes `el` accept dragged cuts of this film.
	 *
	 * `dragleave` also fires when the pointer moves onto a child of the target,
	 * so it only counts once the pointer has left the target altogether.
	 */
	private dropTarget(
		el: HTMLElement,
		accepts: (drag: NonNullable<typeof activeDrag>) => boolean,
		onDrop: (cuts: number[]) => void,
	): void {
		const usable = (): boolean =>
			activeDrag !== null && activeDrag.film === this.path && accepts(activeDrag);
		const over = (e: DragEvent): void => {
			if (!usable()) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			el.addClass('is-drop-target');
		};
		el.addEventListener('dragenter', over);
		el.addEventListener('dragover', over);
		el.addEventListener('dragleave', (e) => {
			if (el.contains(e.relatedTarget as Node | null)) return;
			el.removeClass('is-drop-target');
		});
		el.addEventListener('drop', (e) => {
			const drag = activeDrag;
			if (!drag || !usable()) return;
			e.preventDefault();
			e.stopPropagation();
			el.removeClass('is-drop-target');
			drag.source.endDrag();
			const shots = this.current?.shots ?? [];
			const cuts = new Set<number>();
			for (const time of drag.times) {
				const i = shotAt(shots, time);
				if (i >= 0) cuts.add(i);
			}
			if (cuts.size > 0) onDrop([...cuts].sort((a, b) => a - b));
		});
	}

	// --- scenes and labels -----------------------------------------------

	private openCutMenu(e: MouseEvent, shot: Shot): void {
		const d = this.current;
		if (!d) return;
		// Right-clicking outside the selection acts on that cut alone, as a
		// file list does.
		if (!this.selected.has(shot.index)) this.selectOnly(shot.index);
		const cuts = this.targets();
		const noun = cuts.length === 1 ? 'this cut' : plural(cuts.length, 'cut');
		const menu = new Menu();

		if (cuts.length === 1) {
			const labels = d.labels.get(shot.index);
			menu.addItem((entry) =>
				entry
					.setTitle(labels ? 'Edit label' : 'Label this cut')
					.setIcon('tag')
					.onClick(() => this.promptLabel(shot)),
			);
			menu.addSeparator();
		}
		menu.addItem((entry) =>
			entry
				.setTitle(`New scene from ${noun}`)
				.setIcon('plus')
				.onClick(() => this.promptNewScene(cuts)),
		);
		if (d.scenes.length > 0)
			menu.addItem((entry) =>
				entry
					.setTitle(`Add ${noun} to a scene…`)
					.setIcon('folder-plus')
					.onClick(() => this.pickScene(cuts)),
			);
		for (const scene of d.scenes) {
			if (!cuts.some((i) => hasMember(scene, i))) continue;
			menu.addItem((entry) =>
				entry
					.setTitle(`Remove ${noun} from ${sceneTitle(scene)}`)
					.setIcon('minus')
					.onClick(() => void this.removeFromScene(scene.id, cuts)),
			);
		}
		const others = (d.byShot.get(shot.index) ?? []).filter(
			(s) => s.id !== d.scene?.id,
		);
		if (others.length > 0) menu.addSeparator();
		for (const scene of others)
			menu.addItem((entry) =>
				entry
					.setTitle(`Show ${sceneTitle(scene)}`)
					.setIcon('clapperboard')
					.onClick(() => this.selectScene(scene.id)),
			);
		menu.showAtMouseEvent(e);
	}

	private promptLabel(shot: Shot): void {
		const d = this.current;
		if (!d) return;
		const labels = d.labels.get(shot.index);
		new TextPromptModal(this.app, {
			title: `Label cut ${shot.index + 1}`,
			hint: `${formatTimecode(shot.start)} – ${formatTimecode(shot.end)}. Saved in ${this.plugin.scenes.notePath(d.item.file)}. Save it empty to remove the label.`,
			placeholder: 'Close-up, insert, Marquis…',
			value: labels ? joinLabels(labels) : '',
			onSubmit: (text) => void this.editNotes((n) => setLabel(n, shot, text)),
		}).open();
	}

	private promptNewScene(cuts: number[]): void {
		const d = this.current;
		if (!d) return;
		new TextPromptModal(this.app, {
			title: 'New scene',
			hint:
				cuts.length > 0
					? `With ${plural(cuts.length, 'cut')}. The name can be left empty.`
					: 'Empty for now: drag cards onto it, or select cuts and press A. The name can be left empty.',
			placeholder: `Scene ${d.scenes.length + 1}`,
			value: '',
			onSubmit: (title) => void this.createScene(title, cuts),
		}).open();
	}

	private pickScene(cuts: number[]): void {
		const d = this.current;
		if (!d || cuts.length === 0) return;
		new ScenePickerModal(
			this.app,
			d.scenes,
			`Add ${plural(cuts.length, 'cut')} to…`,
			(pick) => {
				if (pick === 'new') this.promptNewScene(cuts);
				else void this.addToScene(pick.id, cuts);
			},
		).open();
	}

	private promptRename(scene: Scene): void {
		new TextPromptModal(this.app, {
			title: `Rename ${sceneTitle(scene)}`,
			hint: `${plural(scene.members.length, 'cut')}. Save it empty to go back to "Scene ${scene.index + 1}".`,
			placeholder: 'Scene title',
			value: scene.title,
			onSubmit: (title) =>
				void this.editNotes((n) => renameScene(n, scene.id, title)),
		}).open();
	}

	/**
	 * Makes a scene and shows it among all the cuts, so the cuts just grouped
	 * are visibly the ones that went in.
	 */
	async createScene(title: string, cuts: number[]): Promise<void> {
		const d = this.current;
		if (!d) return;
		let id = '';
		const saved = await this.editNotes((n) => {
			id = newSceneId(n);
			return addScene(n, d.shots, id, title, cuts);
		});
		if (!saved) return;
		this.clearSelection();
		this.sceneId = id;
		this.mode = 'all';
		this.saveState();
	}

	async addToScene(id: string, cuts: number[]): Promise<void> {
		const d = this.current;
		if (!d || cuts.length === 0) return;
		if (await this.editNotes((n) => addCuts(n, d.shots, id, cuts)))
			this.clearSelection();
	}

	async removeFromScene(id: string, cuts: number[]): Promise<void> {
		const d = this.current;
		if (!d || cuts.length === 0) return;
		if (await this.editNotes((n) => removeCuts(n, d.shots, id, cuts)))
			this.clearSelection();
	}

	/**
	 * Deletes without asking, and offers to undo instead: a scene can hold an
	 * hour of choosing, but a confirmation you click through every time
	 * protects it less than an undo you only reach for when it matters.
	 */
	private async deleteSceneWithUndo(scene: Scene): Promise<void> {
		const d = this.current;
		if (!d) return;
		const position = d.notes.scenes.findIndex((s) => s.id === scene.id);
		const def = d.notes.scenes[position];
		if (!def) return;
		const film = d.item.file;
		if (!(await this.editNotes((n) => deleteScene(n, scene.id)))) return;
		if (this.sceneId === scene.id) this.sceneId = null;

		// Obsidian's global `createEl` makes a detached element; the document's
		// own `createEl` would append it to the document.
		const undo = createEl('button', { text: 'Undo' });
		const notice = new Notice(
			createFragment((f) => {
				f.appendText(`Deleted ${sceneTitle(scene)}. `);
				f.append(undo);
			}),
			10000,
		);
		undo.addEventListener('click', () => {
			notice.hide();
			void this.plugin.scenes.update(film, (n) => restoreScene(n, def, position));
		});
	}

	/** @returns whether the change was saved. */
	private async editNotes(
		change: (notes: FilmNotes) => FilmNotes,
	): Promise<boolean> {
		const d = this.current;
		if (!d) return false;
		const film = d.item.file;
		try {
			if (await this.plugin.scenes.update(film, change)) return true;
			new Notice(
				`Cinema canvas: nothing was saved. ${this.plugin.scenes.errorFor(film) ?? ''} Fix the block in ${this.plugin.scenes.notePath(film)} first.`,
				12000,
			);
		} catch (err) {
			new Notice(
				`Cinema canvas: the scene note could not be written. ${err instanceof Error ? err.message : String(err)}`,
				12000,
			);
		}
		return false;
	}

	// --- playback ---------------------------------------------------------

	/** Seeks to a cut and plays it, confined to its own range. */
	private playShot(shot: Shot): void {
		this.sequence = null;
		this.setActive(shot.index);
		this.playRange(shot);
	}

	/**
	 * Plays a scene's cuts one after another, skipping what lies between them;
	 * cuts that follow each other in the film play straight through.
	 */
	playScene(scene: Scene): void {
		const d = this.current;
		if (!d) return;
		const ranges = playRanges(d.shots, scene.members);
		if (ranges.length === 0) return;
		this.sequence = { ranges, at: 0 };
		this.playRange(ranges[0] ?? { start: 0, end: 0 });
	}

	/** No Cut's play button: the film itself, from its first cut. */
	playWholeFilm(): void {
		const d = this.current;
		if (!d || d.shots.length === 0) return;
		const ranges = playRanges(
			d.shots,
			d.shots.map((s) => s.index),
		);
		if (ranges.length === 0) return;
		this.sequence = { ranges, at: 0 };
		this.playRange(ranges[0] ?? { start: 0, end: 0 });
	}

	private nextInSequence(): void {
		const sequence = this.sequence;
		if (!sequence) return;
		let next = sequence.at + 1;
		if (next >= sequence.ranges.length) {
			if (!this.loopSegment) {
				this.sequence = null;
				return;
			}
			next = 0;
		}
		sequence.at = next;
		const range = sequence.ranges[next];
		if (range) this.playRange(range);
	}

	/** Plays one range, confined to it. */
	private playRange(range: { start: number; end: number }): void {
		const video = this.video;
		const player = this.player;
		if (!video || !player) return;
		player.play(range, () => {
			void video.play().catch(() => {
				// Autoplay can be refused before any user gesture reaches the
				// document; the seek still happened, so the frame is right.
			});
		});
	}

	/**
	 * Moves the playhead and the highlight to wherever the video actually is.
	 *
	 * Scrubbing the player is deliberately not confined to the current cut —
	 * seeing what surrounds a cut is most of why you would open this view — so
	 * the highlight follows the playhead rather than the last thing clicked.
	 * Outside the cuts a scene tab shows, the playhead is hidden.
	 */
	private syncPlayhead(time: number): void {
		const d = this.current;
		if (!d || d.shots.length === 0) return;

		const found = shotAt(d.shots, time);
		const shot = d.shots[found];
		const offset = this.ribbonAt.get(found);
		if (shot && offset !== undefined && this.ribbonTotal > 0) {
			const into = Math.min(Math.max(time - shot.start, 0), shot.end - shot.start);
			this.playheadEl.show();
			this.playheadEl.style.left = `${((offset + into) / this.ribbonTotal) * 100}%`;
		} else {
			this.playheadEl.hide();
		}

		if (found >= 0 && found !== this.activeIndex) this.setActive(found);
	}

	private setActive(index: number | null): void {
		if (this.activeIndex === index) return;
		this.activeIndex = index;
		this.applyActive(true);
	}

	/**
	 * Highlights the active cut's block and card.
	 *
	 * Only the previous pair is un-highlighted, rather than every element being
	 * visited: this runs once per cut during playback, and a film's grid is
	 * thousands of cards.
	 */
	private applyActive(scroll: boolean): void {
		for (const el of this.activeEls) el.removeClass('is-active');
		this.activeEls = [];
		if (this.activeIndex === null) return;
		const block = this.ribbonEl.querySelector(
			`.cine-clip-block[data-index="${this.activeIndex}"]`,
		);
		const card = this.cards.get(this.activeIndex)?.el ?? null;
		for (const el of [block, card]) {
			if (!el?.instanceOf(HTMLElement)) continue;
			el.addClass('is-active');
			this.activeEls.push(el);
		}
		if (scroll && card)
			card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	/**
	 * Steps to the next or previous cut. In a scene's tab that means the
	 * scene's cuts, however the tab is showing them.
	 */
	step(delta: number): boolean {
		const d = this.current;
		if (!d) return false;
		const list = d.scene
			? d.scene.members.flatMap((i) => (d.shots[i] ? [d.shots[i]] : []))
			: d.shown;
		if (list.length === 0) return false;
		const at = list.findIndex((s) => s.index === this.activeIndex);
		const next =
			at < 0
				? delta > 0
					? 0
					: list.length - 1
				: (at + delta + list.length) % list.length;
		const shot = list[next];
		if (!shot) return false;
		this.selectOnly(shot.index);
		this.playShot(shot);
		return true;
	}

	togglePlayback(): void {
		const video = this.video;
		if (!video) return;
		if (video.paused) void video.play().catch(() => undefined);
		else video.pause();
	}

	/**
	 * Pauses the player and keeps the frame, for when the tab is left.
	 *
	 * Not `dropVideo`: the film, the playhead and the cut under it all stay, so
	 * coming back to the tab costs nothing.
	 */
	pauseForNow(): void {
		if (this.video && !this.video.paused) this.video.pause();
	}

	/**
	 * Full screen over the whole view, not over the player.
	 *
	 * Handing the picture alone to the Fullscreen API — which is what the
	 * player's own button does — puts it on top of everything in the
	 * compositor, and the ribbon, the cards and the scenes simply vanish.
	 * Taking the view's own root keeps every control, only bigger.
	 */
	async toggleFullscreen(): Promise<void> {
		const root = this.contentEl;
		try {
			if (activeDocument.fullscreenElement === root)
				await activeDocument.exitFullscreen();
			else await root.requestFullscreen();
		} catch {
			// Fullscreen can be refused (embedded contexts, gesture rules).
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		// The player's own controls own the arrow keys once it has focus.
		if (e.target instanceof HTMLVideoElement) return;
		if (e.target instanceof HTMLInputElement) return;
		// Leave Obsidian's own hotkeys alone.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		// The scenes half plays and files scenes; the cut keys below would act
		// on cards that are not on screen.
		if (this.half === 'scenes') {
			if (e.key === ' ') {
				this.togglePlayback();
				e.preventDefault();
			} else if (e.key === 'f') {
				void this.toggleFullscreen();
			} else if (e.key === 'Escape' && this.board?.clearFocus()) {
				e.preventDefault();
			}
			return;
		}

		// The sound half has no cuts, no selection and no scenes, so almost
		// none of the keys below mean anything there.
		if (this.half === 'sound') {
			if (this.sound?.onKeyDown(e)) {
				e.preventDefault();
				return;
			}
			const video = this.video;
			if (e.key === ' ') {
				this.togglePlayback();
				e.preventDefault();
			} else if (e.key === 'f') {
				void this.toggleFullscreen();
			} else if (video && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
				const step = (e.shiftKey ? 30 : 5) * (e.key === 'ArrowRight' ? 1 : -1);
				video.currentTime = Math.max(0, video.currentTime + step);
				this.sound?.draw();
				e.preventDefault();
			}
			return;
		}

		const d = this.current;
		const shot =
			d && this.activeIndex !== null ? d.shots[this.activeIndex] : undefined;
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
			case 't':
				// Label the cut under the playhead without reaching for the mouse.
				if (shot) this.promptLabel(shot);
				break;
			case 'n':
				if (d && d.shots.length > 0) this.promptNewScene(this.targets());
				break;
			case 'a':
				if (d && d.scenes.length > 0) this.pickScene(this.targets());
				else if (d && d.shots.length > 0) this.promptNewScene(this.targets());
				break;
			case 'Delete':
			case 'Backspace': {
				const scene = d?.scene;
				if (!scene) break;
				const cuts = this.targets().filter((i) => hasMember(scene, i));
				if (cuts.length > 0) void this.removeFromScene(scene.id, cuts);
				e.preventDefault();
				break;
			}
			case 'v':
				if (d?.scene) this.setMode(this.mode === 'only' ? 'all' : 'only');
				break;
			case 'p':
				if (d?.scene) this.playScene(d.scene);
				break;
			case 'Escape':
				if (this.selected.size > 0) this.clearSelection();
				else if (this.sceneId !== null) this.selectScene(null);
				break;
			default:
				break;
		}
	}

	// --- detection --------------------------------------------------------

	private async detect(item: MediaItem, force: boolean): Promise<void> {
		if (!(await this.plugin.shots.hasModel())) {
			new Notice(
				'Cinema canvas: the TransNetV2 model is not downloaded yet. Settings → Shot detection → Download.',
				10000,
			);
			return;
		}
		this.render();
		const shots = await this.plugin.shots.detect(item, force);
		if (shots || this.plugin.shots.wasCancelled(item)) return;
		const reason = this.plugin.shots.errorFor(item);
		new Notice(
			reason
				? `Cinema canvas: ${DETECTOR_LABEL} failed on ${item.file.name}. ${reason}`
				: `Cinema canvas: ${DETECTOR_LABEL} found no cuts in ${item.file.name} — it may be a single take.`,
			12000,
		);
	}

	private clearCards(): void {
		this.observer?.disconnect();
		this.observer = null;
		for (const slot of this.lazy.values()) slot.cancel?.();
		this.lazy.clear();
		for (const cancel of this.cancels) cancel();
		this.cancels = [];
		this.activeEls = this.activeEls.filter((el) => !this.bodyEl.contains(el));
		this.cards.clear();
		this.cardShots = null;
		this.cardsKey = '';
		this.bodyEl.empty();
	}
}

function joinLabels(labels: CutLabel[]): string {
	return labels.map((l) => l.text).join(' · ');
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
