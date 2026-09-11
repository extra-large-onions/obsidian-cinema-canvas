import { App, Component, normalizePath } from 'obsidian';
import { MediaItem } from '../types';

/** Thumbnail widths, smallest first. Above the last one we use the original. */
export const THUMB_TIERS = [256, 640, 1440] as const;

/** Largest tier; above this the original file is used instead. */
export const TOP_TIER: number = THUMB_TIERS[THUMB_TIERS.length - 1] ?? 1440;

const CONCURRENCY = 2;
/** Extensions that are cheap to draw as-is and gain nothing from a raster cache. */
const BYPASS_EXTENSIONS = new Set(['svg']);

interface Job {
	key: string;
	item: MediaItem;
	tier: number;
	priority: number;
	listeners: Set<(url: string | null) => void>;
}

/**
 * Disk-backed, tiered thumbnail cache.
 *
 * The grid never points at an original file unless the viewer is zoomed past
 * the largest tier. That is the whole performance story: a 6000x4000 still
 * decodes to ~96 MB of bitmap, so a few hundred of them cannot be on screen at
 * once, while their 640px WebP proxies are ~1 MB total. Clips get a single
 * extracted frame, which also means the canvas holds no video decoders.
 */
export class ThumbnailStore extends Component {
	private readonly dir: string;
	/** File names present on disk, listed once at startup. */
	private readonly onDisk = new Set<string>();
	/** Keys that failed to render; retried only after a rescan. */
	private readonly failed = new Set<string>();
	private readonly queue = new Map<string, Job>();
	private running = 0;
	private ready = false;
	private disposed = false;
	private progressListener: ((pending: number) => void) | null = null;

	constructor(
		private readonly app: App,
		pluginDir: string,
		private quality: number,
		private enabled: boolean,
	) {
		super();
		this.dir = normalizePath(`${pluginDir}/thumbs`);
	}

	override onunload(): void {
		this.disposed = true;
		this.queue.clear();
	}

	setOptions(opts: { quality?: number; enabled?: boolean }): void {
		if (opts.quality !== undefined) this.quality = opts.quality;
		if (opts.enabled !== undefined) this.enabled = opts.enabled;
	}

	onProgress(listener: (pending: number) => void): void {
		this.progressListener = listener;
	}

	get pending(): number {
		return this.queue.size + this.running;
	}

	async init(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
			const listing = await adapter.list(this.dir);
			for (const path of listing.files) {
				const name = path.slice(path.lastIndexOf('/') + 1);
				this.onDisk.add(name);
			}
		} catch {
			// A read-only or unavailable adapter just means no cache; the view
			// falls back to originals.
		}
		this.ready = true;
	}

	/**
	 * Best source available right now for a cell of `screenWidth` device px.
	 * `upgrade` is the tier still worth fetching, if any.
	 */
	resolve(
		item: MediaItem,
		screenWidth: number,
	): { url: string | null; tier: number; upgrade: number | null } {
		const wanted = tierFor(screenWidth);

		if (!this.enabled || this.bypasses(item)) {
			// Videos have no still to show without the cache, so they stay null
			// and the cell draws its stub.
			const url =
				item.kind === 'image'
					? this.app.vault.getResourcePath(item.file)
					: null;
			return { url, tier: Number.MAX_SAFE_INTEGER, upgrade: null };
		}

		if (wanted === null) {
			// Zoomed past the top tier: the original is genuinely wanted.
			if (item.kind === 'image')
				return {
					url: this.app.vault.getResourcePath(item.file),
					tier: Number.MAX_SAFE_INTEGER,
					upgrade: null,
				};
			return this.resolveCached(item, TOP_TIER);
		}

		return this.resolveCached(item, wanted);
	}

	/** Queues generation of `tier` for `item`; returns an unsubscribe. */
	request(
		item: MediaItem,
		tier: number,
		priority: number,
		listener: (url: string | null) => void,
	): () => void {
		const key = this.keyFor(item, tier);
		if (!this.enabled || this.bypasses(item) || this.failed.has(key))
			return () => undefined;
		if (this.onDisk.has(key)) {
			listener(this.urlFor(key));
			return () => undefined;
		}

		let job = this.queue.get(key);
		if (!job) {
			job = { key, item, tier, priority, listeners: new Set() };
			this.queue.set(key, job);
		} else if (priority < job.priority) {
			job.priority = priority;
		}
		job.listeners.add(listener);
		this.pump();
		this.progressListener?.(this.pending);

		return () => {
			const current = this.queue.get(key);
			if (!current) return;
			current.listeners.delete(listener);
			// Nothing on screen wants it any more and it has not started yet.
			if (current.listeners.size === 0) this.queue.delete(key);
		};
	}

	/** Drops every cached file and lets the queue rebuild on demand. */
	async clear(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const names = [...this.onDisk];
		this.onDisk.clear();
		this.failed.clear();
		this.queue.clear();
		for (const name of names) {
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// Already gone, or locked; the in-memory set is authoritative.
			}
		}
	}

	/**
	 * Removes cache files whose source is gone or has been rewritten.
	 * Runs in the background after a rebuild; failures are not worth surfacing.
	 */
	async prune(items: Iterable<MediaItem>): Promise<void> {
		if (!this.ready) return;
		const live = new Set<string>();
		for (const item of items) live.add(this.baseKey(item));
		const adapter = this.app.vault.adapter;
		for (const name of [...this.onDisk]) {
			// `<base>_<shot>_<tier>.webp` — drop the tier, then the shot tag.
			const withoutTier = name.slice(0, name.lastIndexOf('_'));
			const base = withoutTier.slice(0, withoutTier.lastIndexOf('_'));
			if (live.has(base)) continue;
			this.onDisk.delete(name);
			try {
				await adapter.remove(normalizePath(`${this.dir}/${name}`));
			} catch {
				// Ignore: a file we cannot delete is only wasted disk.
			}
		}
	}

	/** Lets a rescan retry things that previously failed to decode. */
	resetFailures(): void {
		this.failed.clear();
	}

	// --- internals --------------------------------------------------------

	private bypasses(item: MediaItem): boolean {
		return BYPASS_EXTENSIONS.has(item.file.extension.toLowerCase());
	}

	private resolveCached(
		item: MediaItem,
		wanted: number,
	): { url: string | null; tier: number; upgrade: number | null } {
		const wantedKey = this.keyFor(item, wanted);
		if (this.onDisk.has(wantedKey))
			return { url: this.urlFor(wantedKey), tier: wanted, upgrade: null };

		// Show any smaller tier we already hold rather than an empty box.
		for (let i = THUMB_TIERS.length - 1; i >= 0; i--) {
			const tier = THUMB_TIERS[i];
			if (tier === undefined || tier >= wanted) continue;
			const key = this.keyFor(item, tier);
			if (this.onDisk.has(key))
				return { url: this.urlFor(key), tier, upgrade: wanted };
		}
		return { url: null, tier: -1, upgrade: wanted };
	}

	/** File identity only: path + size + mtime. Shared by every shot of a clip. */
	private baseKey(item: MediaItem): string {
		return `${cyrb53(item.path).toString(36)}${item.file.stat.size.toString(36)}_${item.version.toString(36)}`;
	}

	private keyFor(item: MediaItem, tier: number): string {
		return `${this.baseKey(item)}_${shotTag(item)}_${tier}.webp`;
	}

	private urlFor(key: string): string {
		return this.app.vault.adapter.getResourcePath(
			normalizePath(`${this.dir}/${key}`),
		);
	}

	private pump(): void {
		while (this.running < CONCURRENCY && this.queue.size > 0) {
			const job = this.takeNext();
			if (!job) return;
			this.running++;
			void this.run(job).finally(() => {
				this.running--;
				this.progressListener?.(this.pending);
				if (!this.disposed) this.pump();
			});
		}
	}

	private takeNext(): Job | null {
		let best: Job | null = null;
		for (const job of this.queue.values())
			if (!best || job.priority < best.priority) best = job;
		if (best) this.queue.delete(best.key);
		return best;
	}

	private async run(job: Job): Promise<void> {
		let url: string | null = null;
		try {
			const blob =
				job.item.kind === 'video'
					? await this.renderVideoFrame(job)
					: await this.renderImage(job);
			if (blob) {
				await this.app.vault.adapter.writeBinary(
					normalizePath(`${this.dir}/${job.key}`),
					await blob.arrayBuffer(),
				);
				this.onDisk.add(job.key);
				url = this.urlFor(job.key);
			}
		} catch {
			// Undecodable (HEIC on Chromium, a truncated export, a codec the
			// runtime lacks). Remember it so we do not retry every frame.
		}
		if (!url) this.failed.add(job.key);
		if (this.disposed) return;
		for (const listener of job.listeners) listener(url);
	}

	private async renderImage(job: Job): Promise<Blob | null> {
		const buffer = await this.app.vault.readBinary(job.item.file);
		const blob = new Blob([buffer]);
		const bitmap = await createImageBitmap(blob);
		try {
			const scale = Math.min(1, job.tier / bitmap.width);
			return await encode(
				bitmap,
				Math.max(1, Math.round(bitmap.width * scale)),
				Math.max(1, Math.round(bitmap.height * scale)),
				this.quality,
			);
		} finally {
			bitmap.close();
		}
	}

	private async renderVideoFrame(job: Job): Promise<Blob | null> {
		const video = createEl('video');
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = this.app.vault.getResourcePath(job.item.file);
		try {
			await once(video, 'loadeddata', 15000);
			const duration = Number.isFinite(video.duration) ? video.duration : 0;
			const shot = job.item.shot;
			// Mid-shot is the representative frame; the first frame after a cut
			// is often still a motion-blurred or part-dissolved one. For a whole
			// file, a tenth in dodges black leader and slates.
			const seekTo = shot
				? (shot.start + shot.end) / 2
				: duration > 0
					? Math.min(duration * 0.1, 5)
					: 0;
			if (seekTo > 0) {
				video.currentTime = seekTo;
				await once(video, 'seeked', 15000);
			}
			const width = video.videoWidth;
			const height = video.videoHeight;
			if (!width || !height) return null;
			const scale = Math.min(1, job.tier / width);
			return await encode(
				video,
				Math.max(1, Math.round(width * scale)),
				Math.max(1, Math.round(height * scale)),
				this.quality,
			);
		} finally {
			video.removeAttribute('src');
			video.load();
			video.remove();
		}
	}
}

/**
 * Distinguishes the cached frames of one file from each other.
 *
 * `f` is the whole file; `s<start in ms, base 36>` is one shot of it.
 */
function shotTag(item: MediaItem): string {
	if (!item.shot) return 'f';
	return `s${Math.round(item.shot.start * 1000).toString(36)}`;
}

/** Smallest tier that covers `screenWidth`, or null when nothing is big enough. */
export function tierFor(screenWidth: number): number | null {
	const dpr = activeWindow.devicePixelRatio || 1;
	const need = screenWidth * dpr;
	for (const tier of THUMB_TIERS) if (tier >= need) return tier;
	return null;
}

async function encode(
	source: CanvasImageSource,
	width: number,
	height: number,
	quality: number,
): Promise<Blob | null> {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(source, 0, 0, width, height);
		return await canvas.convertToBlob({ type: 'image/webp', quality });
	}
	const canvas = createEl('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(source, 0, 0, width, height);
	return await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, 'image/webp', quality),
	);
}

function once(
	el: HTMLMediaElement,
	event: 'loadeddata' | 'seeked',
	timeout: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new Error(`timed out waiting for ${event}`));
		}, timeout);
		const onDone = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error('media error'));
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			el.removeEventListener(event, onDone);
			el.removeEventListener('error', onError);
		};
		el.addEventListener(event, onDone, { once: true });
		el.addEventListener('error', onError, { once: true });
	});
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
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
