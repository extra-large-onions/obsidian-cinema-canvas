import { setIcon, setTooltip } from 'obsidian';
import {
	DETECTORS,
	DETECTOR_LABELS,
	Detector,
	ShotIndex,
} from '../media/shots';
import { MediaItem, Shot } from '../types';

/**
 * The controls that belong to a list of shots, wherever that list is shown.
 *
 * Both the strip along the canvas and the dedicated clip view display the same
 * cuts of the same clip, so they have to offer the same two detector buttons
 * and the same cutting sliders, behaving identically. They live here rather
 * than in either view, so there is one implementation to get right.
 */

/**
 * The cutting parameters, which live next to the shots rather than in settings.
 *
 * Every one of them re-cuts the clip instantly from cached candidates, so the
 * shots in front of you *are* the readout for the slider you are dragging.
 */
export interface ShotParams {
	/** scdet score a cut must reach, 1-20. */
	shotThreshold: number;
	/** TransNetV2 probability x100 a cut must reach, 5-95. */
	transnetThreshold: number;
	/** Seconds; a cut closer than this to the previous one is dropped. */
	minShotLength: number;
}

export type ShotParamKey = keyof ShotParams;

/** What each detector button says when you hover it. */
export const DETECTOR_HINTS: Record<Detector, string> = {
	ffmpeg: 'ffmpeg scdet — about 6s per 6 minutes of video. Fast, and fooled by handheld camera movement.',
	transnet:
		'TransNetV2 — about 80s per 6 minutes of video. A trained network: slower, and far fewer false cuts.',
};

export const DETECTOR_ICONS: Record<Detector, string> = {
	ffmpeg: 'scissors',
	transnet: 'sparkles',
};

interface ParamSpec {
	key: ShotParamKey;
	label: string;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	hint: string;
}

const THRESHOLD_PARAMS: Record<Detector, ParamSpec> = {
	ffmpeg: {
		key: 'shotThreshold',
		label: 'Sensitivity',
		min: 1,
		max: 20,
		step: 0.5,
		format: (v) => v.toFixed(1),
		hint: 'How far a frame must differ from the one before it to count as a cut. Lower finds more cuts, and more false ones on whip pans and flashes.',
	},
	transnet: {
		key: 'transnetThreshold',
		label: 'Confidence',
		min: 5,
		max: 95,
		step: 5,
		format: (v) => `${Math.round(v)}%`,
		hint: 'How sure TransNetV2 has to be that a frame is a cut. 50 is what its authors use; the network is decisive, so this moves the count less than you would expect.',
	},
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

export interface ParamHost {
	/** Current values, read fresh every render. */
	getParams: () => ShotParams;
	/** Applies one immediately and persists it. */
	setParam: (key: ShotParamKey, value: number) => void;
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

/**
 * The cutting sliders.
 *
 * Only the threshold of the detector currently showing is offered — the other
 * one would change a list that is not on screen, which is a good way to lose
 * ten minutes wondering why nothing moved.
 */
export function renderParams(
	parent: HTMLElement,
	detector: Detector | null,
	host: ParamHost,
): void {
	const params = host.getParams();
	const group = parent.createDiv({ cls: 'cine-params' });
	const threshold = THRESHOLD_PARAMS[detector ?? 'ffmpeg'];
	renderParam(group, threshold, params[threshold.key], host);
	renderParam(group, MIN_LENGTH_PARAM, params[MIN_LENGTH_PARAM.key], host);
}

function renderParam(
	parent: HTMLElement,
	spec: ParamSpec,
	value: number,
	host: ParamHost,
): void {
	const wrap = parent.createDiv({ cls: 'cine-param' });
	setTooltip(
		wrap,
		`${spec.label} — ${spec.hint} The clip is re-cut instantly; nothing runs again.`,
		{ placement: 'top' },
	);
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
	/** The detector has not run on this clip yet: start it. */
	run: (item: MediaItem, detector: Detector) => void;
	/** It has run: show its cuts instead of the other one's. */
	show: (item: MediaItem, detector: Detector) => void;
}

/**
 * The pair of detector buttons.
 *
 * They are both a switch and a run button: a detector that has already run on
 * this clip swaps in instantly, one that has not is started. That is the same
 * gesture either way, so the button does not have to say which it will be.
 *
 * @param wide the prompt form, shown when the clip has no cuts at all and the
 * buttons are the only thing to press.
 */
export function renderDetectorButtons(
	parent: HTMLElement,
	item: MediaItem,
	current: Detector | null,
	wide: boolean,
	host: DetectorHost,
): void {
	const group = parent.createDiv({ cls: 'cine-detectors' });
	for (const detector of DETECTORS) {
		const cached = host.shots.has(item, detector);
		const button = group.createEl('button', { cls: 'cine-detector' });
		button.toggleClass('is-active', detector === current);
		button.toggleClass('is-cached', cached);
		if (wide) button.addClass('mod-cta');
		const icon = button.createSpan({ cls: 'cine-detector-icon' });
		setIcon(icon, DETECTOR_ICONS[detector]);
		button.createSpan({
			text: wide
				? `Find cuts · ${DETECTOR_LABELS[detector]}`
				: DETECTOR_LABELS[detector],
		});
		setTooltip(
			button,
			cached
				? `Show the cuts ${DETECTOR_LABELS[detector]} already found`
				: DETECTOR_HINTS[detector],
			{ placement: 'top' },
		);
		button.addEventListener('click', () => {
			if (cached && detector !== current) host.show(item, detector);
			else if (!cached) host.run(item, detector);
		});
	}
}

/** `Whiplash.mp4 · ffmpeg · 26 shots · 14.2s avg · 0.4s shortest` */
export function summarize(
	item: MediaItem,
	shots: Shot[],
	detector: Detector | null,
): string {
	const stats = shotStats(shots);
	return [
		item.file.name,
		...(detector ? [DETECTOR_LABELS[detector]] : []),
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
