import {
	ItemView,
	Notice,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from 'obsidian';
import type CinemaCanvasPlugin from '../main';
import {
	ANALYSIS_SECONDS_PER_SECOND,
	SOUND_MODEL_BYTES,
} from '../media/sound';
import {
	BIN_SECONDS,
	LaneName,
	SoundAnalysis,
	SoundLanes,
	SoundParamKey,
	SoundRun,
	classifySound,
	laneSeconds,
	runsOf,
	tagsAt,
} from '../media/sound-analysis';
import { formatTimecode } from '../utils/timecode';
import { RangeHost, RangeSpec, renderRange } from './shot-controls';
import {
	ColorResolver,
	DETAIL_ROWS,
	LANES,
	LOUDNESS_FLOOR,
	OVERVIEW_ROWS,
	RowLayout,
	createColorCache,
	drawLanes,
	drawLine,
	formatLength,
	megabytes,
	rowsHeight,
} from './sound-lanes';

export const VIEW_TYPE_CINEMA_SOUND = 'cinema-sound';

const PARAMS: readonly RangeSpec<SoundParamKey>[] = [
	{
		key: 'soundSilenceDb',
		label: 'Silence',
		min: -80,
		max: -20,
		step: 1,
		format: (v) => `${Math.round(v)} dB`,
		hint: "Anything quieter than this counts as silence. A film's silence is room tone, not zero: -50 dB suits most mixes, and a quiet, wide-range mix may want -60.",
	},
	{
		key: 'soundDialogue',
		label: 'Dialogue',
		min: 10,
		max: 90,
		step: 5,
		format: (v) => `${Math.round(v)}%`,
		hint: 'How sure the speech detector has to be. 50 is what its authors use.',
	},
	{
		key: 'soundMusic',
		label: 'Music',
		min: 5,
		max: 90,
		step: 5,
		format: (v) => `${Math.round(v)}%`,
		hint: 'How sure PANNs has to be that music is playing. Lower catches quiet score under dialogue, and more music that is not there.',
	},
];

/** Seconds shown in the detail lanes: default, and the wheel's limits. */
const ZOOM_DEFAULT = 60;
const ZOOM_MIN = 10;
const ZOOM_MAX = 1800;

/** What makes the lists below the lanes. */
const LIST_MIN_SILENCE = 1;
const LIST_MIN_QUIET = 30;
/** A list longer than this stops; the lanes still show every one. */
const LIST_MAX_ROWS = 400;

type PanelKind =
	| 'missing'
	| 'loading'
	| 'models'
	| 'downloading'
	| 'ready'
	| 'running'
	| 'error'
	| 'none';

/**
 * A whole tab given over to the soundtrack of one file.
 *
 * The cut views ask where the picture changes; this one asks what you are
 * hearing, which is the other half of how a scene is built — where the score
 * comes in, how long a scene goes without a line, where the mix drops out
 * entirely. It is meant for whole films: every lane is drawn to scale across
 * the full running time, and a second, zoomable set of lanes follows the
 * playhead for the detail.
 */
export class CinemaSoundView extends ItemView {
	private readonly plugin: CinemaCanvasPlugin;

	private summaryEl!: HTMLElement;
	private actionEl!: HTMLElement;
	private stageEl!: HTMLElement;
	private timelineEl!: HTMLElement;
	private overviewCanvas!: HTMLCanvasElement;
	private detailCanvas!: HTMLCanvasElement;
	private readoutEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private panelEl!: HTMLElement;
	private listsEl!: HTMLElement;
	private video: HTMLVideoElement | null = null;

	private path: string | null = null;
	private file: TFile | null = null;
	private lanes: SoundLanes | null = null;
	private lanesKey = '';
	private listsKey = '';
	private actionsKey = '';
	private panel: { kind: PanelKind; update: () => void } | null = null;

	/** Pre-rendered overview lanes; only the playhead is drawn per frame. */
	private overviewBitmap: HTMLCanvasElement | null = null;
	private overviewKey = '';
	private colors!: { get: ColorResolver; clear: () => void };
	private zoom = ZOOM_DEFAULT;
	private hover: { canvas: 'overview' | 'detail'; time: number } | null =
		null;

	/** Null until checked; re-checked whenever a download finishes. */
	private modelsReady: boolean | null = null;
	private checkingModels = false;
	/** Files whose cache has been asked for, and those whose answer is in. */
	private readonly cacheRequested = new Set<string>();
	private readonly cacheChecked = new Set<string>();
	private runStartedAt = 0;

	private unsubscribe: (() => void) | null = null;
	private frame: number | null = null;
	private playFrame: number | null = null;
	/** Its own frame, so a retry never swallows a pending render. */
	private drawFrame: number | null = null;
	private drawRetries = 0;
	private resizeObserver: ResizeObserver | null = null;
	private adjusting = false;

	private readonly paramHost: RangeHost<SoundParamKey>;

	constructor(leaf: WorkspaceLeaf, plugin: CinemaCanvasPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
		this.paramHost = {
			setParam: (key, value) => this.plugin.setSoundParam(key, value),
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
		return VIEW_TYPE_CINEMA_SOUND;
	}

	getDisplayText(): string {
		return this.file ? `${this.file.name} · sound` : 'Sound';
	}

	override getIcon(): string {
		return 'audio-waveform';
	}

	// --- lifecycle --------------------------------------------------------

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('cine-clip-view', 'cine-sound-view');
		root.tabIndex = 0;
		this.colors = createColorCache(root);

		const header = root.createDiv({ cls: 'cine-clip-header' });
		this.summaryEl = header.createDiv({ cls: 'cine-clip-summary' });
		this.actionEl = header.createDiv({ cls: 'cine-clip-actions' });

		this.stageEl = root.createDiv({ cls: 'cine-clip-stage cine-sound-stage' });

		this.timelineEl = root.createDiv({ cls: 'cine-sound-timeline' });
		this.overviewCanvas = this.buildLanes(
			this.timelineEl,
			'overview',
			OVERVIEW_ROWS,
		);
		this.detailCanvas = this.buildLanes(
			this.timelineEl,
			'detail',
			DETAIL_ROWS,
		);
		this.readoutEl = this.timelineEl.createDiv({ cls: 'cine-sound-readout' });

		this.bodyEl = root.createDiv({ cls: 'cine-clip-body cine-sound-body' });
		this.panelEl = this.bodyEl.createDiv({ cls: 'cine-sound-panel' });
		this.listsEl = this.bodyEl.createDiv({ cls: 'cine-sound-lists' });

		this.registerDomEvent(root, 'keydown', (e) => this.onKeyDown(e));
		this.registerDomEvent(this.detailCanvas, 'wheel', (e) => this.onWheel(e), {
			passive: false,
		});
		// Full screen changes the width of the lanes without resizing the leaf,
		// and the observer below can miss the transition either way.
		this.registerDomEvent(root, 'fullscreenchange', () => {
			this.sizeCanvases();
			this.draw();
		});

		this.resizeObserver = new ResizeObserver(() => {
			this.sizeCanvases();
			this.draw();
		});
		this.resizeObserver.observe(this.timelineEl);

		this.unsubscribe = this.plugin.sound.onChange(() => this.scheduleRender());
		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				this.colors.clear();
				this.overviewBitmap = null;
				this.overviewKey = '';
				this.draw();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) =>
				this.onRename(file, oldPath),
			),
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file.path === this.path) this.scheduleRender();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file.path === this.path) this.scheduleRender();
			}),
		);
		// The first render can land while this leaf is still hidden: the tab is
		// revealed after `onOpen` returns, and a cached analysis needs no time
		// at all, so everything happens in that one tick. Becoming the active
		// leaf, and the layout settling, both have to draw again.
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf !== this.leaf) return;
				this.drawRetries = 0;
				this.draw();
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			this.drawRetries = 0;
			this.draw();
		});

		this.render();
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		if (this.drawFrame !== null) window.cancelAnimationFrame(this.drawFrame);
		this.drawFrame = null;
		this.stopPlayLoop();
		this.dropVideo();
	}

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
			this.file = null;
			this.resetForFile();
			this.render();
		}
		await super.setState(state, result);
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		if (oldPath !== this.path) return;
		// The readings are keyed by path, so a renamed film is a new analysis;
		// the view follows the file rather than showing a missing one.
		this.path = file.path;
		this.file = null;
		this.resetForFile();
		this.render();
	}

	private resetForFile(): void {
		this.lanes = null;
		this.lanesKey = '';
		this.listsKey = '';
		this.actionsKey = '';
		this.overviewKey = '';
		this.panel = null;
		this.hover = null;
		this.dropVideo();
	}

	private dropVideo(): void {
		this.stopPlayLoop();
		this.video?.pause();
		this.video = null;
	}

	private resolveFile(): TFile | null {
		if (!this.path) return null;
		const found = this.app.vault.getAbstractFileByPath(this.path);
		this.file = found instanceof TFile ? found : null;
		return this.file;
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
		const file = this.resolveFile();
		if (!file) {
			this.renderMissing();
			return;
		}
		const sound = this.plugin.sound;
		this.ensureVideo(file);

		let analysis = sound.get(file);
		const id = this.cacheId(file);
		if (!analysis && !this.cacheRequested.has(id)) {
			this.cacheRequested.add(id);
			void sound.readCached(file).then(() => {
				this.cacheChecked.add(id);
				this.scheduleRender();
			});
		}
		if (this.modelsReady === null) this.checkModels();

		const running = sound.isRunning(file);
		const pending = sound.isPending(file);
		if (pending && this.runStartedAt === 0) this.runStartedAt = Date.now();
		if (!pending) this.runStartedAt = 0;

		if (analysis) this.updateLanes(analysis);
		else this.lanes = null;
		analysis = this.lanes ? analysis : null;

		this.renderSummary(file, analysis, running);
		if (!this.adjusting) this.renderActions(file, analysis, pending);

		this.timelineEl.toggle(analysis !== null);
		this.renderPanel(file, analysis, pending);
		this.renderLists(analysis);
		if (analysis) this.draw();
	}

	/**
	 * Obsidian's own signal that the leaf changed size.
	 *
	 * This is the frame a background tab is first laid out in, which is exactly
	 * what the observer on a `display: none` timeline cannot see.
	 */
	override onResize(): void {
		this.drawRetries = 0;
		this.draw();
	}

	private renderMissing(): void {
		this.dropVideo();
		this.stageEl.empty();
		this.actionEl.empty();
		this.actionsKey = '';
		this.timelineEl.hide();
		this.listsEl.empty();
		this.listsKey = '';
		this.summaryEl.setText(
			this.path ? `${this.path} is not in the vault.` : 'No file.',
		);
		this.setPanel('missing', (el) => {
			el.createDiv({
				cls: 'cine-clip-placeholder',
				text: this.path
					? 'The file may have been moved outside the vault or deleted.'
					: 'Right-click a video or audio file and choose "Open in sound view".',
			});
		});
	}

	private renderSummary(
		file: TFile,
		analysis: SoundAnalysis | null,
		running: boolean,
	): void {
		const sound = this.plugin.sound;
		if (running) {
			const progress = sound.progressFor(file);
			this.summaryEl.setText(
				`${file.name} — analysing sound… ${Math.round(progress * 100)}%`,
			);
			return;
		}
		const lanes = this.lanes;
		if (!analysis || !lanes) {
			const error = sound.errorFor(file);
			this.summaryEl.setText(error ? `${file.name} — ${error}` : file.name);
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
		setTooltip(this.summaryEl, file.path, { placement: 'bottom' });
	}

	private renderActions(
		file: TFile,
		analysis: SoundAnalysis | null,
		pending: boolean,
	): void {
		// Rebuilt only when what it offers changes: progress arrives several
		// times a second, and a button rebuilt under the pointer loses its
		// click.
		const key = `${file.path}|${analysis !== null}|${pending}`;
		if (key === this.actionsKey) return;
		this.actionsKey = key;
		this.actionEl.empty();

		if (analysis) {
			const group = this.actionEl.createDiv({ cls: 'cine-params' });
			const settings = this.plugin.settings;
			for (const spec of PARAMS)
				renderRange(
					group,
					spec,
					settings[spec.key],
					this.paramHost,
					'The lanes are re-labelled instantly; nothing is decoded again.',
				);
		}

		if (pending) {
			const stop = this.actionEl.createEl('button', {
				cls: 'cine-strip-icon',
			});
			setIcon(stop, 'square');
			setTooltip(stop, 'Stop the analysis', { placement: 'bottom' });
			stop.addEventListener('click', () => this.plugin.sound.cancel(file));
		} else if (analysis) {
			const again = this.actionEl.createEl('button', {
				cls: 'cine-strip-icon',
			});
			setIcon(again, 'refresh-cw');
			setTooltip(again, 'Analyse this file again', { placement: 'bottom' });
			again.addEventListener('click', () => void this.analyse(file, true));
		}

		const expand = this.actionEl.createEl('button', {
			cls: 'cine-strip-icon',
		});
		setIcon(expand, 'expand');
		setTooltip(
			expand,
			"Full screen: the player and the lanes, nothing else. The player's own full screen button shows only the picture.",
			{ placement: 'bottom' },
		);
		expand.addEventListener('click', () => void this.toggleFullscreen());
	}

	/**
	 * The state panel: everything between "no models" and "here are the lanes".
	 *
	 * It is rebuilt only when its kind changes and otherwise updated in place,
	 * for the same reason as the header.
	 */
	private renderPanel(
		file: TFile,
		analysis: SoundAnalysis | null,
		pending: boolean,
	): void {
		const sound = this.plugin.sound;
		const kind: PanelKind = pending
			? 'running'
			: analysis
				? 'none'
				: sound.downloading
					? 'downloading'
					: !this.cacheChecked.has(this.cacheId(file)) ||
						  this.modelsReady === null
						? 'loading'
						: sound.errorFor(file)
							? 'error'
							: this.modelsReady
								? 'ready'
								: 'models';

		if (this.panel?.kind === kind) {
			this.panel.update();
			return;
		}

		switch (kind) {
			case 'none':
				this.setPanel(kind, () => undefined);
				break;
			case 'loading':
				this.setPanel(kind, (el) => {
					el.createDiv({ cls: 'cine-clip-spinner-row' }).createDiv({
						cls: 'cine-strip-spinner',
					});
				});
				break;
			case 'models':
				this.setPanel(kind, (el) => {
					el.createDiv({
						cls: 'cine-clip-placeholder',
						text: `Sound analysis runs two networks on this machine: Silero VAD finds dialogue, and PANNs CNN14 tells music from effects. They are downloaded once into the plugin folder, ${megabytes(SOUND_MODEL_BYTES)} in all, and checked against the exact files this view was tested with.`,
					});
					const button = el
						.createDiv({ cls: 'cine-sound-cta' })
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
				this.setPanel(
					kind,
					(el) => {
						label = el.createDiv({ cls: 'cine-clip-placeholder' });
						bar = el
							.createDiv({ cls: 'cine-sound-progress' })
							.createDiv({ cls: 'cine-sound-progress-bar' });
					},
					() => {
						const state = sound.downloading;
						if (!state) return;
						const fraction = state.total > 0 ? state.received / state.total : 0;
						bar.setCssStyles({ width: `${fraction * 100}%` });
						label.setText(
							`Downloading models · ${megabytes(state.received)} of ${megabytes(state.total)}`,
						);
					},
				);
				break;
			}
			case 'ready':
				this.setPanel(kind, (el) => {
					const duration = this.video?.duration;
					const estimate =
						duration && Number.isFinite(duration)
							? `about ${formatLength(duration * ANALYSIS_SECONDS_PER_SECOND)}`
							: 'about 5 seconds per minute of audio';
					el.createDiv({
						cls: 'cine-clip-placeholder',
						text: `This file has not been analysed yet. It is decoded once and read three ways — dialogue, music and effects, and loudness — in ${estimate}. The result is cached, and the thresholds can be changed afterwards without running it again.`,
					});
					const button = el
						.createDiv({ cls: 'cine-sound-cta' })
						.createEl('button', { cls: 'mod-cta', text: 'Analyse sound' });
					button.addEventListener('click', () => void this.analyse(file, false));
				});
				break;
			case 'running': {
				let bar: HTMLElement;
				let label: HTMLElement;
				this.setPanel(
					kind,
					(el) => {
						label = el.createDiv({ cls: 'cine-clip-placeholder' });
						bar = el
							.createDiv({ cls: 'cine-sound-progress' })
							.createDiv({ cls: 'cine-sound-progress-bar' });
						const stop = el
							.createDiv({ cls: 'cine-sound-cta' })
							.createEl('button', { text: 'Stop' });
						stop.addEventListener('click', () => sound.cancel(file));
					},
					() => {
						const running = sound.isRunning(file);
						const fraction = sound.progressFor(file);
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
				this.setPanel(kind, (el) => {
					el.createDiv({
						cls: 'cine-clip-placeholder',
						text: sound.errorFor(file) ?? 'The analysis failed.',
					});
					const button = el
						.createDiv({ cls: 'cine-sound-cta' })
						.createEl('button', { text: 'Try again' });
					button.addEventListener('click', () => void this.analyse(file, true));
				});
				break;
		}
	}

	private setPanel(
		kind: PanelKind,
		build: (el: HTMLElement) => void,
		update: () => void = () => undefined,
	): void {
		this.panelEl.empty();
		build(this.panelEl);
		this.panel = { kind, update };
		update();
	}

	private updateLanes(analysis: SoundAnalysis): void {
		const s = this.plugin.settings;
		const key = `${analysis.path}|${analysis.duration}|${analysis.loudness.length}|${s.soundSilenceDb}|${s.soundDialogue}|${s.soundMusic}`;
		if (key === this.lanesKey && this.lanes) return;
		this.lanesKey = key;
		this.lanes = classifySound(analysis, {
			soundSilenceDb: s.soundSilenceDb,
			soundDialogue: s.soundDialogue,
			soundMusic: s.soundMusic,
		});
		this.overviewKey = '';
	}

	/**
	 * The lists: music cues, silences, and long stretches with no dialogue.
	 *
	 * These are the questions a lane answers only by squinting — how many cues,
	 * how long the longest silence, where the film goes a minute without a
	 * word — so they are also written out, each one a jump to that moment.
	 */
	private renderLists(analysis: SoundAnalysis | null): void {
		const lanes = this.lanes;
		const key = analysis && lanes ? this.lanesKey : '';
		if (key === this.listsKey) return;
		this.listsKey = key;
		this.listsEl.empty();
		if (!analysis || !lanes) return;

		const stats = this.listsEl.createDiv({ cls: 'cine-sound-stats' });
		for (const lane of LANES) {
			const seconds = laneSeconds(lanes[lane.name]);
			const chip = stats.createDiv({ cls: 'cine-sound-stat' });
			chip.createSpan({
				cls: `cine-sound-swatch is-${lane.name}`,
			});
			chip.createSpan({ cls: 'cine-sound-stat-label', text: lane.label });
			chip.createSpan({
				cls: 'cine-sound-stat-value',
				text: `${Math.round((seconds / Math.max(analysis.duration, 1e-6)) * 100)}% · ${formatLength(seconds)}`,
			});
			setTooltip(chip, lane.hint, { placement: 'top' });
		}

		const columns = this.listsEl.createDiv({ cls: 'cine-sound-columns' });
		this.renderRunList(
			columns,
			'Music cues',
			'music',
			runsOf(lanes.music),
			'No music at this threshold.',
		);
		this.renderRunList(
			columns,
			`Silences over ${LIST_MIN_SILENCE}s`,
			'silence',
			runsOf(lanes.silence).filter(
				(r) => r.end - r.start >= LIST_MIN_SILENCE,
			),
			'No silence at this threshold. Try raising it: a mix is rarely quieter than its room tone.',
		);
		this.renderRunList(
			columns,
			`No dialogue for ${LIST_MIN_QUIET}s or more`,
			'dialogue',
			runsOf(lanes.dialogue, 0).filter(
				(r) => r.end - r.start >= LIST_MIN_QUIET,
			),
			`Nobody goes ${LIST_MIN_QUIET}s without speaking.`,
		);
	}

	private renderRunList(
		parent: HTMLElement,
		title: string,
		lane: LaneName,
		runs: SoundRun[],
		empty: string,
	): void {
		const section = parent.createDiv({ cls: 'cine-sound-list' });
		const head = section.createDiv({ cls: 'cine-sound-list-head' });
		head.createSpan({ cls: `cine-sound-swatch is-${lane}` });
		head.createSpan({ text: title });
		head.createSpan({
			cls: 'cine-sound-list-count',
			text: String(runs.length),
		});
		if (runs.length === 0) {
			section.createDiv({ cls: 'cine-sound-list-empty', text: empty });
			return;
		}
		const longest = runs.reduce((a, r) => Math.max(a, r.end - r.start), 0);
		runs.slice(0, LIST_MAX_ROWS).forEach((run, i) => {
			const row = section.createDiv({ cls: 'cine-sound-row' });
			row.createSpan({ cls: 'cine-sound-row-index', text: String(i + 1) });
			row.createSpan({
				cls: 'cine-sound-row-time',
				text: formatTimecode(run.start),
			});
			const length = run.end - run.start;
			const meter = row.createSpan({ cls: 'cine-sound-row-meter' });
			meter
				.createSpan({ cls: `cine-sound-row-fill is-${lane}` })
				.setCssStyles({ width: `${(length / Math.max(longest, 1e-6)) * 100}%` });
			row.createSpan({
				cls: 'cine-sound-row-length',
				text: formatLength(length),
			});
			setTooltip(
				row,
				`${formatTimecode(run.start)} to ${formatTimecode(run.end)} · click to play from here`,
				{ placement: 'left' },
			);
			row.addEventListener('click', () => this.playFrom(run.start));
		});
		if (runs.length > LIST_MAX_ROWS)
			section.createDiv({
				cls: 'cine-sound-list-empty',
				text: `${runs.length - LIST_MAX_ROWS} more are on the lanes above.`,
			});
	}

	// --- the player ---------------------------------------------------------

	private ensureVideo(file: TFile): void {
		if (this.video && this.video.dataset.path === file.path) return;
		this.dropVideo();
		this.stageEl.empty();
		this.stageEl.removeClass('is-audio');
		const video = this.stageEl.createEl('video', { cls: 'cine-clip-video' });
		video.dataset.path = file.path;
		video.src = this.app.vault.getResourcePath(file);
		video.controls = true;
		video.playsInline = true;
		video.preload = 'metadata';
		video.addEventListener('loadedmetadata', () => {
			// An audio file plays in the same element; it just needs no room.
			this.stageEl.toggleClass('is-audio', video.videoHeight === 0);
			if (this.panel?.kind === 'ready') this.panel = null;
			this.scheduleRender();
		});
		video.addEventListener('play', () => this.startPlayLoop());
		video.addEventListener('pause', () => {
			this.stopPlayLoop();
			this.draw();
		});
		video.addEventListener('seeked', () => this.draw());
		this.video = video;
	}

	private playFrom(time: number): void {
		const video = this.video;
		if (!video) return;
		video.currentTime = time;
		void video.play().catch(() => undefined);
	}

	private startPlayLoop(): void {
		if (this.playFrame !== null) return;
		const tick = (): void => {
			this.draw();
			this.playFrame = window.requestAnimationFrame(tick);
		};
		this.playFrame = window.requestAnimationFrame(tick);
	}

	private stopPlayLoop(): void {
		if (this.playFrame !== null) window.cancelAnimationFrame(this.playFrame);
		this.playFrame = null;
	}

	/**
	 * Full screen over the whole view, not over the player.
	 *
	 * Fullscreening the `<video>` — which is what its own controls do — puts the
	 * picture on top of everything else in the compositor, so nothing can be
	 * drawn over it and the lanes simply vanish. Taking the view's own root
	 * instead keeps the DOM intact, and the stylesheet hides the header and the
	 * lists, leaving the player and the timeline.
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

	// --- the lanes ----------------------------------------------------------

	/** A label column and a canvas, for one set of lanes. */
	private buildLanes(
		parent: HTMLElement,
		which: 'overview' | 'detail',
		layout: RowLayout,
	): HTMLCanvasElement {
		const row = parent.createDiv({ cls: `cine-sound-lanes is-${which}` });
		const labels = row.createDiv({ cls: 'cine-sound-labels' });
		const loudness = labels.createDiv({
			cls: 'cine-sound-label',
			text: which === 'overview' ? 'Whole film' : 'Loudness',
		});
		loudness.setCssStyles({
			height: `${layout.loudness}px`,
			marginBottom: `${layout.gap}px`,
		});
		setTooltip(
			loudness,
			which === 'overview'
				? 'The whole running time. The shaded box is what the lanes below show; click anywhere to jump there.'
				: `RMS level, ${LOUDNESS_FLOOR} dB to 0 dB. Scroll over the lanes to zoom.`,
			{ placement: 'left' },
		);
		for (const lane of LANES) {
			const label = labels.createDiv({
				cls: 'cine-sound-label',
				text: which === 'overview' ? '' : lane.label,
			});
			label.setCssStyles({
				height: `${layout.lane}px`,
				marginBottom: `${layout.gap}px`,
			});
			if (which === 'detail')
				setTooltip(label, lane.hint, { placement: 'left' });
		}

		const canvas = row.createEl('canvas', { cls: 'cine-sound-canvas' });
		canvas.setCssStyles({ height: `${rowsHeight(layout)}px` });
		canvas.addEventListener('pointermove', (e) => {
			const time = this.timeAt(which, canvas, e.offsetX);
			this.hover = time === null ? null : { canvas: which, time };
			this.draw();
		});
		canvas.addEventListener('pointerleave', () => {
			this.hover = null;
			this.draw();
		});
		canvas.addEventListener('click', (e) => {
			const time = this.timeAt(which, canvas, e.offsetX);
			const video = this.video;
			if (time === null || !video) return;
			video.currentTime = time;
			this.draw();
		});
		return canvas;
	}

	private sizeCanvases(): void {
		const ratio = window.devicePixelRatio || 1;
		for (const [canvas, layout] of [
			[this.overviewCanvas, OVERVIEW_ROWS],
			[this.detailCanvas, DETAIL_ROWS],
		] as const) {
			const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
			const height = Math.max(1, Math.round(rowsHeight(layout) * ratio));
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
				if (canvas === this.overviewCanvas) this.overviewKey = '';
			}
		}
	}

	/**
	 * The lanes have no width yet; look again next frame, for about a second.
	 *
	 * Bounded because a view genuinely 0 px wide — a collapsed sidebar, a tab
	 * never revealed — would otherwise hold a frame request open for as long as
	 * it stayed open, and `onResize` will call again the moment it is not.
	 */
	private retryDraw(): void {
		if (this.drawFrame !== null || this.drawRetries >= 60) return;
		this.drawRetries++;
		this.drawFrame = window.requestAnimationFrame(() => {
			this.drawFrame = null;
			this.draw();
		});
	}

	private duration(): number {
		const analysis = this.file ? this.plugin.sound.get(this.file) : null;
		return analysis?.duration ?? 0;
	}

	/** The span the detail lanes show: a third behind the playhead. */
	private detailRange(): [number, number] {
		const duration = this.duration();
		const span = Math.min(this.zoom, duration);
		const time = this.video?.currentTime ?? 0;
		const start = Math.min(
			Math.max(0, time - span / 3),
			Math.max(0, duration - span),
		);
		return [start, start + span];
	}

	private timeAt(
		which: 'overview' | 'detail',
		canvas: HTMLCanvasElement,
		offsetX: number,
	): number | null {
		const duration = this.duration();
		const width = canvas.clientWidth;
		if (duration <= 0 || width <= 0) return null;
		const [from, to] = which === 'overview' ? [0, duration] : this.detailRange();
		const x = Math.min(Math.max(0, offsetX), width);
		return from + (x / width) * (to - from);
	}

	private draw(): void {
		const file = this.file;
		const analysis = file ? this.plugin.sound.get(file) : null;
		const lanes = this.lanes;
		if (!analysis || !lanes) return;
		// Sized here rather than in a pass of its own, the way the strip does
		// it. A canvas whose width is still 0 — the timeline shown this very
		// tick, the leaf laid out a frame later, the tab opened in the
		// background — used to leave both canvases and the readout blank with
		// nothing left to drive a second attempt.
		this.sizeCanvases();
		if (this.overviewCanvas.width <= 1 || this.detailCanvas.width <= 1) {
			this.retryDraw();
			return;
		}
		this.drawRetries = 0;
		const duration = analysis.duration;
		const time = this.video?.currentTime ?? 0;
		const ratio = window.devicePixelRatio || 1;

		// Overview: the lanes are drawn once, then the window and playhead.
		const overview = this.overviewCanvas.getContext('2d');
		if (overview && this.overviewCanvas.width > 1) {
			const w = this.overviewCanvas.width;
			const h = this.overviewCanvas.height;
			const key = `${this.lanesKey}|${w}|${h}`;
			if (key !== this.overviewKey || !this.overviewBitmap) {
				// `createEl` appends to whatever it is called on, and a document
				// may hold only one element — asking the *document* for this
				// canvas is what threw, and killed every draw. The timeline
				// makes it instead and it is taken straight back out: a
				// detached canvas is still a valid `drawImage` source, and
				// never reaches the layout.
				const bitmap =
					this.overviewBitmap ?? this.timelineEl.createEl('canvas');
				bitmap.remove();
				bitmap.width = w;
				bitmap.height = h;
				const ctx = bitmap.getContext('2d');
				if (ctx)
					drawLanes({
						ctx,
						w,
						h,
						from: 0,
						to: duration,
						layout: OVERVIEW_ROWS,
						ratio,
						analysis,
						lanes,
						ticks: false,
						color: this.colors.get,
					});
				this.overviewBitmap = bitmap;
				this.overviewKey = key;
			}
			overview.clearRect(0, 0, w, h);
			overview.drawImage(this.overviewBitmap, 0, 0);
			const [from, to] = this.detailRange();
			overview.fillStyle = this.colors.get('--text-normal', '#000');
			overview.globalAlpha = 0.12;
			overview.fillRect((from / duration) * w, 0, Math.max(2, ((to - from) / duration) * w), h);
			overview.globalAlpha = 1;
			drawLine(overview, (time / duration) * w, h, ratio, this.colors.get('--text-normal', '#000'));
			if (this.hover?.canvas === 'overview')
				drawLine(overview, (this.hover.time / duration) * w, h, ratio, this.colors.get('--text-muted', '#888'));
		}

		// Detail: few enough bins to redraw every frame.
		const detail = this.detailCanvas.getContext('2d');
		if (detail && this.detailCanvas.width > 1) {
			const w = this.detailCanvas.width;
			const h = this.detailCanvas.height;
			const [from, to] = this.detailRange();
			detail.clearRect(0, 0, w, h);
			drawLanes({
				ctx: detail,
				w,
				h,
				from,
				to,
				layout: DETAIL_ROWS,
				ratio,
				analysis,
				lanes,
				ticks: true,
				color: this.colors.get,
			});
			const span = Math.max(to - from, 1e-6);
			drawLine(detail, ((time - from) / span) * w, h, ratio, this.colors.get('--text-normal', '#000'));
			if (this.hover?.canvas === 'detail')
				drawLine(detail, ((this.hover.time - from) / span) * w, h, ratio, this.colors.get('--text-muted', '#888'));
		}

		this.renderReadout(analysis, lanes, this.hover?.time ?? time);
	}

	/** `1:02:05.4 · dialogue · music — Speech 71 · Music 65 · Piano 30 · -23 dB` */
	private renderReadout(
		analysis: SoundAnalysis,
		lanes: SoundLanes,
		time: number,
	): void {
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
		this.readoutEl.setText(
			[
				`${formatTimecode(time)}  ·  ${on.length > 0 ? on.join(' · ') : 'nothing'}`,
				tags.length > 0 ? tags.join(' · ') : '',
				`${level <= -100 ? '−∞' : level} dB`,
			]
				.filter((part) => part.length > 0)
				.join('  —  '),
		);
	}

	// --- input ----------------------------------------------------------------

	private onWheel(e: WheelEvent): void {
		if (this.duration() <= 0) return;
		e.preventDefault();
		const factor = e.deltaY > 0 ? 1.25 : 0.8;
		this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
		this.draw();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.target instanceof HTMLVideoElement) return;
		if (e.target instanceof HTMLInputElement) return;
		const video = this.video;
		if (!video) return;
		switch (e.key) {
			case ' ':
				if (video.paused) void video.play().catch(() => undefined);
				else video.pause();
				e.preventDefault();
				break;
			case 'ArrowRight':
			case 'ArrowLeft': {
				const step = (e.shiftKey ? 30 : 5) * (e.key === 'ArrowRight' ? 1 : -1);
				video.currentTime = Math.max(0, video.currentTime + step);
				e.preventDefault();
				break;
			}
			case '=':
			case '+':
				this.zoom = Math.max(ZOOM_MIN, this.zoom * 0.8);
				this.draw();
				break;
			case '-':
				this.zoom = Math.min(ZOOM_MAX, this.zoom * 1.25);
				this.draw();
				break;
			case 'f':
				void this.toggleFullscreen();
				break;
			default:
				break;
		}
	}

	// --- actions ------------------------------------------------------------

	private checkModels(): void {
		if (this.checkingModels) return;
		this.checkingModels = true;
		void this.plugin.sound.hasModels().then((ready) => {
			this.checkingModels = false;
			this.modelsReady = ready;
			this.scheduleRender();
		});
	}

	private async download(): Promise<void> {
		try {
			await this.plugin.sound.downloadModels();
			new Notice('Cinema canvas: sound models downloaded.');
		} catch (err) {
			new Notice(
				`Cinema canvas: downloading the sound models failed. ${err instanceof Error ? err.message : String(err)}`,
				12000,
			);
		}
		this.modelsReady = null;
		this.panel = null;
		this.scheduleRender();
	}

	private async analyse(file: TFile, force: boolean): Promise<void> {
		if (!(await this.plugin.sound.hasModels())) {
			this.modelsReady = false;
			this.scheduleRender();
			return;
		}
		const result = await this.plugin.sound.analyse(file, force);
		if (!result) {
			const reason = this.plugin.sound.errorFor(file);
			if (reason)
				new Notice(
					`Cinema canvas: sound analysis failed on ${file.name}. ${reason}`,
					12000,
				);
		}
	}

	private cacheId(file: TFile): string {
		return `${file.path}|${file.stat.size}|${file.stat.mtime}`;
	}
}

