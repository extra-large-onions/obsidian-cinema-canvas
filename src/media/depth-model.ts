import { mkdir, stat } from 'fs/promises';
import { App, FileSystemAdapter, normalizePath } from 'obsidian';
import { Worker } from 'worker_threads';
import { ModelFile, fetchVerified } from './model-download';
import { loadOrt, loadSession } from './onnx';
import { hasRuntime, installRuntime, runtimeRoot } from './ort-runtime';

/**
 * Depth Anything V2 Small (Apache-2.0), exported to ONNX by the
 * onnx-community: relative depth from one picture, 25M parameters in full
 * precision. Pinned to one Hugging Face revision and hash.
 */
export const DEPTH_MODEL: ModelFile = {
	name: 'depth_anything_v2_small.onnx',
	url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx',
	bytes: 99060839,
	sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
};

export type DepthModelState = 'ready' | 'missing' | 'unsupported';

export interface DepthOutput {
	/** Relative inverse depth: larger is nearer. */
	data: Float32Array;
	width: number;
	height: number;
}

/**
 * Runs the model on a thread of its own.
 *
 * onnxruntime-node's `run` is synchronous underneath its promise: on the main
 * thread two or three seconds of depth would freeze Obsidian outright. The
 * worker loads the same runtime by path and keeps its session between frames.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
let ort = null;
let session = null;
parentPort.on('message', async (m) => {
	try {
		if (!ort) {
			const failures = [];
			for (const id of workerData.ort) {
				try { const mod = require(id); ort = mod.default || mod; break; }
				catch (err) { failures.push(String(err && err.message || err)); }
			}
			if (!ort) throw new Error('onnxruntime-node could not be loaded: ' + failures.join(' | '));
		}
		if (!session)
			session = await ort.InferenceSession.create(workerData.model, {
				executionProviders: ['cpu'],
				graphOptimizationLevel: 'all',
				logSeverityLevel: 3,
			});
		const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', m.input, m.dims) });
		const t = out[session.outputNames[0]];
		const data = new Float32Array(t.data);
		parentPort.postMessage({ id: m.id, data, dims: t.dims }, [data.buffer]);
	} catch (err) {
		parentPort.postMessage({ id: m.id, error: String(err && err.message || err) });
	}
});
`;

interface Reply {
	id: number;
	data?: Float32Array;
	dims?: number[];
	error?: string;
}

/**
 * Owns the depth model: whether it is on disk, fetching it, and running it.
 * Beside the face model in the plugin folder, on the same ONNX runtime.
 */
export class DepthEstimator {
	private downloading: Promise<void> | null = null;
	private worker: Worker | null = null;
	/** Set once the worker has failed: the main thread runs the model instead. */
	private workerFailed = false;
	private nextId = 0;
	private readonly waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
	) {}

	async state(): Promise<DepthModelState> {
		const root = this.runtimeDir();
		if (!root) return 'unsupported';
		if (!(await hasRuntime(root))) return 'missing';
		try {
			const size = (await stat(this.modelPath(root))).size;
			return size === DEPTH_MODEL.bytes ? 'ready' : 'missing';
		} catch {
			return 'missing';
		}
	}

	/** Fetches the runtime if it is missing (112 MB), then the model (99 MB). */
	download(onProgress?: (received: number, total: number) => void): Promise<void> {
		if (this.downloading) return this.downloading;
		this.downloading = (async () => {
			const root = this.runtimeDir();
			if (!root)
				throw new Error(
					'The vault is not on a normal file system, so the model has nowhere to go.',
				);
			if (!(await hasRuntime(root))) await installRuntime(root);
			await mkdir(`${root}/models`, { recursive: true });
			await fetchVerified(DEPTH_MODEL, this.modelPath(root), (received) =>
				onProgress?.(received, DEPTH_MODEL.bytes),
			);
		})().finally(() => {
			this.downloading = null;
		});
		return this.downloading;
	}

	/** Depth for a picture packed by `depthInput`, `width` x `height`. */
	async estimate(input: Float32Array, width: number, height: number): Promise<DepthOutput> {
		const root = this.runtimeDir();
		if (!root) throw new Error('The vault is not on a normal file system.');
		const dims = [1, 3, height, width];
		if (!this.workerFailed) {
			try {
				return this.toOutput(await this.onWorker(root, input, dims));
			} catch (err) {
				// Only a worker that could not start or load the runtime falls
				// back; a model error would fail the same way on this thread.
				if (!(err instanceof WorkerStartError)) throw err;
				this.workerFailed = true;
				console.warn('Cinema canvas: depth runs on the main thread', err.message);
			}
		}
		const session = await loadSession(this.modelPath(root), root, {
			providers: ['cpu'],
			spin: false,
		});
		const ort = loadOrt(root);
		const out = await session.run({
			[session.inputNames[0] ?? 'pixel_values']: new ort.Tensor('float32', input, dims),
		});
		const t = out[session.outputNames[0] ?? 'predicted_depth'];
		if (!t) throw new Error('The depth model returned nothing.');
		return this.toOutput({ id: 0, data: t.data, dims: [...t.dims] });
	}

	/** Stops the worker; called when the plugin unloads. */
	dispose(): void {
		void this.worker?.terminate();
		this.worker = null;
		for (const w of this.waiting.values()) w.reject(new Error('The depth model was unloaded.'));
		this.waiting.clear();
	}

	private onWorker(root: string, input: Float32Array, dims: number[]): Promise<Reply> {
		const worker = this.startWorker(root);
		const id = ++this.nextId;
		return new Promise<Reply>((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			worker.postMessage({ id, input, dims }, [input.buffer as ArrayBuffer]);
		}).then((reply) => {
			if (reply.error) {
				const loading = /could not be loaded|Cannot find module/.test(reply.error);
				throw loading ? new WorkerStartError(reply.error) : new Error(reply.error);
			}
			return reply;
		});
	}

	private startWorker(root: string): Worker {
		if (this.worker) return this.worker;
		let worker: Worker;
		try {
			worker = new Worker(WORKER_SOURCE, {
				eval: true,
				workerData: {
					model: this.modelPath(root),
					ort: [
						`${runtimeRoot(root)}/node_modules/onnxruntime-node`,
						`${root.replace(/\\/g, '/')}/node_modules/onnxruntime-node`,
					],
				},
			});
		} catch (err) {
			throw new WorkerStartError(err instanceof Error ? err.message : String(err));
		}
		worker.on('message', (reply: Reply) => {
			const w = this.waiting.get(reply.id);
			this.waiting.delete(reply.id);
			w?.resolve(reply);
		});
		const fail = (err: Error) => {
			this.worker = null;
			for (const w of this.waiting.values()) w.reject(new WorkerStartError(err.message));
			this.waiting.clear();
		};
		worker.on('error', fail);
		worker.on('exit', (code) => {
			if (this.worker === worker) fail(new Error(`The depth worker stopped (${code}).`));
		});
		this.worker = worker;
		return worker;
	}

	private toOutput(reply: Reply): DepthOutput {
		const dims = reply.dims ?? [];
		const height = dims[dims.length - 2] ?? 0;
		const width = dims[dims.length - 1] ?? 0;
		if (!reply.data || !width || !height) throw new Error('The depth model returned nothing.');
		return { data: reply.data, width, height };
	}

	private modelPath(root: string): string {
		return `${root.replace(/\\/g, '/')}/models/${DEPTH_MODEL.name}`;
	}

	private runtimeDir(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(normalizePath(this.pluginDir));
	}
}

/** The worker could not start or load the runtime: worth one try on the main thread. */
class WorkerStartError extends Error {}
