import { TFile } from 'obsidian';

export type MediaKind = 'image' | 'video';

/** One detected shot: a range of the source file, never a separate file. */
export interface Shot {
	/** Position within the owning clip, 0-based. */
	index: number;
	/** Seconds from the start of the file. */
	start: number;
	end: number;
	/** Cut confidence x100 at the cut that opened this shot; 0 for the first. */
	score: number;
}

export interface MediaItem {
	/**
	 * Identity on the canvas, and the cell recycling key.
	 *
	 * A canvas item is always a whole file, so this is the vault path. Shot
	 * items — made by the strip and the lightbox, never by the index — use
	 * `path#t=<start>`, because one file then stands for many thumbnails.
	 */
	key: string;
	/** Vault-relative path of the source file. */
	path: string;
	file: TFile;
	kind: MediaKind;
	/** Parent folder path, '' for vault root. */
	folder: string;
	/** mtime, used to bust the cached resource URL when a file is rewritten. */
	version: number;
	/** Set only on shot items: the slice of the file this cell represents. */
	shot?: Shot;
}

export interface MediaGroup {
	/** Folder path, '' for vault root. */
	folder: string;
	/** Display label, e.g. "archive/b-roll" or "(vault root)". */
	label: string;
	items: MediaItem[];
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ItemBox extends Rect {
	item: MediaItem;
	/** Index into the flattened, layout-ordered item list. */
	index: number;
	groupIndex: number;
	/** Position within the owning group's grid, for row-wise navigation. */
	col: number;
	row: number;
	cols: number;
}

export interface GroupBox extends Rect {
	group: MediaGroup;
	groupIndex: number;
	/** Header strip height, included in `h`. */
	headerHeight: number;
}

export interface LayoutResult {
	groups: GroupBox[];
	items: ItemBox[];
	/** Bounding box of everything laid out. */
	bounds: Rect;
}
