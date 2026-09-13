import { setIcon, setTooltip } from 'obsidian';
import { DETECTOR_LABEL, ShotIndex } from '../media/shots';
import { MediaItem, Shot } from '../types';

/**
 * The controls that belong to a list of shots, wherever that list is shown.
 *
 * Both the strip along the canvas and the dedicated clip view display the same
 * cuts of the same clip, so they have to offer the same Find cuts button and
 * the same cutting sliders, behaving identically. They live here rather than
 * in either view, so there is one implementation to get right.
 */

/**
 * The cutting parameters, which live next to the shots rather than in settings.
 *
 * Every one of them re-cuts the clip instantly from cached candidates, so the
 * shots in front of you *are* the readout for the slider you are dragging.
 */
export interface ShotParams {
	/** TransNetV2 probability x100 a cut must reach, 5-95. */
	transnetThreshold: number;
	/** Seconds; a cut closer than this to the previous one is dropped. */
	minShotLength: number;
}

export type ShotParamKey = keyof ShotParams;

/** What the Find cuts button says when you hover it. */
export const DETECTOR_HINT =
	'TransNetV2 — about 80s per 6 minutes of video. A trained network, so camera movement and flashes do not read as cuts.';

/** One slider: what it sets, its range, and what it says when hovered. */
export interface RangeSpec<K extends string> {
	key: K;
	label: string;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	hint: string;
}

type ParamSpec = RangeSpec<ShotParamKey>;

const THRESHOLD_PARAM: ParamSpec = {
	key: 'transnetThreshold',
	label: 'Confidence',
	min: 5,
	max: 95,
	step: 5,
	format: (v) => `${Math.round(v)}%`,
	hint: 'How sure TransNetV2 has to be that a frame is a cut. 50 is what its authors use; the network is decisive, so this moves the count less than you would expect.',
};

const MIN_LENGTH_PARAM: ParamSpec = {
	key: 'minShotLength',
	label: 'Min shot',
	min: 0,
	max: 3,
	step: 0.1,
	format: (v) => `${v.toFixed(1)}s`,
	hint: 'A cut closer than this to the one before it is ignored, which is what stops a single dissolve becoming three shots.',
};

export interface RangeHost<K extends string> {
	/** Applies one immediately and persists it. */
	setParam: (key: K, value: number) => void;
	/**
	 * Called when a drag starts and ends.
	 *
	 * Each drag step re-cuts the clip, which fires a change event, which would
	 * rebuild the header the slider lives in and tear it out from under the
	 * pointer. The view uses this to suppress that one rebuild.
	 */
	hold: () => void;
	release: () => void;
}

export interface ParamHost extends RangeHost<ShotParamKey> {
	/** Current values, read fresh every render. */
	getParams: () => ShotParams;
}

/** The cutting sliders. */
export function renderParams(parent: HTMLElement, host: ParamHost): void {
	const params = host.getParams();
	const group = parent.createDiv({ cls: 'cine-params' });
	const note = 'The clip is re-cut instantly; nothing runs again.';
	renderRange(group, THRESHOLD_PARAM, params[THRESHOLD_PARAM.key], host, note);
	renderRange(group, MIN_LENGTH_PARAM, params[MIN_LENGTH_PARAM.key], host, note);
}

/**
 * One labelled slider with a live readout.
 *
 * @param note appended to the hint: what moving it costs.
 */
export function renderRange<K extends string>(
	parent: HTMLElement,
	spec: RangeSpec<K>,
	value: number,
	host: RangeHost<K>,
	note: string,
): void {
	const wrap = parent.createDiv({ cls: 'cine-param' });
	setTooltip(wrap, `${spec.label} — ${spec.hint} ${note}`, {
		placement: 'top',
	});
	wrap.createSpan({ cls: 'cine-param-label', text: spec.label });
	const input = wrap.createEl('input', {
		cls: 'cine-param-range',
		type: 'range',
	});
	input.min = String(spec.min);
	input.max = String(spec.max);
	input.step = String(spec.step);
	input.value = String(value);
	const readout = wrap.createSpan({
		cls: 'cine-param-value',
		text: spec.format(value),
	});

	input.addEventListener('pointerdown', host.hold);
	input.addEventListener('keydown', host.hold);
	input.addEventListener('pointerup', host.release);
	input.addEventListener('pointercancel', host.release);
	input.addEventListener('blur', host.release);
	input.addEventListener('input', () => {
		const next = Number(input.value);
		if (!Number.isFinite(next)) return;
		readout.setText(spec.format(next));
		host.setParam(spec.key, next);
	});
}

export interface DetectorHost {
	shots: ShotIndex;
	/** Start detection on this clip. */
	run: (item: MediaItem) => void;
}

/**
 * The Find cuts button.
 *
 * @param wide the prompt form, shown when the clip has no cuts at all and this
 * is the only thing to press.
 */
export function renderFindCuts(
	parent: HTMLElement,
	item: MediaItem,
	wide: boolean,
	host: DetectorHost,
): void {
	const group = parent.createDiv({ cls: 'cine-detectors' });
	const button = group.createEl('button', { cls: 'cine-detector' });
	if (wide) button.addClass('mod-cta');
	const icon = button.createSpan({ cls: 'cine-detector-icon' });
	setIcon(icon, 'sparkles');
	button.createSpan({
		text: wide ? `Find cuts · ${DETECTOR_LABEL}` : DETECTOR_LABEL,
	});
	setTooltip(button, DETECTOR_HINT, { placement: 'top' });
	button.addEventListener('click', () => host.run(item));
}

/** `Whiplash.mp4 · 26 shots · 14.2s avg · 0.4s shortest` */
export function summarize(item: MediaItem, shots: Shot[]): string {
	const stats = shotStats(shots);
	return [
		item.file.name,
		`${shots.length} shot${shots.length === 1 ? '' : 's'}`,
		`${stats.average.toFixed(1)}s avg`,
		`${stats.shortest.toFixed(1)}s shortest`,
		`${stats.longest.toFixed(1)}s longest`,
	].join('  ·  ');
}

export interface ShotStats {
	total: number;
	average: number;
	shortest: number;
	longest: number;
}

export function shotStats(shots: Shot[]): ShotStats {
	let total = 0;
	let shortest = Infinity;
	let longest = 0;
	for (const shot of shots) {
		const length = shot.end - shot.start;
		total += length;
		if (length < shortest) shortest = length;
		if (length > longest) longest = length;
	}
	return {
		total,
		average: shots.length > 0 ? total / shots.length : 0,
		shortest: Number.isFinite(shortest) ? shortest : 0,
		longest,
	};
}
