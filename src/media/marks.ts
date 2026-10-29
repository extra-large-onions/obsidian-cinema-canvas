/**
 * Frame marks: arrows, circles, boxes, lines, freehand strokes and text drawn
 * over a film, each shown only for a stretch of time.
 *
 * Like one clip on a video editor's track: a mark has a start, an end and a
 * layer, and is shown while the film is inside `[start, end)`. A mark for one
 * frame only runs from that frame's start to the next frame's.
 *
 * Points are fractions of the picture (0–1 across, 0–1 down), not pixels, so
 * a mark lands on the same spot at any size and inside any letterboxing.
 *
 * Kept in the film's note beside its scenes and labels (see `scenes.ts`).
 * Everything here is pure.
 */

export type MarkShape = 'arrow' | 'circle' | 'box' | 'line' | 'free' | 'text';

export const MARK_SHAPES: readonly MarkShape[] = [
	'arrow',
	'circle',
	'box',
	'line',
	'free',
	'text',
];

export interface FrameMark {
	/** Identity, like a scene's: letters, digits, - or _. */
	id: string;
	/** Seconds, to the millisecond. Shown from here… */
	start: number;
	/** …up to, not including, here. */
	end: number;
	/** Draw order: a higher layer is drawn on top, like V2 over V1. */
	layer: number;
	shape: MarkShape;
	/**
	 * Fractions of the picture. Arrow and line: tail, head. Circle and box:
	 * two opposite corners. Text: where it starts. Freehand: every point.
	 */
	points: [number, number][];
	/** Only for text. */
	text?: string;
	/** A CSS colour, one of `MARK_COLORS` when drawn in the viewer. */
	color: string;
}

/** The palette the viewer offers: strong, and readable over any picture. */
export const MARK_COLORS: readonly { name: string; value: string }[] = [
	{ name: 'Red', value: '#ff4d5e' },
	{ name: 'Yellow', value: '#ffd43b' },
	{ name: 'White', value: '#ffffff' },
	{ name: 'Cyan', value: '#3dd9ff' },
	{ name: 'Green', value: '#5ce07e' },
];

/** Stored times are kept to the millisecond, so closer than this is the same. */
const SAME_TIME = 0.0005;

const roundTime = (t: number): number => Math.round(t * 1000) / 1000;
/** Points to a tenth of a pixel on a 4K frame; enough, and short in the note. */
const roundPoint = (v: number): number =>
	Math.round(Math.min(1, Math.max(0, v)) * 100000) / 100000;

/** Every mark shown at `time`, bottom layer first. */
export function marksAt(marks: readonly FrameMark[], time: number): FrameMark[] {
	return marks
		.filter((m) => time >= m.start - SAME_TIME && time < m.end - SAME_TIME)
		.sort((a, b) => a.layer - b.layer);
}

/** A mark's times and points as the note stores them. */
export function tidyMark(mark: FrameMark): FrameMark {
	const start = roundTime(Math.max(0, mark.start));
	// Never empty: a mark that shows for no time at all would be lost.
	const end = Math.max(roundTime(mark.end), roundTime(start + 0.001));
	const tidy: FrameMark = {
		id: mark.id,
		start,
		end,
		layer: mark.layer,
		shape: mark.shape,
		points: mark.points.map(([x, y]) => [roundPoint(x), roundPoint(y)]),
		color: mark.color,
	};
	if (mark.shape === 'text') tidy.text = mark.text ?? '';
	return tidy;
}

/** Adds a mark on top of every other: one layer above the highest. */
export function addMark(marks: readonly FrameMark[], mark: FrameMark): FrameMark[] {
	const top = marks.reduce((max, m) => Math.max(max, m.layer), 0);
	return [...marks, tidyMark({ ...mark, layer: top + 1 })];
}

/** Replaces the mark with `id`; unknown ids change nothing. */
export function updateMark(
	marks: readonly FrameMark[],
	id: string,
	change: (mark: FrameMark) => FrameMark,
): FrameMark[] {
	return marks.map((m) => (m.id === id ? tidyMark(change(m)) : m));
}

export function deleteMark(marks: readonly FrameMark[], id: string): FrameMark[] {
	return marks.filter((m) => m.id !== id);
}

/** A short id no mark uses yet; random for the reason scene ids are. */
export function newMarkId(
	marks: readonly FrameMark[],
	random: () => number = Math.random,
): string {
	const taken = new Set(marks.map((m) => m.id));
	for (;;) {
		const id = Math.floor(random() * 36 ** 6)
			.toString(36)
			.padStart(6, '0');
		if (!taken.has(id)) return id;
	}
}

// --- the note ----------------------------------------------------------------

const MARK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How many points each shape needs; freehand takes any number from two. */
function pointsFit(shape: MarkShape, count: number): boolean {
	if (shape === 'text') return count === 1;
	if (shape === 'free') return count >= 2;
	return count === 2;
}

/**
 * Reads the `marks` list of a note's block.
 *
 * Strict for the same reason `parseBlock` is: a mark that does not read is an
 * error, because skipping it and writing the rest back would delete it.
 */
export function parseMarks(raw: unknown): { marks: FrameMark[] } | { error: string } {
	if (!Array.isArray(raw)) return { error: '"marks" should be a list.' };
	const isTime = (v: unknown): v is number =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0;
	const isPoint = (v: unknown): v is [number, number] =>
		Array.isArray(v) &&
		v.length === 2 &&
		v.every((n) => typeof n === 'number' && Number.isFinite(n));
	const marks: FrameMark[] = [];
	const ids = new Set<string>();
	for (const [i, entry] of raw.entries()) {
		const { id, start, end, layer = 0, shape, points, text, color } = (entry ??
			{}) as Record<string, unknown>;
		if (
			typeof id !== 'string' ||
			!MARK_ID.test(id) ||
			!isTime(start) ||
			!isTime(end) ||
			end <= start ||
			typeof layer !== 'number' ||
			!Number.isFinite(layer) ||
			typeof shape !== 'string' ||
			!(MARK_SHAPES as readonly string[]).includes(shape) ||
			!Array.isArray(points) ||
			!points.every(isPoint) ||
			!pointsFit(shape as MarkShape, points.length) ||
			(text !== undefined && typeof text !== 'string') ||
			typeof color !== 'string'
		)
			return {
				error: `Mark ${i + 1} should look like {"id": "a1b2c3", "start": 12.5, "end": 14, "layer": 1, "shape": "arrow", "points": [[0.2, 0.3], [0.5, 0.5]], "color": "#ff4d5e"}: times in seconds with end after start, a shape of ${MARK_SHAPES.join(', ')}, and points as fractions of the picture.`,
			};
		if (ids.has(id)) return { error: `Two marks have the id "${id}"; each needs its own.` };
		ids.add(id);
		const mark: FrameMark = {
			id,
			start,
			end,
			layer,
			shape: shape as MarkShape,
			points: points.map(([x, y]) => [x, y]),
			color,
		};
		if (shape === 'text') mark.text = typeof text === 'string' ? text : '';
		marks.push(mark);
	}
	return { marks: marks.sort((a, b) => a.start - b.start || a.layer - b.layer) };
}

/** A mark as one line of the note, keys in a fixed order. */
export function markJson(mark: FrameMark): object {
	const { id, start, end, layer, shape, points, text, color } = mark;
	return shape === 'text'
		? { id, start, end, layer, shape, color, text: text ?? '', points }
		: { id, start, end, layer, shape, color, points };
}
