import { Notice, TFile, setTooltip } from 'obsidian';
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
	| 'loading'
	| 'models'
	| 'downloading'
	| 'ready'
	| 'running'
	| 'error'
	| 'none';

/** The one big button this half is offering, if any. */
export interface SoundCta {
	label: string;
	tooltip: string;
	run: () => void;
}

export interface SoundPaneHost {
	plugin: CinemaCanvasPlugin;
	/** The player the whole tab shares, or null before it exists. */
	video: () => HTMLVideoElement | null;
	/** Asks the tab to render again, header and all. */
	refresh: () => void;
}

/**
 * The sound half of a film's tab: lanes, lists, and the run that fills them.
 *
 * The cuts ask where the picture changes; this asks what you are hearing, which
 * is the other half of how a scene is built — where the score comes in, how long
 * a scene goes without a line, where the mix drops out entirely.
 *
 * It is a pane rather than a view of its own because both questions are about
 * the same file at the same moment: one tab, one player, one playhead, and a
 * switch. It owns the timeline and the lists, and nothing above them — the
 * player, the header and the summary belong to the tab.
 */
export class SoundPane {
	private readonly host: SoundPaneHost;
	private readonly plugin: CinemaCanvasPlugin;

	private readonly timelineEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly overviewCanvas: HTMLCanvasElement;
	private readonly detailCanvas: HTMLCanvasElement;
	private readonly readoutEl: HTMLElement;
	private readonly panelEl: HTMLElement;
	private readonly listsEl: HTMLElement;

	private file: TFile | null = null;
	private lanes: SoundLanes | null = null;
	private lanesKey = '';
	private listsKey = '';
	private panel: { kind: PanelKind; update: () => void } | null = null;

	/** Pre-rendered overview lanes; only the playhead is drawn per frame. */
	private overviewBitmap: HTMLCanvasElement | null = null;
	private overviewKey = '';
	private readonly colors: { get: ColorResolver; clear: () => void };
	private zoom = ZOOM_DEFAULT;
	private hover: { canvas: 'overview' | 'detail'; time: number } | null = null;

	/** Null until checked; re-checked whenever a download finishes. */
	private modelsReady: boolean | null = null;
	private checkingModels = false;
	/** Files whose cache has been asked for, and those whose answer is in. */
	private readonly cacheRequested = new Set<string>();
	private readonly cacheChecked = new Set<string>();
	private runStartedAt = 0;

	private resizeObserver: ResizeObserver | null = null;
	/** Its own frame, so a retry never swallows a pending render. */
	private drawFrame: number | null = null;
	private drawRetries = 0;
	private adjusting = false;

	private readonly paramHost: RangeHost<SoundParamKey>;

	/**
	 * @param timelineEl and `bodyEl` are made by the tab, in its own order, and
	 * filled in here. The pane never decides where in the tab it sits.
	 */
	constructor(
		timelineEl: HTMLElement,
		bodyEl: HTMLElement,
		host: SoundPaneHost,
	) {
		this.host = host;
		this.plugin = host.plugin;

		this.timelineEl = timelineEl;
		this.timelineEl.addClass('cine-sound-timeline');
		this.overviewCanvas = this.buildLanes('overview', OVERVIEW_ROWS);
		this.detailCanvas = this.buildLanes('detail', DETAIL_ROWS);
		this.readoutEl = this.timelineEl.createDiv({ cls: 'cine-sound-readout' });

		this.bodyEl = bodyEl;
		this.bodyEl.addClass('cine-clip-body', 'cine-sound-body');
		this.panelEl = this.bodyEl.createDiv({ cls: 'cine-sound-panel' });
		this.listsEl = this.bodyEl.createDiv({ cls: 'cine-sound-lists' });

		this.colors = createColorCache(this.timelineEl);
		this.detailCanvas.addEventListener('wheel', (e) => this.onWheel(e), {
			passive: false,
		});

		this.resizeObserver = new ResizeObserver(() => {
			this.sizeCanvases();
			this.draw();
		});
		this.resizeObserver.observe(this.timelineEl);

		this.paramHost = {
			setParam: (key, value) => this.plugin.setSoundParam(key, value),
			hold: () => {
				this.adjusting = true;
			},
			release: () => {
				if (!this.adjusting) return;
				this.adjusting = false;
				this.host.refresh();
			},
		};
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.drawFrame !== null) window.cancelAnimationFrame(this.drawFrame);
		this.drawFrame = null;
	}

	/** Points the pane at a file, or at nothing. */
	setFile(file: TFile | null): void {
		if (file?.path === this.file?.path) return;
		this.file = file;
		this.lanes = null;
		this.lanesKey = '';
		this.listsKey = '';
		this.overviewKey = '';
		this.panel = null;
		this.hover = null;
		this.runStartedAt = 0;
	}

	/** True once there are lanes to look at. */
	analysed(): boolean {
		return this.file !== null && this.plugin.sound.get(this.file) !== null;
	}

	/** True while the analysis is running or waiting its turn. */
	pending(): boolean {
		return this.file !== null && this.plugin.sound.isPending(this.file);
	}

	/** `Heat.mkv · 1:52:04 · dialogue 34% · music 41% …` */
	summary(): string {
		const file = this.file;
		if (!file) return '';
		const sound = this.plugin.sound;
		if (sound.isRunning(file))
			return `${file.name} — analysing sound… ${Math.round(sound.progressFor(file) * 100)}%`;
		const analysis = sound.get(file);
		const lanes = this.lanes;
		if (!analysis || !lanes) {
			const error = sound.errorFor(file);
			return error ? `${file.name} — ${error}` : file.name;
		}
		const share = (mask: Uint8Array): string =>
			`${Math.round((laneSeconds(mask) / Math.max(analysis.duration, 1e-6)) * 100)}%`;
		return [
			file.name,
			formatTimecode(analysis.duration),
			`dialogue ${share(lanes.dialogue)}`,
			`music ${share(lanes.music)}`,
			`effects ${share(lanes.effects)}`,
			`silence ${share(lanes.silence)}`,
		].join('  ·  ');
	}

	/** The three thresholds, for the tab's header. */
	renderParams(parent: HTMLElement): void {
		if (!this.analysed()) return;
		const group = parent.createDiv({ cls: 'cine-params' });
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

	/**
	 * The one button worth making big: download the models, run the analysis, or
	 * stop the run. Null once there are lanes and nothing is left to press.
	 *
	 * The tab draws it in the header, where it survives full screen — the panel
	 * below carries the same offer, but the panel is the first thing a bigger
	 * player pushes off the screen.
	 */
	cta(): SoundCta | null {
		const file = this.file;
		if (!file) return null;
		const sound = this.plugin.sound;
		if (sound.isPending(file))
			return {
				label: 'Stop',
				tooltip: 'Stop the analysis. Nothing is kept.',
				run: () => sound.cancel(file),
			};
		if (sound.downloading) return null;
		if (this.modelsReady === false)
			return {
				label: `Download models · ${megabytes(SOUND_MODEL_BYTES)}`,
				tooltip: `Silero VAD and PANNs CNN14, downloaded once into the plugin folder, ${megabytes(SOUND_MODEL_BYTES)} in all.`,
				run: () => void this.download(),
			};
		if (this.analysed()) return null;
		if (!this.cacheChecked.has(this.cacheId(file))) return null;
		const failed = sound.errorFor(file);
		return {
			label: failed ? 'Analyse sound again' : 'Analyse sound',
			tooltip: failed
				? `The last run failed. ${failed}`
				: `Read this file three ways — dialogue, music and effects, and loudness — in ${this.estimate()}. The result is cached.`,
			run: () => void this.analyse(failed !== null),
		};
	}

	/** Re-runs a file that already has lanes; the tab's refresh button. */
	again(): void {
		void this.analyse(true);
	}

	// --- rendering --------------------------------------------------------

	render(): void {
		const file = this.file;
		if (!file) {
			this.timelineEl.hide();
			this.listsEl.empty();
			this.listsKey = '';
			return;
		}
		const sound = this.plugin.sound;

		let analysis = sound.get(file);
		const id = this.cacheId(file);
		if (!analysis && !this.cacheRequested.has(id)) {
			this.cacheRequested.add(id);
			void sound.readCached(file).then(() => {
				this.cacheChecked.add(id);
				this.host.refresh();
			});
		}
		if (this.modelsReady === null) this.checkModels();

		const pending = sound.isPending(file);
		if (pending && this.runStartedAt === 0) this.runStartedAt = Date.now();
		if (!pending) this.runStartedAt = 0;

		if (analysis) this.updateLanes(analysis);
		else this.lanes = null;
		analysis = this.lanes ? analysis : null;

		this.timelineEl.toggle(analysis !== null);
		this.renderPanel(file, analysis, pending);
		this.renderLists(analysis);
		if (analysis) this.draw();
	}

	/**
	 * The state panel: everything between "no models" and "here are the lanes".
	 *
	 * It is rebuilt only when its kind changes and otherwise updated in place, so
	 * a progress bar arriving three times a second does not take the Stop button
	 * out from under the pointer.
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
						text: `Sound analysis runs two networks on this machine: Silero VAD finds dialogue, and PANNs CNN14 tells music from effects. They are downloaded once into the plugin folder, ${megabytes(SOUND_MODEL_BYTES)} in all, and checked against the exact files this view was tested with. The button is in the header.`,
					});
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
					el.createDiv({
						cls: 'cine-clip-placeholder',
						text: `This file has not been analysed yet. It is decoded once and read three ways — dialogue, music and effects, and loudness — in ${this.estimate()}. The result is cached, and the thresholds can be changed afterwards without running it again. Press Analyse sound in the header.`,
					});
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

	private estimate(): string {
		const duration = this.host.video()?.duration;
		return duration && Number.isFinite(duration)
			? `about ${formatLength(duration * ANALYSIS_SECONDS_PER_SECOND)}`
			: 'about 5 seconds per minute of audio';
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
	 * how long the longest silence, where the film goes a minute without a word —
	 * so they are also written out, each one a jump to that moment.
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
			chip.createSpan({ cls: `cine-sound-swatch is-${lane.name}` });
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
			runsOf(lanes.silence).filter((r) => r.end - r.start >= LIST_MIN_SILENCE),
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
				.setCssStyles({
					width: `${(length / Math.max(longest, 1e-6)) * 100}%`,
				});
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

	private playFrom(time: number): void {
		const video = this.host.video();
		if (!video) return;
		video.currentTime = time;
		void video.play().catch(() => undefined);
	}

	// --- the lanes ----------------------------------------------------------

	/** A label column and a canvas, for one set of lanes. */
	private buildLanes(
		which: 'overview' | 'detail',
		layout: RowLayout,
	): HTMLCanvasElement {
		const row = this.timelineEl.createDiv({
			cls: `cine-sound-lanes is-${which}`,
		});
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
			if (which === 'detail') setTooltip(label, lane.hint, { placement: 'left' });
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
			const video = this.host.video();
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

	/** The theme changed; every cached colour and the drawn lanes go with it. */
	clearColors(): void {
		this.colors.clear();
		this.overviewBitmap = null;
		this.overviewKey = '';
		this.draw();
	}

	onResize(): void {
		this.drawRetries = 0;
		this.sizeCanvases();
		this.draw();
	}

	/**
	 * The lanes have no width yet; look again next frame, for about a second.
	 *
	 * Bounded because a view genuinely 0 px wide — a collapsed sidebar, a tab
	 * never revealed, the other half of this one — would otherwise hold a frame
	 * request open for as long as it stayed open, and `onResize` will call again
	 * the moment it is not.
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
		const time = this.host.video()?.currentTime ?? 0;
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

	draw(): void {
		const file = this.file;
		const analysis = file ? this.plugin.sound.get(file) : null;
		const lanes = this.lanes;
		if (!analysis || !lanes) return;
		// Sized here rather than in a pass of its own. A canvas whose width is
		// still 0 — the half switched to this very tick, the leaf laid out a
		// frame later, the tab opened in the background — used to leave both
		// canvases and the readout blank with nothing left to drive a second
		// attempt.
		this.sizeCanvases();
		if (this.overviewCanvas.width <= 1 || this.detailCanvas.width <= 1) {
			this.retryDraw();
			return;
		}
		this.drawRetries = 0;
		const duration = analysis.duration;
		const time = this.host.video()?.currentTime ?? 0;
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
				// canvas is what threw, and killed every draw. The timeline makes
				// it instead and it is taken straight back out: a detached canvas
				// is still a valid `drawImage` source, and never reaches the
				// layout.
				const bitmap = this.overviewBitmap ?? this.timelineEl.createEl('canvas');
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
			overview.fillRect(
				(from / duration) * w,
				0,
				Math.max(2, ((to - from) / duration) * w),
				h,
			);
			overview.globalAlpha = 1;
			drawLine(
				overview,
				(time / duration) * w,
				h,
				ratio,
				this.colors.get('--text-normal', '#000'),
			);
			if (this.hover?.canvas === 'overview')
				drawLine(
					overview,
					(this.hover.time / duration) * w,
					h,
					ratio,
					this.colors.get('--text-muted', '#888'),
				);
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
			drawLine(
				detail,
				((time - from) / span) * w,
				h,
				ratio,
				this.colors.get('--text-normal', '#000'),
			);
			if (this.hover?.canvas === 'detail')
				drawLine(
					detail,
					((this.hover.time - from) / span) * w,
					h,
					ratio,
					this.colors.get('--text-muted', '#888'),
				);
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

	/** @returns whether the key belonged to this half. */
	onKeyDown(e: KeyboardEvent): boolean {
		switch (e.key) {
			case '=':
			case '+':
				this.zoom = Math.max(ZOOM_MIN, this.zoom * 0.8);
				this.draw();
				return true;
			case '-':
				this.zoom = Math.min(ZOOM_MAX, this.zoom * 1.25);
				this.draw();
				return true;
			default:
				return false;
		}
	}

	// --- the run ---------------------------------------------------------------

	private checkModels(): void {
		if (this.checkingModels) return;
		this.checkingModels = true;
		void this.plugin.sound.hasModels().then((ready) => {
			this.checkingModels = false;
			this.modelsReady = ready;
			this.host.refresh();
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
		this.host.refresh();
	}

	private async analyse(force: boolean): Promise<void> {
		const file = this.file;
		if (!file) return;
		if (!(await this.plugin.sound.hasModels())) {
			this.modelsReady = false;
			this.host.refresh();
			return;
		}
		const result = await this.plugin.sound.analyse(file, force);
		if (result) return;
		const reason = this.plugin.sound.errorFor(file);
		if (reason)
			new Notice(
				`Cinema canvas: sound analysis failed on ${file.name}. ${reason}`,
				12000,
			);
	}

	private cacheId(file: TFile): string {
		return `${file.path}|${file.stat.size}|${file.stat.mtime}`;
	}
}
