import { getIcon, setIcon, setTooltip } from 'obsidian';
import { FrameMark, MARK_COLORS, MarkShape } from '../media/marks';
import { formatTimecode } from '../utils/timecode';

export type MarkTool = 'select' | MarkShape;

/** How long a new mark shows, from the frame it was drawn on. */
export type RangePreset = 'frame' | 'second' | 'seconds' | 'rest' | 'cut';

export const RANGE_PRESETS: readonly { id: RangePreset; label: string }[] = [
	{ id: 'frame', label: 'This frame' },
	{ id: 'second', label: '1 second' },
	{ id: 'seconds', label: '3 seconds' },
	{ id: 'rest', label: 'To end of cut' },
	{ id: 'cut', label: 'Whole cut' },
];

const TOOLS: readonly { tool: MarkTool; icon: string[]; label: string; key: string }[] = [
	{ tool: 'select', icon: ['mouse-pointer-2', 'mouse-pointer'], label: 'Select', key: '1' },
	{ tool: 'arrow', icon: ['move-up-right', 'arrow-up-right'], label: 'Arrow', key: '2' },
	{ tool: 'circle', icon: ['circle'], label: 'Circle', key: '3' },
	{ tool: 'box', icon: ['square'], label: 'Box', key: '4' },
	{ tool: 'line', icon: ['minus'], label: 'Line', key: '5' },
	{ tool: 'free', icon: ['pencil'], label: 'Freehand', key: '6' },
	{ tool: 'text', icon: ['type'], label: 'Text', key: '7' },
];

export function toolForKey(key: string): MarkTool | null {
	return TOOLS.find((t) => t.key === key)?.tool ?? null;
}

export const SHAPE_NAMES: Record<MarkShape, string> = {
	arrow: 'Arrow',
	circle: 'Circle',
	box: 'Box',
	line: 'Line',
	free: 'Stroke',
	text: 'Text',
};

export interface ToolbarState {
	tool: MarkTool;
	color: string;
	range: RangePreset;
	selected: FrameMark | null;
	/** Length of one frame, in seconds. */
	frame: number;
	canUndo: boolean;
	canRedo: boolean;
}

export interface ToolbarHandlers {
	onTool: (tool: MarkTool) => void;
	onColor: (color: string) => void;
	onRange: (range: RangePreset) => void;
	onStartHere: () => void;
	onEndHere: () => void;
	onDelete: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onDone: () => void;
}

function icon(el: HTMLElement, names: string[]): void {
	setIcon(el, names.find((name) => getIcon(name)) ?? 'square');
}

/**
 * The strip above the picture while drawing: tools, colours, how long a new
 * mark shows, and what can be done to the selected one.
 */
export class MarkToolbar {
	readonly el: HTMLElement;
	private readonly toolButtons = new Map<MarkTool, HTMLButtonElement>();
	private readonly swatches = new Map<string, HTMLButtonElement>();
	private readonly range: HTMLSelectElement;
	private readonly selection: HTMLElement;
	private readonly selectionText: HTMLElement;
	private readonly undo: HTMLButtonElement;
	private readonly redo: HTMLButtonElement;

	constructor(parent: HTMLElement, handlers: ToolbarHandlers) {
		this.el = parent.createDiv({ cls: 'cine-mark-toolbar' });
		this.el.hide();
		// Nothing here may reach the backdrop, which closes the viewer.
		for (const type of ['click', 'pointerdown', 'dblclick'] as const)
			this.el.addEventListener(type, (e) => e.stopPropagation());

		const button = (
			group: HTMLElement,
			names: string[],
			label: string,
			onClick: () => void,
		): HTMLButtonElement => {
			const b = group.createEl('button', { cls: 'cine-mark-button' });
			icon(b, names);
			setTooltip(b, label, { placement: 'bottom' });
			b.addEventListener('click', onClick);
			return b;
		};

		const tools = this.el.createDiv({ cls: 'cine-mark-group' });
		for (const t of TOOLS)
			this.toolButtons.set(
				t.tool,
				button(tools, t.icon, `${t.label} (${t.key})`, () => handlers.onTool(t.tool)),
			);

		const colors = this.el.createDiv({ cls: 'cine-mark-group' });
		for (const c of MARK_COLORS) {
			const swatch = colors.createEl('button', { cls: 'cine-mark-swatch' });
			swatch.style.setProperty('--swatch', c.value);
			setTooltip(swatch, c.name, { placement: 'bottom' });
			swatch.addEventListener('click', () => handlers.onColor(c.value));
			this.swatches.set(c.value, swatch);
		}

		const timing = this.el.createDiv({ cls: 'cine-mark-group' });
		this.range = timing.createEl('select', { cls: 'cine-mark-range dropdown' });
		for (const preset of RANGE_PRESETS)
			this.range.createEl('option', { value: preset.id, text: preset.label });
		setTooltip(this.range, 'How long a new mark shows', { placement: 'bottom' });
		this.range.addEventListener('change', () => {
			handlers.onRange(this.range.value as RangePreset);
			// Back to the viewer, whose keys a focused list would swallow.
			this.range.blur();
			parent.focus();
		});

		this.selection = this.el.createDiv({ cls: 'cine-mark-group cine-mark-selection' });
		this.selectionText = this.selection.createDiv({ cls: 'cine-mark-selection-text' });
		button(this.selection, ['arrow-left-to-line', 'chevron-first'], 'Start on this frame', handlers.onStartHere);
		button(this.selection, ['arrow-right-to-line', 'chevron-last'], 'End after this frame', handlers.onEndHere);
		button(this.selection, ['trash-2', 'trash'], 'Delete (Delete)', handlers.onDelete);

		const history = this.el.createDiv({ cls: 'cine-mark-group' });
		this.undo = button(history, ['undo-2', 'undo'], 'Undo (Ctrl+Z)', handlers.onUndo);
		this.redo = button(history, ['redo-2', 'redo'], 'Redo (Ctrl+Shift+Z)', handlers.onRedo);
		const done = button(history, ['check'], 'Done (D or Esc)', handlers.onDone);
		done.addClass('is-done');
	}

	sync(state: ToolbarState): void {
		for (const [tool, b] of this.toolButtons) b.toggleClass('is-active', tool === state.tool);
		const shown = state.selected?.color ?? state.color;
		for (const [value, s] of this.swatches) s.toggleClass('is-active', value === shown);
		this.range.value = state.range;
		this.undo.disabled = !state.canUndo;
		this.redo.disabled = !state.canRedo;
		const mark = state.selected;
		this.selection.toggleClass('is-hidden', !mark);
		if (mark) {
			const what = mark.shape === 'text' && mark.text ? `“${mark.text}”` : SHAPE_NAMES[mark.shape];
			this.selectionText.setText(`${what} · ${describeRange(mark, state.frame)}`);
		}
	}
}

/** `1 frame at 0:12.4`, `6 frames from 0:12.4`, `0:12.4 – 0:15.4`. */
export function describeRange(mark: Pick<FrameMark, 'start' | 'end'>, frame: number): string {
	const length = mark.end - mark.start;
	const frames = Math.max(1, Math.round(length / frame));
	if (frames === 1) return `1 frame at ${formatTimecode(mark.start)}`;
	if (length < 1) return `${frames} frames from ${formatTimecode(mark.start)}`;
	return `${formatTimecode(mark.start)} – ${formatTimecode(mark.end)}`;
}
