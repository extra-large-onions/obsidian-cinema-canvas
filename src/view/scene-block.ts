import type CinemaCanvasPlugin from '../main';
import { filmPathForNote, parseBlock } from '../media/scenes';
import { formatTimecode } from '../utils/timecode';

/**
 * Draws a film note's `cinema-scenes` block as what it describes in reading
 * view: the scenes in the note's order, each one opening the film's cut view
 * and showing itself there, and
 * how many cuts are labelled.
 *
 * In editing view the block stays JSON, which is the form worth editing by
 * hand. The film is found from the note's own name — `Heat.mkv.scenes.md`
 * belongs to `Heat.mkv` — so nothing inside the block can go stale on a rename.
 */
export function renderSceneBlock(
	plugin: CinemaCanvasPlugin,
	source: string,
	el: HTMLElement,
	sourcePath: string,
): void {
	const root = el.createDiv({ cls: 'cine-scene-block' });
	const parsed = parseBlock(source);
	if (parsed.error || !parsed.notes) {
		root.createDiv({
			cls: 'cine-scene-block-error',
			text: `${parsed.error ?? 'Nothing to show.'} Nothing will be saved to this note until it is fixed.`,
		});
		return;
	}

	const filmPath = filmPathForNote(sourcePath);
	const film = filmPath ? plugin.app.vault.getFileByPath(filmPath) : null;
	const { scenes, labels } = parsed.notes;

	const head = root.createDiv({ cls: 'cine-scene-block-head' });
	head.createSpan({
		text: film?.name ?? filmPath?.split('/').pop() ?? 'Scenes',
	});
	head.createSpan({
		cls: 'cine-scene-block-count',
		text: `${scenes.length} scene${scenes.length === 1 ? '' : 's'} · ${labels.length} label${labels.length === 1 ? '' : 's'}`,
	});
	if (film) {
		const open = head.createEl('button', {
			cls: 'cine-scene-block-open',
			text: 'Open cuts',
		});
		open.addEventListener('click', () => void plugin.openClip(film));
	} else {
		root.createDiv({
			cls: 'cine-scene-block-error',
			text: filmPath
				? `There is no film at ${filmPath}. A scene note is named after its film, plus .scenes.md.`
				: 'This block belongs in the note beside a film, named after it plus .scenes.md.',
		});
	}

	if (scenes.length === 0) return;
	const list = root.createEl('ul', { cls: 'cine-scene-block-list' });
	scenes.forEach((scene, i) => {
		const row = list.createEl('li');
		const cuts = scene.cuts.length;
		row.createSpan({
			cls: 'cine-scene-block-time',
			text: cuts > 0 ? formatTimecode(scene.cuts[0] ?? 0) : '—',
		});
		row.createSpan({ text: scene.title || `Scene ${i + 1}` });
		row.createSpan({
			cls: 'cine-scene-block-count',
			text: `${cuts} cut${cuts === 1 ? '' : 's'}`,
		});
		if (!film) return;
		row.addClass('is-link');
		row.addEventListener('click', () => void plugin.openClip(film, scene.id));
	});
}
