import { mkdir, stat } from 'fs/promises';
import { App, FileSystemAdapter, normalizePath } from 'obsidian';
import type { Face } from './lighting';
import { ModelFile, fetchVerified } from './model-download';
import { YUNET_SIZE, decodeYunet, yunetInput } from './yunet';
import { OrtSession, loadOrt, loadSession } from './onnx';
import { hasRuntime, installRuntime } from './ort-runtime';

/**
 * YuNet (OpenCV Zoo, 2023-03 release, MIT licence): a face detector of 230 KB
 * that also returns five landmarks — which is what splits a face into its lit
 * and shadow halves. Pinned to one Hugging Face revision and hash.
 */
export const FACE_MODEL: ModelFile = {
	name: 'face_detection_yunet_2023mar.onnx',
	url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx',
	bytes: 232589,
	sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
};

export type FaceModelState = 'ready' | 'missing' | 'unsupported';

/**
 * Owns the face model: whether it is on disk, fetching it, and running it.
 *
 * It lives beside the other models in the plugin folder and runs on the same
 * ONNX runtime, so a vault that has downloaded either of those only fetches
 * the 230 KB model itself.
 */
export class FaceDetector {
	private session: Promise<OrtSession> | null = null;
	private downloading: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
	) {}

	async state(): Promise<FaceModelState> {
		const root = this.runtimeDir();
		if (!root) return 'unsupported';
		if (!(await hasRuntime(root))) return 'missing';
		try {
			const size = (await stat(this.modelPath(root))).size;
			return size === FACE_MODEL.bytes ? 'ready' : 'missing';
		} catch {
			return 'missing';
		}
	}

	/** Fetches the runtime if it is missing (112 MB), then the model. */
	download(onProgress?: (received: number) => void): Promise<void> {
		if (this.downloading) return this.downloading;
		this.downloading = (async () => {
			const root = this.runtimeDir();
			if (!root)
				throw new Error(
					'The vault is not on a normal file system, so the model has nowhere to go.',
				);
			if (!(await hasRuntime(root))) await installRuntime(root, onProgress);
			await mkdir(`${root}/models`, { recursive: true });
			await fetchVerified(FACE_MODEL, this.modelPath(root), () => {});
		})().finally(() => {
			this.downloading = null;
		});
		return this.downloading;
	}

	/**
	 * Finds faces in a 640 x 640 letterboxed RGBA image.
	 *
	 * @returns faces in that square's pixels; see `unletterbox`.
	 */
	async detect(square: Uint8ClampedArray): Promise<Face[]> {
		const root = this.runtimeDir();
		if (!root) return [];
		this.session ??= loadSession(this.modelPath(root), root, {
			// One small image at a time: the CPU beats a trip to the GPU.
			providers: ['cpu'],
			threads: 2,
			spin: false,
		}).catch((err: unknown) => {
			this.session = null;
			throw err;
		});
		const session = await this.session;
		const ort = loadOrt(root);
		const input = new ort.Tensor('float32', yunetInput(square), [
			1,
			3,
			YUNET_SIZE,
			YUNET_SIZE,
		]);
		const outputs = await session.run({ [session.inputNames[0] ?? 'input']: input });
		return decodeYunet(outputs);
	}

	private modelPath(root: string): string {
		return `${root.replace(/\\/g, '/')}/models/${FACE_MODEL.name}`;
	}

	private runtimeDir(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(normalizePath(this.pluginDir));
	}
}
