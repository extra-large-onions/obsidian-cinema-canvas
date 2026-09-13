import {
	BIN_SECONDS,
	LaneName,
	SoundAnalysis,
	SoundLanes,
} from '../media/sound-analysis';

/**
 * Drawing the sound lanes, shared by everything that shows them.
 *
 * The dedicated sound view draws them across a whole tab; the strip along the
 * bottom of the canvas draws the same four lanes an inch high. They have to
 * mean the same thing in both places — the same colours, the same opacity for a
 * lane that is only half on, the same idea of what "effects" is — so there is
 * one implementation and the callers pass their own row heights.
 */

export interface LaneSpec {
	name: LaneName;
	label: string;
	/** Theme variable, read at draw time so the lanes follow the theme. */
	color: string;
	fallback: string;
	hint: string;
}

export const LANES: readonly LaneSpec[] = [
	{
		name: 'dialogue',
		label: 'Dialogue',
		color: '--color-blue',
		fallback: '#3b82f6',
		hint: 'Someone is speaking. Silero VAD, judged every 32 ms.',
	},
	{
		name: 'music',
		label: 'Music',
		color: '--color-purple',
		fallback: '#a855f7',
		hint: 'Score, source music or singing. PANNs, judged every second over a two-second window.',
	},
	{
		name: 'effects',
		label: 'Effects',
		color: '--color-orange',
		fallback: '#f97316',
		hint: 'Anything audible that is neither dialogue nor music, backgrounds and room tone included, plus any effect PANNs is sure of underneath them.',
	},
	{
		name: 'silence',
		label: 'Silence',
		color: '--text-faint',
		fallback: '#8a8a8a',
		hint: 'Quieter than the silence threshold for at least half a second.',
	},
];

/** Row heights in CSS pixels: the loudness envelope, then one row per lane. */
export interface RowLayout {
	loudness: number;
	lane: number;
	gap: number;
}

export const OVERVIEW_ROWS: RowLayout = { loudness: 18, lane: 7, gap: 2 };
export const DETAIL_ROWS: RowLayout = { loudness: 44, lane: 16, gap: 3 };
/** The strip along the canvas: short enough to sit under the shot cards. */
export const STRIP_ROWS: RowLayout = { loudness: 22, lane: 9, gap: 2 };

/** The loudness envelope is drawn from this level up to 0 dBFS. */
export const LOUDNESS_FLOOR = -60;

/** Resolves a theme variable to a colour, usually through a per-view cache. */
export type ColorResolver = (variable: string, fallback: string) => string;

export function rowsHeight(layout: RowLayout): number {
	return (
		layout.loudness + LANES.length * layout.lane + LANES.length * layout.gap
	);
}

/** Device-pixel top and height of every row. */
export function rowTops(
	layout: RowLayout,
	ratio: number,
): Record<'loudness' | LaneName, { top: number; height: number }> {
	let top = 0;
	const next = (height: number): { top: number; height: number } => {
		const row = {
			top: Math.round(top * ratio),
			height: Math.round(height * ratio),
		};
		top += height + layout.gap;
		return row;
	};
	const loudness = next(layout.loudness);
	const dialogue = next(layout.lane);
	const music = next(layout.lane);
	const effects = next(layout.lane);
	const silence = next(layout.lane);
	return { loudness, dialogue, music, effects, silence };
}

export interface DrawLanesOptions {
	ctx: CanvasRenderingContext2D;
	/** Canvas size in device pixels. */
	w: number;
	h: number;
	/** The span to draw, in seconds. */
	from: number;
	to: number;
	layout: RowLayout;
	ratio: number;
	analysis: SoundAnalysis;
	lanes: SoundLanes;
	/** Clock labels along the top of the loudness row. */
	ticks: boolean;
	color: ColorResolver;
}

/**
 * Draws the loudness envelope and the four lanes over `[from, to)`.
 *
 * One device pixel column at a time. Where a column holds many bins — the
 * overview of a two-hour film puts ~30 in each — a lane is drawn with the
 * share of them that are on as its opacity, so a scattered lane reads as
 * lighter than a solid one instead of as the same solid bar.
 */
export function drawLanes(options: DrawLanesOptions): void {
	const { ctx, w, h, from, to, layout, ratio, analysis, lanes, color } =
		options;
	const rows = rowTops(layout, ratio);
	const background = color('--background-secondary', '#eee');
	ctx.fillStyle = background;
	ctx.fillRect(0, rows.loudness.top, w, rows.loudness.height);
	for (const lane of LANES) {
		const row = rows[lane.name];
		ctx.fillRect(0, row.top, w, row.height);
	}

	const bins = lanes.bins;
	const firstBin = from / BIN_SECONDS;
	const binsPerPixel = (to - from) / BIN_SECONDS / w;
	const loudnessTop = rows.loudness.top;
	const loudnessHeight = rows.loudness.height;

	ctx.beginPath();
	ctx.moveTo(0, loudnessTop + loudnessHeight);
	const counts = new Float32Array(LANES.length * w);
	for (let x = 0; x < w; x++) {
		const start = Math.floor(firstBin + x * binsPerPixel);
		const end = Math.max(
			start + 1,
			Math.floor(firstBin + (x + 1) * binsPerPixel),
		);
		let loudest = -100;
		const a = Math.max(0, start);
		const b = Math.min(bins, end);
		for (let i = a; i < b; i++) {
			loudest = Math.max(loudest, analysis.loudness[i] ?? -100);
			for (let l = 0; l < LANES.length; l++) {
				const lane = LANES[l];
				if (lane && lanes[lane.name][i])
					counts[l * w + x] = (counts[l * w + x] ?? 0) + 1;
			}
		}
		const span = Math.max(1, b - a);
		for (let l = 0; l < LANES.length; l++)
			counts[l * w + x] = (counts[l * w + x] ?? 0) / span;
		const level = Math.min(
			1,
			Math.max(0, (loudest - LOUDNESS_FLOOR) / -LOUDNESS_FLOOR),
		);
		ctx.lineTo(x, loudnessTop + loudnessHeight * (1 - level));
	}
	ctx.lineTo(w, loudnessTop + loudnessHeight);
	ctx.closePath();
	ctx.fillStyle = color('--text-muted', '#888');
	ctx.globalAlpha = 0.55;
	ctx.fill();
	ctx.globalAlpha = 1;

	LANES.forEach((lane, l) => {
		const row = rows[lane.name];
		ctx.fillStyle = color(lane.color, lane.fallback);
		// Runs of equal opacity are drawn as one rectangle.
		let runStart = 0;
		let runAlpha = 0;
		const flush = (end: number): void => {
			if (runAlpha <= 0 || end <= runStart) return;
			ctx.globalAlpha = runAlpha;
			ctx.fillRect(runStart, row.top, end - runStart, row.height);
		};
		for (let x = 0; x <= w; x++) {
			const share = x < w ? (counts[l * w + x] ?? 0) : 0;
			const alpha =
				share <= 0 ? 0 : Math.round((0.25 + 0.75 * share) * 10) / 10;
			if (alpha !== runAlpha) {
				flush(x);
				runStart = x;
				runAlpha = alpha;
			}
		}
		ctx.globalAlpha = 1;
	});

	if (options.ticks)
		drawTicks(ctx, w, from, to, rows.loudness.top, ratio, color);
	void h;
}

export function drawTicks(
	ctx: CanvasRenderingContext2D,
	w: number,
	from: number,
	to: number,
	top: number,
	ratio: number,
	color: ColorResolver,
): void {
	const span = to - from;
	const step =
		[1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => span / s <= 8) ??
		1200;
	ctx.fillStyle = color('--text-faint', '#999');
	ctx.font = `${10 * ratio}px ${color('--font-interface', 'sans-serif')}`;
	ctx.textBaseline = 'top';
	for (let t = Math.ceil(from / step) * step; t < to; t += step) {
		const x = ((t - from) / span) * w;
		ctx.globalAlpha = 0.5;
		ctx.fillRect(Math.round(x), top, Math.max(1, Math.round(ratio)), 4 * ratio);
		ctx.globalAlpha = 1;
		ctx.fillText(formatClock(t), x + 3 * ratio, top + 1 * ratio);
	}
}

export function drawLine(
	ctx: CanvasRenderingContext2D,
	x: number,
	h: number,
	ratio: number,
	color: string,
): void {
	const width = Math.max(1, Math.round(2 * ratio));
	ctx.fillStyle = color;
	ctx.fillRect(Math.round(x - width / 2), 0, width, h);
}

/**
 * A per-view cache of resolved theme colours.
 *
 * `getComputedStyle` is far too slow to call per lane per frame, and the values
 * only change when the theme does — which every view already hears about
 * through `css-change`, and answers by calling `clear`.
 */
export function createColorCache(el: HTMLElement): {
	get: ColorResolver;
	clear: () => void;
} {
	const colors = new Map<string, string>();
	return {
		get: (variable, fallback) => {
			const cached = colors.get(variable);
			if (cached) return cached;
			const value =
				getComputedStyle(el).getPropertyValue(variable).trim() ||
				fallback;
			colors.set(variable, value);
			return value;
		},
		clear: () => colors.clear(),
	};
}

/** `42.5s`, `4m 05s`, `1h 02m`. */
export function formatLength(seconds: number): string {
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) {
		const m = Math.floor(seconds / 60);
		return `${m}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
	}
	const h = Math.floor(seconds / 3600);
	return `${h}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

/** `1:05`, `1:02:05` — tick labels, whole seconds. */
export function formatClock(seconds: number): string {
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function megabytes(bytes: number): string {
	return `${Math.round(bytes / 1e6)} MB`;
}
