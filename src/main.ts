import { Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_VIDEO_EXTENSIONS,
	parseExtensionList,
} from './media/extensions';
import { MediaIndex } from './media/media-index';
import { SceneStore } from './media/scene-store';
import { BLOCK_LANGUAGE, tagKey } from './media/scenes';
import { ShotIndex } from './media/shots';
import { SoundIndex } from './media/sound';
import type { SoundParamKey } from './media/sound-analysis';
import { ThumbnailStore } from './media/thumbnails';
import {
	CinemaCanvasSettings,
	CinemaCanvasSettingTab,
	DEFAULT_SETTINGS,
} from './settings';
import type { ShotOptions } from './media/shots';
import { DETECTOR_LABEL } from './media/shots';
import { debounce } from './utils/debounce';
import { CachePickerModal } from './view/cache-picker';
import type { ClearTarget } from './view/cache-picker';
import { CinemaCanvasView, VIEW_TYPE_CINEMA_CANVAS } from './view/canvas-view';
import { CinemaClipView, VIEW_TYPE_CINEMA_CLIP } from './view/clip-view';
import { renderSceneBlock } from './view/scene-block';
import type { ShotParamKey } from './view/shot-controls';
import type { MediaItem } from './types';

/** Audio-only formats the sound half accepts on top of every video format. */
const SOUND_ONLY_EXTENSIONS = [
	'mp3',
	'wav',
	'flac',
	'm4a',
	'aac',
	'ogg',
	'oga',
	'opus',
	'aiff',
	'aif',
];

export default class CinemaCanvasPlugin extends Plugin {
	settings!: CinemaCanvasSettings;
	index!: MediaIndex;
	thumbnails!: ThumbnailStore;
	shots!: ShotIndex;
	sound!: SoundIndex;
	scenes!: SceneStore;

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

		this.sound = new SoundIndex(this.app, pluginDir, {
			ffmpegPath: this.settings.ffmpegPath,
		});
		this.addChild(this.sound);

		this.scenes = new SceneStore(this.app);
		this.addChild(this.scenes);

		this.registerView(
			VIEW_TYPE_CINEMA_CANVAS,
			(leaf) => new CinemaCanvasView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_CINEMA_CLIP,
			(leaf) => new CinemaClipView(leaf, this),
		);

		// A film is usually not on the canvas at all — it is one big file in a
		// folder of its own — so both halves are offered wherever a file is.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (this.isVideoFile(file))
					menu.addItem((entry) =>
						entry
							.setTitle('Open in cut view')
							.setIcon('film')
							.onClick(() => void this.openClip(file)),
					);
				if (!this.isSoundFile(file)) return;
				menu.addItem((entry) =>
					entry
						.setTitle('Open in sound view')
						.setIcon('audio-waveform')
						.onClick(() => void this.openSound(file)),
				);
			}),
		);

		// Shot lists and sound readings are keyed by path. Carrying them across
		// a rename is what keeps moving a film from costing another half hour.
		// Scene notes follow their film on their own; see SceneStore.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (this.isVideoFile(file))
					void this.shots.rename(oldPath, this.itemForFile(file));
				if (this.isSoundFile(file)) void this.sound.rename(file, oldPath);
			}),
		);

		this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) =>
			renderSceneBlock(this, source, el, ctx.sourcePath),
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
			void Promise.all([
				this.thumbnails.init(),
				this.shots.init(),
				this.sound.init(),
			]).then(
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
	 * Opens a film in the cut view, showing one of its scenes if asked.
	 *
	 * Any video in the vault will do, on the canvas or not. One film is one
	 * tab: a film already open is revealed and told which scene to show, rather
	 * than opened again. A second tab would throw away the playhead and the
	 * selection in the first, and a tab per scene would bury the film under its
	 * own parts.
	 *
	 * @param scene the scene's id, from its note.
	 */
	async openClip(file: TFile, scene?: string): Promise<void> {
		if (!this.isVideoFile(file)) {
			new Notice('Cinema canvas: cuts only exist for video.');
			return;
		}
		await this.reveal(
			file,
			scene === undefined ? { half: 'cuts' } : { half: 'cuts', scene },
		);
	}

	/**
	 * Opens the soundtrack of one file: the sound half of the same tab.
	 *
	 * The cuts and the sound are two questions about one file at one moment, so
	 * they share a tab, a player and a playhead, with a switch in the header.
	 * Any audio or video file will do, on the canvas or not — a file with no
	 * picture simply has no cuts half.
	 */
	async openSound(file: TFile): Promise<void> {
		if (!this.isSoundFile(file)) {
			new Notice('Cinema canvas: the sound half needs an audio or video file.');
			return;
		}
		await this.reveal(file, { half: 'sound' });
	}

	/**
	 * One file, one tab. A file already open is revealed and told which half,
	 * and which scene, to show — rather than opened again. A second tab would
	 * throw away the playhead and the selection in the first.
	 */
	private async reveal(
		file: TFile,
		extra: Record<string, unknown>,
	): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_CINEMA_CLIP)) {
			// The leaf's view state, not the view: since 1.7 a background leaf
			// holds a deferred placeholder until it is revealed, so asking the
			// view would miss every tab the user has not looked at yet.
			const state = leaf.getViewState().state;
			if (state?.path !== file.path) continue;
			if (Object.entries(extra).some(([key, value]) => state[key] !== value))
				await leaf.setViewState({
					type: VIEW_TYPE_CINEMA_CLIP,
					active: true,
					state: { ...state, ...extra },
				});
			await workspace.revealLeaf(leaf);
			return;
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_CINEMA_CLIP,
			active: true,
			state: { path: file.path, ...extra },
		});
		await workspace.revealLeaf(leaf);
	}

	/** Anything ffmpeg can pull an audio track out of, as far as the name says. */
	isSoundFile(file: TFile): boolean {
		return (
			SOUND_ONLY_EXTENSIONS.includes(file.extension.toLowerCase()) ||
			this.isVideoFile(file)
		);
	}

	/** Anything the cut view can open, whether or not the canvas indexes it. */
	isVideoFile(file: TFile): boolean {
		const extension = file.extension.toLowerCase();
		return (
			DEFAULT_VIDEO_EXTENSIONS.includes(extension) ||
			parseExtensionList(this.settings.extraVideoExtensions).includes(
				extension,
			)
		);
	}

	/**
	 * The media item for a video: the canvas's own when it is indexed, or one
	 * made on the spot for a film outside the canvas folders.
	 */
	itemForFile(file: TFile): MediaItem {
		const indexed = this.index.getItem(file.path);
		if (indexed) return indexed;
		const parent = file.parent?.path ?? '';
		return {
			key: file.path,
			path: file.path,
			file,
			kind: 'video',
			folder: parent === '/' ? '' : parent,
			version: file.stat.mtime,
		};
	}

	/** Applies one sound threshold from the sound half; see `setShotParam`. */
	setSoundParam(key: SoundParamKey, value: number): void {
		if (this.settings[key] === value) return;
		this.settings[key] = value;
		this.sound.retune();
		this.saveShotParams();
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

	/**
	 * Adds a tag to the list every film's scenes half offers.
	 *
	 * @returns the tag as it is now listed: an existing tag differing only in
	 * case is kept as it was first written.
	 */
	async addSceneTag(tag: string): Promise<string | null> {
		const text = tag.trim();
		if (!text) return null;
		const existing = this.settings.sceneTags.find((t) => tagKey(t) === tagKey(text));
		if (existing) return existing;
		this.settings.sceneTags = [...this.settings.sceneTags, text];
		await this.saveTags();
		return text;
	}

	/**
	 * Takes a tag off the list. Scenes carrying it are the film's business:
	 * the view that asked strips its own film's scenes.
	 */
	async removeSceneTag(tag: string): Promise<void> {
		const key = tagKey(tag);
		const kept = this.settings.sceneTags.filter((t) => tagKey(t) !== key);
		if (kept.length === this.settings.sceneTags.length) return;
		this.settings.sceneTags = kept;
		await this.saveTags();
	}

	/** Moves a tag to `index` in the list. */
	async moveSceneTag(tag: string, index: number): Promise<void> {
		const key = tagKey(tag);
		const from = this.settings.sceneTags.findIndex((t) => tagKey(t) === key);
		if (from < 0) return;
		const tags = [...this.settings.sceneTags];
		const [moved] = tags.splice(from, 1);
		if (moved === undefined) return;
		tags.splice(Math.min(Math.max(index, 0), tags.length), 0, moved);
		this.settings.sceneTags = tags;
		await this.saveTags();
	}

	private async saveTags(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CINEMA_CLIP))
			if (leaf.view instanceof CinemaClipView) leaf.view.render();
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
		// data.json is hand-editable; a tag list that is not one is replaced.
		const tags: unknown = this.settings.sceneTags;
		this.settings.sceneTags = Array.isArray(tags)
			? tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
			: [...DEFAULT_SETTINGS.sceneTags];
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
		this.sound.setOptions({ ffmpegPath: this.settings.ffmpegPath });
		if (reindex) this.index.applySettings(this.settings);
		else for (const view of this.canvasViews()) view.refreshSettings();
	}

	private shotOptions(): ShotOptions {
		return {
			ffmpegPath: this.settings.ffmpegPath,
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
			id: 'clear-caches',
			name: 'Clear cached data',
			callback: () => this.promptClear(),
		});

		this.addCommand({
			id: 'detect-shots',
			name: 'Detect shots in all clips',
			callback: () => void this.detectShots(),
		});

		this.addCommand({
			id: 'open-clip-active-file',
			name: 'Open current file in the cut view',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isVideoFile(file)) return false;
				if (!checking) void this.openClip(file);
				return true;
			},
		});

		this.addCommand({
			id: 'open-sound-active-file',
			name: 'Open current file in the sound view',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isSoundFile(file)) return false;
				if (!checking) void this.openSound(file);
				return true;
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

		viewCommand('open-clip', 'Open selected clip in the cut view', (v) => {
			const selected = v.selectedItem();
			if (selected) void this.openClip(selected.file);
		});

		viewCommand('open-sound', 'Open selected clip in the sound view', (v) => {
			const selected = v.selectedItem();
			if (selected) void this.openSound(selected.file);
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
			'Detect shots in the selected clip',
			(v) => void this.detectSelectedShots(v),
		);
	}

	/**
	 * Asks which cache to clear, and clears it.
	 *
	 * Everything here is derived from files that are still in the vault, so
	 * none of it is lost for good. What differs is the price of making it
	 * again, which is why each choice says what that price is, and why
	 * clearing all three has to be chosen rather than assumed.
	 */
	private promptClear(): void {
		const targets: ClearTarget[] = [
			{
				label: 'Thumbnails',
				hint: 'stills for the canvas and the cut cards; made again as you look at them',
				run: async () => {
					await this.thumbnails.clear();
					for (const view of this.canvasViews()) view.refreshSettings();
				},
			},
			{
				label: 'Detected shots',
				hint: `cut lists from ${DETECTOR_LABEL}; about 27 minutes again per two-hour film`,
				run: () => this.shots.clear(),
			},
			{
				label: 'Sound analysis',
				hint: 'dialogue, music, effects and loudness; about 5 seconds again per minute of audio',
				run: () => this.sound.clear(),
			},
		];
		const everything: ClearTarget = {
			label: 'Everything',
			hint: 'all three of the below',
			// In order, not at once: three cache folders being rewritten in
			// parallel is the one way to make this slower than it has to be.
			run: async () => {
				for (const target of targets) await target.run();
			},
		};

		new CachePickerModal(this.app, [everything, ...targets], (picked) => {
			void picked
				.run()
				.then(() =>
					new Notice(
						`Cinema canvas: cleared ${picked.label.toLowerCase()}.`,
					),
				)
				.catch((err: unknown) =>
					new Notice(
						`Cinema canvas: ${picked.label.toLowerCase()} could not be cleared. ${err instanceof Error ? err.message : String(err)}`,
						12000,
					),
				);
		}).open();
	}

	/**
	 * Re-detects the one clip under the cursor, at the current threshold.
	 *
	 * This is the tuning loop: change the sensitivity, re-run it here, look at
	 * the result. Re-running the whole vault to judge one setting is what makes
	 * that unbearable, so this always forces, even when a list is cached.
	 */
	private async detectSelectedShots(view: CinemaCanvasView): Promise<void> {
		const selected = view.selectedItem();
		if (!selected || selected.kind !== 'video') {
			new Notice('Cinema canvas: select a clip first.');
			return;
		}
		if (!(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: download the TransNetV2 model in settings first.',
				10000,
			);
			return;
		}

		new Notice(
			`Cinema canvas: ${DETECTOR_LABEL} is finding cuts in ${selected.file.name}…`,
		);
		const shots = await this.shots.detect(selected, true);
		if (!shots) {
			if (this.shots.wasCancelled(selected)) return;
			const reason = this.shots.errorFor(selected);
			new Notice(
				reason
					? `Cinema canvas: ${DETECTOR_LABEL} failed on ${selected.file.name}. ${reason}`
					: `Cinema canvas: ${DETECTOR_LABEL} found no cuts in ${selected.file.name} — it may be a single take.`,
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
	private async detectShots(): Promise<void> {
		const version = await this.shots.probe();
		if (!version) {
			new Notice(
				'Cinema canvas: ffmpeg could not be run. Set its path in settings.',
				8000,
			);
			return;
		}
		// TransNetV2 reads its frames through ffmpeg, and also needs the
		// network itself on disk.
		if (!(await this.shots.hasModel())) {
			new Notice(
				'Cinema canvas: download the TransNetV2 model in settings first.',
				10000,
			);
			return;
		}

		const clips = [...this.index.allItems()].filter(
			(item) => item.kind === 'video' && !this.shots.has(item),
		);
		if (clips.length === 0) {
			new Notice('Cinema canvas: every clip already has shots.');
			return;
		}

		new Notice(
			`Cinema canvas: ${DETECTOR_LABEL} is finding cuts in ${clips.length} clip(s)…`,
		);
		const detected = await this.shots.detectAll(clips);
		new Notice(
			`Cinema canvas: detected shots in ${detected} of ${clips.length} clip(s).`,
		);
	}
}
