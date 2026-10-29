import { DepthMap, depthInput, depthInputSize, pictureBox, readDepth } from '../media/depth';
import { DepthEstimator, DepthModelState } from '../media/depth-model';
import { FaceDetector, FaceModelState } from '../media/faces';
import {
	FaceReading,
	LINEAR,
	LightReading,
	RgbaFrame,
	ratioLabel,
	readLight,
} from '../media/lighting';
import { messageOf } from '../media/onnx';
import { EdgeLight, findEdgeLight } from '../media/rim';
import { YUNET_SIZE, unletterbox } from '../media/yunet';
import { ZoneMap, findZones, romanZone, zoneNumber } from '../media/zones';
import { Rect } from '../types';
import { DepthLayer, MIST_CSS, depthChart } from './light-depth';
import { LightLoupe, SpotReading } from './light-loupe';
import { ZoneLayer, signedStops, warmthLabel } from './light-zones';

/** Analysis frames are at most this wide: enough for a face in a wide shot. */
const MAX_WIDTH = 1280;
/** How often a playing clip is read again. */
const PLAYING_INTERVAL_MS = 500;

type Media = HTMLImageElement | HTMLVideoElement;

/** What the readout draws over the picture. */
type Overlay = 'zones' | 'depth';

export interface LightMeterModels {
	faces: FaceDetector;
	/** Whether to read faces; checked on every reading. */
	readFaces: () => boolean;
	depth: DepthEstimator;
	/** Whether to read depth; checked on every reading. */
	readDepth: () => boolean;
}

/**
 * The lighting readout in the full screen viewer: marks drawn on the picture,
 * and a panel of numbers beside it.
 *
 * Reads whatever frame is showing — a still once, a clip twice a second while
 * it plays and again on every pause and seek. Frame readings need nothing.
 * Face and depth readings are off unless their settings are on; then they
 * need their models, which the panel offers to download. Depth takes seconds,
 * so it is read after the rest, on a paused frame only.
 */
export class LightMeter {
	private readonly panel: HTMLElement;
	private readonly overlay: HTMLElement;
	/** Face marks and the edge tint, redrawn with every reading. */
	private readonly marks: HTMLElement;
	/** Takes the pointer over the picture, for the loupe and zone hover. */
	private readonly hit: HTMLElement;
	private readonly zones: ZoneLayer;
	private readonly depthLayer: DepthLayer;
	private readonly loupe: LightLoupe;
	/** Panel rows by zone or plane id, lit while their area is pointed at. */
	private regionRows = new Map<number, HTMLElement>();
	private overlayKind: Overlay = 'zones';
	private enabled = false;
	private media: Media | null = null;
	/** Bumped on every new picture, so a late result for the old one is dropped. */
	private generation = 0;
	private busy = false;
	private again = false;
	private timer: number | null = null;
	private modelState: FaceModelState | null = null;
	private downloading = false;
	private depthState: DepthModelState | null = null;
	/** Share of the depth model downloaded, 0–1; null when not downloading. */
	private depthProgress: number | null = null;
	/** Whether depth is being read, and the frame waiting to be read next. */
	private depthBusy = false;
	private depthNext: RgbaFrame | null = null;
	private readonly depthCanvas = createEl('canvas');
	private error: string | null = null;
	private last: {
		reading: LightReading;
		edge: EdgeLight;
		/** Null while a clip plays: zones are read on a still frame only. */
		zones: ZoneMap | null;
		/** Null until read: after the rest, on a still frame, when switched on. */
		depth: DepthMap | null;
		frame: RgbaFrame;
		width: number;
		height: number;
	} | null = null;
	private readonly frameCanvas = createEl('canvas');
	private readonly squareCanvas = createEl('canvas');
	private readonly detach: (() => void)[] = [];

	private readonly faces: FaceDetector;
	private readonly readFaces: () => boolean;
	private readonly depth: DepthEstimator;
	private readonly readDepth: () => boolean;

	constructor(root: HTMLElement, models: LightMeterModels) {
		this.faces = models.faces;
		this.readFaces = models.readFaces;
		this.depth = models.depth;
		this.readDepth = models.readDepth;
		this.overlay = root.createDiv({ cls: 'cine-light-overlay' });
		this.overlay.hide();
		this.marks = this.overlay.createDiv({ cls: 'cine-light-marks' });
		this.zones = new ZoneLayer(this.overlay, (id) => this.hoverRegion(id));
		this.depthLayer = new DepthLayer(this.overlay, (id) => this.hoverRegion(id));
		this.depthLayer.setVisible(false);
		this.hit = this.overlay.createDiv({ cls: 'cine-light-hit' });
		this.loupe = new LightLoupe(root, this.overlay, {
			sample: (fx, fy) => this.sample(fx, fy),
			media: () => this.media,
			regionName: (fx, fy) => this.regionName(fx, fy),
		});
		this.listenPointer();
		this.panel = root.createDiv({ cls: 'cine-light-panel' });
		this.panel.hide();
		// Clicks on the panel must not reach the backdrop, which closes.
		this.panel.addEventListener('click', (e) => e.stopPropagation());
		this.squareCanvas.width = YUNET_SIZE;
		this.squareCanvas.height = YUNET_SIZE;
	}

	setEnabled(on: boolean): void {
		if (on === this.enabled) return;
		this.enabled = on;
		this.panel.toggle(on);
		this.overlay.toggle(on);
		if (!on) this.loupe.leave();
		if (on) {
			this.listen();
			this.request();
		} else {
			this.unlisten();
		}
	}

	/** Points the meter at the picture now showing; null when there is none. */
	attach(media: Media | null): void {
		this.unlisten();
		this.media = media;
		this.generation++;
		this.last = null;
		this.error = null;
		this.hit.toggleClass('is-video', media instanceof HTMLVideoElement);
		this.loupe.reset();
		this.zones.setMap(null);
		this.depthLayer.setMap(null);
		this.depthNext = null;
		this.renderOverlay();
		this.renderPanel();
		if (this.enabled) {
			this.listen();
			this.request();
		}
	}

	/** Puts the marks on the picture's rect, in the viewer's own pixels. */
	place(rect: Rect): void {
		const style = this.overlay.style;
		style.left = `${rect.x}px`;
		style.top = `${rect.y}px`;
		style.width = `${rect.w}px`;
		style.height = `${rect.h}px`;
		this.loupe.place(rect);
	}

	destroy(): void {
		this.unlisten();
		this.loupe.destroy();
		this.zones.destroy();
		this.depthLayer.destroy();
		this.panel.remove();
		this.overlay.remove();
	}

	// --- scheduling -------------------------------------------------------

	private listen(): void {
		const media = this.media;
		if (!media) return;
		const on = (type: string) => {
			const handler = () => this.request();
			media.addEventListener(type, handler);
			this.detach.push(() => media.removeEventListener(type, handler));
		};
		if (media instanceof HTMLVideoElement) {
			on('loadeddata');
			on('seeked');
			on('pause');
			const tick = () => {
				if (!media.paused) this.request();
			};
			this.timer = window.setInterval(tick, PLAYING_INTERVAL_MS);
		} else {
			on('load');
		}
	}

	private unlisten(): void {
		for (const off of this.detach.splice(0)) off();
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	/** Reads the frame now, or right after the reading in flight. */
	private request(): void {
		if (!this.enabled || !this.media) return;
		if (this.busy) {
			this.again = true;
			return;
		}
		void this.measure();
	}

	private async measure(): Promise<void> {
		const media = this.media;
		if (!media) return;
		const generation = this.generation;
		this.busy = true;
		try {
			const frame = this.capture(media);
			if (!frame) return;
			const still = !(media instanceof HTMLVideoElement) || media.paused;
			let faces: ReturnType<typeof unletterbox> = [];
			if (!this.readFaces()) this.modelState = null;
			else if (this.modelState === null) void this.checkModel();
			else if (this.modelState === 'ready') {
				const square = this.letterbox(frame);
				faces = unletterbox(await this.faces.detect(square.data), square.scale);
			}
			if (generation !== this.generation) return;
			this.last = {
				reading: readLight(frame, faces),
				edge: findEdgeLight(frame),
				// A few hundred milliseconds: too slow to run twice a second
				// beside playback, and zones that jump about are no use.
				zones: still ? findZones(frame) : null,
				depth: null,
				frame,
				width: frame.width,
				height: frame.height,
			};
			this.error = null;
			if (!this.readDepth()) this.depthState = null;
			else if (this.depthState === null) void this.checkDepthModel();
			else if (this.depthState === 'ready' && still) this.requestDepth(frame);
		} catch (err) {
			if (generation !== this.generation) return;
			this.error = messageOf(err);
			console.error('Cinema canvas: lighting readout failed', err);
		} finally {
			this.busy = false;
		}
		this.renderOverlay();
		this.renderPanel();
		this.zones.setMap(this.last?.zones ?? null);
		this.depthLayer.setMap(this.last?.depth ?? null);
		this.showOverlay();
		this.loupe.refresh();
		if (this.again) {
			this.again = false;
			this.request();
		}
	}

	private capture(media: Media): RgbaFrame | null {
		const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
		const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
		if (!w || !h) return null;
		if (media instanceof HTMLVideoElement && media.readyState < 2) return null;
		const scale = Math.min(1, MAX_WIDTH / w);
		const width = Math.max(1, Math.round(w * scale));
		const height = Math.max(1, Math.round(h * scale));
		const canvas = this.frameCanvas;
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(media, 0, 0, width, height);
		const image = ctx.getImageData(0, 0, width, height);
		return { data: image.data, width, height };
	}

	/** The frame, fitted into YuNet's black 640 square from the top left. */
	private letterbox(frame: RgbaFrame): { data: Uint8ClampedArray; scale: number } {
		const scale = Math.min(YUNET_SIZE / frame.width, YUNET_SIZE / frame.height);
		const ctx = this.squareCanvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('No 2D canvas for face detection.');
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, YUNET_SIZE, YUNET_SIZE);
		ctx.drawImage(
			this.frameCanvas,
			0,
			0,
			Math.round(frame.width * scale),
			Math.round(frame.height * scale),
		);
		return { data: ctx.getImageData(0, 0, YUNET_SIZE, YUNET_SIZE).data, scale };
	}

	private async checkModel(): Promise<void> {
		this.modelState = await this.faces.state();
		this.renderPanel();
		if (this.modelState === 'ready') this.request();
	}

	private async download(): Promise<void> {
		this.downloading = true;
		this.renderPanel();
		try {
			await this.faces.download();
		} catch (err) {
			this.error = messageOf(err);
		}
		this.downloading = false;
		await this.checkModel();
	}

	// --- depth ------------------------------------------------------------

	/** Reads depth for a frame now, or once the one in flight is done. */
	private requestDepth(frame: RgbaFrame): void {
		if (this.depthBusy) {
			this.depthNext = frame;
			return;
		}
		void this.measureDepth(frame);
	}

	private async measureDepth(frame: RgbaFrame): Promise<void> {
		const generation = this.generation;
		this.depthBusy = true;
		this.renderPanel();
		try {
			const box = pictureBox(frame);
			const size = depthInputSize(box.w, box.h);
			const canvas = this.depthCanvas;
			canvas.width = size.width;
			canvas.height = size.height;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) throw new Error('No 2D canvas for the depth model.');
			ctx.imageSmoothingQuality = 'high';
			// The captured frame as an image again, the bars cropped away.
			const source = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
			const bitmap = await createImageBitmap(source, box.x, box.y, box.w, box.h);
			ctx.drawImage(bitmap, 0, 0, size.width, size.height);
			bitmap.close();
			const pixels = ctx.getImageData(0, 0, size.width, size.height).data;
			const out = await this.depth.estimate(
				depthInput(pixels, size.width, size.height),
				size.width,
				size.height,
			);
			// Kept only if the frame it was read from is still the one shown.
			if (generation === this.generation && this.last?.frame === frame) {
				this.last.depth = readDepth(frame, box, out.data, out.width, out.height);
				this.depthLayer.setMap(this.last.depth);
				this.loupe.refresh();
			}
		} catch (err) {
			if (generation === this.generation) this.error = messageOf(err);
			console.error('Cinema canvas: depth reading failed', err);
		} finally {
			this.depthBusy = false;
		}
		this.renderPanel();
		const next = this.depthNext;
		this.depthNext = null;
		if (next && next === this.last?.frame) this.requestDepth(next);
	}

	private async checkDepthModel(): Promise<void> {
		this.depthState = await this.depth.state();
		this.renderPanel();
		if (this.depthState === 'ready') this.request();
	}

	private async downloadDepth(): Promise<void> {
		this.depthProgress = 0;
		this.renderPanel();
		let shown = 0;
		try {
			await this.depth.download((received, total) => {
				const share = received / total;
				// A redraw per percent is plenty.
				if (share - shown < 0.01) return;
				shown = share;
				this.depthProgress = share;
				this.renderPanel();
			});
		} catch (err) {
			this.error = messageOf(err);
		}
		this.depthProgress = null;
		await this.checkDepthModel();
	}

	/** Switches the picture between zones and depth. */
	private setOverlay(kind: Overlay): void {
		if (kind === this.overlayKind) return;
		this.hoverRegion(null);
		this.overlayKind = kind;
		this.showOverlay();
		this.renderPanel();
	}

	private showOverlay(): void {
		const depth = this.showingDepth;
		this.zones.setVisible(!depth);
		this.depthLayer.setVisible(depth);
	}

	private get showingDepth(): boolean {
		return this.overlayKind === 'depth' && this.readDepth();
	}

	// --- drawing ----------------------------------------------------------

	// --- pointer --------------------------------------------------------

	private listenPointer(): void {
		const fraction = (e: MouseEvent): [number, number] => {
			const box = this.overlay.getBoundingClientRect();
			return [
				(e.clientX - box.left) / Math.max(1, box.width),
				(e.clientY - box.top) / Math.max(1, box.height),
			];
		};
		this.hit.addEventListener('pointermove', (e) => {
			const [fx, fy] = fraction(e);
			this.loupe.move(fx, fy);
			this.hoverRegion(
				this.showingDepth
					? (this.depthLayer.at(fx, fy)?.plane?.id ?? null)
					: (this.zones.zoneAt(fx, fy)?.id ?? null),
			);
		});
		this.hit.addEventListener('pointerleave', () => {
			this.loupe.leave();
			this.hoverRegion(null);
		});
		this.hit.addEventListener('click', (e) => {
			// Not the backdrop's click, which closes the viewer.
			e.stopPropagation();
			const [fx, fy] = fraction(e);
			this.loupe.click(fx, fy);
		});
		this.hit.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.loupe.clearPins();
		});
	}

	/** Lights up one zone or plane, whichever the picture shows, and its row. */
	private hoverRegion(id: number | null): void {
		if (this.showingDepth) this.depthLayer.setHovered(id);
		else this.zones.setHovered(id);
		for (const [key, row] of this.regionRows) row.toggleClass('is-hovered', key === id);
	}

	/** What the loupe names the spot by: its zone, or its plane and depth. */
	private regionName(fx: number, fy: number): string | null {
		if (!this.showingDepth) return this.zones.zoneAt(fx, fy)?.name ?? null;
		const at = this.depthLayer.at(fx, fy);
		if (!at) return null;
		return `${at.plane?.name ?? 'Depth'} ${Math.round(at.depth * 100)}% back`;
	}

	/** The spot around a point, from the last reading's frame. */
	private sample(fx: number, fy: number): SpotReading | null {
		const last = this.last;
		if (!last) return null;
		const { frame } = last;
		// While playing there are no zones; the frame reading's median, which
		// is as displayed, decoded to linear light.
		const shown = last.reading.frame.median;
		const median =
			last.zones?.median ??
			(shown <= 0.04045 ? shown / 12.92 : Math.pow((shown + 0.055) / 1.055, 2.4));
		const cx = Math.round(fx * (frame.width - 1));
		const cy = Math.round(fy * (frame.height - 1));
		let r = 0;
		let g = 0;
		let b = 0;
		let level = 0;
		let clipped = 0;
		let count = 0;
		// A 5 x 5 patch, so grain does not make the number jump.
		for (let y = cy - 2; y <= cy + 2; y++)
			for (let x = cx - 2; x <= cx + 2; x++) {
				if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
				const i = (y * frame.width + x) * 4;
				const R = frame.data[i]!;
				const G = frame.data[i + 1]!;
				const B = frame.data[i + 2]!;
				r += LINEAR[R]!;
				g += LINEAR[G]!;
				b += LINEAR[B]!;
				level += (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
				if (R >= 250 || G >= 250 || B >= 250) clipped++;
				count++;
			}
		if (!count) return null;
		r /= count;
		g /= count;
		b /= count;
		const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const enc = (v: number) =>
			Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
		return {
			stops: Math.log2(Math.max(luma, 1 / 4096) / Math.max(median, 1 / 4096)),
			zone: zoneNumber(luma),
			level: level / count,
			color: `rgb(${enc(r)}, ${enc(g)}, ${enc(b)})`,
			warmth: r / Math.max(b, 1e-6),
			clipped: clipped > count / 2,
			crushed: level / count < 0.02,
		};
	}

	private renderOverlay(): void {
		this.marks.empty();
		const last = this.last;
		if (!last) return;
		const { reading, edge, width, height } = last;
		if (edge.streaks) this.paintEdge(edge);
		const svg = this.marks.createSvg('svg', {
			attr: { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' },
		});
		const pct = (v: number, of: number) => `${(v / of) * 100}%`;

		reading.faces.forEach((f, index) => {
			const { x, y, w, h } = f.face;
			this.shape(svg, 'rect', 'cine-light-face', { x, y, width: w, height: h, rx: w * 0.08 });
			if (f.small) return;
			const [top, bottom] = f.axis;
			this.shape(svg, 'line', 'cine-light-axis', {
				x1: top.x,
				y1: top.y,
				x2: bottom.x,
				y2: bottom.y,
			});
			// The two sides of the box in their own light's colour, so the key
			// side reads at a glance and the colours can be compared.
			const leftColor = f.keySide === 'right' ? f.fillColor : f.keyColor;
			const rightColor = f.keySide === 'right' ? f.keyColor : f.fillColor;
			const bar = Math.max(3, w * 0.035);
			this.shape(svg, 'rect', 'cine-light-side', { x: x - bar * 1.6, y, width: bar, height: h }).style.fill = leftColor;
			this.shape(svg, 'rect', 'cine-light-side', { x: x + w + bar * 0.6, y, width: bar, height: h }).style.fill = rightColor;

			if (f.rim) {
				for (const side of f.rim.sides) {
					const gap = w * 0.18;
					if (side === 'top')
						this.shape(svg, 'line', 'cine-light-rim', { x1: x + w * 0.2, y1: y - gap, x2: x + w * 0.8, y2: y - gap });
					else {
						const rx = side === 'left' ? x - gap : x + w + gap;
						this.shape(svg, 'line', 'cine-light-rim', { x1: rx, y1: y, x2: rx, y2: y + h * 0.7 });
					}
				}
			}

			const label =
				f.keySide === null
					? `${index + 1} · even`
					: `${index + 1} · key ${f.keySide === 'left' ? '←' : '→'} ${ratioLabel(f.ratioStops)}`;
			this.chip(label, pct(x, width), pct(y + h, height), 'is-face');
		});
	}

	/**
	 * Edge light traced in warm light, pixel for pixel: a fine core with a
	 * soft glow and a dark rim under it (CSS), so it reads the way the zone
	 * lines do on any tone.
	 */
	private paintEdge(edge: EdgeLight): void {
		const canvas = this.marks.createEl('canvas', { cls: 'cine-light-edge' });
		canvas.width = edge.width;
		canvas.height = edge.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const image = ctx.createImageData(edge.width, edge.height);
		const px = image.data;
		for (let i = 0; i < edge.mask.length; i++) {
			if (!edge.mask[i]) continue;
			px[i * 4] = 255;
			px[i * 4 + 1] = 208;
			px[i * 4 + 2] = 128;
			px[i * 4 + 3] = 235;
		}
		ctx.putImageData(image, 0, 0);
	}

	private shape(
		parent: SVGElement,
		tag: 'rect' | 'line',
		cls: string,
		attrs: Record<string, number>,
	): SVGElement {
		return parent.createSvg(tag, { cls, attr: attrs });
	}

	private chip(text: string, left: string, top: string, cls: string): void {
		const el = this.marks.createDiv({ cls: `cine-light-chip ${cls}`, text });
		el.style.left = left;
		el.style.top = top;
	}

	private renderPanel(): void {
		const panel = this.panel;
		panel.empty();
		const head = panel.createDiv({ cls: 'cine-light-head' });
		head.createSpan({ cls: 'cine-light-title', text: 'Lighting' });
		head.createSpan({ cls: 'cine-light-note', text: 'of the graded image' });
		if (this.readDepth()) {
			const choice = head.createDiv({ cls: 'cine-light-switch' });
			for (const [kind, label] of [
				['zones', 'Zones'],
				['depth', 'Depth'],
			] as const) {
				const button = choice.createEl('button', { text: label });
				button.toggleClass('is-active', this.overlayKind === kind);
				button.addEventListener('click', () => this.setOverlay(kind));
			}
		}

		if (this.error) panel.createDiv({ cls: 'cine-light-error', text: this.error });

		const last = this.last;
		if (!last) {
			panel.createDiv({ cls: 'cine-light-muted', text: 'Reading the frame…' });
		} else {
			const f = last.reading.frame;
			const frame = this.section(panel, 'Frame');
			this.row(frame, 'Contrast', `${f.contrastStops.toFixed(1)} stops`);
			this.row(frame, 'Tone', `${capital(f.tone)} · median ${Math.round(f.median * 100)}%`);
			const blacks: string[] = [];
			if (f.blackLevel > 0.07) blacks.push('lifted (haze or grade)');
			if (f.crushed > 0.01) blacks.push(`${percent(f.crushed)} crushed`);
			this.row(frame, 'Blacks', blacks.length ? blacks.join(', ') : 'clean');
			this.row(
				frame,
				'Highlights',
				f.clipped > 0.002 ? `${percent(f.clipped)} clipped` : 'none clipped',
			);
			if (f.brightest.blown)
				this.row(frame, 'Brightest', 'blown out: a window, a lamp or sky?');
			const edge = last.edge;
			const edgeRow = this.row(
				frame,
				'Edge light',
				edge.streaks
					? `${edge.streaks} ${edge.streaks === 1 ? 'streak' : 'streaks'}, ${percent(edge.share)} of frame`
					: 'none',
			);
			if (edge.streaks) edgeRow.addClass('cine-light-edge-value');

			this.regionRows = new Map();
			if (this.showingDepth) this.depthSection(panel);
			else if (last.zones) this.zoneSection(panel, last.zones);
			else
				this.section(panel, 'Zones').createDiv({
					cls: 'cine-light-muted',
					text: 'Pause to see the zones.',
				});

			last.reading.faces.forEach((r, i) => this.faceSection(panel, r, i, last.width));
		}
		this.modelNotice(panel);
		this.depthNotice(panel);
	}

	/** The zones brightest first; pointing at a row lights up its zone. */
	private zoneSection(panel: HTMLElement, map: ZoneMap): void {
		const box = this.section(panel, 'Zones');
		const hovered = this.zones.hoveredZone?.id ?? null;
		for (const zone of [...map.zones].reverse()) {
			const row = box.createDiv({ cls: 'cine-zone-row' });
			row.toggleClass('is-hovered', zone.id === hovered);
			const dot = row.createSpan({ cls: 'cine-zone-dot' });
			dot.style.backgroundColor = zone.color;
			row.createSpan({ cls: 'cine-zone-row-name', text: zone.name });
			row.createSpan({ cls: 'cine-zone-row-stops', text: signedStops(zone.stops) });
			row.createSpan({
				cls: 'cine-zone-row-detail',
				text: `${romanZone(zone.zone)} · ${percent(zone.share)} · ${warmthLabel(zone.warmth)}`,
			});
			row.addEventListener('pointerenter', () => this.hoverRegion(zone.id));
			row.addEventListener('pointerleave', () => this.hoverRegion(null));
			this.regionRows.set(zone.id, row);
		}
		box.createDiv({
			cls: 'cine-light-muted',
			text: "Stops over the frame's median. Point at the picture for a spot reading; click two spots to compare them.",
		});
	}

	/** Planes near to far, the front-to-back chart, and what the air is doing. */
	private depthSection(panel: HTMLElement): void {
		const box = this.section(panel, 'Depth');
		const map = this.last?.depth;
		if (this.depthState !== 'ready') {
			box.createDiv({
				cls: 'cine-light-muted',
				text:
					this.depthState === null
						? 'Checking for the depth model…'
						: 'Needs the depth model: see below.',
			});
			return;
		}
		if (!map) {
			const media = this.media;
			const playing = media instanceof HTMLVideoElement && !media.paused;
			box.createDiv({
				cls: 'cine-light-muted',
				text: playing ? 'Pause to read depth.' : 'Reading depth…',
			});
			return;
		}
		depthChart(box, map);
		const legend = box.createDiv({ cls: 'cine-depth-legend' });
		legend.createSpan({ cls: 'is-bars', text: 'contrast' });
		legend
			.createSpan({ cls: 'is-line', text: 'blacks' })
			.style.setProperty('--depth-line', MIST_CSS);

		const hovered = this.depthLayer.hoveredPlane?.id ?? null;
		for (const plane of map.planes) {
			const row = box.createDiv({ cls: 'cine-zone-row' });
			row.toggleClass('is-hovered', plane.id === hovered);
			const dot = row.createSpan({ cls: 'cine-zone-dot' });
			dot.style.backgroundColor = plane.veil;
			row.createSpan({ cls: 'cine-zone-row-name', text: plane.name });
			row.createSpan({ cls: 'cine-zone-row-stops', text: plane.contrast.toFixed(1) });
			row.createSpan({
				cls: 'cine-zone-row-detail',
				text: `stops · blacks ${percent(plane.black)} · ${percent(plane.share)}`,
			});
			row.addEventListener('pointerenter', () => this.hoverRegion(plane.id));
			row.addEventListener('pointerleave', () => this.hoverRegion(null));
			this.regionRows.set(plane.id, row);
		}
		box.createDiv({ cls: 'cine-depth-verdict', text: atmosphereText(map) });
		box.createDiv({
			cls: 'cine-light-muted',
			text: "Depth is relative: which things are nearer, not how far. Each dot is the colour of that plane's darkest tones.",
		});
	}

	private faceSection(panel: HTMLElement, r: FaceReading, index: number, width: number): void {
		const cx = (r.face.x + r.face.w / 2) / width;
		const where = cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
		const box = this.section(panel, `Face ${index + 1} · ${where}`);
		if (r.small) {
			box.createDiv({ cls: 'cine-light-muted', text: 'Too small in frame to read.' });
			return;
		}
		this.row(
			box,
			'Key',
			r.keySide === null
				? `even, ${ratioLabel(r.ratioStops)} (flat)`
				: `screen ${r.keySide}, ${ratioLabel(r.ratioStops)} (${r.ratioStops.toFixed(1)} stops)`,
		);
		if (r.hardness) this.row(box, 'Shadow edge', r.hardness);
		const colors = this.row(box, 'Color', '');
		this.swatch(colors, r.keyColor, 'key');
		this.swatch(colors, r.fillColor, 'fill');
		colors.appendText(
			r.warmthShift > 0.04
				? ' key warmer'
				: r.warmthShift < -0.04
					? ' key cooler'
					: ' same color',
		);
		this.row(
			box,
			'Rim',
			r.rim ? `${r.rim.sides.join(' + ')}, ${signed(r.rim.stops)} stops over key` : 'none',
		);
		const sep = r.separationStops;
		this.row(
			box,
			'Background',
			sep < -1
				? `${Math.abs(sep).toFixed(1)} stops brighter than the face: backlit`
				: sep < 0.5
					? 'about as bright as the face'
					: `${sep.toFixed(1)} stops darker than the face`,
		);
		if (r.turned)
			box.createDiv({
				cls: 'cine-light-muted',
				text: 'Turned away: one half is partly hidden, so the ratio is rough.',
			});
	}

	private depthNotice(panel: HTMLElement): void {
		if (!this.readDepth() || this.depthState === 'ready' || this.depthState === null) return;
		const box = panel.createDiv({ cls: 'cine-light-model' });
		if (this.depthState === 'unsupported') {
			box.setText('Depth readings need the vault on a local disk.');
			return;
		}
		box.createDiv({
			text: 'To read depth and haze, download the depth model (Depth Anything V2 Small, 99 MB), plus the ONNX runtime (112 MB) if shot detection has not fetched it yet.',
		});
		const progress = this.depthProgress;
		const button = box.createEl('button', {
			text: progress === null ? 'Download' : `Downloading… ${Math.round(progress * 100)}%`,
		});
		button.disabled = progress !== null;
		button.addEventListener('click', () => void this.downloadDepth());
	}

	private modelNotice(panel: HTMLElement): void {
		if (this.modelState === 'ready' || this.modelState === null) return;
		const box = panel.createDiv({ cls: 'cine-light-model' });
		if (this.modelState === 'unsupported') {
			box.setText('Face readings need the vault on a local disk.');
			return;
		}
		box.createDiv({
			text: 'Optional: to also read faces (key/fill ratio, rim), download a 230 KB face model, plus the ONNX runtime (112 MB) if shot detection has not fetched it yet.',
		});
		const button = box.createEl('button', {
			text: this.downloading ? 'Downloading…' : 'Download',
		});
		button.disabled = this.downloading;
		button.addEventListener('click', () => void this.download());
	}

	private section(panel: HTMLElement, title: string): HTMLElement {
		const el = panel.createDiv({ cls: 'cine-light-section' });
		el.createDiv({ cls: 'cine-light-section-title', text: title });
		return el;
	}

	private row(parent: HTMLElement, label: string, value: string): HTMLElement {
		const row = parent.createDiv({ cls: 'cine-light-row' });
		row.createSpan({ cls: 'cine-light-label', text: label });
		return row.createSpan({ cls: 'cine-light-value', text: value });
	}

	private swatch(parent: HTMLElement, color: string, label: string): void {
		const el = parent.createSpan({ cls: 'cine-light-swatch' });
		el.style.backgroundColor = color;
		el.setAttribute('aria-label', `${label} ${color}`);
		parent.appendText(` ${label} `);
	}
}

function atmosphereText(map: DepthMap): string {
	const near = map.planes[0];
	const far = map.planes[map.planes.length - 1];
	if (!near || !far || near === far) return 'One plane: nothing to compare front to back.';
	switch (map.atmosphere) {
		case 'haze':
			return `Haze: the far plane is ${map.drop.toFixed(1)} stops flatter, its blacks lifted to ${percent(far.black)} from ${percent(near.black)}.`;
		case 'lifted':
			return `The far plane's blacks lift to ${percent(far.black)} from ${percent(near.black)}, but its contrast holds: light haze, or a paler background.`;
		case 'surface':
			return 'The far plane is paler, but toward a strong colour: a bright surface, not haze.';
		case 'even':
			return `Blacks lifted near and far alike (${percent(near.black)}): the grade, or haze through the whole space.`;
		case 'clear':
			return 'No haze: the blacks hold to the back.';
	}
}

function capital(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function percent(share: number): string {
	return `${share < 0.1 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`;
}

function signed(value: number): string {
	return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}
