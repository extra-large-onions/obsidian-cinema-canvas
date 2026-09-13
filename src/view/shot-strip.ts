import { Notice, TFile, setIcon, setTooltip } from 'obsidian';
import { DETECTOR_LABEL, ShotIndex } from '../media/shots';
import {
	ANALYSIS_SECONDS_PER_SECOND,
	SOUND_MODEL_BYTES,
	SoundIndex,
} from '../media/sound';
import {
	BIN_SECONDS,
	SoundAnalysis,
	SoundLanes,
	SoundParamKey,
	SoundParams,
	classifySound,
	laneSeconds,
	tagsAt,
} from '../media/sound-analysis';
import { ThumbnailStore } from '../media/thumbnails';
import { MediaItem, Shot } from '../types';
import { formatTimecode } from '../utils/timecode';
import {
	ParamHost,
	ShotParamKey,
	ShotParams,
	renderFindCuts,
	renderParams,
	summarize,
} from './shot-controls';
import {
	LANES,
	STRIP_ROWS,
	createColorCache,
	drawLanes,
	drawLine,
	formatLength,
	megabytes,
	rowsHeight,
} from './sound-lanes';

/**
 * Width of one strip item in CSS pixels. Fixed, so the strip reads as a
 * filmstrip rather than as a proportional timeline: a 0.4s shot and a 40s shot
 * are equally clickable, which is what you want when the strip is for
 * navigating rather than for judging rhythm.
 */
const ITEM_WIDTH = 132;

/** Thumbnail tier is picked from this, not from the canvas zoom. */
const ITEM_SCREEN_WIDTH = ITEM_WIDTH;

/** Which question the strip is answering about the selected clip. */
type Tab = 'cuts' | 'sound';

const TABS: readonly { id: Tab; label: string; icon: string; hint: string }[] = [
	{
		id: 'cuts',
		label: 'Cuts',
		icon: 'scissors',
		hint: 'Where the picture changes, one card per shot.',
	},
	{
		id: 'sound',
		label: 'Sound',
		icon: 'audio-waveform',
		hint: 'What you are hearing: dialogue, music, effects and silence.',
	},
];

/** What the sound half of the strip is showing instead of lanes, if anything. */
type SoundPanel =
	| 'lanes'
	| 'loading'
	| 'models'
	| 'downloading'
	| 'ready'
	| 'running'
	| 'error';

export interface ShotStripOptions {
	/** Play just this shot in the canvas cell for the current clip. */
	onPlayShot: (item: MediaItem, shot: Shot) => void;
	/** Open the lightbox on this shot. */
	onOpenShot: (item: MediaItem, shot: Shot) => void;
	/** Open the clip in its own tab, with every segment laid out. */
	onOpenClip: (item: MediaItem) => void;
	/** Open the clip's soundtrack in its own tab. */
	onOpenSound: (item: MediaItem) => void;
	/** Play the canvas cell from `time` to the end of the file. */
	onSeek: (item: MediaItem, time: number, duration: number) => void;
	/** Current cutting parameters, read fresh on every render. */
	getParams: () => ShotParams;
	/** Applies one immediately and persists it; re-cutting is the caller's job. */
	setParam: (key: ShotParamKey, value: number) => void;
	/** Current sound thresholds, read fresh on every render. */
	getSoundParams: () => SoundParams;
	setSoundParam: (key: SoundParamKey, value: number) => void;
}

/**
 * The sticky strip along the bottom of the canvas.
 *
 * Two tabs over one body, both about whichever clip is selected: **Cuts**, one
 * cell per shot, and **Sound**, the four lanes of the sound view drawn an inch
 * high. Each side offers the one button that starts its own analysis when it
 * has not run, and a button that opens the same thing in a tab of its own when
 * the strip is too small for what you are looking at.
 *
 * The canvas above stays one cell per file — the strip is the only place a clip
 * is ever broken open, which keeps "which file is this" and "what is inside it"
 * as two separate questions.
 */
export class ShotStrip {
	readonly el: HTMLElement;

	private readonly tabsEl: HTMLElement;
	private readonly summaryEl: HTMLElement;
	private readonly actionEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly soundEl: HTMLElement;
	private readonly soundCanvas: HTMLCanvasElement;
	private readonly soundReadoutEl: HTMLElement;
	private readonly panelEl: HTMLElement;

	private item: MediaItem | null = null;
	private tab: Tab = 'cuts';
	private activeIndex: number | null = null;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeSound: (() => void) | null = null;
	/** Cancels for the thumbnail requests of the items currently rendered. */
	private cancels: (() => void)[] = [];
	private collapsed = false;
	/**
	 * True while a parameter slider is being dragged.
	 *
	 * Each drag step re-cuts the clip, which fires a change event, which would
	 * rebuild the header and destroy the slider under the pointer. While this is
	 * set, only the body below is redrawn.
	 */
	private adjusting = false;
	private frame: number | null = null;

	/** Rebuild keys, so nothing is torn out from under the pointer. */
	private tabsKey = '';
	private actionsKey = '';
	private panelKind: SoundPanel | null = null;
	private panelUpdate: (() => void) | null = null;

	private lanes: SoundLanes | null = null;
	private lanesKey = '';
	private hover: number | null = null;
	private readonly colors: { get: (v: string, f: string) => string; clear: () => void };
	private resizeObserver: ResizeObserver | null = null;

	/** Null until checked; re-checked whenever a download finishes. */
	private modelsReady: boolean | null = null;
	private checkingModels = false;
	private readonly cacheRequested = new Set<string>();
	private readonly cacheChecked = new Set<string>();
	private runStartedAt = 0;

	private readonly paramHost: ParamHost;

	constructor(
		parent: HTMLElement,
		private readonly shots: ShotIndex,
		private readonly sound: SoundIndex,
		private readonly thumbnails: ThumbnailStore,
		private readonly options: ShotStripOptions,
	) {
		this.el = parent.createDiv({ cls: 'cine-strip' });
		this.el.hide();

		const header = this.el.createDiv({ cls: 'cine-strip-header' });
		this.tabsEl = header.createDiv({ cls: 'cine-strip-tabs' });
		this.summaryEl = header.createDiv({ cls: 'cine-strip-summary' });
		this.actionEl = header.createDiv({ cls: 'cine-strip-actions' });

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

		this.soundEl = this.el.createDiv({ cls: 'cine-strip-sound' });
		this.soundCanvas = this.soundEl.createEl('canvas', {
			cls: 'cine-strip-sound-canvas',
		});
		this.soundCanvas.setCssStyles({ height: `${rowsHeight(STRIP_ROWS)}px` });
		this.soundReadoutEl = this.soundEl.createDiv({
			cls: 'cine-strip-sound-readout',
		});
		this.soundEl.hide();

		this.panelEl = this.el.createDiv({ cls: 'cine-strip-panel' });
		this.panelEl.hide();

		this.colors = createColorCache(this.el);
		this.bindSoundCanvas();

		this.resizeObserver = new ResizeObserver(() => this.drawSound());
		this.resizeObserver.observe(this.soundEl);

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
		this.unsubscribeSound = this.sound.onChange(() => this.scheduleRender());
	}

	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeSound?.();
		this.unsubscribeSound = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
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
		this.lanes = null;
		this.lanesKey = '';
		this.hover = null;
		this.runStartedAt = 0;
		// The header and panel belong to the old clip; force both to rebuild.
		this.tabsKey = '';
		this.actionsKey = '';
		this.panelKind = null;
		this.render();
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		this.el.toggleClass('is-collapsed', this.collapsed);
	}

	/** Switches which question the strip is answering. */
	setTab(tab: Tab): void {
		if (this.tab === tab) return;
		this.tab = tab;
		this.actionsKey = '';
		this.panelKind = null;
		this.render();
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

	/** Runs detection over the selected clip, cached result or not. */
	detectSelected(force = false): void {
		if (this.item) void this.detect(this.item, force);
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

		this.renderTabs(item);
		if (this.tab === 'cuts') this.renderCuts(item);
		else this.renderSound(item);
	}

	/**
	 * The tab bar.
	 *
	 * Each tab carries a dot when its side has never been run for this clip, so
	 * "there is nothing here" is visible before you switch to find out.
	 */
	private renderTabs(item: MediaItem): void {
		const hasCuts = this.shots.has(item);
		const hasSound = this.sound.get(item.file) !== null;
		const key = `${item.path}|${this.tab}|${hasCuts}|${hasSound}`;
		if (key === this.tabsKey) return;
		this.tabsKey = key;
		this.tabsEl.empty();

		for (const tab of TABS) {
			const button = this.tabsEl.createEl('button', {
				cls: 'cine-strip-tab',
			});
			button.toggleClass('is-active', tab.id === this.tab);
			const icon = button.createSpan();
			setIcon(icon, tab.icon);
			button.createSpan({ text: tab.label });
			const ran = tab.id === 'cuts' ? hasCuts : hasSound;
			if (!ran) button.createSpan({ cls: 'cine-strip-tab-dot' });
			setTooltip(
				button,
				ran ? tab.hint : `${tab.hint} Not run on this clip yet.`,
				{ placement: 'top' },
			);
			button.addEventListener('click', () => this.setTab(tab.id));
		}
	}

	// --- the cuts tab -----------------------------------------------------

	private renderCuts(item: MediaItem): void {
		this.soundEl.hide();
		this.bodyEl.show();

		const shots = this.shots.get(item);
		// Mid-drag the header must survive, because the slider being dragged
		// lives in it.
		if (this.adjusting && shots && shots.length > 0) {
			this.clearItems();
			this.summaryEl.setText(summarize(item, shots));
			for (const shot of shots) this.renderItem(item, shot);
			this.applyActive();
			return;
		}

		this.clearItems();

		if (this.shots.isPending(item)) {
			this.setPanel(null);
			this.el.toggleClass('is-empty', true);
			const progress = this.shots.progressFor(item);
			const percent =
				progress === null ? '' : ` ${Math.round(progress * 100)}%`;
			this.summaryEl.setText(
				`${DETECTOR_LABEL} is finding cuts in ${item.file.name}…${percent}`,
			);
			this.renderCutActions(item, false, true);
			return;
		}
		if (shots && shots.length > 0) {
			this.setPanel(null);
			this.el.toggleClass('is-empty', false);
			this.summaryEl.setText(summarize(item, shots));
			setTooltip(this.summaryEl, item.path, { placement: 'top' });
			this.renderCutActions(item, true, false);
			for (const shot of shots) this.renderItem(item, shot);
			this.applyActive();
			return;
		}

		this.setPanel(null);
		this.el.toggleClass('is-empty', true);
		// A detector that ran and failed has a reason; one that ran and found a
		// single long take does not. Saying which is the whole point.
		const error = this.shots.errorFor(item);
		this.summaryEl.setText(
			error ? `${item.file.name} — ${error}` : item.file.name,
		);
		setTooltip(this.summaryEl, error ?? item.path, { placement: 'top' });
		this.renderCutActions(item, false, false);
	}

	private renderCutActions(
		item: MediaItem,
		cut: boolean,
		pending: boolean,
	): void {
		if (this.adjusting) return;
		const key = `cuts|${item.path}|${cut}|${pending}`;
		if (key === this.actionsKey) return;
		this.actionsKey = key;
		this.actionEl.empty();

		if (pending) {
			this.actionEl.createDiv({ cls: 'cine-strip-spinner' });
			this.renderOpenButton(
				'gallery-vertical-end',
				'Open this clip in its own tab, with every segment laid out',
				() => this.options.onOpenClip(item),
			);
			return;
		}

		if (cut) renderParams(this.actionEl, this.paramHost);
		else
			renderFindCuts(this.actionEl, item, true, {
				shots: this.shots,
				run: (target) => void this.detect(target, false),
			});

		this.renderOpenButton(
			'gallery-vertical-end',
			'Open this clip in its own tab, with every segment laid out',
			() => this.options.onOpenClip(item),
		);

		if (!cut) return;
		const again = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(again, 'refresh-cw');
		setTooltip(again, `Run ${DETECTOR_LABEL} over this clip again`, {
			placement: 'top',
		});
		again.addEventListener('click', () => void this.detect(item, true));
	}

	private renderOpenButton(
		icon: string,
		tooltip: string,
		action: () => void,
	): void {
		const button = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(button, icon);
		setTooltip(button, tooltip, { placement: 'top' });
		button.addEventListener('click', action);
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

	// --- the sound tab ----------------------------------------------------

	private renderSound(item: MediaItem): void {
		this.bodyEl.hide();
		this.clearItems();
		this.el.toggleClass('is-empty', false);

		const file = item.file;
		let analysis = this.sound.get(file);
		const id = `${file.path}|${file.stat.size}|${file.stat.mtime}`;
		if (!analysis && !this.cacheRequested.has(id)) {
			this.cacheRequested.add(id);
			// Marked checked whether the read worked or not: a cache that cannot
			// be read is the same as no cache, and leaving it unchecked would
			// wedge the panel on its spinner with no way out.
			const done = (): void => {
				this.cacheChecked.add(id);
				this.scheduleRender();
			};
			void this.sound.readCached(file).then(done, done);
		}
		if (this.modelsReady === null) this.checkModels();

		const pending = this.sound.isPending(file);
		if (pending && this.runStartedAt === 0) this.runStartedAt = Date.now();
		if (!pending) this.runStartedAt = 0;

		if (analysis) this.updateLanes(analysis);
		else this.lanes = null;
		analysis = this.lanes ? analysis : null;

		this.renderSoundSummary(item, analysis, pending);
		this.renderSoundActions(item, analysis !== null, pending);

		const kind: SoundPanel = pending
			? 'running'
			: analysis
				? 'lanes'
				: this.sound.downloading
					? 'downloading'
					: !this.cacheChecked.has(id) || this.modelsReady === null
						? 'loading'
						: this.sound.errorFor(file)
							? 'error'
							: this.modelsReady
								? 'ready'
								: 'models';

		this.soundEl.toggle(kind === 'lanes');
		if (kind === 'lanes') {
			this.setPanel(null);
			this.drawSound();
		} else {
			this.renderSoundPanel(item, kind);
		}
	}

	private renderSoundSummary(
		item: MediaItem,
		analysis: SoundAnalysis | null,
		pending: boolean,
	): void {
		const file = item.file;
		if (pending) {
			const progress = this.sound.progressFor(file);
			this.summaryEl.setText(
				`Analysing the sound of ${file.name}… ${Math.round(progress * 100)}%`,
			);
			return;
		}
		const lanes = this.lanes;
		if (!analysis || !lanes) {
			const error = this.sound.errorFor(file);
			this.summaryEl.setText(
				error ? `${file.name} — ${error}` : file.name,
			);
			setTooltip(this.summaryEl, error ?? item.path, { placement: 'top' });
			return;
		}
		const share = (mask: Uint8Array): string =>
			`${Math.round((laneSeconds(mask) / Math.max(analysis.duration, 1e-6)) * 100)}%`;
		this.summaryEl.setText(
			[
				file.name,
				formatTimecode(analysis.duration),
				`dialogue ${share(lanes.dialogue)}`,
				`music ${share(lanes.music)}`,
				`effects ${share(lanes.effects)}`,
				`silence ${share(lanes.silence)}`,
			].join('  ·  '),
		);
		setTooltip(this.summaryEl, item.path, { placement: 'top' });
	}

	private renderSoundActions(
		item: MediaItem,
		analysed: boolean,
		pending: boolean,
	): void {
		if (this.adjusting) return;
		const key = `sound|${item.path}|${analysed}|${pending}`;
		if (key === this.actionsKey) return;
		this.actionsKey = key;
		this.actionEl.empty();

		if (analysed) {
			const group = this.actionEl.createDiv({ cls: 'cine-params' });
			const params = this.options.getSoundParams();
			const host = {
				setParam: (k: SoundParamKey, v: number) =>
					this.options.setSoundParam(k, v),
				hold: this.paramHost.hold,
				release: this.paramHost.release,
			};
			// Only the two thresholds that change what you can see at this size;
			// the silence level belongs with the lists in the full view.
			renderSoundRange(group, 'soundDialogue', 'Dialogue', params, host);
			renderSoundRange(group, 'soundMusic', 'Music', params, host);
		}

		this.renderOpenButton(
			'audio-waveform',
			'Open this clip in the sound view: lanes across the whole running time, plus music cues and silences',
			() => this.options.onOpenSound(item),
		);

		if (pending) {
			const stop = this.actionEl.createEl('button', {
				cls: 'cine-strip-icon',
			});
			setIcon(stop, 'square');
			setTooltip(stop, 'Stop the analysis', { placement: 'top' });
			stop.addEventListener('click', () => this.sound.cancel(item.file));
			return;
		}
		if (!analysed) return;

		const again = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(again, 'refresh-cw');
		setTooltip(again, 'Analyse this clip again', { placement: 'top' });
		again.addEventListener('click', () => void this.analyse(item, true));
	}

	/**
	 * The prompt that stands in for the lanes.
	 *
	 * Rebuilt only when its kind changes and otherwise updated in place, so a
	 * progress bar arriving three times a second does not take the Stop button
	 * out from under the pointer.
	 */
	private renderSoundPanel(item: MediaItem, kind: SoundPanel): void {
		if (this.panelKind === kind) {
			this.panelUpdate?.();
			return;
		}
		const file = item.file;
		const build = (
			fill: (el: HTMLElement) => void,
			update: () => void = () => undefined,
		): void => {
			this.panelEl.empty();
			this.panelEl.show();
			fill(this.panelEl);
			this.panelKind = kind;
			this.panelUpdate = update;
			update();
		};

		switch (kind) {
			case 'loading':
				build((el) => {
					el.createDiv({ cls: 'cine-strip-spinner' });
				});
				break;
			case 'models':
				build((el) => {
					el.createDiv({
						cls: 'cine-strip-panel-text',
						text: `Hearing a clip needs two networks on this machine: Silero VAD for dialogue, and PANNs CNN14 to tell music from effects. ${megabytes(SOUND_MODEL_BYTES)}, downloaded once into the plugin folder.`,
					});
					const button = el
						.createDiv({ cls: 'cine-strip-panel-row' })
						.createEl('button', {
							cls: 'mod-cta',
							text: `Download models · ${megabytes(SOUND_MODEL_BYTES)}`,
						});
					button.addEventListener('click', () => void this.download());
				});
				break;
			case 'downloading': {
				let bar: HTMLElement;
				let label: HTMLElement;
				build(
					(el) => {
						label = el.createDiv({ cls: 'cine-strip-panel-text' });
						bar = el
							.createDiv({ cls: 'cine-strip-progress' })
							.createDiv({ cls: 'cine-strip-progress-bar' });
					},
					() => {
						const state = this.sound.downloading;
						if (!state) return;
						const fraction =
							state.total > 0 ? state.received / state.total : 0;
						bar.setCssStyles({ width: `${fraction * 100}%` });
						label.setText(
							`Downloading models · ${megabytes(state.received)} of ${megabytes(state.total)}`,
						);
					},
				);
				break;
			}
			case 'ready':
				build((el) => {
					const duration = this.shots.get(item)?.at(-1)?.end ?? 0;
					const estimate =
						duration > 0
							? `about ${formatLength(duration * ANALYSIS_SECONDS_PER_SECOND)}`
							: 'about 5 seconds per minute of audio';
					el.createDiv({
						cls: 'cine-strip-panel-text',
						text: `Not analysed yet. The clip is decoded once and read three ways — dialogue, music and effects, and loudness — in ${estimate}. The thresholds can be changed afterwards without running it again.`,
					});
					const button = el
						.createDiv({ cls: 'cine-strip-panel-row' })
						.createEl('button', {
							cls: 'mod-cta',
							text: 'Analyse sound',
						});
					button.addEventListener('click', () => void this.analyse(item, false));
				});
				break;
			case 'running': {
				let bar: HTMLElement;
				let label: HTMLElement;
				build(
					(el) => {
						label = el.createDiv({ cls: 'cine-strip-panel-text' });
						bar = el
							.createDiv({ cls: 'cine-strip-progress' })
							.createDiv({ cls: 'cine-strip-progress-bar' });
						const stop = el
							.createDiv({ cls: 'cine-strip-panel-row' })
							.createEl('button', { text: 'Stop' });
						stop.addEventListener('click', () => this.sound.cancel(file));
					},
					() => {
						const running = this.sound.isRunning(file);
						const fraction = this.sound.progressFor(file);
						bar.setCssStyles({ width: `${fraction * 100}%` });
						const elapsed = (Date.now() - this.runStartedAt) / 1000;
						const left =
							running && fraction > 0.02
								? ` · about ${formatLength((elapsed / fraction) * (1 - fraction))} left`
								: '';
						label.setText(
							running
								? `Analysing sound · ${Math.round(fraction * 100)}%${left}`
								: 'Waiting for another analysis to finish…',
						);
					},
				);
				break;
			}
			case 'error':
				build((el) => {
					el.createDiv({
						cls: 'cine-strip-panel-text',
						text: this.sound.errorFor(file) ?? 'The analysis failed.',
					});
					const button = el
						.createDiv({ cls: 'cine-strip-panel-row' })
						.createEl('button', { text: 'Try again' });
					button.addEventListener('click', () => void this.analyse(item, true));
				});
				break;
			case 'lanes':
				break;
		}
	}

	private setPanel(kind: null): void {
		if (this.panelKind === kind) return;
		this.panelKind = kind;
		this.panelUpdate = null;
		this.panelEl.empty();
		this.panelEl.hide();
	}

	private updateLanes(analysis: SoundAnalysis): void {
		const p = this.options.getSoundParams();
		const key = `${analysis.path}|${analysis.duration}|${analysis.loudness.length}|${p.soundSilenceDb}|${p.soundDialogue}|${p.soundMusic}`;
		if (key === this.lanesKey && this.lanes) return;
		this.lanesKey = key;
		this.lanes = classifySound(analysis, p);
	}

	private bindSoundCanvas(): void {
		const timeAt = (offsetX: number): number | null => {
			const analysis = this.item
				? this.sound.get(this.item.file)
				: null;
			const width = this.soundCanvas.clientWidth;
			if (!analysis || analysis.duration <= 0 || width <= 0) return null;
			const x = Math.min(Math.max(0, offsetX), width);
			return (x / width) * analysis.duration;
		};
		this.soundCanvas.addEventListener('pointermove', (e) => {
			this.hover = timeAt(e.offsetX);
			this.drawSound();
		});
		this.soundCanvas.addEventListener('pointerleave', () => {
			this.hover = null;
			this.drawSound();
		});
		this.soundCanvas.addEventListener('click', (e) => {
			const time = timeAt(e.offsetX);
			const item = this.item;
			const analysis = item ? this.sound.get(item.file) : null;
			if (time === null || !item || !analysis) return;
			this.options.onSeek(item, time, analysis.duration);
		});
	}

	private drawSound(): void {
		const item = this.item;
		const analysis = item ? this.sound.get(item.file) : null;
		const lanes = this.lanes;
		if (!analysis || !lanes || !this.soundEl.isShown()) return;

		const ratio = window.devicePixelRatio || 1;
		const canvas = this.soundCanvas;
		const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
		const h = Math.max(1, Math.round(rowsHeight(STRIP_ROWS) * ratio));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const ctx = canvas.getContext('2d');
		if (!ctx || w <= 1) return;

		ctx.clearRect(0, 0, w, h);
		drawLanes({
			ctx,
			w,
			h,
			from: 0,
			to: analysis.duration,
			layout: STRIP_ROWS,
			ratio,
			analysis,
			lanes,
			ticks: true,
			color: this.colors.get,
		});
		if (this.hover !== null)
			drawLine(
				ctx,
				(this.hover / analysis.duration) * w,
				h,
				ratio,
				this.colors.get('--text-muted', '#888'),
			);

		this.renderSoundReadout(analysis, lanes, this.hover);
	}

	/** `1:02:05 · dialogue · music — Speech 71 · Piano 30 · -23 dB` */
	private renderSoundReadout(
		analysis: SoundAnalysis,
		lanes: SoundLanes,
		time: number | null,
	): void {
		if (time === null) {
			this.soundReadoutEl.setText(
				'Hover the lanes to read a moment; click to play from there.',
			);
			return;
		}
		const bin = Math.min(
			lanes.bins - 1,
			Math.max(0, Math.floor(time / BIN_SECONDS)),
		);
		const on = LANES.filter((lane) => lanes[lane.name][bin]).map((l) =>
			l.label.toLowerCase(),
		);
		const tags = tagsAt(analysis, time)
			.filter((t) => t.score >= 5)
			.map((t) => `${t.label} ${t.score}`);
		const level = analysis.loudness[bin] ?? -100;
		this.soundReadoutEl.setText(
			[
				`${formatTimecode(time)}  ·  ${on.length > 0 ? on.join(' · ') : 'nothing'}`,
				tags.length > 0 ? tags.join(' · ') : '',
				`${level <= -100 ? '−∞' : level} dB`,
			]
				.filter((part) => part.length > 0)
				.join('  —  '),
		);
	}

	private checkModels(): void {
		if (this.checkingModels) return;
		this.checkingModels = true;
		void this.sound.hasModels().then((ready) => {
			this.checkingModels = false;
			this.modelsReady = ready;
			this.scheduleRender();
		});
	}

	private async download(): Promise<void> {
		try {
			await this.sound.downloadModels();
			new Notice('Cinema canvas: sound models downloaded.');
		} catch (err) {
			new Notice(
				`Cinema canvas: downloading the sound models failed. ${err instanceof Error ? err.message : String(err)}`,
				12000,
			);
		}
		this.modelsReady = null;
		this.panelKind = null;
		this.scheduleRender();
	}

	private async analyse(item: MediaItem, force: boolean): Promise<void> {
		const file: TFile = item.file;
		if (!(await this.sound.hasModels())) {
			this.modelsReady = false;
			this.panelKind = null;
			this.scheduleRender();
			return;
		}
		const result = await this.sound.analyse(file, force);
		if (!result) {
			const reason = this.sound.errorFor(file);
			if (reason)
				new Notice(
					`Cinema canvas: sound analysis failed on ${file.name}. ${reason}`,
					12000,
				);
		}
	}

	// --- state ------------------------------------------------------------

	private async detect(item: MediaItem, force: boolean): Promise<void> {
		if (!(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: the TransNetV2 model is not downloaded yet. Settings → Shot detection → Download.',
				10000,
			);
			return;
		}
		this.render();
		const shots = await this.shots.detect(item, force);
		if (!shots) {
			const reason = this.shots.errorFor(item);
			new Notice(
				reason
					? `Cinema canvas: ${DETECTOR_LABEL} failed on ${item.file.name}. ${reason}`
					: `Cinema canvas: ${DETECTOR_LABEL} found no cuts in ${item.file.name} — it may be a single take.`,
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

/** One sound threshold slider, in the strip's own compact range. */
function renderSoundRange(
	parent: HTMLElement,
	key: SoundParamKey,
	label: string,
	params: SoundParams,
	host: {
		setParam: (key: SoundParamKey, value: number) => void;
		hold: () => void;
		release: () => void;
	},
): void {
	const wrap = parent.createDiv({ cls: 'cine-param' });
	setTooltip(
		wrap,
		`${label} — how sure the detector has to be. The lanes are re-labelled instantly; nothing is decoded again.`,
		{ placement: 'top' },
	);
	wrap.createSpan({ cls: 'cine-param-label', text: label });
	const input = wrap.createEl('input', {
		cls: 'cine-param-range',
		type: 'range',
	});
	input.min = key === 'soundMusic' ? '5' : '10';
	input.max = '90';
	input.step = '5';
	input.value = String(params[key]);
	const readout = wrap.createSpan({
		cls: 'cine-param-value',
		text: `${Math.round(params[key])}%`,
	});
	input.addEventListener('pointerdown', host.hold);
	input.addEventListener('keydown', host.hold);
	input.addEventListener('pointerup', host.release);
	input.addEventListener('pointercancel', host.release);
	input.addEventListener('blur', host.release);
	input.addEventListener('input', () => {
		const next = Number(input.value);
		if (!Number.isFinite(next)) return;
		readout.setText(`${Math.round(next)}%`);
		host.setParam(key, next);
	});
}
