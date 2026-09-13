import { spawn } from 'child_process';
import {
	App,
	Component,
	FileSystemAdapter,
	normalizePath,
	requestUrl,
} from 'obsidian';
import { MediaItem, Shot } from '../types';
import { cyrb53 } from '../utils/hash';
import { releaseModels } from './onnx';
import { MODEL_BYTES, MODEL_URL, detectWithTransNet } from './transnet';

/**
 * What finds the cuts: TransNetV2, a network trained on labelled cuts.
 *
 * There used to be a choice between this and ffmpeg's scdet filter. scdet is
 * far faster, but it compares neighbouring frames and has no idea what a shot
 * is, so a whip pan or a flash reads as a cut and a dissolve reads as three.
 * The network is better by enough that the choice was not worth the interface
 * it cost, so it is the only detector now.
 */
export const DETECTOR_LABEL = 'TransNetV2';

/** One frame TransNetV2 thought might be a cut, and how strongly. */
export interface Candidate {
	/** Seconds from the start of the file. */
	time: number;
	/** 0-100: the network's cut probability x100. */
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
	/**
	 * What wrote this file.
	 *
	 * Only `'transnet'` is read. Files written by the old ffmpeg detector score
	 * frames on a completely different scale — scdet's 1-20 against a
	 * probability x100 — so reading one at a TransNetV2 threshold would
	 * silently report a feature film as a single take.
	 */
	detector?: string;
	duration: number;
	/** Scores under this were never recorded, so a lower threshold would lie. */
	floor: number;
	candidates: Candidate[];
	/**
	 * `'incoming'`: every time names the first frame of the incoming shot.
	 *
	 * Absent from TransNetV2 files written before 0.8.1, whose times were one
	 * frame early. Those are ignored rather than shifted: the shift is one frame
	 * at the clip's exact frame rate, which the file never recorded.
	 */
	cutAt?: 'incoming';
}

/** Everything known about one clip, before a sensitivity is chosen. */
interface Detection {
	duration: number;
	floor: number;
	candidates: Candidate[];
}

interface Job {
	item: MediaItem;
	resolve: (shots: Shot[] | null) => void;
}

export interface ShotOptions {
	/** Still needed: TransNetV2 reads its frames through an ffmpeg pipe. */
	ffmpegPath: string;
	/** TransNetV2 probability x100 a cut must reach, 5-95. */
	transnetThreshold: number;
	minShotLength: number;
	/** Absolute path to the ONNX model, or '' for the plugin's own copy. */
	modelPath: string;
}

/**
 * The lowest score TransNetV2 is asked to report, and so the lowest confidence
 * the cache can answer for. The network is decisive — on a 370 s clip only 102
 * of 11090 frames scored over 0.1 — so recording everything at or above 1 costs
 * a few kilobytes and makes every confidence above it free to try.
 */
export const SCORE_FLOOR = 1;

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
	/** Vault path -> raw detection, for the current mtime only. */
	private readonly detections = new Map<string, Detection>();
	/** Shots derived at the current confidence; dropped when it changes. */
	private readonly derived = new Map<string, Shot[]>();
	/** Cache file names seen on disk, listed once at startup. */
	private readonly onDisk = new Set<string>();
	/** Clips that could not be read; retried only after a rescan. */
	private readonly failed = new Set<string>();
	/** Vault path -> why the last attempt failed, for the strip to show. */
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

	/** True while `item` is queued for detection or being detected right now. */
	isPending(item: MediaItem): boolean {
		if (this.running?.item.path === item.path) return true;
		return this.queue.some((job) => job.item.path === item.path);
	}

	/** 0-1 through the detection of `item`, or null when it is not measurable. */
	progressFor(item: MediaItem): number | null {
		if (this.running?.item.path !== item.path) return null;
		return this.runningProgress;
	}

	/**
	 * Why the last run on `item` failed, or null.
	 *
	 * A run that finished fine and genuinely found nothing reports no error, so
	 * this separates "this clip is one long take" from "the runtime is not
	 * installed" — which otherwise look identical from the strip.
	 */
	errorFor(item: MediaItem): string | null {
		return this.errors.get(item.path) ?? null;
	}

	/** True when detection ran on `item` and produced nothing usable. */
	hasFailed(item: MediaItem): boolean {
		return this.failed.has(this.keyFor(item));
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
					// Anything the old ffmpeg detector wrote is ignored: its
					// scores are on another scale entirely. Those files are
					// swept up by `prune` and `clear`.
					if (parsed.detector !== 'transnet') continue;
					if (parsed.cutAt !== 'incoming') continue;
					this.detections.set(parsed.path, {
						duration: parsed.duration,
						floor: parsed.floor ?? SCORE_FLOOR,
						candidates: parsed.candidates,
					});
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
	 * Shots for `item` at the current confidence, or null when detection has
	 * never run on it.
	 *
	 * Cutting the candidates is cheap but the strip asks on every render, so
	 * the result is memoised until the confidence changes.
	 */
	get(item: MediaItem): Shot[] | null {
		const cached = this.derived.get(item.path);
		if (cached) return cached;
		const detection = this.detections.get(item.path);
		if (!detection) return null;
		const shots = buildShots(
			detection.candidates,
			detection.duration,
			this.options.transnetThreshold,
			this.options.minShotLength,
		);
		this.derived.set(item.path, shots);
		return shots;
	}

	/** True once detection has run on this clip. */
	has(item: MediaItem): boolean {
		return this.detections.has(item.path);
	}

	/**
	 * Detects `item` unless it is already cached. Resolves to the shot list, or
	 * null when the tool is missing or the file cannot be read.
	 */
	detect(item: MediaItem, force = false): Promise<Shot[] | null> {
		if (item.kind !== 'video') return Promise.resolve(null);
		if (!force) {
			if (this.has(item)) return Promise.resolve(this.get(item));
			if (this.failed.has(this.keyFor(item)))
				return Promise.resolve(null);
		}
		return new Promise<Shot[] | null>((resolve) => {
			this.queue.push({ item, resolve });
			this.progressListener?.(this.pending);
			this.emit();
			void this.pump();
		});
	}

	/** Detects every clip with no cached list yet; resolves to how many worked. */
	async detectAll(items: Iterable<MediaItem>): Promise<number> {
		const wanted: MediaItem[] = [];
		for (const item of items) {
			if (item.kind !== 'video') continue;
			if (this.has(item)) continue;
			if (this.failed.has(this.keyFor(item))) continue;
			wanted.push(item);
		}
		const results = await Promise.all(
			wanted.map((item) => this.detect(item)),
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

	/**
	 * Removes cache files whose source is gone or has been re-exported.
	 *
	 * Files left behind by the old ffmpeg detector are never in `live`, so this
	 * is also what eventually sweeps them off disk.
	 */
	async prune(items: Iterable<MediaItem>): Promise<void> {
		const live = new Set<string>();
		for (const item of items)
			if (item.kind === 'video') live.add(this.keyFor(item));
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

	private async pump(): Promise<void> {
		if (this.running || this.disposed) return;
		const job = this.queue.shift();
		if (!job) return;
		this.running = job;
		this.runningProgress = 0;
		// The strip watches this to swap its buttons for a progress readout.
		this.emit();

		const key = job.item.path;
		let detection: Detection | null = null;
		try {
			detection = await this.runDetection(job.item);
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
			shots = this.get(job.item);
		} else {
			this.failed.add(this.keyFor(job.item));
		}

		this.running = null;
		this.runningProgress = null;
		job.resolve(shots);
		this.emit();
		this.progressListener?.(this.pending);
		if (!this.disposed) void this.pump();
	}

	private async runDetection(item: MediaItem): Promise<Detection | null> {
		const full = this.fullPathOf(item);
		if (!full) return null;
		const detection = await this.runTransNet(item, full);
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
			duration: result.duration,
			floor: SCORE_FLOOR,
			candidates: result.candidates,
		};
	}

	private fullPathOf(item: MediaItem): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(item.file.path);
	}

	private keyFor(item: MediaItem): string {
		const hash = cyrb53(item.path).toString(36);
		const size = item.file.stat.size.toString(36);
		// The `_transnet` suffix is kept even though there is nothing to tell
		// it apart from any more: it is the name every existing cache file
		// already has, and dropping it would both orphan them and collide with
		// the unsuffixed names the old ffmpeg detector wrote.
		return `${hash}${size}_${item.version.toString(36)}_transnet.json`;
	}

	private async save(item: MediaItem, detection: Detection): Promise<void> {
		const key = this.keyFor(item);
		const payload: ShotCacheFile = {
			path: item.path,
			detector: 'transnet',
			duration: detection.duration,
			floor: detection.floor,
			candidates: detection.candidates,
			cutAt: 'incoming',
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
 * Pure, and the only place confidence is applied. `candidates` is every frame
 * the network scored at or above the floor; `threshold` decides which of those
 * are cuts, so raising it re-cuts the clip without touching the file.
 *
 * A cut closer than `minLength` to the previous **kept** one is dropped rather
 * than merged afterwards, because a single dissolve can score across several
 * neighbouring frames and each of those would otherwise become its own shot.
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
