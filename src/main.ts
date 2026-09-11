import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { MediaIndex } from './media/media-index';
import { ShotIndex } from './media/shots';
import { ThumbnailStore } from './media/thumbnails';
import {
	CinemaCanvasSettings,
	CinemaCanvasSettingTab,
	DEFAULT_SETTINGS,
} from './settings';
import type { Detector, ShotOptions } from './media/shots';
import { DETECTOR_LABELS } from './media/shots';
import { debounce } from './utils/debounce';
import { CinemaCanvasView, VIEW_TYPE_CINEMA_CANVAS } from './view/canvas-view';
import { CinemaClipView, VIEW_TYPE_CINEMA_CLIP } from './view/clip-view';
import type { ShotParamKey } from './view/shot-controls';
import type { MediaItem } from './types';

export default class CinemaCanvasPlugin extends Plugin {
	settings!: CinemaCanvasSettings;
	index!: MediaIndex;
	thumbnails!: ThumbnailStore;
	shots!: ShotIndex;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.index = new MediaIndex(this.app, this.settings);
		this.addChild(this.index);

		const pluginDir =
			this.manifest.dir ??
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`;

		this.thumbnails = new ThumbnailStore(
			this.app,
			pluginDir,
			this.settings.thumbnailQuality,
			this.settings.useThumbnails,
		);
		this.addChild(this.thumbnails);

		this.shots = new ShotIndex(this.app, pluginDir, this.shotOptions());
		this.addChild(this.shots);

		this.registerView(
			VIEW_TYPE_CINEMA_CANVAS,
			(leaf) => new CinemaCanvasView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_CINEMA_CLIP,
			(leaf) => new CinemaClipView(leaf, this),
		);

		this.addRibbonIcon('clapperboard', 'Open cinema canvas', () => {
			void this.activateView();
		});

		this.addSettingTab(new CinemaCanvasSettingTab(this.app, this));
		this.registerCommands();

		// Orphaned thumbnails are cheap to leave lying around, so sweeping is
		// deferred well past any burst of file changes.
		const prune = debounce(() => {
			void this.thumbnails.prune(this.index.allItems());
		}, 5000);
		this.index.onChange(prune);

		// The vault file list is only complete once the layout is ready, and
		// scanning earlier would miss files or block startup.
		this.app.workspace.onLayoutReady(() => {
			void Promise.all([this.thumbnails.init(), this.shots.init()]).then(
				() => {
					this.index.rebuild();
					if (this.settings.openOnStartup) void this.activateView();
				},
			);
		});
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CINEMA_CANVAS);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_CINEMA_CANVAS,
				active: true,
			});
		}
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Opens one clip in its own tab, with every segment laid out.
	 *
	 * A clip already open is revealed rather than opened twice — the view holds
	 * a playhead and a selected segment, and duplicating a tab would silently
	 * throw those away.
	 */
	async openClip(item: MediaItem): Promise<void> {
		if (item.kind !== 'video') {
			new Notice('Cinema canvas: segments only exist for video.');
			return;
		}
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_CINEMA_CLIP)) {
			// The leaf's view state, not the view: since 1.7 a background leaf
			// holds a deferred placeholder until it is revealed, so asking the
			// view would miss every tab the user has not looked at yet.
			const state = leaf.getViewState().state;
			if (state?.path !== item.path) continue;
			await workspace.revealLeaf(leaf);
			return;
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_CINEMA_CLIP,
			active: true,
			state: { path: item.path },
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Applies one cutting parameter from the shot strip.
	 *
	 * The strip owns these rather than the settings tab, because the clip in
	 * front of you is their readout: `setOptions` drops the derived shots and
	 * the strip redraws from the same cached candidates, with nothing decoded.
	 * Only the write to disk is deferred — a slider fires an event per pixel.
	 */
	setShotParam(key: ShotParamKey, value: number): void {
		if (this.settings[key] === value) return;
		this.settings[key] = value;
		this.shots.setOptions(this.shotOptions());
		this.saveShotParams();
	}

	private readonly saveShotParams = debounce(() => {
		void this.saveData(this.settings);
	}, 500);

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<CinemaCanvasSettings>,
		);
	}

	/**
	 * @param reindex true when a scanning setting changed, which needs a full
	 * rebuild; otherwise the open views just redraw.
	 */
	async saveSettings(reindex = false): Promise<void> {
		await this.saveData(this.settings);
		this.thumbnails.setOptions({
			quality: this.settings.thumbnailQuality,
			enabled: this.settings.useThumbnails,
		});
		this.shots.setOptions(this.shotOptions());
		if (reindex) this.index.applySettings(this.settings);
		else for (const view of this.canvasViews()) view.refreshSettings();
	}

	private shotOptions(): ShotOptions {
		return {
			ffmpegPath: this.settings.ffmpegPath,
			threshold: this.settings.shotThreshold,
			transnetThreshold: this.settings.transnetThreshold,
			minShotLength: this.settings.minShotLength,
			modelPath: this.settings.transnetModelPath,
		};
	}

	private canvasViews(): CinemaCanvasView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_CINEMA_CANVAS)
			.map((leaf) => leaf.view)
			.filter(
				(view): view is CinemaCanvasView =>
					view instanceof CinemaCanvasView,
			);
	}

	private activeCanvasView(): CinemaCanvasView | null {
		const active = this.app.workspace.getActiveViewOfType(CinemaCanvasView);
		return active ?? this.canvasViews()[0] ?? null;
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'open-canvas',
			name: 'Open canvas',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'rescan-vault',
			name: 'Rescan vault for media',
			callback: () => {
				this.thumbnails.resetFailures();
				this.shots.resetFailures();
				this.index.rebuild();
				new Notice(
					`Cinema canvas: ${this.index.size} media files in ${this.index.scopeDescription}`,
				);
			},
		});

		this.addCommand({
			id: 'clear-thumbnail-cache',
			name: 'Clear thumbnail cache',
			callback: () => {
				void this.thumbnails.clear().then(() => {
					for (const view of this.canvasViews()) view.refreshSettings();
					new Notice('Cinema canvas: thumbnail cache cleared');
				});
			},
		});

		this.addCommand({
			id: 'detect-shots',
			name: 'Detect shots in all clips with ffmpeg',
			callback: () => void this.detectShots('ffmpeg'),
		});

		this.addCommand({
			id: 'detect-shots-transnet',
			name: 'Detect shots in all clips with TransNetV2',
			callback: () => void this.detectShots('transnet'),
		});

		this.addCommand({
			id: 'clear-shot-cache',
			name: 'Clear detected shots',
			callback: () => {
				void this.shots.clear().then(() => {
					new Notice('Cinema canvas: detected shots cleared');
				});
			},
		});

		const viewCommand = (
			id: string,
			name: string,
			run: (view: CinemaCanvasView) => void,
		) => {
			this.addCommand({
				id,
				name,
				checkCallback: (checking: boolean) => {
					const view = this.activeCanvasView();
					if (!view) return false;
					if (!checking) run(view);
					return true;
				},
			});
		};

		viewCommand('open-clip', 'Open selected clip in the segment view', (v) => {
			const selected = v.selectedItem();
			if (selected) void this.openClip(selected);
		});

		viewCommand('fit-all', 'Fit all items', (v) => v.fitAll());
		viewCommand('zoom-to-current', 'Zoom to current item', (v) =>
			v.zoomToCurrent(),
		);
		viewCommand('zoom-to-parent', 'Zoom to parent folder', (v) =>
			v.zoomToParent(),
		);
		viewCommand('next-item', 'Next item', (v) => v.step(1));
		viewCommand('previous-item', 'Previous item', (v) => v.step(-1));
		viewCommand('toggle-playback', 'Play or pause selected clip', (v) =>
			v.togglePlayback(),
		);
		viewCommand('toggle-fullscreen', 'Toggle full screen viewer', (v) =>
			v.toggleLightbox(),
		);
		viewCommand(
			'detect-shots-selected',
			'Detect shots in the selected clip with ffmpeg',
			(v) => void this.detectSelectedShots(v, 'ffmpeg'),
		);
		viewCommand(
			'detect-shots-selected-transnet',
			'Detect shots in the selected clip with TransNetV2',
			(v) => void this.detectSelectedShots(v, 'transnet'),
		);
	}

	/**
	 * Re-detects the one clip under the cursor, at the current threshold.
	 *
	 * This is the tuning loop: change the sensitivity, re-run it here, look at
	 * the result. Re-running the whole vault to judge one setting is what makes
	 * that unbearable, so this always forces, even when a list is cached.
	 */
	private async detectSelectedShots(
		view: CinemaCanvasView,
		detector: Detector,
	): Promise<void> {
		const selected = view.selectedItem();
		if (!selected || selected.kind !== 'video') {
			new Notice('Cinema canvas: select a clip first.');
			return;
		}
		if (detector === 'transnet' && !(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: download the TransNetV2 model in settings first.',
				10000,
			);
			return;
		}

		const label = DETECTOR_LABELS[detector];
		new Notice(
			`Cinema canvas: ${label} is finding cuts in ${selected.file.name}…`,
		);
		const shots = await this.shots.detect(selected, detector, true);
		if (!shots) {
			new Notice(
				`Cinema canvas: ${label} found no cuts in ${selected.file.name}. Check the ffmpeg path in settings.`,
				8000,
			);
			return;
		}
		new Notice(
			`Cinema canvas: ${shots.length} shot(s) in ${selected.file.name}.`,
		);
	}

	/**
	 * Detects shots for every clip that has none yet.
	 *
	 * Runs one clip at a time in the background: detection is a full decode,
	 * so anything more would just contend for the same cores the UI needs.
	 */
	private async detectShots(detector: Detector): Promise<void> {
		const version = await this.shots.probe();
		if (!version) {
			new Notice(
				'Cinema canvas: ffmpeg could not be run. Set its path in settings.',
				8000,
			);
			return;
		}
		// Both detectors decode through ffmpeg; only TransNetV2 also needs the
		// network on disk.
		if (detector === 'transnet' && !(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: download the TransNetV2 model in settings first.',
				10000,
			);
			return;
		}

		const clips = [...this.index.allItems()].filter(
			(item) => item.kind === 'video' && !this.shots.has(item, detector),
		);
		if (clips.length === 0) {
			new Notice('Cinema canvas: every clip already has shots.');
			return;
		}

		const label = DETECTOR_LABELS[detector];
		new Notice(
			`Cinema canvas: ${label} is finding cuts in ${clips.length} clip(s)…`,
		);
		const detected = await this.shots.detectAll(clips, detector);
		new Notice(
			`Cinema canvas: detected shots in ${detected} of ${clips.length} clip(s).`,
		);
	}
}
