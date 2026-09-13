/**
 * The one place the plugin touches onnxruntime-node.
 *
 * TransNetV2 finds cuts and the sound analysis runs two more networks; all
 * three share this loader, so the runtime is required once and each model file
 * is opened once per session.
 */

// --- the slice of onnxruntime-node this plugin uses -----------------------
// Declared structurally rather than imported, so the plugin still type-checks
// and builds on a machine that has never installed the runtime.

export interface OrtTensor {
	data: Float32Array;
	dims: readonly number[];
}

export interface OrtSession {
	inputNames: string[];
	outputNames: string[];
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

export interface OrtModule {
	Tensor: {
		new (type: 'float32', data: Float32Array, dims: number[]): OrtTensor;
		new (type: 'int64', data: BigInt64Array, dims: number[]): OrtTensor;
	};
	InferenceSession: {
		create(path: string, options?: unknown): Promise<OrtSession>;
	};
}

export interface SessionOptions {
	/**
	 * Tried in order. DirectML first suits a large window over many frames;
	 * the CPU suits many small runs, where handing each one to the GPU costs
	 * more than the run itself.
	 */
	providers: ('dml' | 'cpu')[];
	/** Intra-op threads; 0 lets the runtime pick one per physical core. */
	threads?: number;
	/**
	 * False stops idle worker threads busy-waiting for the next run. Worth it
	 * when two sessions take turns: each would otherwise spin on cores the
	 * other one needs.
	 */
	spin?: boolean;
}

let ortModule: OrtModule | null = null;

declare const require: ((id: string) => unknown) | undefined;

/**
 * Loads onnxruntime-node out of the plugin's own `node_modules`, by absolute
 * path.
 *
 * The path is the whole point. Obsidian evaluates `main.js` in the renderer,
 * so the `require` in scope is Electron's, and its resolution paths are rooted
 * at Obsidian's own program directory — a bare `require('onnxruntime-node')`
 * walks up from there and never looks inside the plugin folder, failing with
 * MODULE_NOT_FOUND. An absolute path skips resolution entirely. (A dynamic
 * `import()` is worse still: esbuild leaves it as a real ESM import, which the
 * renderer resolves against the page URL.)
 *
 * The bare name is still tried afterwards, for the case where the package has
 * been hoisted somewhere Obsidian can see.
 */
export function loadOrt(runtimeDir: string): OrtModule {
	if (ortModule) return ortModule;
	const load =
		typeof require === 'function'
			? require
			: (window as unknown as { require?: (id: string) => unknown }).require;
	if (!load)
		throw new Error(
			'Node require is unavailable in this Obsidian build, so onnxruntime-node cannot be loaded.',
		);
	const candidates = [
		`${runtimeDir.replace(/\\/g, '/')}/node_modules/onnxruntime-node`,
		'onnxruntime-node',
	];
	const failures: string[] = [];
	for (const id of candidates) {
		try {
			const mod = load(id) as OrtModule & { default?: OrtModule };
			ortModule = mod.default ?? mod;
			return ortModule;
		} catch (err) {
			failures.push(`${id}: ${messageOf(err)}`);
		}
	}
	throw new Error(
		`onnxruntime-node could not be loaded. Run \`npm install\` in the plugin folder. (${failures.join(' | ')})`,
	);
}

export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const sessions = new Map<string, Promise<OrtSession>>();

/**
 * Opens a model once and hands the same session to every later caller.
 *
 * Each provider is tried in turn and falling through is not an error worth
 * reporting: DirectML is missing on machines without Direct3D 12, and the CPU
 * gives identical output.
 */
export async function loadSession(
	modelPath: string,
	runtimeDir: string,
	options: SessionOptions,
): Promise<OrtSession> {
	const key = `${modelPath}|${options.providers.join(',')}|${options.threads ?? 0}|${options.spin ?? true}`;
	const existing = sessions.get(key);
	if (existing) return existing;
	const created = (async () => {
		const ort = loadOrt(runtimeDir);
		let lastError: unknown = null;
		for (let i = 0; i < options.providers.length; i++) {
			try {
				return await ort.InferenceSession.create(modelPath, {
					executionProviders: options.providers.slice(i),
					graphOptimizationLevel: 'all',
					intraOpNumThreads: options.threads ?? 0,
					// Warnings about shape ops being kept on the CPU are
					// expected and would otherwise fill the console per run.
					logSeverityLevel: 3,
					...(options.spin === false
						? {
								extra: {
									session: {
										intra_op: { allow_spinning: '0' },
										inter_op: { allow_spinning: '0' },
									},
								},
							}
						: {}),
				});
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error(`Could not open ${modelPath}.`);
	})();
	sessions.set(key, created);
	try {
		return await created;
	} catch (err) {
		// A failed load must not be cached, or fixing the model path would
		// need a restart.
		sessions.delete(key);
		throw err;
	}
}

/** Drops every loaded model. Called when the plugin unloads. */
export function releaseModels(): void {
	sessions.clear();
}
