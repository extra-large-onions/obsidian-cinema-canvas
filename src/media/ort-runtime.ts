/**
 * Installs onnxruntime-node into the plugin folder on first use.
 *
 * The runtime is a native addon, which cannot be bundled into `main.js`: the
 * `.node` binding and the DLLs beside it have to be real files on disk. So
 * rather than ship a `node_modules` folder with the plugin, the two npm
 * packages it needs are fetched from the npm registry, pinned to one version
 * and checked against the registry's SHA-512, and only this machine's
 * platform binaries are unpacked (about 64 MB of the 280 MB package).
 *
 * The result lives in `<plugin>/runtime/node_modules/`, outside the plugin's
 * own `node_modules`, so an `npm install` during development cannot prune it.
 */
import { createHash } from 'crypto';
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { get as httpsGet } from 'https';
import type { IncomingMessage } from 'http';
import { dirname } from 'path';
import { createGunzip } from 'zlib';

const VERSION = '1.29.0';

interface RuntimePackage {
	name: string;
	url: string;
	/** The registry's `dist.integrity`, base64 SHA-512 of the tarball. */
	sha512: string;
	/** Size of the tarball, for progress. */
	bytes: number;
	/** Which tarball paths (under `package/`) are worth unpacking. */
	keep: (path: string) => boolean;
}

/**
 * The JavaScript half of a package. The nested `package.json` files count:
 * onnxruntime-common is `"type": "module"` at the top and marks `dist/cjs`
 * as CommonJS with one of its own, without which `require` fails.
 */
const isCode = (p: string): boolean =>
	p.endsWith('package.json') || (p.startsWith('dist/') && p.endsWith('.js'));

const BIN = `bin/napi-v6/${process.platform}/${process.arch}/`;

const PACKAGES: RuntimePackage[] = [
	{
		name: 'onnxruntime-node',
		url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${VERSION}.tgz`,
		sha512: 'WjiVVB72riILz8HbYvxvmjKyE/WmkYoSfKY++axo5jAR609HQg8MwiG/HhShpTcJfmmAdzxxmB+MMST3A+SiPA==',
		bytes: 111735068,
		keep: (p) => isCode(p) || p.startsWith(BIN),
	},
	{
		name: 'onnxruntime-common',
		url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${VERSION}.tgz`,
		sha512: '/F63/e2VJoaVXGGNu6S5QH7jivBThGO95OzAVXXQ8hTta/b1QxI8udHa6cI3+3mAb5WWIIaMMwfZw01oivjJ1g==',
		bytes: 66604,
		keep: isCode,
	},
];

/** Total download size, for a progress readout that includes the runtime. */
export const RUNTIME_BYTES = PACKAGES.reduce((a, p) => a + p.bytes, 0);

/** Written last, so its presence means every file before it landed. */
const MARKER = 'installed.json';

/** The folder whose `node_modules` holds the runtime, for `loadOrt`. */
export function runtimeRoot(pluginRoot: string): string {
	return `${pluginRoot.replace(/\\/g, '/')}/runtime`;
}

/** True when this version of the runtime is unpacked for this machine. */
export async function hasRuntime(pluginRoot: string): Promise<boolean> {
	const root = runtimeRoot(pluginRoot);
	try {
		await stat(`${root}/${MARKER}-${VERSION}-${process.platform}-${process.arch}`);
		return true;
	} catch {
		return false;
	}
}

let installing: Promise<void> | null = null;

/**
 * Downloads and unpacks the runtime. Concurrent callers (the shot and sound
 * downloads can both ask) share one install. `onBytes` gets the running total
 * of tarball bytes received, against `RUNTIME_BYTES`.
 */
export function installRuntime(
	pluginRoot: string,
	onBytes?: (received: number) => void,
): Promise<void> {
	installing ??= install(pluginRoot, onBytes).finally(() => {
		installing = null;
	});
	return installing;
}

async function install(
	pluginRoot: string,
	onBytes?: (received: number) => void,
): Promise<void> {
	if (await hasRuntime(pluginRoot)) return;
	const root = runtimeRoot(pluginRoot);
	const staging = `${root}/.staging`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	try {
		let before = 0;
		for (const pkg of PACKAGES) {
			await fetchPackage(pkg, `${staging}/node_modules/${pkg.name}`, (n) =>
				onBytes?.(before + n),
			);
			before += pkg.bytes;
		}
		try {
			await stat(`${staging}/node_modules/onnxruntime-node/${BIN}`);
		} catch {
			throw new Error(
				`onnxruntime-node ${VERSION} has no build for ${process.platform}/${process.arch}.`,
			);
		}
		await rm(`${root}/node_modules`, { recursive: true, force: true });
		await rename(`${staging}/node_modules`, `${root}/node_modules`);
		await writeFile(
			`${root}/${MARKER}-${VERSION}-${process.platform}-${process.arch}`,
			'',
		);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * Streams one tarball through gunzip and a tar reader, writing the kept
 * entries under `target`, and fails unless the tarball's SHA-512 matches.
 */
function fetchPackage(
	pkg: RuntimePackage,
	target: string,
	onBytes: (received: number) => void,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		openUrl(pkg.url, 5, (response) => {
			const hash = createHash('sha512');
			const writes: Promise<void>[] = [];
			const tar = new TarReader((path, data) => {
				const inner = path.replace(/^package\//, '');
				if (inner === path || !pkg.keep(inner)) return;
				const file = `${target}/${inner}`;
				writes.push(
					mkdir(dirname(file), { recursive: true }).then(() =>
						writeFile(file, data),
					),
				);
			});
			const gunzip = createGunzip();
			let received = 0;
			response.on('data', (chunk: Buffer) => {
				hash.update(chunk);
				received += chunk.length;
				onBytes(received);
			});
			response.on('error', reject);
			gunzip.on('data', (chunk: Buffer) => tar.push(chunk));
			gunzip.on('error', reject);
			gunzip.on('end', () => {
				void (async () => {
					await Promise.all(writes);
					const digest = hash.digest('base64');
					if (digest !== pkg.sha512)
						throw new Error(
							`${pkg.name} did not match the expected file (sha512 ${digest.slice(0, 12)}…). Nothing was installed.`,
						);
					resolve();
				})().catch(reject);
			});
			response.pipe(gunzip);
		}, reject);
	});
}

function openUrl(
	url: string,
	redirects: number,
	onResponse: (response: IncomingMessage) => void,
	onError: (err: Error) => void,
): void {
	httpsGet(
		url,
		{ headers: { 'User-Agent': 'obsidian-cinema-canvas' } },
		(response) => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.resume();
				if (redirects <= 0) onError(new Error(`Too many redirects fetching ${url}.`));
				else openUrl(new URL(location, url).toString(), redirects - 1, onResponse, onError);
				return;
			}
			if (status !== 200) {
				response.resume();
				onError(new Error(`Fetching ${url} failed: HTTP ${status}.`));
				return;
			}
			onResponse(response);
		},
	).on('error', onError);
}

/**
 * A minimal streaming reader for the ustar archives npm publishes: regular
 * files only, with pax headers honoured for long paths. Each file is handed
 * over whole; the largest runtime file is a few tens of MB.
 */
class TarReader {
	private chunks: Buffer[] = [];
	private queued = 0;
	private entry: { path: string; size: number; type: string } | null = null;
	private paxPath: string | null = null;
	private done = false;

	constructor(private readonly onFile: (path: string, data: Buffer) => void) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.queued += chunk.length;
		while (!this.done) {
			if (!this.entry) {
				const header = this.take(512);
				if (!header) return;
				if (header.every((b) => b === 0)) {
					this.done = true;
					return;
				}
				const name = text(header, 0, 100);
				const prefix = text(header, 345, 155);
				const type = String.fromCharCode(header[156] ?? 0);
				this.entry = {
					path: this.paxPath ?? (prefix ? `${prefix}/${name}` : name),
					size: parseInt(text(header, 124, 12).trim() || '0', 8),
					type,
				};
				if (type !== 'x') this.paxPath = null;
				continue;
			}
			const padded = Math.ceil(this.entry.size / 512) * 512;
			const block = this.take(padded);
			if (!block) return;
			const data = block.subarray(0, this.entry.size);
			if (this.entry.type === 'x') this.paxPath = paxPath(data);
			else if (this.entry.type === '0' || this.entry.type === '\u0000')
				this.onFile(this.entry.path, data);
			this.entry = null;
		}
	}

	/** The next `n` bytes as one buffer, or null until that many arrive. */
	private take(n: number): Buffer | null {
		if (this.queued < n) return null;
		const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
		this.chunks = n < all.length ? [all.subarray(n)] : [];
		this.queued -= n;
		return Buffer.from(all.subarray(0, n));
	}
}

function text(buf: Buffer, start: number, length: number): string {
	const slice = buf.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

function paxPath(data: Buffer): string | null {
	const match = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
	return match?.[1] ?? null;
}
