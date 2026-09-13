import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { get as httpsGet } from 'https';
import {
	App,
	Component,
	FileSystemAdapter,
	TFile,
	normalizePath,
} from 'obsidian';
import { cyrb53 } from '../utils/hash';
import { messageOf, releaseModels } from './onnx';
import {
	ANALYSIS_FORMAT,
	AnalysisCancelled,
	SoundAnalysis,
	analyseSound,
} from './sound-analysis';

/**
 * A model file the sound analysis needs, pinned to one exact build.
 *
 * Both URLs name a fixed revision rather than a branch, and the bytes are
 * checked against the SHA-256 of the files the analysis was verified with, so
 * an upstream change can never swap in a different network unnoticed.
 */
interface ModelFile {
	name: string;
	url: string;
	bytes: number;
	sha256: string;
}

/**
 * Silero VAD v6.2.1, MIT licence, from the authors' own repository; PANNs
 * CNN14 at 16 kHz (Kong et al., 2020, MIT licence), exported to ONNX and
 * published on Hugging Face as a graph plus its external weights.
 */
export const SOUND_MODELS: readonly ModelFile[] = [
	{
		name: 'silero_vad.onnx',
		url: 'https://github.com/snakers4/silero-vad/raw/v6.2.1/src/silero_vad/data/silero_vad.onnx',
		bytes: 2327524,
		sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
	},
	{
		name: 'Cnn14_16k.onnx',
		url: 'https://huggingface.co/pranjal-pravesh/PANNs_CNN14_ONNX/resolve/bafe3efef3ea1ea7577ee915ac1407029eef339b/Cnn14_16k.onnx',
		bytes: 86649,
		sha256: 'ad56b79861aaecc29a27e3e47923954de81418a181135f4d94de8d1a15e0fa9c',
	},
	{
		// Must sit beside Cnn14_16k.onnx under exactly this name: the graph
		// refers to it, and onnxruntime resolves it from the graph's folder.
		name: 'Cnn14_16k.onnx.data',
		url: 'https://huggingface.co/pranjal-pravesh/PANNs_CNN14_ONNX/resolve/bafe3efef3ea1ea7577ee915ac1407029eef339b/Cnn14_16k.onnx.data',
		bytes: 327483392,
		sha256: 'd95f724232bb60b78c8e9ef3e031a599e00be33e8347fbbd6472f6e1348e6a8b',
	},
];

export const SOUND_MODEL_BYTES = SOUND_MODELS.reduce((a, m) => a + m.bytes, 0);

/**
 * Measured: 14 s of wall time for 185 s of audio, on the CPU. Used only to say
 * how long a run will take before it starts.
 */
export const ANALYSIS_SECONDS_PER_SECOND = 14 / 185;

export interface SoundOptions {
	ffmpegPath: string;
}

interface Job {
	file: TFile;
	resolve: (analysis: SoundAnalysis | null) => void;
}

/**
 * Sound readings for any audio or video file in the vault, cached beside the
 * shots.
 *
 * Keyed by file rather than by canvas item, because the films this is for are
 * usually not what the canvas is scoped to: a feature is a single file, often
 * in a folder of its own.
 */
export class SoundIndex extends Component {
	private readonly dir: string;
	/** Loaded readings by vault path, with the cache key they were read for. */
	private readonly analyses = new Map<
		string,
		{ key: string; analysis: SoundAnalysis }
	>();
	private readonly onDisk = new Set<string>();
	/** Vault path -> why the last analysis failed. */
	private readonly errors = new Map<string, string>();
	private readonly queue: Job[] = [];
	private readonly listeners = new Set<() => void>();
	private running: { file: TFile; controller: AbortController } | null =
		null;
	private runningProgress = 0;
	private download: { received: number; total: number } | null = null;
	private disposed = false;
	private options: SoundOptions;

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
		options: SoundOptions,
	) {
		super();
		this.dir = normalizePath(`${pluginDir}/sound`);
		this.options = options;
	}

	override onunload(): void {
		this.disposed = true;
		this.queue.length = 0;
		this.running?.controller.abort();
		this.listeners.clear();
		releaseModels();
	}

	setOptions(options: SoundOptions): void {
		this.options = options;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Tells every open sound view to re-label, after a threshold moved. */
	retune(): void {
		this.emit();
	}

	/** Lists the cache once; files are only read when a view asks for one. */
	async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
			const listing = await adapter.list(this.dir);
			for (const path of listing.files)
				if (path.endsWith('.json'))
					this.onDisk.add(path.slice(path.lastIndexOf('/') + 1));
		} catch {
			// No adapter, no cache. Analysis still works, it just never sticks.
		}
	}

	/** Readings already in memory for `file`, or null. */
	get(file: TFile): SoundAnalysis | null {
		const cached = this.analyses.get(file.path);
		// A file rewritten since it was read has a different key, and its old
		// readings describe audio that is gone.
		if (!cached || cached.key !== this.keyFor(file)) return null;
		return cached.analysis;
	}

	/** Readings for `file` from memory or the cache, without analysing. */
	async readCached(file: TFile): Promise<SoundAnalysis | null> {
		const inMemory = this.get(file);
		if (inMemory) return inMemory;
		const key = this.keyFor(file);
		if (!this.onDisk.has(key)) return null;
		try {
			const parsed = JSON.parse(
				await this.app.vault.adapter.read(
					normalizePath(`${this.dir}/${key}`),
				),
			) as SoundAnalysis;
			if (
				parsed.format !== ANALYSIS_FORMAT ||
				!Array.isArray(parsed.loudness) ||
				parsed.loudness.length === 0
			)
				return null;
			this.analyses.set(file.path, { key, analysis: parsed });
			this.emit();
			return parsed;
		} catch {
			// Truncated or hand-edited: analyse again on demand.
			return null;
		}
	}

	isPending(file: TFile): boolean {
		return (
			this.running?.file.path === file.path ||
			this.queue.some((job) => job.file.path === file.path)
		);
	}

	/** True only while `file` is the one being decoded right now. */
	isRunning(file: TFile): boolean {
		return this.running?.file.path === file.path;
	}

	/** 0-1 through the running analysis of `file`. */
	progressFor(file: TFile): number {
		return this.isRunning(file) ? this.runningProgress : 0;
	}

	errorFor(file: TFile): string | null {
		return this.errors.get(file.path) ?? null;
	}

	/** Analyses `file` unless it is cached. Resolves to null on failure or stop. */
	analyse(file: TFile, force = false): Promise<SoundAnalysis | null> {
		if (!force) {
			const cached = this.get(file);
			if (cached) return Promise.resolve(cached);
		}
		if (this.isPending(file)) return Promise.resolve(null);
		this.errors.delete(file.path);
		return new Promise((resolve) => {
			this.queue.push({ file, resolve });
			this.emit();
			void this.pump();
		});
	}

	/** Stops a queued or running analysis of `file`. */
	cancel(file: TFile): void {
		const queued = this.queue.findIndex((job) => job.file.path === file.path);
		if (queued >= 0) {
			const [job] = this.queue.splice(queued, 1);
			job?.resolve(null);
			this.emit();
		}
		if (this.running?.file.path === file.path)
			this.running.controller.abort();
	}

	/** Deletes every cached reading. */
	async clear(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const names = [...this.onDisk];
		this.onDisk.clear();
		this.analyses.clear();
		this.errors.clear();
		for (const name of names) {
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// Already gone, or locked; the in-memory state is authoritative.
			}
		}
		this.emit();
	}

	// --- models -------------------------------------------------------------

	/** Bytes and progress of a download in flight, or null. */
	get downloading(): { received: number; total: number } | null {
		return this.download;
	}

	/** True when every model file is on disk at its expected size. */
	async hasModels(): Promise<boolean> {
		const dir = this.modelDir();
		if (!dir) return false;
		for (const model of SOUND_MODELS) {
			try {
				if ((await stat(`${dir}/${model.name}`)).size !== model.bytes)
					return false;
			} catch {
				return false;
			}
		}
		return true;
	}

	/**
	 * Fetches whichever model files are missing, streaming them to disk.
	 *
	 * Streamed rather than fetched with `requestUrl`, which would hold all
	 * 330 MB in memory at once and could not report progress. Nothing about
	 * the vault leaves the machine: these are plain GETs for public files, and
	 * inference runs locally.
	 */
	async downloadModels(): Promise<void> {
		if (this.download) return;
		const dir = this.modelDir();
		if (!dir)
			throw new Error(
				'The vault is not on a normal file system, so the models have nowhere to go.',
			);
		await mkdir(dir, { recursive: true });

		const missing: ModelFile[] = [];
		for (const model of SOUND_MODELS) {
			try {
				if ((await stat(`${dir}/${model.name}`)).size === model.bytes)
					continue;
			} catch {
				// Not there yet.
			}
			missing.push(model);
		}
		const total = missing.reduce((a, m) => a + m.bytes, 0);
		this.download = { received: 0, total };
		this.emit();
		let lastEmit = 0;
		try {
			for (const model of missing) {
				const before = this.download.received;
				await fetchVerified(model, `${dir}/${model.name}`, (bytes) => {
					if (!this.download) return;
					this.download.received = before + bytes;
					const now = Date.now();
					if (now - lastEmit > 200) {
						lastEmit = now;
						this.emit();
					}
				});
			}
		} finally {
			this.download = null;
			this.emit();
		}
	}

	// --- internals ----------------------------------------------------------

	private modelDir(): string | null {
		const root = this.runtimeDir();
		return root ? `${root.replace(/\\/g, '/')}/models` : null;
	}

	private runtimeDir(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(normalizePath(this.pluginDir));
	}

	private async pump(): Promise<void> {
		if (this.running || this.disposed) return;
		const job = this.queue.shift();
		if (!job) return;
		const controller = new AbortController();
		this.running = { file: job.file, controller };
		this.runningProgress = 0;
		this.emit();

		let analysis: SoundAnalysis | null = null;
		try {
			analysis = await this.run(job.file, controller.signal);
		} catch (err) {
			if (!(err instanceof AnalysisCancelled)) {
				this.errors.set(job.file.path, messageOf(err));
				console.error('Cinema canvas: sound analysis failed', err);
			}
		}

		this.running = null;
		this.runningProgress = 0;
		job.resolve(analysis);
		this.emit();
		if (!this.disposed) void this.pump();
	}

	private async run(
		file: TFile,
		signal: AbortSignal,
	): Promise<SoundAnalysis> {
		const adapter = this.app.vault.adapter;
		const runtimeDir = this.runtimeDir();
		const modelDir = this.modelDir();
		if (!(adapter instanceof FileSystemAdapter) || !runtimeDir || !modelDir)
			throw new Error(
				'The vault is not on a normal file system, so the file cannot be decoded.',
			);
		if (!(await this.hasModels()))
			throw new Error('The sound models are not downloaded yet.');

		let lastEmit = 0;
		const readings = await analyseSound({
			ffmpegPath: this.options.ffmpegPath,
			vadModelPath: `${modelDir}/${SOUND_MODELS[0]?.name ?? ''}`,
			taggerModelPath: `${modelDir}/${SOUND_MODELS[1]?.name ?? ''}`,
			runtimeDir,
			filePath: adapter.getFullPath(file.path),
			signal,
			onProgress: (fraction) => {
				this.runningProgress = fraction;
				const now = Date.now();
				// Once a second of audio is ~13 times a second of wall time;
				// a readout does not need that.
				if (now - lastEmit > 250) {
					lastEmit = now;
					this.emit();
				}
			},
		});
		const analysis: SoundAnalysis = { ...readings, path: file.path };
		this.analyses.set(file.path, { key: this.keyFor(file), analysis });
		await this.save(file, analysis);
		return analysis;
	}

	/** `<path hash>_<size>_<mtime>.json`, so a re-exported file is re-analysed. */
	private keyFor(file: TFile): string {
		return `${this.prefixFor(file)}${file.stat.size.toString(36)}_${file.stat.mtime.toString(36)}.json`;
	}

	private prefixFor(file: TFile): string {
		return `${cyrb53(file.path).toString(36)}_`;
	}

	private async save(file: TFile, analysis: SoundAnalysis): Promise<void> {
		const adapter = this.app.vault.adapter;
		const key = this.keyFor(file);
		try {
			await adapter.write(
				normalizePath(`${this.dir}/${key}`),
				JSON.stringify(analysis),
			);
			this.onDisk.add(key);
		} catch {
			// Read-only plugin folder: the readings still work this session.
			return;
		}
		// Readings of an older version of the same file are dead weight.
		const prefix = this.prefixFor(file);
		for (const name of [...this.onDisk]) {
			if (name === key || !name.startsWith(prefix)) continue;
			this.onDisk.delete(name);
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// Only wasted disk.
			}
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

/**
 * Streams `model.url` to `target`, following redirects, and only moves it into
 * place once its size and SHA-256 match.
 */
function fetchVerified(
	model: ModelFile,
	target: string,
	onBytes: (received: number) => void,
): Promise<void> {
	const part = `${target}.part`;
	return new Promise<void>((resolve, reject) => {
		const request = (url: string, redirects: number): void => {
			httpsGet(
				url,
				{ headers: { 'User-Agent': 'obsidian-cinema-canvas' } },
				(response) => {
					const status = response.statusCode ?? 0;
					const location = response.headers.location;
					if (status >= 300 && status < 400 && location) {
						response.resume();
						if (redirects <= 0) {
							reject(new Error(`Too many redirects fetching ${model.name}.`));
							return;
						}
						request(new URL(location, url).toString(), redirects - 1);
						return;
					}
					if (status !== 200) {
						response.resume();
						reject(new Error(`Fetching ${model.name} failed: HTTP ${status}.`));
						return;
					}
					const hash = createHash('sha256');
					const out = createWriteStream(part);
					let received = 0;
					response.on('data', (chunk: Buffer) => {
						hash.update(chunk);
						received += chunk.length;
						onBytes(received);
					});
					response.on('error', (err) => {
						out.destroy();
						reject(err);
					});
					out.on('error', reject);
					out.on('finish', () => {
						void (async () => {
							const digest = hash.digest('hex');
							if (received !== model.bytes || digest !== model.sha256) {
								await rm(part, { force: true });
								reject(
									new Error(
										`${model.name} did not match the expected file (${received} bytes, sha256 ${digest.slice(0, 12)}…). Nothing was installed.`,
									),
								);
								return;
							}
							await rename(part, target);
							resolve();
						})().catch(reject);
					});
					response.pipe(out);
				},
			).on('error', reject);
		};
		request(model.url, 5);
	});
}
