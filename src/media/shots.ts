import { spawn } from 'child_process';
import {
	App,
	Component,
	FileSystemAdapter,
	normalizePath,
	requestUrl,
} from 'obsidian';
import { MediaItem, Shot } from '../types';
import {
	MODEL_BYTES,
	MODEL_URL,
	detectWithTransNet,
	lastLines,
	releaseModels,
} from './transnet';

/**
 * Which detector found a cut.
 *
 * `ffmpeg` is the scdet filter: one decode pass, six seconds for six minutes of
 * video, and no idea what a shot is. `transnet` is TransNetV2, a network
 * trained on labelled cuts: fourteen times slower and much harder to fool.
 * Both are cached per clip, so switching between them is instant once each has
 * run once.
 */
export type Detector = 'ffmpeg' | 'transnet';

export const DETECTORS: readonly Detector[] = ['ffmpeg', 'transnet'];

/** Short label for the strip and for notices. */
export const DETECTOR_LABELS: Record<Detector, string> = {
	ffmpeg: 'ffmpeg',
	transnet: 'TransNetV2',
};

/** One frame a detector thought might be a cut, and how strongly. */
export interface Candidate {
	/** Seconds from the start of the file. */
	time: number;
	/** 0-100. scdet's own score for ffmpeg; probability x100 for TransNetV2. */
	score: number;
}

/**
 * Cache payload written per source file, per detector.
 *
 * The *candidates* are cached, not the shots. The detector is asked for
 * everything scoring at or above `floor`, and the sensitivity is applied
 * afterwards in JS — so changing it re-cuts the clip instantly instead of
 * decoding the file again.
 */
interface ShotCacheFile {
	/** Vault path at the time of detection, for tracing a stray cache file. */
	path: string;
	/** Absent in files written before 0.7, which were all ffmpeg. */
	detector?: Detector;
	duration: number;
	/** Scores under this were never recorded, so a lower threshold would lie. */
	floor: number;
	candidates: Candidate[];
}

/** Everything known about one clip, before a sensitivity is chosen. */
interface Detection {
	detector: Detector;
	duration: number;
	floor: number;
	candidates: Candidate[];
}

interface Job {
	item: MediaItem;
	detector: Detector;
	resolve: (shots: Shot[] | null) => void;
}

export interface ShotOptions {
	ffmpegPath: string;
	/** scdet score a cut must reach, 1-20. */
	threshold: number;
	/** TransNetV2 probability x100 a cut must reach, 5-95. */
	transnetThreshold: number;
	minShotLength: number;
	/** Absolute path to the ONNX model, or '' for the plugin's own copy. */
	modelPath: string;
}

/**
 * The lowest score a detector is asked to report, and so the lowest sensitivity
 * the cache can answer for. Measured on a 370 s 720p clip: 7.4% of frames score
 * at or above 1.0 under scdet, which is ~11 KB of cache and no measurable
 * decode cost over a high threshold. Anything below this is noise — the median
 * frame scores 0.07.
 */
export const SCORE_FLOOR = 1;

/**
 * `[scdet @ 0x…] lavfi.scd.score: 19.102, lavfi.scd.time: 2.1021`
 *
 * scdet logs one of these per detected cut at info level, so the whole shot
 * list arrives on stderr and nothing has to be demuxed to a file first.
 */
const SCD_LINE = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g;
const DURATION_LINE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Detection is CPU-bound, so one clip at a time keeps the UI responsive. */
const DETECT_TIMEOUT_MS = 30 * 60 * 1000;

/** Vault-relative, under the plugin folder. Never inside the vault proper. */
const MODEL_FILE = 'models/transnetv2.onnx';

/**
 * Shot boundaries for every indexed clip, cached to disk beside the thumbnails.
 *
 * Nothing is ever cut out of the source. A shot is a `{ start, end }` pair
 * against the original file, so a 40-shot scene costs one file on disk and
 * forty seeks, not forty exports. The shot strip, the thumbnail cache and the
 * lightbox all then treat those pairs as ordinary items.
 */
export class ShotIndex extends Component {
	private readonly dir: string;
	/** `path detector` -> raw detection, for the current mtime only. */
	private readonly detections = new Map<string, Detection>();
	/** Shots derived at the current sensitivity; dropped when it changes. */
	private readonly derived = new Map<string, Shot[]>();
	/** Which detector's cuts the strip shows for a clip that has both. */
	private readonly preferred = new Map<string, Detector>();
	/** Cache file names seen on disk, listed once at startup. */
	private readonly onDisk = new Set<string>();
	/** Keys a detector could not read; retried only after a rescan. */
	private readonly failed = new Set<string>();
	/** `path detector` -> why the last attempt failed, for the strip to show. */
	private readonly errors = new Map<string, string>();
	private readonly queue: Job[] = [];
	private readonly listeners = new Set<() => void>();
	private running: Job | null = null;
	/** 0-1 through the running job, or null when it cannot be measured. */
	private runningProgress: number | null = null;
	private disposed = false;
	private options: ShotOptions;
	private progressListener: ((pending: number) => void) | null = null;

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
		options: ShotOptions,
	) {
		super();
		this.dir = normalizePath(`${pluginDir}/shots`);
		this.options = options;
	}

	override onunload(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.listeners.clear();
		releaseModels();
	}

	setOptions(options: ShotOptions): void {
		const retuned =
			options.threshold !== this.options.threshold ||
			options.transnetThreshold !== this.options.transnetThreshold ||
			options.minShotLength !== this.options.minShotLength;
		this.options = options;
		// The candidates survive a retune — only the shots cut from them are
		// stale — so this is a recompute over a few hundred numbers, not a
		// re-decode of the file.
		if (retuned) this.derived.clear();
		this.emit();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onProgress(listener: (pending: number) => void): void {
		this.progressListener = listener;
	}

	get pending(): number {
		return this.queue.length + (this.running ? 1 : 0);
	}

	/** The detector running or queued for `item`, or null. */
	pendingDetector(item: MediaItem): Detector | null {
		if (this.running?.item.path === item.path) return this.running.detector;
		return (
			this.queue.find((job) => job.item.path === item.path)?.detector ??
			null
		);
	}

	/** True while `item` is queued for detection or being detected right now. */
	isPending(item: MediaItem): boolean {
		return this.pendingDetector(item) !== null;
	}

	/** 0-1 through the detection of `item`, or null when it is not measurable. */
	progressFor(item: MediaItem): number | null {
		if (this.running?.item.path !== item.path) return null;
		return this.runningProgress;
	}

	/**
	 * Why the last run of `detector` on `item` failed, or null.
	 *
	 * A detector that ran fine and genuinely found nothing reports no error, so
	 * this separates "this clip is one long take" from "the runtime is not
	 * installed" — which otherwise look identical from the strip.
	 */
	errorFor(item: MediaItem, detector?: Detector): string | null {
		if (detector)
			return this.errors.get(this.cacheKey(item.path, detector)) ?? null;
		for (const d of DETECTORS) {
			const message = this.errors.get(this.cacheKey(item.path, d));
			if (message) return message;
		}
		return null;
	}

	/** True when `detector` ran on `item` and produced nothing usable. */
	hasFailed(item: MediaItem, detector?: Detector): boolean {
		if (detector) return this.failed.has(this.keyFor(item, detector));
		return DETECTORS.some((d) => this.failed.has(this.keyFor(item, d)));
	}

	/** Loads every cached candidate list into memory. */
	async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
			const listing = await adapter.list(this.dir);
			for (const path of listing.files) {
				if (!path.endsWith('.json')) continue;
				const name = path.slice(path.lastIndexOf('/') + 1);
				this.onDisk.add(name);
				try {
					const parsed = JSON.parse(
						await adapter.read(path),
					) as ShotCacheFile;
					// Pre-0.6 files cached shots rather than candidates and
					// cannot be re-cut, so they are left for the next detection
					// to overwrite.
					if (
						!Array.isArray(parsed.candidates) ||
						parsed.candidates.length === 0
					)
						continue;
					const detector = parsed.detector ?? 'ffmpeg';
					this.detections.set(this.cacheKey(parsed.path, detector), {
						detector,
						duration: parsed.duration,
						floor: parsed.floor ?? SCORE_FLOOR,
						candidates: parsed.candidates,
					});
					// TransNetV2 is the more trustworthy of the two, so when a
					// clip has both it is what the strip opens on.
					if (
						detector === 'transnet' ||
						!this.preferred.has(parsed.path)
					)
						this.preferred.set(parsed.path, detector);
				} catch {
					// Truncated or hand-edited: ignore it and let the clip be
					// detected again on demand.
				}
			}
		} catch {
			// No adapter, no cache. Detection still works, it just never sticks.
		}
	}

	/**
	 * Shots for `item` at the current sensitivity, or null when no detector has
	 * ever run on it.
	 *
	 * Cutting the candidates is cheap but the strip asks on every render, so
	 * the result is memoised until the sensitivity changes.
	 */
	get(item: MediaItem, detector?: Detector): Shot[] | null {
		const which = detector ?? this.detectorFor(item);
		if (!which) return null;
		const key = this.cacheKey(item.path, which);
		const cached = this.derived.get(key);
		if (cached) return cached;
		const detection = this.detections.get(key);
		if (!detection) return null;
		const shots = buildShots(
			detection.candidates,
			detection.duration,
			this.thresholdFor(which),
			this.options.minShotLength,
		);
		this.derived.set(key, shots);
		return shots;
	}

	/** Whose cuts `get` returns for this clip, or null when it has none. */
	detectorFor(item: MediaItem): Detector | null {
		const preferred = this.preferred.get(item.path);
		if (
			preferred &&
			this.detections.has(this.cacheKey(item.path, preferred))
		)
			return preferred;
		return (
			DETECTORS.find((d) =>
				this.detections.has(this.cacheKey(item.path, d)),
			) ?? null
		);
	}

	/** True once `detector` — or any detector — has run on this clip. */
	has(item: MediaItem, detector?: Detector): boolean {
		if (detector)
			return this.detections.has(this.cacheKey(item.path, detector));
		return this.detectorFor(item) !== null;
	}

	/** Switches which cached detector the strip shows, without running one. */
	prefer(item: MediaItem, detector: Detector): boolean {
		if (!this.has(item, detector)) return false;
		this.preferred.set(item.path, detector);
		this.emit();
		return true;
	}

	/**
	 * Detects `item` with `detector` unless it is already cached. Resolves to
	 * the shot list, or null when the tool is missing or the file cannot be
	 * read.
	 */
	detect(
		item: MediaItem,
		detector: Detector = 'ffmpeg',
		force = false,
	): Promise<Shot[] | null> {
		if (item.kind !== 'video') return Promise.resolve(null);
		if (!force) {
			if (this.has(item, detector)) {
				this.preferred.set(item.path, detector);
				this.emit();
				return Promise.resolve(this.get(item, detector));
			}
			if (this.failed.has(this.keyFor(item, detector)))
				return Promise.resolve(null);
		}
		return new Promise<Shot[] | null>((resolve) => {
			this.queue.push({ item, detector, resolve });
			this.progressListener?.(this.pending);
			this.emit();
			void this.pump();
		});
	}

	/** Detects every clip with no cached list yet; resolves to how many worked. */
	async detectAll(
		items: Iterable<MediaItem>,
		detector: Detector = 'ffmpeg',
	): Promise<number> {
		const wanted: MediaItem[] = [];
		for (const item of items) {
			if (item.kind !== 'video') continue;
			if (this.has(item, detector)) continue;
			if (this.failed.has(this.keyFor(item, detector))) continue;
			wanted.push(item);
		}
		const results = await Promise.all(
			wanted.map((item) => this.detect(item, detector)),
		);
		return results.filter((shots) => shots !== null).length;
	}

	/** Drops every cached list and lets detection rebuild on demand. */
	async clear(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const names = [...this.onDisk];
		this.onDisk.clear();
		this.detections.clear();
		this.derived.clear();
		this.preferred.clear();
		this.failed.clear();
		this.errors.clear();
		this.queue.length = 0;
		for (const name of names) {
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// Already gone, or locked; the in-memory map is authoritative.
			}
		}
		this.emit();
	}

	/** Removes cache files whose source is gone or has been re-exported. */
	async prune(items: Iterable<MediaItem>): Promise<void> {
		const live = new Set<string>();
		for (const item of items)
			if (item.kind === 'video')
				for (const detector of DETECTORS)
					live.add(this.keyFor(item, detector));
		const adapter = this.app.vault.adapter;
		for (const name of [...this.onDisk]) {
			if (live.has(name)) continue;
			this.onDisk.delete(name);
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// A file we cannot delete is only wasted disk.
			}
		}
	}

	/** Lets a rescan retry clips that previously failed. */
	resetFailures(): void {
		this.failed.clear();
		this.errors.clear();
	}

	/** Resolves to the ffmpeg banner line, or null when it cannot be run. */
	async probe(): Promise<string | null> {
		try {
			const { stdout, stderr } = await run(
				this.binary,
				['-version'],
				10000,
			);
			const line = (stdout || stderr).split('\n')[0]?.trim() ?? '';
			return line.toLowerCase().includes('ffmpeg') ? line : null;
		} catch {
			return null;
		}
	}

	// --- the TransNetV2 model ---------------------------------------------

	/**
	 * Absolute path of the plugin folder.
	 *
	 * onnxruntime-node has to be required from here by absolute path: the
	 * renderer's `require` resolves from Obsidian's program directory, not
	 * from the plugin.
	 */
	runtimeDir(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(normalizePath(this.pluginDir));
	}

	/** Absolute path of the ONNX file, wherever it is meant to live. */
	modelPath(): string | null {
		const override = this.options.modelPath.trim();
		if (override) return override;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(
			normalizePath(`${this.pluginDir}/${MODEL_FILE}`),
		);
	}

	/** True when the model is on disk and TransNetV2 can be run. */
	async hasModel(): Promise<boolean> {
		if (this.options.modelPath.trim()) {
			// A path outside the vault is not something the vault adapter can
			// answer for, so ask the file system directly.
			try {
				const fs = await import('fs/promises');
				await fs.access(this.options.modelPath.trim());
				return true;
			} catch {
				return false;
			}
		}
		try {
			return await this.app.vault.adapter.exists(
				normalizePath(`${this.pluginDir}/${MODEL_FILE}`),
			);
		} catch {
			return false;
		}
	}

	/**
	 * Fetches the ONNX export into the plugin folder.
	 *
	 * 31 MB, once, from Hugging Face. Nothing about the vault leaves the
	 * machine: this is a plain GET for a file, and inference then runs locally.
	 */
	async downloadModel(): Promise<boolean> {
		if (this.options.modelPath.trim()) return false;
		const target = normalizePath(`${this.pluginDir}/${MODEL_FILE}`);
		const dir = normalizePath(`${this.pluginDir}/models`);
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			const response = await requestUrl({ url: MODEL_URL, method: 'GET' });
			if (response.status !== 200) return false;
			const bytes = response.arrayBuffer;
			// A redirect page or an error body would be orders of magnitude
			// smaller than the weights, and writing it would look like success.
			if (bytes.byteLength < MODEL_BYTES / 2) return false;
			await adapter.writeBinary(target, bytes);
			return true;
		} catch {
			return false;
		}
	}

	// --- internals --------------------------------------------------------

	private get binary(): string {
		return this.options.ffmpegPath.trim() || 'ffmpeg';
	}

	private thresholdFor(detector: Detector): number {
		return detector === 'transnet'
			? this.options.transnetThreshold
			: this.options.threshold;
	}

	private cacheKey(path: string, detector: Detector): string {
		return `${path} ${detector}`;
	}

	private async pump(): Promise<void> {
		if (this.running || this.disposed) return;
		const job = this.queue.shift();
		if (!job) return;
		this.running = job;
		this.runningProgress = job.detector === 'transnet' ? 0 : null;
		// The strip watches this to swap its buttons for a progress readout.
		this.emit();

		const key = this.cacheKey(job.item.path, job.detector);
		let detection: Detection | null = null;
		try {
			detection = await this.runDetection(job.item, job.detector);
			this.errors.delete(key);
		} catch (err) {
			// A missing tool, an unreadable file, or a codec ffmpeg lacks. The
			// message is the only thing that tells those apart, so it is kept
			// and also logged: the console gets the stack, the strip does not.
			this.errors.set(key, messageOf(err));
			console.error('Cinema canvas: shot detection failed', err);
		}
		let shots: Shot[] | null = null;
		if (detection) {
			this.detections.set(key, detection);
			this.derived.delete(key);
			this.preferred.set(job.item.path, job.detector);
			shots = this.get(job.item, job.detector);
		} else {
			this.failed.add(this.keyFor(job.item, job.detector));
		}

		this.running = null;
		this.runningProgress = null;
		job.resolve(shots);
		this.emit();
		this.progressListener?.(this.pending);
		if (!this.disposed) void this.pump();
	}

	private async runDetection(
		item: MediaItem,
		detector: Detector,
	): Promise<Detection | null> {
		const full = this.fullPathOf(item);
		if (!full) return null;
		const detection =
			detector === 'transnet'
				? await this.runTransNet(item, full)
				: await this.runScdet(full);
		if (!detection) return null;
		await this.save(item, detection);
		return detection;
	}

	private async runTransNet(
		item: MediaItem,
		full: string,
	): Promise<Detection | null> {
		const modelPath = this.modelPath();
		if (!modelPath)
			throw new Error(
				'The vault is not on a normal file system, so the model cannot be located.',
			);
		if (!(await this.hasModel()))
			throw new Error(
				`No model at ${modelPath}. Download it in settings, under Shot detection.`,
			);
		const runtimeDir = this.runtimeDir();
		if (!runtimeDir)
			throw new Error(
				'The vault is not on a normal file system, so the ONNX runtime cannot be located.',
			);
		const result = await detectWithTransNet({
			ffmpegPath: this.binary,
			modelPath,
			runtimeDir,
			filePath: full,
			floor: SCORE_FLOOR,
			onProgress: (fraction) => {
				if (this.running?.item.path !== item.path) return;
				this.runningProgress = fraction;
				this.emit();
			},
		});
		if (result.candidates.length === 0) return null;
		return {
			detector: 'transnet',
			duration: result.duration,
			floor: SCORE_FLOOR,
			candidates: result.candidates,
		};
	}

	private async runScdet(full: string): Promise<Detection | null> {
		// scdet is asked for everything above the floor, not above the user's
		// sensitivity: the extra rows are what make retuning free. `-an -sn`
		// skips the audio and subtitle decode, which roughly halves the wall
		// time; `-f null -` means nothing is muxed or written.
		const { stderr } = await run(
			this.binary,
			[
				'-nostdin',
				'-nostats',
				'-i',
				full,
				'-vf',
				`scdet=threshold=${SCORE_FLOOR}`,
				'-an',
				'-sn',
				'-f',
				'null',
				'-',
			],
			DETECT_TIMEOUT_MS,
		);

		const duration = parseDuration(stderr);
		if (!duration)
			throw new Error(
				`ffmpeg reported no duration for this file. ${lastLines(stderr)}`,
			);

		const candidates: Candidate[] = [];
		SCD_LINE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = SCD_LINE.exec(stderr)) !== null) {
			const time = Number(match[2]);
			if (!Number.isFinite(time) || time <= 0 || time >= duration)
				continue;
			// Two decimals is well past what the score is meaningful to, and
			// keeps a feature-length cache in the tens of kilobytes.
			candidates.push({
				time: Math.round(time * 1000) / 1000,
				score: Math.round((Number(match[1]) || 0) * 100) / 100,
			});
		}
		if (candidates.length === 0) return null;

		return {
			detector: 'ffmpeg',
			duration,
			floor: SCORE_FLOOR,
			candidates,
		};
	}

	private fullPathOf(item: MediaItem): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(item.file.path);
	}

	private keyFor(item: MediaItem, detector: Detector): string {
		const hash = cyrb53(item.path).toString(36);
		const size = item.file.stat.size.toString(36);
		// ffmpeg keeps the unsuffixed name it had before there was a choice.
		const suffix = detector === 'ffmpeg' ? '' : `_${detector}`;
		return `${hash}${size}_${item.version.toString(36)}${suffix}.json`;
	}

	private async save(item: MediaItem, detection: Detection): Promise<void> {
		const key = this.keyFor(item, detection.detector);
		const payload: ShotCacheFile = {
			path: item.path,
			detector: detection.detector,
			duration: detection.duration,
			floor: detection.floor,
			candidates: detection.candidates,
		};
		try {
			await this.app.vault.adapter.write(
				normalizePath(`${this.dir}/${key}`),
				JSON.stringify(payload),
			);
			this.onDisk.add(key);
		} catch {
			// Read-only plugin folder: the list still works for this session.
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/**
 * Cuts a clip into contiguous shots covering its whole duration.
 *
 * Pure, and the only place sensitivity is applied. `candidates` is every frame
 * the detector scored at or above the floor; `threshold` decides which of those
 * are cuts, so raising it re-cuts the clip without touching the file.
 *
 * A cut closer than `minLength` to the previous **kept** one is dropped rather
 * than merged afterwards, because scdet fires two or three times across a
 * single dissolve and each of those would otherwise become its own shot.
 */
export function buildShots(
	candidates: Candidate[],
	duration: number,
	threshold: number,
	minLength: number,
): Shot[] {
	const boundaries: number[] = [];
	const keptScores: number[] = [];
	let last = 0;
	for (const candidate of candidates) {
		const { time, score } = candidate;
		if (score < threshold) continue;
		if (!Number.isFinite(time) || time <= 0 || time >= duration) continue;
		if (time - last < minLength) continue;
		boundaries.push(time);
		keptScores.push(score);
		last = time;
	}

	const shots: Shot[] = [];
	let start = 0;
	for (let i = 0; i <= boundaries.length; i++) {
		const end =
			i < boundaries.length ? (boundaries[i] ?? duration) : duration;
		if (end - start <= 0) continue;
		shots.push({
			index: shots.length,
			start,
			end,
			score: i === 0 ? 0 : (keptScores[i - 1] ?? 0),
		});
		start = end;
	}
	return shots;
}

/** `Duration: 00:06:10.04, start: 0.000000, bitrate: 998 kb/s` */
function parseDuration(stderr: string): number {
	const m = DURATION_LINE.exec(stderr);
	if (!m) return 0;
	const hours = Number(m[1]);
	const minutes = Number(m[2]);
	const seconds = Number(m[3]);
	if (![hours, minutes, seconds].every((n) => Number.isFinite(n))) return 0;
	return hours * 3600 + minutes * 60 + seconds;
}

function run(
	bin: string,
	args: string[],
	timeout: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			// `windowsHide` stops a console window flashing up per clip.
			child = spawn(bin, args, { windowsHide: true });
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		const timer = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`${bin} timed out`));
		}, timeout);

		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			fn();
		};

		child.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString();
		});
		child.on('error', (err: Error) => finish(() => reject(err)));
		child.on('close', () => finish(() => resolve({ stdout, stderr })));
	});
}

function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	const text = String(err).trim();
	return text || 'Unknown error.';
}

/** cyrb53 — fast, well-distributed 53-bit string hash. */
function cyrb53(str: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
