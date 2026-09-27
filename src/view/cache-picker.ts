import { App, FuzzySuggestModal } from 'obsidian';

/** One thing the plugin has cached, and how to throw it away. */
export interface ClearTarget {
	/** Shown first, and named back in the notice afterwards. */
	label: string;
	/** What it holds, and what making it again costs. */
	hint: string;
	run: () => Promise<void>;
}

/**
 * Chooses which cache to clear.
 *
 * There is one command rather than one per cache, because three entries in the
 * palette all beginning with "Clear" are three ways to read the wrong one. The
 * choice is kept, though: nothing here is irreplaceable, but the price of
 * making it again is wildly different — a thumbnail is seconds, a feature
 * film's cut list is half an hour of TransNetV2 — so the hint says so, and
 * clearing all three is a deliberate first entry rather than the only option.
 */
export class CachePickerModal extends FuzzySuggestModal<ClearTarget> {
	constructor(
		app: App,
		private readonly targets: readonly ClearTarget[],
		private readonly onPick: (target: ClearTarget) => void,
	) {
		super(app);
		this.setPlaceholder('What should be cleared?');
	}

	getItems(): ClearTarget[] {
		return [...this.targets];
	}

	getItemText(target: ClearTarget): string {
		return `${target.label} — ${target.hint}`;
	}

	onChooseItem(target: ClearTarget): void {
		this.onPick(target);
	}
}
