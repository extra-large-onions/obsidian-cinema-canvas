import { Menu, Notice, setIcon, setTooltip } from 'obsidian';
import type CinemaCanvasPlugin from '../main';
import {
	FilmNotes,
	Scene,
	hasTag,
	removeTagEverywhere,
	sceneTitle,
	setSceneTag,
	tagKey,
	tagsUsed,
} from '../media/scenes';
import { MediaItem, Shot } from '../types';
import { formatLength } from './sound-lanes';
import { TextPromptModal } from './text-prompt';

/** Width the scene cards ask their still at, in CSS pixels. */
const CARD_STILL_WIDTH = 240;

/** What the board needs from the tab it is drawn in, fresh on every render. */
export interface BoardContext {
	item: MediaItem;
	/** Empty until the film has been cut. */
	shots: Shot[];
	scenes: Scene[];
	notes: FilmNotes;
}

export interface BoardHost {
	plugin: CinemaCanvasPlugin;
	color: (scene: Scene) => string;
	editNotes: (change: (notes: FilmNotes) => FilmNotes) => Promise<boolean>;
	playScene: (scene: Scene) => void;
	/** Goes to the cuts half with this scene picked. */
	showInCuts: (scene: Scene) => void;
}

/** One group on the board: a tag and the scenes carrying it. */
interface Group {
	/** The tag as listed; null for the scenes carrying none. */
	tag: string | null;
	scenes: Scene[];
	/** Used by this film's note but not on the shared list. */
	offList: boolean;
}

/**
 * A scene or a tag on its way somewhere. A scene dropped on a tag takes the
 * tag, and so does a tag dropped on a scene. Kept here rather than in the
 * drag's `dataTransfer`, which the browser hides until the drop, so a target
 * could not light up while something is held over it.
 */
let boardDrag: { kind: 'scene'; id: string } | { kind: 'tag'; tag: string } | null =
	null;

/**
 * The scenes half: every scene of the film, filed under its tags.
 *
 * The tag list stands on the left, the same list for every film, and you add
 * to it and take from it here. The board fills the rest: one group per tag,
 * then the scenes with none. A scene with two tags is in two groups — a tag is
 * a way of finding a scene, not a place it lives — so dragging a scene onto a
 * tag adds the tag and never takes one away. Taking a tag off is the × on its
 * chip.
 */
export class SceneBoard {
	private readonly tagsEl: HTMLElement;
	private readonly groupsEl: HTMLElement;
	/** The one tag the board is narrowed to, by key; '' for untagged. */
	private focus: string | null = null;
	private key = '';
	private ctx: BoardContext | null = null;
	private cancels: (() => void)[] = [];
	/** Typed into the add box but not yet added; survives a rebuild. */
	private draft = '';

	constructor(
		private readonly root: HTMLElement,
		private readonly host: BoardHost,
	) {
		root.addClass('cine-board');
		this.tagsEl = root.createDiv({ cls: 'cine-board-tags' });
		this.groupsEl = root.createDiv({ cls: 'cine-board-groups' });
	}

	destroy(): void {
		this.clearStills();
		if (boardDrag) boardDrag = null;
		this.root.empty();
	}

	/** One line for the tab's header. */
	summary(ctx: BoardContext): string {
		const tagged = ctx.scenes.filter((s) => s.tags.length > 0).length;
		const n = ctx.scenes.length;
		return `${ctx.item.file.name}  ·  ${plural(n, 'scene')}  ·  ${tagged} tagged  ·  ${plural(this.tags(ctx).length, 'tag')}`;
	}

	/** Escape: back from one tag to all of them. */
	clearFocus(): boolean {
		if (this.focus === null) return false;
		this.focus = null;
		this.key = '';
		if (this.ctx) this.render(this.ctx);
		return true;
	}

	/**
	 * Rebuilt only when what it shows changes: detection progress re-renders
	 * the tab several times a second, and a card replaced under the pointer
	 * loses its hover and, mid-drag, its place as a drop target.
	 */
	render(ctx: BoardContext): void {
		this.ctx = ctx;
		const tags = this.tags(ctx);
		if (this.focus !== null && this.focus !== '' && !tags.some((t) => tagKey(t) === this.focus))
			this.focus = null;
		const key = JSON.stringify([
			ctx.item.path,
			ctx.shots.length,
			tags,
			this.host.plugin.settings.sceneTags,
			ctx.scenes.map((s) => [s.id, s.index, s.title, s.tags, s.members[0] ?? -1, s.members.length, s.stored, Math.round(s.duration * 10)]),
			this.focus,
		]);
		if (key === this.key) return;
		this.key = key;
		this.renderTags(ctx, tags);
		this.renderGroups(ctx, tags);
	}

	/**
	 * The shared list, then any tag this film's note uses that is not on it —
	 * written by hand, or left behind when the tag was taken off the list
	 * while another film was open.
	 */
	private tags(ctx: BoardContext): string[] {
		const listed = this.host.plugin.settings.sceneTags;
		const keys = new Set(listed.map(tagKey));
		return [...listed, ...tagsUsed(ctx.notes.scenes).filter((t) => !keys.has(tagKey(t)))];
	}

	private isListed(tag: string): boolean {
		const key = tagKey(tag);
		return this.host.plugin.settings.sceneTags.some((t) => tagKey(t) === key);
	}

	// --- the tag list -------------------------------------------------------

	private renderTags(ctx: BoardContext, tags: string[]): void {
		const el = this.tagsEl;
		el.empty();
		const head = el.createDiv({ cls: 'cine-scene-panel-head' });
		head.createSpan({ cls: 'cine-scene-panel-title', text: 'Tags' });
		head.createSpan({ cls: 'cine-scene-panel-count', text: String(tags.length) });

		const list = el.createDiv({ cls: 'cine-board-tag-list' });
		const untagged = ctx.scenes.filter((s) => s.tags.length === 0).length;
		this.renderTagRow(list, null, untagged, false);
		for (const tag of tags)
			this.renderTagRow(
				list,
				tag,
				ctx.scenes.filter((s) => hasTag(s, tag)).length,
				!this.isListed(tag),
			);

		// Typed straight into the list rather than asked for in a dialog: a
		// vocabulary is built a word at a time, and Enter leaves the box ready
		// for the next one.
		const add = el.createDiv({ cls: 'cine-board-tag-add' });
		setIcon(add.createSpan({ cls: 'cine-board-tag-add-icon' }), 'plus');
		const input = add.createEl('input', { type: 'text' });
		input.placeholder = 'Add a tag';
		input.value = this.draft;
		input.addEventListener('input', () => {
			this.draft = input.value;
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				input.value = this.draft = '';
				input.blur();
				e.stopPropagation();
				return;
			}
			if (e.key !== 'Enter' || e.isComposing) return;
			e.preventDefault();
			const text = input.value.trim();
			if (!text) return;
			this.draft = '';
			void this.host.plugin.addSceneTag(text).then(() => {
				// The list was rebuilt; the new box takes the focus back.
				this.tagsEl.querySelector<HTMLInputElement>('.cine-board-tag-add input')?.focus();
			});
		});
		setTooltip(add, 'Type a tag and press Enter. The list is shared by every film.', {
			placement: 'top',
		});
	}

	private renderTagRow(
		list: HTMLElement,
		tag: string | null,
		count: number,
		offList: boolean,
	): void {
		const key = tag === null ? '' : tagKey(tag);
		const row = list.createDiv({ cls: 'cine-scene-row cine-board-tag' });
		row.dataset.tag = tag ?? '';
		row.toggleClass('is-none', tag === null);
		row.toggleClass('is-current', this.focus === key);
		row.toggleClass('is-off-list', offList);
		row.toggleClass('is-empty', count === 0);
		setIcon(row.createSpan({ cls: 'cine-board-tag-icon' }), tag === null ? 'circle-dashed' : 'tag');
		const text = row.createDiv({ cls: 'cine-scene-row-text' });
		text.createDiv({ cls: 'cine-scene-row-title', text: tag ?? 'Untagged' });
		row.createSpan({ cls: 'cine-scene-panel-count', text: String(count) });

		if (tag !== null) {
			const tools = row.createDiv({ cls: 'cine-scene-row-tools' });
			const remove = tools.createEl('button', { cls: 'cine-strip-icon' });
			remove.dataset.tool = 'remove';
			setIcon(remove, 'x');
			setTooltip(
				remove,
				offList
					? 'Take this tag off every scene of this film. It is not on your list.'
					: count > 0
						? `Remove this tag from the list, and from ${plural(count, 'scene')} of this film`
						: 'Remove this tag from the list',
				{ placement: 'right' },
			);
			remove.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.removeTag(tag);
			});
		}

		setTooltip(
			row,
			tag === null
				? 'Show only the scenes with no tag; click again for all of them'
				: offList
					? 'Used in this film’s note but not on your list. Click to show only its scenes.'
					: 'Click to show only these scenes; click again for all of them. Drop a scene here, or drag this onto a scene, to tag it.',
			{ placement: 'right' },
		);
		row.addEventListener('click', () => {
			this.focus = this.focus === key ? null : key;
			this.key = '';
			if (this.ctx) this.render(this.ctx);
		});
		if (tag === null) return;
		this.dragSource(row, () => ({ kind: 'tag', tag }));
		this.dropTarget(
			row,
			(drag) => drag.kind === 'scene',
			(drag) => {
				if (drag.kind === 'scene') void this.setTag(drag.id, tag, true);
			},
		);
	}

	/**
	 * Takes a tag off the list and off this film's scenes, with an undo in
	 * the notice rather than a confirmation before it.
	 *
	 * Other films' notes are not opened: they keep the tag, and show it as
	 * off the list the next time they are looked at, where the same × takes
	 * it off them too. Rewriting every scene note in the vault for one click
	 * is a larger thing than a click should do.
	 */
	private async removeTag(tag: string): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		const plugin = this.host.plugin;
		const position = plugin.settings.sceneTags.findIndex((t) => tagKey(t) === tagKey(tag));
		const carriers = ctx.notes.scenes.filter((s) => hasTag(s, tag)).map((s) => s.id);
		if (carriers.length > 0 && !(await this.host.editNotes((n) => removeTagEverywhere(n, tag))))
			return;
		if (position >= 0) await plugin.removeSceneTag(tag);

		const film = ctx.item.file;
		const undo = createEl('button', { text: 'Undo' });
		const notice = new Notice(
			createFragment((f) => {
				f.appendText(
					carriers.length > 0
						? `Removed “${tag}” from ${plural(carriers.length, 'scene')}. `
						: `Removed “${tag}”. `,
				);
				f.append(undo);
			}),
			10000,
		);
		undo.addEventListener('click', () => {
			notice.hide();
			void (async () => {
				if (position >= 0) {
					await plugin.addSceneTag(tag);
					await plugin.moveSceneTag(tag, position);
				}
				if (carriers.length > 0)
					await plugin.scenes.update(film, (n) =>
						carriers.reduce((acc, id) => setSceneTag(acc, id, tag, true), n),
					);
			})();
		});
	}

	// --- the board ----------------------------------------------------------

	private renderGroups(ctx: BoardContext, tags: string[]): void {
		const scroll = this.groupsEl.scrollTop;
		this.clearStills();
		this.groupsEl.empty();

		if (ctx.scenes.length === 0) {
			this.groupsEl.createDiv({
				cls: 'cine-scene-panel-hint',
				text:
					ctx.shots.length > 0
						? 'No scenes yet. Make them on the Cuts half — select cards and press N — then file them here under tags.'
						: 'Scenes are made from cuts. Find the cuts on the Cuts half first, group them into scenes, then tag them here.',
			});
			return;
		}

		const groups: Group[] = [
			{ tag: null, scenes: ctx.scenes.filter((s) => s.tags.length === 0), offList: false },
			...tags.map((tag) => ({
				tag,
				scenes: ctx.scenes.filter((s) => hasTag(s, tag)),
				offList: !this.isListed(tag),
			})),
		];
		const shown =
			this.focus === null
				? groups
				: groups.filter((g) => (g.tag === null ? '' : tagKey(g.tag)) === this.focus);
		for (const group of shown) {
			// With nothing focused an empty Untagged is noise: every scene is
			// filed, which is the point.
			if (this.focus === null && group.tag === null && group.scenes.length === 0) continue;
			this.renderGroup(ctx, group, tags);
		}
		this.groupsEl.scrollTop = scroll;
	}

	private renderGroup(ctx: BoardContext, group: Group, tags: string[]): void {
		const el = this.groupsEl.createDiv({ cls: 'cine-board-group' });
		el.dataset.tag = group.tag ?? '';
		el.toggleClass('is-empty', group.scenes.length === 0);
		el.toggleClass('is-none', group.tag === null);
		const head = el.createDiv({ cls: 'cine-board-group-head' });
		setIcon(head.createSpan({ cls: 'cine-board-tag-icon' }), group.tag === null ? 'circle-dashed' : 'tag');
		head.createSpan({ cls: 'cine-board-group-title', text: group.tag ?? 'Untagged' });
		head.createSpan({ cls: 'cine-scene-panel-count', text: String(group.scenes.length) });
		if (group.offList) head.createSpan({ cls: 'cine-board-off-list', text: 'not on your list' });

		if (group.scenes.length === 0) {
			el.createDiv({ cls: 'cine-board-empty', text: 'Drag scenes here to tag them.' });
		} else {
			const cards = el.createDiv({ cls: 'cine-board-cards' });
			for (const scene of group.scenes) this.renderCard(cards, ctx, scene, tags);
		}

		const tag = group.tag;
		if (tag === null) return;
		this.dropTarget(
			el,
			(drag) => drag.kind === 'scene',
			(drag) => {
				if (drag.kind === 'scene') void this.setTag(drag.id, tag, true);
			},
		);
	}

	private renderCard(parent: HTMLElement, ctx: BoardContext, scene: Scene, tags: string[]): void {
		const card = parent.createDiv({ cls: 'cine-board-card' });
		card.dataset.id = scene.id;
		card.style.setProperty('--cine-scene-color', this.host.color(scene));

		const frame = card.createDiv({ cls: 'cine-board-still' });
		const first = ctx.shots[scene.members[0] ?? -1];
		if (first) this.still(frame, ctx.item, first);
		const tools = frame.createDiv({ cls: 'cine-board-card-tools' });
		const tool = (icon: string, tooltip: string, action: () => void): void => {
			const button = tools.createEl('button', { cls: 'cine-strip-icon' });
			button.dataset.tool = icon;
			setIcon(button, icon);
			setTooltip(button, tooltip, { placement: 'top' });
			button.addEventListener('click', (e) => {
				e.stopPropagation();
				action();
			});
		};
		if (scene.members.length > 0) tool('play', 'Play it, cut after cut', () => this.host.playScene(scene));
		tool('film', 'Show its cuts on the Cuts half', () => this.host.showInCuts(scene));

		const text = card.createDiv({ cls: 'cine-board-card-text' });
		const title = text.createDiv({ cls: 'cine-scene-row-title', text: sceneTitle(scene) });
		title.toggleClass('is-unnamed', scene.title === '');
		text.createDiv({
			cls: 'cine-scene-row-meta',
			text:
				ctx.shots.length > 0
					? `${plural(scene.members.length, 'cut')}  ·  ${formatLength(scene.duration)}`
					: plural(scene.stored, 'cut'),
		});

		const chips = card.createDiv({ cls: 'cine-board-chips' });
		// A click that misses a chip's × should not start the scene playing.
		chips.addEventListener('click', (e) => e.stopPropagation());
		chips.addEventListener('dblclick', (e) => e.stopPropagation());
		for (const tag of scene.tags) {
			const chip = chips.createSpan({ cls: 'cine-board-chip', text: tag });
			chip.dataset.tag = tag;
			const x = chip.createEl('button', { cls: 'cine-board-chip-x' });
			setIcon(x, 'x');
			setTooltip(x, `Take “${tag}” off this scene`, { placement: 'top' });
			x.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.setTag(scene.id, tag, false);
			});
		}
		const add = chips.createEl('button', { cls: 'cine-board-chip is-add' });
		setIcon(add, 'plus');
		setTooltip(add, 'Tag this scene', { placement: 'top' });
		add.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openTagMenu(e, scene, tags);
		});

		setTooltip(
			card,
			'Click to play it; double-click to show its cuts. Drag it onto a tag to tag it.',
			{ placement: 'top' },
		);
		card.addEventListener('click', () => {
			if (scene.members.length > 0) this.host.playScene(scene);
		});
		card.addEventListener('dblclick', () => this.host.showInCuts(scene));
		card.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.openTagMenu(e, scene, tags);
		});
		this.dragSource(card, () => ({ kind: 'scene', id: scene.id }));
		this.dropTarget(
			card,
			(drag) => drag.kind === 'tag',
			(drag) => {
				if (drag.kind === 'tag') void this.setTag(scene.id, drag.tag, true);
			},
		);
	}

	/** Every tag with a tick on the ones the scene has, and a new one. */
	private openTagMenu(e: MouseEvent, scene: Scene, tags: string[]): void {
		const menu = new Menu();
		for (const tag of tags) {
			const on = hasTag(scene, tag);
			menu.addItem((entry) =>
				entry
					.setTitle(tag)
					.setChecked(on)
					.onClick(() => void this.setTag(scene.id, tag, !on)),
			);
		}
		if (tags.length > 0) menu.addSeparator();
		menu.addItem((entry) =>
			entry
				.setTitle('New tag…')
				.setIcon('plus')
				.onClick(() =>
					new TextPromptModal(this.host.plugin.app, {
						title: `Tag ${sceneTitle(scene)}`,
						hint: 'A new tag, added to the list every film shares.',
						placeholder: 'Over the shoulder, two shot, rapid cuts…',
						value: '',
						onSubmit: (text) => {
							if (!text) return;
							void this.host.plugin.addSceneTag(text).then((listed) => {
								if (listed) void this.setTag(scene.id, listed, true);
							});
						},
					}).open(),
				),
		);
		menu.showAtMouseEvent(e);
	}

	private async setTag(id: string, tag: string, on: boolean): Promise<void> {
		await this.host.editNotes((n) => setSceneTag(n, id, tag, on));
	}

	// --- drag and drop ------------------------------------------------------

	private dragSource(el: HTMLElement, what: () => NonNullable<typeof boardDrag>): void {
		el.draggable = true;
		el.addEventListener('dragstart', (e) => {
			boardDrag = what();
			e.dataTransfer?.setData(
				'text/plain',
				boardDrag.kind === 'tag' ? boardDrag.tag : boardDrag.id,
			);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
			this.root.addClass(boardDrag.kind === 'tag' ? 'is-dragging-tag' : 'is-dragging-scene');
		});
		el.addEventListener('dragend', () => {
			boardDrag = null;
			this.root.removeClass('is-dragging-tag', 'is-dragging-scene');
			for (const lit of Array.from(this.root.querySelectorAll('.is-drop-target')))
				lit.removeClass('is-drop-target');
		});
	}

	private dropTarget(
		el: HTMLElement,
		accepts: (drag: NonNullable<typeof boardDrag>) => boolean,
		drop: (drag: NonNullable<typeof boardDrag>) => void,
	): void {
		const over = (e: DragEvent): void => {
			if (!boardDrag || !accepts(boardDrag)) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			el.addClass('is-drop-target');
		};
		el.addEventListener('dragenter', over);
		el.addEventListener('dragover', over);
		el.addEventListener('dragleave', (e) => {
			if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
			el.removeClass('is-drop-target');
		});
		el.addEventListener('drop', (e) => {
			el.removeClass('is-drop-target');
			const drag = boardDrag;
			if (!drag || !accepts(drag)) return;
			e.preventDefault();
			e.stopPropagation();
			drop(drag);
		});
	}

	// --- stills -------------------------------------------------------------

	/**
	 * The scene's first cut, as its face. A board holds dozens of scenes, not
	 * thousands of cuts, so each asks for its still at once.
	 */
	private still(frame: HTMLElement, item: MediaItem, shot: Shot): void {
		const img = frame.createEl('img', { cls: 'cine-clip-thumb' });
		img.hide();
		const shotItem: MediaItem = { ...item, key: `${item.path}#t=${shot.start}`, shot };
		const thumbs = this.host.plugin.thumbnails;
		const resolved = thumbs.resolve(shotItem, CARD_STILL_WIDTH);
		if (resolved.url) {
			img.src = resolved.url;
			img.show();
			return;
		}
		this.cancels.push(
			thumbs.request(shotItem, resolved.upgrade ?? 0, shot.index, (url) => {
				if (!url) return;
				img.src = url;
				img.show();
			}),
		);
	}

	private clearStills(): void {
		for (const cancel of this.cancels) cancel();
		this.cancels = [];
	}
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
