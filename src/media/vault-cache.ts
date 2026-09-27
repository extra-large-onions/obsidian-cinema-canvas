import { DataAdapter, normalizePath } from 'obsidian';

/**
 * Where detection results live: inside the vault, under the folder it already
 * keeps for rebuildable caches.
 *
 * `_cache/` is where other plugins in this vault keep their indexes, and the
 * vault's `.gitignore` excludes it as cache that is never versioned. A shot list
 * or a sound reading can always be recomputed from the film, so it belongs
 * there. Scenes and cut labels cannot — they are made by hand — so those are a
 * note beside the film instead; see `scene-store.ts`.
 */
export const CACHE_ROOT = '_cache/cinema-canvas';

/** `_cache/cinema-canvas/<name>`, vault-relative. */
export function cacheDir(name: string): string {
	return normalizePath(`${CACHE_ROOT}/${name}`);
}

/** Creates `path` and any missing parent, one level at a time. */
export async function ensureDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	let current = '';
	for (const part of normalizePath(path).split('/')) {
		current = current ? `${current}/${part}` : part;
		if (!(await adapter.exists(current))) await adapter.mkdir(current);
	}
}

/**
 * Moves every file from an old cache folder into its new home, once.
 *
 * Used for the caches written into the plugin folder before 0.11. They are
 * moved rather than re-created because re-creating a film's shot list is most
 * of half an hour of inference. A file already at the destination wins, and
 * the old folder is removed once it is empty.
 *
 * @returns how many files were moved.
 */
export async function migrateDir(
	adapter: DataAdapter,
	from: string,
	to: string,
): Promise<number> {
	if (!(await adapter.exists(from))) return 0;
	await ensureDir(adapter, to);
	let moved = 0;
	for (const source of (await adapter.list(from)).files) {
		const name = source.slice(source.lastIndexOf('/') + 1);
		const target = normalizePath(`${to}/${name}`);
		try {
			if (await adapter.exists(target)) {
				await adapter.remove(source);
			} else {
				await adapter.rename(source, target);
				moved++;
			}
		} catch {
			// Locked or already gone. Left where it is, it is only wasted disk,
			// and the next startup tries again.
		}
	}
	try {
		const rest = await adapter.list(from);
		if (rest.files.length === 0 && rest.folders.length === 0)
			await adapter.rmdir(from, false);
	} catch {
		// An empty folder left behind is harmless.
	}
	return moved;
}
