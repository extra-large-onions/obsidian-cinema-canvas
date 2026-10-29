/**
 * YuNet's input and output formats, with no runtime attached: pure, so the
 * decode can be checked against real frames outside Obsidian.
 */

import type { Face } from './lighting';

/** The export takes exactly this square; frames are letterboxed into it. */
export const YUNET_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
/**
 * The authors default to 0.9, tuned for well-lit portraits. Film faces are
 * darker, smaller and turned. On the test frames 0.7 kept every face a person
 * would point at; below it came the back of a head and faces too small to read.
 */
const SCORE_THRESHOLD = 0.7;
const NMS_IOU = 0.3;

/** Packs a 640 x 640 RGBA image as the planar BGR, 0-255 floats YuNet expects. */
export function yunetInput(rgba: Uint8ClampedArray): Float32Array {
	const plane = YUNET_SIZE * YUNET_SIZE;
	const out = new Float32Array(3 * plane);
	for (let p = 0; p < plane; p++) {
		out[p] = rgba[p * 4 + 2] ?? 0;
		out[plane + p] = rgba[p * 4 + 1] ?? 0;
		out[2 * plane + p] = rgba[p * 4] ?? 0;
	}
	return out;
}

interface Tensor {
	data: Float32Array;
}

/**
 * Turns YuNet's twelve outputs into faces, in the 640 square's pixels.
 *
 * Follows OpenCV's own `FaceDetectorYN` decode: per stride, the score is the
 * geometric mean of class and objectness, box centres and landmarks are
 * offsets in cells, and sizes are log-scaled.
 */
export function decodeYunet(outputs: Record<string, Tensor>): Face[] {
	const faces: Face[] = [];
	for (const s of STRIDES) {
		const cls = outputs[`cls_${s}`]?.data;
		const obj = outputs[`obj_${s}`]?.data;
		const bbox = outputs[`bbox_${s}`]?.data;
		const kps = outputs[`kps_${s}`]?.data;
		if (!cls || !obj || !bbox || !kps) continue;
		const cols = YUNET_SIZE / s;
		for (let i = 0; i < cls.length; i++) {
			const c = Math.min(1, Math.max(0, cls[i] ?? 0));
			const o = Math.min(1, Math.max(0, obj[i] ?? 0));
			const score = Math.sqrt(c * o);
			if (score < SCORE_THRESHOLD) continue;
			const col = i % cols;
			const row = Math.floor(i / cols);
			const cx = (col + (bbox[i * 4] ?? 0)) * s;
			const cy = (row + (bbox[i * 4 + 1] ?? 0)) * s;
			const w = Math.exp(bbox[i * 4 + 2] ?? 0) * s;
			const h = Math.exp(bbox[i * 4 + 3] ?? 0) * s;
			const landmarks = [];
			for (let k = 0; k < 5; k++)
				landmarks.push({
					x: ((kps[i * 10 + 2 * k] ?? 0) + col) * s,
					y: ((kps[i * 10 + 2 * k + 1] ?? 0) + row) * s,
				});
			faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks });
		}
	}
	return suppress(faces);
}

function iou(a: Face, b: Face): number {
	const x0 = Math.max(a.x, b.x);
	const y0 = Math.max(a.y, b.y);
	const x1 = Math.min(a.x + a.w, b.x + b.w);
	const y1 = Math.min(a.y + a.h, b.y + b.h);
	const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
	return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Keeps the best of each cluster of overlapping boxes. */
function suppress(faces: Face[]): Face[] {
	const kept: Face[] = [];
	for (const f of [...faces].sort((a, z) => z.score - a.score))
		if (kept.every((k) => iou(k, f) < NMS_IOU)) kept.push(f);
	return kept;
}

/** Scales faces found in the letterboxed square back to the frame. */
export function unletterbox(faces: Face[], scale: number): Face[] {
	return faces.map((f) => ({
		...f,
		x: f.x / scale,
		y: f.y / scale,
		w: f.w / scale,
		h: f.h / scale,
		landmarks: f.landmarks.map((p) => ({ x: p.x / scale, y: p.y / scale })),
	}));
}
