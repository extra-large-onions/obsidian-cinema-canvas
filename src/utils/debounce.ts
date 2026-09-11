/** Trailing-edge debounce with a `cancel()` for teardown. */
export function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	wait: number,
): ((...args: A) => void) & { cancel: () => void } {
	let timer: number | null = null;
	const wrapped = (...args: A) => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			fn(...args);
		}, wait);
	};
	wrapped.cancel = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	};
	return wrapped;
}

export function clamp(v: number, min: number, max: number): number {
	return v < min ? min : v > max ? max : v;
}
