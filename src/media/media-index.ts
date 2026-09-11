import { App, Component, TAbstractFile, TFile, TFolder } from 'obsidian';
import { CinemaCanvasSettings, SortField } from '../settings';
import { MediaGroup, MediaItem } from '../types';
import { debounce } from '../utils/debounce';
import { buildExtensionTable, ExtensionTable } from './extensions';
import { FolderScope } from './scope';

export const VAULT_ROOT_LABEL = '(vault root)';

type ChangeListener = () => void;

/** Supplied by the plugin so the index does not have to know about ffmpeg. */

/**
 * The live picture of every media file in scope.
 *
 * Reconciliation has two halves:
 *  - a full build from `vault.getFiles()`, run on startup and whenever a
 *    scanning setting changes. This reads Obsidian's in-memory file list, so
 *    it never touches disk.
 *  - incremental patches from vault events, which is what covers dragging a
 *    file in, deleting one, or an external tool writing into the vault while
 *    Obsidian is open. Patches are coalesced through a short debounce so a
 *    drop of 200 stills triggers one relayout, not 200.
 */
export class MediaIndex extends Component {
	private readonly items = new Map<string, MediaItem>();
	private readonly listeners = new Set<ChangeListener>();

	private scope: FolderScope;
	private extensions: ExtensionTable;
	private settings: CinemaCanvasSettings;

	/** Cached grouping, invalidated on every mutation. */
	private groupCache: MediaGroup[] | null = null;
	/** Bumped on every emitted change so views can cheaply detect staleness. */
	private revision = 0;

	private readonly notifyDebounced = debounce(() => this.emit(), 150);
	private readonly rebuildDebounced = debounce(() => this.rebuild(), 300);

	constructor(
		private readonly app: App,
		settings: CinemaCanvasSettings,
	) {
		super();
		this.settings = settings;
		this.scope = new FolderScope(settings.folders);
		this.extensions = buildExtensionTable(settings);
	}

	override onload(): void {
		const vault = this.app.vault;
		this.registerEvent(
			vault.on('create', (f) => this.onCreate(f)),
		);
		this.registerEvent(
			vault.on('delete', (f) => this.onDelete(f)),
		);
		this.registerEvent(
			vault.on('rename', (f, oldPath) => this.onRename(f, oldPath)),
		);
		this.registerEvent(
			vault.on('modify', (f) => this.onModify(f)),
		);
	}

	override onunload(): void {
		this.notifyDebounced.cancel();
		this.rebuildDebounced.cancel();
		this.listeners.clear();
		this.items.clear();
	}

	// --- public API -------------------------------------------------------

	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}


	get currentRevision(): number {
		return this.revision;
	}

	get size(): number {
		return this.items.size;
	}

	get scopeDescription(): string {
		return this.scope.isWholeVault
			? 'whole vault'
			: this.scope.folders.join(', ');
	}

	/** Re-reads settings and does a full rebuild. */
	applySettings(settings: CinemaCanvasSettings): void {
		this.settings = settings;
		this.scope = new FolderScope(settings.folders);
		this.extensions = buildExtensionTable(settings);
		this.rebuild();
	}

	/** Full scan. Cheap: Obsidian already holds the file list in memory. */
	rebuild(): void {
		this.rebuildDebounced.cancel();
		this.items.clear();
		for (const file of this.app.vault.getFiles()) {
			const item = this.toItem(file);
			if (item) this.items.set(file.path, item);
		}
		this.invalidate();
		this.emit();
	}

	/** Every indexed item, unordered. */
	allItems(): Iterable<MediaItem> {
		return this.items.values();
	}

	/**
	 * One item by vault path.
	 *
	 * The clip view holds a path rather than an item, because that is all a
	 * workspace leaf can persist across a restart.
	 */
	getItem(path: string): MediaItem | null {
		return this.items.get(path) ?? null;
	}

	/** Items grouped by parent folder, sorted per settings. */
	getGroups(): MediaGroup[] {
		if (this.groupCache) return this.groupCache;

		const byFolder = new Map<string, MediaItem[]>();
		for (const item of this.items.values()) {
			let bucket = byFolder.get(item.folder);
			if (!bucket) {
				bucket = [];
				byFolder.set(item.folder, bucket);
			}
			bucket.push(item);
		}

		const compare = itemComparator(
			this.settings.sortField,
			this.settings.sortDescending,
		);

		const groups: MediaGroup[] = [];
		for (const [folder, items] of byFolder) {
			items.sort(compare);
			groups.push({
				folder,
				label: folder === '' ? VAULT_ROOT_LABEL : folder,
				items,
			});
		}
		groups.sort((a, b) => {
			// Root first, then alphabetical by path.
			if (a.folder === '') return -1;
			if (b.folder === '') return 1;
			return a.folder.localeCompare(b.folder, undefined, {
				numeric: true,
				sensitivity: 'base',
			});
		});

		this.groupCache = groups;
		return groups;
	}

	// --- vault events -----------------------------------------------------

	private onCreate(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			// A folder appearing usually means a directory of files landed at
			// once; children arrive as their own events, but a moved folder
			// may not, so resync.
			this.rebuildDebounced();
			return;
		}
		if (!(file instanceof TFile)) return;
		const item = this.toItem(file);
		if (!item) return;
		this.items.set(file.path, item);
		this.invalidate();
		this.notifyDebounced();
	}

	private onDelete(file: TAbstractFile): void {
		if (file instanceof TFolder) {
			const prefix = file.path + '/';
			let removed = false;
			for (const path of [...this.items.keys()]) {
				if (path.startsWith(prefix)) {
					this.items.delete(path);
					removed = true;
				}
			}
			if (removed) {
				this.invalidate();
				this.notifyDebounced();
			}
			return;
		}
		if (!this.items.delete(file.path)) return;
		this.invalidate();
		this.notifyDebounced();
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		if (file instanceof TFolder) {
			// Children keep their TFile identity but every path changed, and
			// Obsidian does not emit per-child events. Rebuild.
			this.rebuildDebounced();
			return;
		}
		if (!(file instanceof TFile)) return;
		const had = this.items.delete(oldPath);
		const item = this.toItem(file);
		if (item) this.items.set(file.path, item);
		if (!had && !item) return;
		this.invalidate();
		this.notifyDebounced();
	}

	private onModify(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const existing = this.items.get(file.path);
		if (!existing) return;
		// Bust the cached resource so a re-export of the same filename shows.
		existing.version = file.stat.mtime;
		this.invalidate();
		this.notifyDebounced();
	}

	// --- internals --------------------------------------------------------

	private toItem(file: TFile): MediaItem | null {
		const kind = this.extensions.kindOf(file.extension);
		if (!kind) return null;
		if (!this.scope.includes(file.path)) return null;
		return {
			key: file.path,
			path: file.path,
			file,
			kind,
			folder: file.parent?.path === '/' ? '' : (file.parent?.path ?? ''),
			version: file.stat.mtime,
		};
	}

	private invalidate(): void {
		this.groupCache = null;
	}

	private emit(): void {
		this.notifyDebounced.cancel();
		this.revision++;
		for (const listener of this.listeners) listener();
	}
}

function itemComparator(
	field: SortField,
	descending: boolean,
): (a: MediaItem, b: MediaItem) => number {
	const direction = descending ? -1 : 1;
	return (a, b) => {
		let result: number;
		switch (field) {
			case 'modified':
				result = a.file.stat.mtime - b.file.stat.mtime;
				break;
			case 'created':
				result = a.file.stat.ctime - b.file.stat.ctime;
				break;
			case 'path':
				result = a.path.localeCompare(b.path, undefined, {
					numeric: true,
					sensitivity: 'base',
				});
				break;
			case 'name':
			default:
				result = a.file.name.localeCompare(b.file.name, undefined, {
					numeric: true,
					sensitivity: 'base',
				});
				break;
		}
		// Stable tiebreak so relayout never reshuffles equal items.
		if (result === 0) result = a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
		return result * direction;
	};
}
