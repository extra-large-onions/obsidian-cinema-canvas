import { setTooltip } from 'obsidian';
import {
	FrameMark,
	MARK_COLORS,
	addMark,
	deleteMark,
	marksAt,
	newMarkId,
	tidyMark,
	updateMark,
} from '../media/marks';
import { shotAt } from '../media/scenes';
import { Rect, Shot } from '../types';
import { formatTimecode } from '../utils/timecode';
import { drawMark, simplify, textSize } from './mark-draw';
import {
	MarkTool,
	MarkToolbar,
	RangePreset,
	SHAPE_NAMES,
	toolForKey,
} from './mark-toolbar';

/** Edits leave as functions of the marks, so the owner applies them to disk. */
export type MarkChange = (marks: FrameMark[]) => FrameMark[];

export interface MarkLayerOptions {
	onEdit: (change: MarkChange) => void;
	onDrawingChange: (drawing: boolean) => void;
}

/** Until playback measures it, a film is taken to run at 24 frames a second. */
const DEFAULT_FRAME = 1 / 24;
/** Undo steps kept in memory. */
const HISTORY = 50;
/** Smaller than this, in pixels, a drag is a click, not a shape. */
const MIN_DRAG = 5;

type Pt = [number, number];

type Gesture =
	| { kind: 'draw'; mark: FrameMark }
	| { kind: 'move'; id: string; from: Pt; original: FrameMark; moved: boolean }
	| { kind: 'handle'; id: string; index: number; original: FrameMark };

/**
 * Frame marks over a playing video: shows each mark while the film is inside
 * its time range, and in draw mode lets you draw, select, move and delete
 * them.
 *
 * Built like `FramingGuides`: the owner places it onto the picture itself, so
 * letterboxing never shifts a mark. Times come from
 * `requestVideoFrameCallback`, which reports the frame actually shown, so a
 * mark for one frame lands on that frame and not on its neighbour.
 */
export class MarkLayer {
	private readonly svg: SVGSVGElement;
	private readonly track: HTMLElement;
	private readonly toolbar: MarkToolbar;
	private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
	private marks: FrameMark[] = [];
	private video: HTMLVideoElement | null = null;
	private shots: readonly Shot[] | null = null;
	private detach: (() => void) | null = null;
	/** Start of the frame showing, in seconds. */
	private time = 0;
	private frame = DEFAULT_FRAME;
	/** False while `frame` is still the guess. */
	private measured = false;
	private lastFrame: { mediaTime: number; presented: number } | null = null;

	private drawing = false;
	private tool: MarkTool = 'arrow';
	private color: string = MARK_COLORS[0]?.value ?? '#ff4d5e';
	private range: RangePreset = 'frame';
	private selected: string | null = null;
	private gesture: Gesture | null = null;
	private textInput: HTMLInputElement | null = null;
	private readonly past: FrameMark[][] = [];
	private readonly future: FrameMark[][] = [];

	constructor(
		private readonly parent: HTMLElement,
		private readonly options: MarkLayerOptions,
	) {
		this.svg = parent.createSvg('svg', { cls: ['cine-marks', 'is-hidden'] });
		this.track = parent.createDiv({ cls: 'cine-mark-track' });
		this.track.hide();
		this.toolbar = new MarkToolbar(parent, {
			onTool: (tool) => this.setTool(tool),
			onColor: (color) => this.setColor(color),
			onRange: (range) => this.setRange(range),
			onStartHere: () => this.setStartHere(),
			onEndHere: () => this.setEndHere(),
			onDelete: () => this.deleteSelected(),
			onUndo: () => this.undo(),
			onRedo: () => this.redo(),
			onDone: () => this.setDrawing(false),
		});

		this.svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		this.svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
		this.svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
		this.svg.addEventListener('pointercancel', () => this.cancelGesture());
		this.svg.addEventListener('dblclick', (e) => this.onDoubleClick(e));
		// The backdrop closes the viewer on click; a click that drew must not.
		this.svg.addEventListener('click', (e) => e.stopPropagation());
		this.track.addEventListener('click', (e) => e.stopPropagation());
		this.track.addEventListener('pointerdown', (e) => this.onTrackDown(e));
	}

	get isDrawing(): boolean {
		return this.drawing;
	}

	/** The video marks are shown on, with its cuts if known; null for none. */
	attach(video: HTMLVideoElement | null, shots: readonly Shot[] | null): void {
		this.detach?.();
		this.detach = null;
		this.video = video;
		this.shots = shots;
		this.time = 0;
		this.frame = DEFAULT_FRAME;
		this.measured = false;
		this.lastFrame = null;
		this.selected = null;
		this.past.length = 0;
		this.future.length = 0;
		this.cancelGesture();
		if (!video) {
			this.marks = [];
			this.setDrawing(false);
			this.render();
			return;
		}

		let callback = 0;
		let alive = true;
		const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
			if (!alive) return;
			this.onFrame(meta.mediaTime, meta.presentedFrames);
			callback = video.requestVideoFrameCallback(onFrame);
		};
		const hasFrames = typeof video.requestVideoFrameCallback === 'function';
		if (hasFrames) callback = video.requestVideoFrameCallback(onFrame);
		// Without frame callbacks, times are whatever the element reports.
		const onTime = () => {
			if (!hasFrames) this.setTime(video.currentTime);
			else this.renderTrack();
		};
		const onMeta = () => this.renderTrack();
		video.addEventListener('timeupdate', onTime);
		video.addEventListener('seeked', onTime);
		video.addEventListener('loadedmetadata', onMeta);
		this.detach = () => {
			alive = false;
			if (hasFrames) video.cancelVideoFrameCallback(callback);
			video.removeEventListener('timeupdate', onTime);
			video.removeEventListener('seeked', onTime);
			video.removeEventListener('loadedmetadata', onMeta);
		};
		this.render();
	}

	/** The marks as stored; kept as they are mid-gesture. */
	setMarks(marks: readonly FrameMark[]): void {
		this.marks = [...marks];
		if (this.selected && !this.marks.some((m) => m.id === this.selected))
			this.selected = null;
		this.render();
	}

	/** Puts the layer on `rect`, in the parent's own pixels. */
	place(rect: Rect): void {
		this.rect = rect;
		this.svg.style.left = `${rect.x}px`;
		this.svg.style.top = `${rect.y}px`;
		this.svg.style.width = `${rect.w}px`;
		this.svg.style.height = `${rect.h}px`;
		this.svg.setAttr('viewBox', `0 0 ${Math.max(1, rect.w)} ${Math.max(1, rect.h)}`);
		this.track.style.left = `${rect.x}px`;
		this.track.style.width = `${rect.w}px`;
		this.track.style.top = `${rect.y + rect.h + 8}px`;
		this.render();
	}

	setDrawing(on: boolean): void {
		if (on && !this.video) return;
		if (on === this.drawing) return;
		this.drawing = on;
		this.commitText();
		this.cancelGesture();
		if (on) this.video?.pause();
		else this.selected = null;
		this.options.onDrawingChange(on);
		this.render();
	}

	destroy(): void {
		this.detach?.();
		this.textInput?.remove();
		this.svg.remove();
		this.track.remove();
		this.toolbar.el.remove();
	}

	/**
	 * Keys while the viewer is open. Returns true when the key was used.
	 *
	 * Only D works outside draw mode; inside it the layer takes the keys it
	 * needs before the viewer does, so the arrows step frames rather than
	 * files.
	 */
	handleKey(e: KeyboardEvent): boolean {
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
		if (!this.drawing) {
			if (plain && e.key === 'd' && this.video) {
				this.setDrawing(true);
				return true;
			}
			return false;
		}
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === 'z') {
			if (e.shiftKey) this.redo();
			else this.undo();
			return true;
		}
		if (mod && e.key.toLowerCase() === 'y') {
			this.redo();
			return true;
		}
		if (!plain) return false;
		switch (e.key) {
			case 'd':
				this.setDrawing(false);
				return true;
			case 'Escape':
				if (this.gesture) this.cancelGesture();
				else if (this.selected) this.select(null);
				else this.setDrawing(false);
				return true;
			case 'Delete':
			case 'Backspace':
				this.deleteSelected();
				return true;
			case 'ArrowLeft':
			case ',':
				this.stepFrames(e.shiftKey ? -Math.round(1 / this.frame) : -1);
				return true;
			case 'ArrowRight':
			case '.':
				this.stepFrames(e.shiftKey ? Math.round(1 / this.frame) : 1);
				return true;
			case ' ':
				if (this.video?.paused) void this.video.play();
				else this.video?.pause();
				return true;
		}
		const tool = toolForKey(e.key);
		if (tool) {
			this.setTool(tool);
			return true;
		}
		return false;
	}

	// --- time -------------------------------------------------------------------

	private onFrame(mediaTime: number, presented: number): void {
		const last = this.lastFrame;
		// Two frames shown one after the other, while playing, are one frame
		// apart; the shortest such gap seen is the film's frame length.
		if (last && presented === last.presented + 1 && this.video && !this.video.paused) {
			const gap = mediaTime - last.mediaTime;
			if (gap > 1 / 121 && gap < 1 / 10) {
				this.frame = this.measured ? Math.min(this.frame, gap) : gap;
				this.measured = true;
			}
		}
		this.lastFrame = { mediaTime, presented };
		this.setTime(mediaTime);
	}

	private setTime(time: number): void {
		if (!Number.isFinite(time)) return;
		const changed = Math.abs(time - this.time) > 0.0001;
		this.time = time;
		if (changed) this.render();
		else this.renderTrack();
	}

	private stepFrames(count: number): void {
		const video = this.video;
		if (!video) return;
		video.pause();
		// A tenth of a frame in, so rounding never lands on the frame before.
		const target = this.time + count * this.frame + this.frame * 0.1;
		video.currentTime = Math.min(Math.max(0, target), video.duration || target);
	}

	/** The range a new mark drawn now gets. */
	private rangeFrom(start: number, preset: RangePreset): [number, number] {
		const duration = this.video?.duration;
		const filmEnd = Number.isFinite(duration) && duration ? duration : Infinity;
		const cut = this.cutAt(start);
		let range: [number, number];
		switch (preset) {
			case 'frame':
				range = [start, start + this.frame];
				break;
			case 'second':
				range = [start, start + 1];
				break;
			case 'seconds':
				range = [start, start + 3];
				break;
			case 'rest':
				range = [start, cut ? cut.end : filmEnd];
				break;
			case 'cut':
				range = cut ? [cut.start, cut.end] : [0, filmEnd];
				break;
		}
		if (!Number.isFinite(range[1])) range[1] = start + 3;
		range[1] = Math.min(range[1], filmEnd);
		if (range[1] <= range[0]) range[1] = range[0] + this.frame;
		return range;
	}

	private cutAt(time: number): Shot | null {
		if (!this.shots) return null;
		// A little in, so the first frame of a cut belongs to it.
		return this.shots[shotAt(this.shots, time + 0.001)] ?? null;
	}

	// --- editing ----------------------------------------------------------------

	private edit(change: MarkChange): void {
		this.past.push(this.marks);
		if (this.past.length > HISTORY) this.past.shift();
		this.future.length = 0;
		this.marks = change(this.marks);
		this.options.onEdit(change);
		this.render();
	}

	private undo(): void {
		const previous = this.past.pop();
		if (!previous) return;
		this.future.push(this.marks);
		this.restore(previous);
	}

	private redo(): void {
		const next = this.future.pop();
		if (!next) return;
		this.past.push(this.marks);
		this.restore(next);
	}

	/**
	 * Puts every mark back as it was in `state`, one mark at a time, so a mark
	 * written by hand in the note meanwhile is not thrown away.
	 */
	private restore(state: FrameMark[]): void {
		const current = this.marks;
		const change: MarkChange = (marks) => {
			const touched = new Set([...current, ...state].map((m) => m.id));
			const wanted = new Map(state.map((m) => [m.id, m]));
			const kept = marks.filter((m) => !touched.has(m.id));
			return [...kept, ...wanted.values()];
		};
		this.marks = change(this.marks);
		if (this.selected && !this.marks.some((m) => m.id === this.selected))
			this.selected = null;
		this.options.onEdit(change);
		this.render();
	}

	private select(id: string | null): void {
		this.selected = id;
		this.render();
	}

	private selectedMark(): FrameMark | null {
		return this.marks.find((m) => m.id === this.selected) ?? null;
	}

	private setTool(tool: MarkTool): void {
		this.commitText();
		this.tool = tool;
		this.render();
	}

	private setColor(color: string): void {
		this.color = color;
		const id = this.selected;
		if (id) this.edit((marks) => updateMark(marks, id, (m) => ({ ...m, color })));
		else this.render();
	}

	private setRange(range: RangePreset): void {
		this.range = range;
		const mark = this.selectedMark();
		if (!mark) return this.render();
		const [start, end] = this.rangeFrom(mark.start, range);
		this.edit((marks) => updateMark(marks, mark.id, (m) => ({ ...m, start, end })));
	}

	private setStartHere(): void {
		const mark = this.selectedMark();
		if (!mark) return;
		const start = this.time;
		const end = mark.end > start ? mark.end : start + this.frame;
		this.edit((marks) => updateMark(marks, mark.id, (m) => ({ ...m, start, end })));
	}

	private setEndHere(): void {
		const mark = this.selectedMark();
		if (!mark) return;
		// Through the end of the frame showing, so it is still included.
		const end = this.time + this.frame;
		const start = mark.start < end ? mark.start : this.time;
		this.edit((marks) => updateMark(marks, mark.id, (m) => ({ ...m, start, end })));
	}

	private deleteSelected(): void {
		const id = this.selected;
		if (!id) return;
		this.selected = null;
		this.edit((marks) => deleteMark(marks, id));
	}

	/** Adds a mark drawn now, and selects it. */
	private create(mark: Omit<FrameMark, 'id' | 'start' | 'end' | 'layer'>): void {
		const [start, end] = this.rangeFrom(this.time, this.range);
		const id = newMarkId(this.marks);
		const full: FrameMark = { ...mark, id, start, end, layer: 0 };
		this.selected = id;
		this.edit((marks) => addMark(marks, full));
	}

	// --- pointer ----------------------------------------------------------------

	private toFraction(e: PointerEvent | MouseEvent): Pt {
		const box = this.svg.getBoundingClientRect();
		return [
			Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width))),
			Math.min(1, Math.max(0, (e.clientY - box.top) / Math.max(1, box.height))),
		];
	}

	private pixelsBetween(a: Pt, b: Pt): number {
		return Math.hypot((a[0] - b[0]) * this.rect.w, (a[1] - b[1]) * this.rect.h);
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.drawing || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.commitText();
		this.video?.pause();
		const p = this.toFraction(e);
		const target = e.target instanceof Element ? e.target : null;

		const handle = target?.closest('[data-handle]');
		const handleIndex = Number(handle?.getAttribute('data-handle'));
		const selected = this.selectedMark();
		if (handle && selected && Number.isInteger(handleIndex)) {
			this.gesture = { kind: 'handle', id: selected.id, index: handleIndex, original: selected };
		} else {
			const id = target?.closest('[data-id]')?.getAttribute('data-id');
			const hit = id ? this.marks.find((m) => m.id === id) : undefined;
			if (hit) {
				this.selected = hit.id;
				this.gesture = { kind: 'move', id: hit.id, from: p, original: hit, moved: false };
			} else if (this.tool === 'select') {
				this.select(null);
				return;
			} else if (this.tool === 'text') {
				this.openText(p, null);
				return;
			} else {
				this.selected = null;
				const shape = this.tool;
				this.gesture = {
					kind: 'draw',
					mark: {
						id: '',
						start: 0,
						end: 0,
						layer: Infinity,
						shape,
						points: shape === 'free' ? [p] : [p, p],
						color: this.color,
					},
				};
			}
		}
		this.svg.setPointerCapture(e.pointerId);
		this.render();
	}

	private onPointerMove(e: PointerEvent): void {
		const g = this.gesture;
		if (!g) return;
		const p = this.toFraction(e);
		if (g.kind === 'draw') {
			const pts = g.mark.points;
			if (g.mark.shape === 'free') {
				const last = pts[pts.length - 1];
				if (!last || this.pixelsBetween(last, p) >= 2) pts.push(p);
			} else {
				pts[1] = e.shiftKey ? this.snap(pts[0]!, p, g.mark.shape) : p;
			}
		} else if (g.kind === 'move') {
			const dx = p[0] - g.from[0];
			const dy = p[1] - g.from[1];
			if (!g.moved && this.pixelsBetween(g.from, p) < MIN_DRAG / 2) return;
			g.moved = true;
			this.preview(g.id, {
				...g.original,
				points: g.original.points.map(([x, y]) => [x + dx, y + dy]),
			});
			return;
		} else {
			const points = g.original.points.map((q, i): Pt => (i === g.index ? p : [q[0], q[1]]));
			this.preview(g.id, { ...g.original, points });
			return;
		}
		this.render();
	}

	private onPointerUp(e: PointerEvent): void {
		const g = this.gesture;
		if (!g) return;
		this.gesture = null;
		if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
		if (g.kind === 'draw') {
			const { shape, color } = g.mark;
			let points = g.mark.points;
			if (shape === 'free') {
				const px = points.map(([x, y]): Pt => [x * this.rect.w, y * this.rect.h]);
				points = simplify(px, 1.2).map(([x, y]): Pt => [
					x / Math.max(1, this.rect.w),
					y / Math.max(1, this.rect.h),
				]);
				if (points.length < 2) return this.render();
			} else if (this.pixelsBetween(points[0]!, points[1]!) < MIN_DRAG) {
				return this.render();
			}
			this.create({ shape, color, points });
			return;
		}
		const shown = this.marks.find((m) => m.id === g.id);
		if (g.kind === 'move' && !g.moved) return this.render();
		// `preview` changed the mark in place; record it as one edit.
		const final = shown ? tidyMark(shown) : null;
		this.marks = this.marks.map((m) => (m.id === g.id ? g.original : m));
		if (final) this.edit((marks) => updateMark(marks, g.id, () => final));
	}

	private cancelGesture(): void {
		const g = this.gesture;
		this.gesture = null;
		if (g && g.kind !== 'draw')
			this.marks = this.marks.map((m) => (m.id === g.id ? g.original : m));
		this.render();
	}

	private onDoubleClick(e: MouseEvent): void {
		if (!this.drawing) return;
		e.stopPropagation();
		const id = (e.target instanceof Element ? e.target : null)
			?.closest('[data-id]')
			?.getAttribute('data-id');
		const mark = this.marks.find((m) => m.id === id);
		if (mark?.shape === 'text') this.openText(mark.points[0] ?? [0, 0], mark);
	}

	/** Shows `mark` changed, without saving; the gesture's end saves it. */
	private preview(id: string, mark: FrameMark): void {
		this.marks = this.marks.map((m) => (m.id === id ? mark : m));
		this.render();
	}

	/**
	 * Shift while drawing: an arrow or line keeps to the nearest 45°, a circle
	 * or box to a square.
	 */
	private snap(a: Pt, b: Pt, shape: FrameMark['shape']): Pt {
		const { w, h } = this.rect;
		const dx = (b[0] - a[0]) * w;
		const dy = (b[1] - a[1]) * h;
		if (shape === 'circle' || shape === 'box') {
			const side = Math.max(Math.abs(dx), Math.abs(dy));
			return [a[0] + (Math.sign(dx) * side) / w, a[1] + (Math.sign(dy) * side) / h];
		}
		const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
		const length = Math.hypot(dx, dy);
		return [a[0] + (Math.cos(angle) * length) / w, a[1] + (Math.sin(angle) * length) / h];
	}

	// --- text -------------------------------------------------------------------

	/** An input over the picture, for a new label at `at` or for `mark`'s. */
	private openText(at: Pt, mark: FrameMark | null): void {
		this.commitText();
		const input = this.parent.createEl('input', {
			cls: 'cine-mark-input',
			attr: { type: 'text', placeholder: 'Label', spellcheck: 'false' },
		});
		const size = textSize(this.rect);
		input.style.left = `${this.rect.x + at[0] * this.rect.w}px`;
		input.style.top = `${this.rect.y + at[1] * this.rect.h}px`;
		input.style.fontSize = `${size}px`;
		input.style.setProperty('--mark-color', mark?.color ?? this.color);
		input.value = mark?.text ?? '';
		input.dataset.at = JSON.stringify(at);
		if (mark) input.dataset.id = mark.id;
		for (const type of ['click', 'pointerdown', 'dblclick'] as const)
			input.addEventListener(type, (e) => e.stopPropagation());
		input.addEventListener('keydown', (e) => {
			// Typing must not reach the viewer's keys (G, C, arrows…).
			e.stopPropagation();
			if (e.key === 'Enter') this.commitText();
			else if (e.key === 'Escape') this.closeText();
		});
		input.addEventListener('blur', () => this.commitText());
		this.textInput = input;
		this.render();
		input.focus();
		input.select();
	}

	private closeText(): HTMLInputElement | null {
		const input = this.textInput;
		this.textInput = null;
		input?.remove();
		// Back to the viewer, so its keys keep working.
		this.parent.focus();
		return input;
	}

	private commitText(): void {
		const input = this.closeText();
		if (!input) return;
		const text = input.value.trim();
		const id = input.dataset.id;
		if (id) {
			if (text) this.edit((marks) => updateMark(marks, id, (m) => ({ ...m, text })));
			else {
				this.selected = id;
				this.deleteSelected();
			}
			return;
		}
		if (!text) return this.render();
		const at = JSON.parse(input.dataset.at ?? '[0,0]') as Pt;
		this.create({ shape: 'text', color: this.color, points: [at], text });
	}

	// --- drawing ----------------------------------------------------------------

	private render(): void {
		const hasVideo = this.video !== null;
		this.svg.toggleClass('is-hidden', !hasVideo || this.rect.w <= 0);
		this.svg.toggleClass('is-drawing', this.drawing);
		this.svg.toggleClass('is-selecting', this.tool === 'select');
		this.toolbar.el.toggle(this.drawing);
		this.toolbar.sync({
			tool: this.tool,
			color: this.color,
			range: this.range,
			selected: this.selectedMark(),
			frame: this.frame,
			canUndo: this.past.length > 0,
			canRedo: this.future.length > 0,
		});
		this.svg.empty();
		this.renderTrack();
		if (!hasVideo || this.rect.w <= 0) return;

		const size = { w: this.rect.w, h: this.rect.h };
		const editing = this.textInput?.dataset.id;
		const shown = marksAt(this.marks, this.time).filter((m) => m.id !== editing);
		const selected = this.selectedMark();
		for (const mark of shown) drawMark(this.svg, mark, size);
		// The selection stays in view, faint, while the film is outside its
		// range, so its start and end can still be moved to where it is now.
		if (selected && !shown.includes(selected) && selected.id !== editing)
			drawMark(this.svg, selected, size).addClass('is-ghost');
		const g = this.gesture;
		if (g?.kind === 'draw') drawMark(this.svg, g.mark, size).addClass('is-draft');

		if (this.drawing && selected && selected.id !== editing) {
			this.svg.querySelector(`[data-id="${selected.id}"]`)?.addClass('is-selected');
			if (selected.shape !== 'free' && selected.shape !== 'text')
				selected.points.forEach(([x, y], i) =>
					this.svg.createSvg('circle', {
						cls: 'cine-mark-handle',
						attr: {
							cx: String(x * size.w),
							cy: String(y * size.h),
							r: '6',
							'data-handle': String(i),
						},
					}),
				);
		}
	}

	/** Where marks are on the film, under the picture, with the playhead. */
	private renderTrack(): void {
		const video = this.video;
		const duration = video?.duration ?? 0;
		const show =
			video !== null &&
			Number.isFinite(duration) &&
			duration > 0 &&
			this.rect.w > 0 &&
			(this.drawing || this.marks.length > 0);
		this.track.toggle(show);
		if (!show) return;
		const key = `${this.rect.w}|${duration}|${this.selected}|${this.marks
			.map((m) => `${m.id}:${m.start}:${m.end}:${m.color}`)
			.join(',')}`;
		if (this.track.dataset.key !== key) {
			this.track.dataset.key = key;
			this.track.empty();
			for (const mark of this.marks) {
				const tick = this.track.createDiv({ cls: 'cine-mark-tick' });
				const left = (mark.start / duration) * 100;
				const width = ((mark.end - mark.start) / duration) * 100;
				tick.style.left = `${left}%`;
				tick.style.width = `${width}%`;
				tick.style.setProperty('--mark-color', mark.color);
				tick.dataset.id = mark.id;
				tick.toggleClass('is-selected', mark.id === this.selected);
				const what = mark.shape === 'text' && mark.text ? `“${mark.text}”` : SHAPE_NAMES[mark.shape];
				setTooltip(tick, `${what} at ${formatTimecode(mark.start)}`, { placement: 'top' });
			}
			this.track.createDiv({ cls: 'cine-mark-playhead' });
		}
		const head = this.track.querySelector<HTMLElement>('.cine-mark-playhead');
		if (head) head.style.left = `${(this.time / duration) * 100}%`;
	}

	/**
	 * Track clicks: on a mark, go to its first frame and select it; elsewhere,
	 * scrub to the spot and keep scrubbing while the button is held.
	 */
	private onTrackDown(e: PointerEvent): void {
		const video = this.video;
		if (!video || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const id = (e.target instanceof HTMLElement ? e.target : null)?.closest<HTMLElement>(
			'.cine-mark-tick',
		)?.dataset.id;
		const mark = this.marks.find((m) => m.id === id);
		if (mark) {
			video.pause();
			video.currentTime = mark.start + Math.min(this.frame * 0.1, (mark.end - mark.start) / 2);
			if (this.drawing) this.select(mark.id);
			return;
		}
		const seek = (ev: PointerEvent) => {
			const box = this.track.getBoundingClientRect();
			const at = Math.min(1, Math.max(0, (ev.clientX - box.left) / Math.max(1, box.width)));
			video.currentTime = at * video.duration;
		};
		video.pause();
		seek(e);
		this.track.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => seek(ev);
		const up = (ev: PointerEvent) => {
			this.track.releasePointerCapture(ev.pointerId);
			this.track.removeEventListener('pointermove', move);
			this.track.removeEventListener('pointerup', up);
		};
		this.track.addEventListener('pointermove', move);
		this.track.addEventListener('pointerup', up);
	}
}
