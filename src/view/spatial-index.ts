import { ItemBox, Rect } from '../types';

/**
 * Uniform bucket grid over the laid-out cells.
 *
 * Visibility used to be a full array scan every animation frame, which is fine
 * for a few hundred cells and wasteful for tens of thousands. Bucketing turns
 * it into a local lookup proportional to what is actually on screen.
 */
export class SpatialIndex {
	private readonly buckets = new Map<string, ItemBox[]>();
	private readonly cell: number;

	constructor(boxes: ItemBox[], cellSize: number) {
		this.cell = Math.max(1, cellSize);
		for (const box of boxes) {
			const x0 = Math.floor(box.x / this.cell);
			const y0 = Math.floor(box.y / this.cell);
			const x1 = Math.floor((box.x + box.w) / this.cell);
			const y1 = Math.floor((box.y + box.h) / this.cell);
			for (let x = x0; x <= x1; x++) {
				for (let y = y0; y <= y1; y++) {
					const key = `${x},${y}`;
					const bucket = this.buckets.get(key);
					if (bucket) bucket.push(box);
					else this.buckets.set(key, [box]);
				}
			}
		}
	}

	query(rect: Rect): ItemBox[] {
		const seen = new Set<number>();
		const out: ItemBox[] = [];
		const x0 = Math.floor(rect.x / this.cell);
		const y0 = Math.floor(rect.y / this.cell);
		const x1 = Math.floor((rect.x + rect.w) / this.cell);
		const y1 = Math.floor((rect.y + rect.h) / this.cell);
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				const bucket = this.buckets.get(`${x},${y}`);
				if (!bucket) continue;
				for (const box of bucket) {
					// A box spanning several buckets shows up more than once.
					if (seen.has(box.index)) continue;
					seen.add(box.index);
					out.push(box);
				}
			}
		}
		return out;
	}
}
