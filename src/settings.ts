import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type CinemaCanvasPlugin from './main';

export type SortField = 'name' | 'modified' | 'created' | 'path';

export interface CinemaCanvasSettings {
	/** Comma-separated folders, recursive. Empty = whole vault. */
	folders: string;
	includeImages: boolean;
	includeVideos: boolean;
	extraImageExtensions: string;
	extraVideoExtensions: string;

	/** Cell height in world px at zoom 1. 720 = "720p". */
	itemHeight: number;
	/** Cell aspect ratio, width / height. */
	aspectRatio: number;
	gap: number;
	maxColumnsPerGroup: number;
	showFileNames: boolean;

	sortField: SortField;
	sortDescending: boolean;

	hoverPlayVideos: boolean;
	loopLightboxVideos: boolean;
	openOnStartup: boolean;

	/** Draw cached proxies in the grid instead of the original files. */
	useThumbnails: boolean;
	/** WebP quality for generated thumbnails, 0-1. */
	thumbnailQuality: number;

	/** ffmpeg binary; empty means whatever is on PATH. */
	ffmpegPath: string;
	/**
	 * TransNetV2 probability x100 a frame must reach to count as a cut, 5-95.
	 *
	 * Default 50, which is the threshold the model's authors use. The network
	 * is decisive — on a 370 s clip only 65 of 11090 frames scored over 0.5 and
	 * only 102 scored over 0.1 — so this slider moves the shot count much less
	 * than its range suggests.
	 */
	transnetThreshold: number;
	/** Absolute path to a TransNetV2 ONNX file; empty means the plugin's own. */
	transnetModelPath: string;
	/** Cuts closer together than this many seconds are ignored. */
	minShotLength: number;

	/**
	 * RMS level under which the sound view calls a moment silent, dBFS.
	 *
	 * Default -50. A film is almost never digitally silent — its quiet is room
	 * tone — so 0-referenced "silence" would find none at all.
	 */
	soundSilenceDb: number;
	/** Speech probability x100 for the dialogue lane; 50 is Silero's own. */
	soundDialogue: number;
	/**
	 * Music score x100 for the music lane. Default 30: on the test track, solo
	 * piano scored 78-86 and speech alone at most 5.
	 */
	soundMusic: number;
}

export const DEFAULT_SETTINGS: CinemaCanvasSettings = {
	folders: '',
	includeImages: true,
	includeVideos: true,
	extraImageExtensions: '',
	extraVideoExtensions: '',

	itemHeight: 720,
	aspectRatio: 16 / 9,
	gap: 48,
	maxColumnsPerGroup: 8,
	showFileNames: true,

	sortField: 'name',
	sortDescending: false,

	hoverPlayVideos: true,
	loopLightboxVideos: true,
	openOnStartup: false,

	useThumbnails: true,
	thumbnailQuality: 0.8,

	ffmpegPath: '',
	transnetThreshold: 50,
	transnetModelPath: '',
	minShotLength: 0.4,

	soundSilenceDb: -50,
	soundDialogue: 50,
	soundMusic: 30,
};

const HEIGHT_PRESETS: Record<string, string> = {
	'360': '360p',
	'480': '480p',
	'720': '720p (default)',
	'1080': '1080p',
	'1440': '1440p',
	'2160': '2160p',
};

const ASPECT_PRESETS: Record<string, string> = {
	'1.7777777777777777': '16:9',
	'2.39': '2.39:1 (anamorphic)',
	'1.85': '1.85:1',
	'1.5': '3:2',
	'1.3333333333333333': '4:3',
	'1': '1:1',
	'0.5625': '9:16 (vertical)',
};

/** Settings that change *what* is indexed, as opposed to how it is drawn. */
export const INDEX_KEYS: readonly (keyof CinemaCanvasSettings)[] = [
	'folders',
	'includeImages',
	'includeVideos',
	'extraImageExtensions',
	'extraVideoExtensions',
	'sortField',
	'sortDescending',
];

export class CinemaCanvasSettingTab extends PluginSettingTab {
	plugin: CinemaCanvasPlugin;

	constructor(app: App, plugin: CinemaCanvasPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Scanning').setHeading();

		new Setting(containerEl)
			.setName('Folders')
			.setDesc(
				'Comma-separated folders to scan, searched recursively (for example: src/, archive/2024). Leave empty to scan the whole vault.',
			)
			.addTextArea((text) => {
				text.setPlaceholder('src/, archive/')
					.setValue(this.plugin.settings.folders)
					.onChange((value) => this.update('folders', value));
				text.inputEl.rows = 3;
				text.inputEl.addClass('cine-settings-textarea');
			});

		new Setting(containerEl)
			.setName('Include images')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.includeImages)
					.onChange((v) => this.update('includeImages', v)),
			);

		new Setting(containerEl)
			.setName('Include videos')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.includeVideos)
					.onChange((v) => this.update('includeVideos', v)),
			);

		new Setting(containerEl)
			.setName('Extra image extensions')
			.setDesc('Comma-separated, added to the built-in image formats.')
			.addText((t) =>
				t
					.setPlaceholder('dng, cr2')
					.setValue(this.plugin.settings.extraImageExtensions)
					.onChange((v) => this.update('extraImageExtensions', v)),
			);

		new Setting(containerEl)
			.setName('Extra video extensions')
			.setDesc('Comma-separated, added to the built-in video formats.')
			.addText((t) =>
				t
					.setPlaceholder('mts, mxf')
					.setValue(this.plugin.settings.extraVideoExtensions)
					.onChange((v) => this.update('extraVideoExtensions', v)),
			);

		new Setting(containerEl).setName('Grid').setHeading();

		new Setting(containerEl)
			.setName('Item size')
			.setDesc('Height of each cell on the canvas, in pixels.')
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(HEIGHT_PRESETS))
					d.addOption(value, label);
				const current = String(this.plugin.settings.itemHeight);
				if (!(current in HEIGHT_PRESETS))
					d.addOption(current, `${current}px (custom)`);
				d.setValue(current).onChange((v) =>
					this.update('itemHeight', Number(v)),
				);
			})
			.addText((t) => {
				t.setPlaceholder('custom px')
					.setValue(String(this.plugin.settings.itemHeight))
					.onChange((v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n >= 32 && n <= 8192)
							this.update('itemHeight', Math.round(n));
					});
				t.inputEl.type = 'number';
				t.inputEl.addClass('cine-settings-number');
			});

		new Setting(containerEl)
			.setName('Aspect ratio')
			.setDesc(
				'Shape of each cell. Media is fitted inside without cropping.',
			)
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(ASPECT_PRESETS))
					d.addOption(value, label);
				const current = String(this.plugin.settings.aspectRatio);
				if (!(current in ASPECT_PRESETS))
					d.addOption(current, `${current} (custom)`);
				d.setValue(current).onChange((v) =>
					this.update('aspectRatio', Number(v)),
				);
			});

		new Setting(containerEl)
			.setName('Max columns per group')
			.setDesc('A folder wraps to a new row after this many items.')
			.addSlider((s) =>
				s
					.setLimits(1, 24, 1)
					.setValue(this.plugin.settings.maxColumnsPerGroup)
					.setDynamicTooltip()
					.onChange((v) => this.update('maxColumnsPerGroup', v)),
			);

		new Setting(containerEl)
			.setName('Gap')
			.setDesc('Space between cells, in pixels.')
			.addSlider((s) =>
				s
					.setLimits(0, 200, 4)
					.setValue(this.plugin.settings.gap)
					.setDynamicTooltip()
					.onChange((v) => this.update('gap', v)),
			);

		new Setting(containerEl).setName('Show file names').addToggle((t) =>
			t
				.setValue(this.plugin.settings.showFileNames)
				.onChange((v) => this.update('showFileNames', v)),
		);

		new Setting(containerEl).setName('Sorting').setHeading();

		new Setting(containerEl).setName('Sort items by').addDropdown((d) =>
			d
				.addOption('name', 'File name')
				.addOption('path', 'Full path')
				.addOption('modified', 'Date modified')
				.addOption('created', 'Date created')
				.setValue(this.plugin.settings.sortField)
				.onChange((v) => this.update('sortField', v as SortField)),
		);

		new Setting(containerEl).setName('Descending').addToggle((t) =>
			t
				.setValue(this.plugin.settings.sortDescending)
				.onChange((v) => this.update('sortDescending', v)),
		);

		new Setting(containerEl).setName('Performance').setHeading();

		new Setting(containerEl)
			.setName('Use thumbnails')
			.setDesc(
				'Render cached low-resolution proxies in the grid instead of the original files, and show clips as one extracted frame. Turning this off draws full-size images directly, which is very slow for large folders, and leaves clips as an icon until you hover them.',
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.useThumbnails)
					.onChange((v) => this.update('useThumbnails', v)),
			);

		new Setting(containerEl)
			.setName('Thumbnail quality')
			.setDesc(
				'Higher looks better and takes more disk. Clear the cache after changing this.',
			)
			.addSlider((s) =>
				s
					.setLimits(0.4, 1, 0.05)
					.setValue(this.plugin.settings.thumbnailQuality)
					.setDynamicTooltip()
					.onChange((v) => this.update('thumbnailQuality', v)),
			);

		new Setting(containerEl)
			.setName('Shot detection')
			.setDesc(
				'Select a clip on the canvas and press Find cuts in the strip along the bottom. The sliders that shape the cutting live in that strip too, next to the shots they change. Nothing is written to the vault and the clip is never split on disk — a shot is only a start and end time against the original file.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('ffmpeg path')
			.setDesc(
				'Used to decode frames for shot detection and audio for the sound view. Leave empty to use whatever is on PATH. Use the check button to confirm it runs.',
			)
			.addText((t) =>
				t
					.setPlaceholder('ffmpeg')
					.setValue(this.plugin.settings.ffmpegPath)
					.onChange((v) => this.update('ffmpegPath', v)),
			)
			.addButton((b) =>
				b.setButtonText('Check').onClick(async () => {
					b.setDisabled(true);
					const version = await this.plugin.shots.probe();
					b.setDisabled(false);
					new Notice(
						version
							? `Found ${version}`
							: 'ffmpeg could not be run. Check the path.',
						version ? 5000 : 8000,
					);
				}),
			);

		new Setting(containerEl)
			.setName('TransNetV2 model')
			.setDesc(
				'Cuts are found by a trained network, which needs a 31 MB model file downloaded once into the plugin folder. Leave the path empty to use that copy.',
			)
			.addText((t) =>
				t
					.setPlaceholder('(plugin folder)')
					.setValue(this.plugin.settings.transnetModelPath)
					.onChange((v) => this.update('transnetModelPath', v)),
			)
			.addButton((b) =>
				b.setButtonText('Download').onClick(async () => {
					if (await this.plugin.shots.hasModel()) {
						new Notice('The model is already downloaded.');
						return;
					}
					b.setButtonText('Downloading…').setDisabled(true);
					const ok = await this.plugin.shots.downloadModel();
					b.setButtonText('Download').setDisabled(false);
					new Notice(
						ok
							? 'TransNetV2 model downloaded. Find cuts works now.'
							: 'The model could not be downloaded. Check the connection, or fetch it by hand and point the path at it.',
						ok ? 5000 : 10000,
					);
				}),
			);

		new Setting(containerEl).setName('Playback').setHeading();

		new Setting(containerEl)
			.setName('Play clips on hover')
			.setDesc(
				'Preview videos in the grid while the pointer is over them.',
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.hoverPlayVideos)
					.onChange((v) => this.update('hoverPlayVideos', v)),
			);

		new Setting(containerEl)
			.setName('Loop clips in full screen')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.loopLightboxVideos)
					.onChange((v) => this.update('loopLightboxVideos', v)),
			);

		new Setting(containerEl)
			.setName('Open canvas on startup')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.openOnStartup)
					.onChange((v) => this.update('openOnStartup', v)),
			);
	}

	private update<K extends keyof CinemaCanvasSettings>(
		key: K,
		value: CinemaCanvasSettings[K],
	): void {
		if (this.plugin.settings[key] === value) return;
		this.plugin.settings[key] = value;
		void this.plugin.saveSettings(INDEX_KEYS.includes(key));
	}
}
