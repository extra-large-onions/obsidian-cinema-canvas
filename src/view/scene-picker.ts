import { App, FuzzySuggestModal } from 'obsidian';
import { Scene, sceneTitle } from '../media/scenes';

/** What the picker offers: an existing scene, or a new one. */
export type ScenePick = Scene | 'new';

/**
 * Chooses the scene some cuts go into, by typing part of its title.
 *
 * A menu would do for three scenes; a film you have grouped by character,
 * location and shot type has dozens, and a filtered list is the one that
 * still works then.
 */
export class ScenePickerModal extends FuzzySuggestModal<ScenePick> {
	constructor(
		app: App,
		private readonly scenes: readonly Scene[],
		placeholder: string,
		private readonly onPick: (pick: ScenePick) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): ScenePick[] {
		return ['new', ...this.scenes];
	}

	getItemText(pick: ScenePick): string {
		if (pick === 'new') return 'New scene…';
		const cuts = pick.members.length;
		return `${sceneTitle(pick)} (${cuts} cut${cuts === 1 ? '' : 's'})`;
	}

	onChooseItem(pick: ScenePick): void {
		this.onPick(pick);
	}
}
