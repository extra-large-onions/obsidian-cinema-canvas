/**
 * `8.375` -> `0:08.3`, `3725.4` -> `1:02:05.4`.
 *
 * Tenths rather than frames, because the index has no frame rate and a shot
 * boundary is only ever read here as "where in the clip", not as an edit point.
 */
export function formatTimecode(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	const s = secs.toFixed(1).padStart(4, '0');
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${s}`;
	return `${minutes}:${s}`;
}

/** `0:08.3 – 0:09.0 (0.6s)` */
export function formatShotRange(start: number, end: number): string {
	const length = Math.max(0, end - start);
	return `${formatTimecode(start)} – ${formatTimecode(end)} (${length.toFixed(1)}s)`;
}
