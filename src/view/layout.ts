import { CinemaCanvasSettings } from '../settings';
import { GroupBox, ItemBox, LayoutResult, MediaGroup, Rect } from '../types';

export interface LayoutMetrics {
	cellWidth: number;
	cellHeight: number;
	/** Extra strip under the media for the file name. */
	captionHeight: number;
	gap: number;
	groupPadding: number;
	groupHeaderHeight: number;
	groupGap: number;
}

export function layoutMetrics(settings: CinemaCanvasSettings): LayoutMetrics {
	const cellHeight = Math.max(32, settings.itemHeight);
	const cellWidth = Math.max(32, Math.round(cellHeight * settings.aspectRatio));
	const captionHeight = settings.showFileNames
		? Math.round(cellHeight * 0.09)
		: 0;
	const gap = Math.max(0, settings.gap);
	return {
		cellWidth,
		cellHeight,
		captionHeight,
		gap,
		groupPadding: Math.round(cellHeight * 0.06) + gap / 2,
		groupHeaderHeight: Math.round(cellHeight * 0.14),
		groupGap: gap * 2 + Math.round(cellHeight * 0.05),
	};
}

/**
 * Packs folder groups into a roughly square canvas.
 *
 * Each group is an internally regular grid whose column count grows with its
 * item count (capped by the setting), then groups are shelf-packed left to
 * right and wrapped at a target width derived from total area. The result is
 * deterministic: the same groups always produce the same rects, so selection
 * and viewport stay put across relayouts.
 */
export function computeLayout(
	groups: MediaGroup[],
	settings: CinemaCanvasSettings,
): LayoutResult {
	const m = layoutMetrics(settings);
	const maxCols = Math.max(1, settings.maxColumnsPerGroup);

	const sized = groups.map((group) => {
		const count = Math.max(1, group.items.length);
		const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(count))));
		const rows = Math.ceil(count / cols);
		const inner = m.cellHeight + m.captionHeight;
		return {
			group,
			cols,
			rows,
			w: m.groupPadding * 2 + cols * m.cellWidth + (cols - 1) * m.gap,
			h:
				m.groupPadding * 2 +
				m.groupHeaderHeight +
				rows * inner +
				(rows - 1) * m.gap,
		};
	});

	const totalArea = sized.reduce((sum, g) => sum + g.w * g.h, 0);
	const widest = sized.reduce((max, g) => Math.max(max, g.w), 0);
	// 1.6 biases slightly wider than tall, which suits landscape screens.
	const targetWidth = Math.max(widest, Math.sqrt(totalArea * 1.6));

	const groupBoxes: GroupBox[] = [];
	const itemBoxes: ItemBox[] = [];

	let cursorX = 0;
	let cursorY = 0;
	let rowHeight = 0;
	let flatIndex = 0;

	sized.forEach((g, groupIndex) => {
		if (cursorX > 0 && cursorX + g.w > targetWidth) {
			cursorX = 0;
			cursorY += rowHeight + m.groupGap;
			rowHeight = 0;
		}

		const box: GroupBox = {
			x: cursorX,
			y: cursorY,
			w: g.w,
			h: g.h,
			group: g.group,
			groupIndex,
			headerHeight: m.groupHeaderHeight,
		};
		groupBoxes.push(box);

		const originX = cursorX + m.groupPadding;
		const originY = cursorY + m.groupPadding + m.groupHeaderHeight;
		g.group.items.forEach((item, i) => {
			const col = i % g.cols;
			const row = Math.floor(i / g.cols);
			itemBoxes.push({
				x: originX + col * (m.cellWidth + m.gap),
				y: originY + row * (m.cellHeight + m.captionHeight + m.gap),
				w: m.cellWidth,
				h: m.cellHeight + m.captionHeight,
				item,
				index: flatIndex++,
				groupIndex,
				col,
				row,
				cols: g.cols,
			});
		});

		rowHeight = Math.max(rowHeight, g.h);
		cursorX += g.w + m.groupGap;
	});

	return {
		groups: groupBoxes,
		items: itemBoxes,
		bounds: boundsOf(groupBoxes),
	};
}

function boundsOf(boxes: Rect[]): Rect {
	if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of boxes) {
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.w > maxX) maxX = b.x + b.w;
		if (b.y + b.h > maxY) maxY = b.y + b.h;
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function intersects(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.w &&
		a.x + a.w > b.x &&
		a.y < b.y + b.h &&
		a.y + a.h > b.y
	);
}

export function expand(r: Rect, margin: number): Rect {
	return {
		x: r.x - margin,
		y: r.y - margin,
		w: r.w + margin * 2,
		h: r.h + margin * 2,
	};
}
