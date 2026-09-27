import type { Shot } from '../types';

/**
 * Scenes and cut labels: the first thing in this plugin made by hand rather
 * than detected.
 *
 * Both are anchored to **times**, never to cut numbers. A cut's number is only
 * its position in a list the confidence slider rebuilds on every drag, so
 * "cut 412" names a different frame after a retune, and 1:02:05.4 does not.
 *
 * - A **scene** is any set of cuts you choose, with a title. Its cuts need not
 *   be next to each other, and one cut can be in any number of scenes — a
 *   scene here is a grouping you make ("every shot of the Marquis", "the
 *   stagecoach"), not a division of the film. Each cut in it is stored as the
 *   time of its middle, and shown as whichever cut contains that time now.
 *   The middle rather than the start, because a start sits on the boundary
 *   itself, and a re-detection that moves the boundary by a millisecond would
 *   put it in the cut before.
 * - A **tag** is a word you file scenes under: "over the shoulder", "rapid
 *   cuts", "two shot". A scene has any number of them. Tags belong to scenes,
 *   not to cuts, and are kept as written; two tags that differ only in case
 *   are the same tag.
 * - A **label** is a line of text at the start of the cut it was written on.
 *   It is shown on whichever cut contains that time, so raising the confidence
 *   until its cut disappears moves the label onto the cut that swallowed it
 *   instead of losing it.
 *
 * Everything in this file is pure; `scene-store.ts` does the reading and
 * writing.
 */

export interface SceneDef {
	/**
	 * Identity: tabs, the panel and edits refer to a scene by this, since its
	 * title can change, repeat, or be empty.
	 */
	id: string;
	/** Empty until named; shown as "Scene N". */
	title: string;
	/**
	 * Seconds, to the millisecond: one time inside each cut of the scene, in
	 * film order. Two times can land in one cut after a retune; the cut is
	 * then shown once, and both times are kept.
	 */
	cuts: number[];
	/** Tags as written, in the order they were added, without repeats. */
	tags: string[];
}

export interface CutLabel {
	/** Seconds: the start of the cut the label was written on. */
	at: number;
	text: string;
}

/** Everything the note beside a film records. */
export interface FilmNotes {
	scenes: SceneDef[];
	labels: CutLabel[];
}

export const EMPTY_NOTES: FilmNotes = Object.freeze({
	scenes: [],
	labels: [],
});

/** One scene as it falls on the current cuts. */
export interface Scene {
	id: string;
	/** Position in the note's list, 0-based. */
	index: number;
	title: string;
	tags: string[];
	/** Indexes into the film's shot list, ascending and without repeats. */
	members: number[];
	/** How many cut times the note stores, shown or not. */
	stored: number;
	/** The members' lengths added up: how long the scene plays. */
	duration: number;
	/** The first member's start and the last member's end; 0 when empty. */
	start: number;
	end: number;
}

/** Stored times are kept to the millisecond, so closer than this is the same. */
const SAME_TIME = 0.0005;

export const roundTime = (t: number): number => Math.round(t * 1000) / 1000;

export function sceneTitle(scene: Pick<Scene, 'title' | 'index'>): string {
	return scene.title || `Scene ${scene.index + 1}`;
}

/** The time a cut is stored as inside a scene: its middle. */
export function anchorOf(shot: Pick<Shot, 'start' | 'end'>): number {
	return roundTime((shot.start + shot.end) / 2);
}

/**
 * Index of the cut containing `time`, or -1 when the time is outside the film.
 * `shots` is sorted and contiguous.
 */
export function shotAt(shots: readonly Shot[], time: number): number {
	let lo = 0;
	let hi = shots.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const shot = shots[mid];
		if (!shot) return -1;
		if (time < shot.start) hi = mid - 1;
		else if (time >= shot.end) lo = mid + 1;
		else return mid;
	}
	return -1;
}

/** Lays every stored scene over the current cuts, in the note's order. */
export function buildScenes(shots: readonly Shot[], defs: readonly SceneDef[]): Scene[] {
	return defs.map((def, index) => {
		const members = membersOf(shots, def.cuts);
		let duration = 0;
		for (const i of members) {
			const shot = shots[i];
			if (shot) duration += shot.end - shot.start;
		}
		const first = shots[members[0] ?? -1];
		const last = shots[members[members.length - 1] ?? -1];
		return {
			id: def.id,
			index,
			title: def.title,
			tags: def.tags,
			members,
			stored: def.cuts.length,
			duration,
			start: first?.start ?? 0,
			end: last?.end ?? 0,
		};
	});
}

function membersOf(shots: readonly Shot[], times: readonly number[]): number[] {
	const found = new Set<number>();
	for (const time of times) {
		const i = shotAt(shots, time);
		if (i >= 0) found.add(i);
	}
	return [...found].sort((a, b) => a - b);
}

export function findScene(scenes: readonly Scene[], id: string | null): Scene | null {
	if (id === null) return null;
	return scenes.find((s) => s.id === id) ?? null;
}

/** Every scene a cut is in, in the note's order. */
export function scenesWith(scenes: readonly Scene[], shotIndex: number): Scene[] {
	return scenes.filter((s) => hasMember(s, shotIndex));
}

/** Binary search: `members` is sorted. */
export function hasMember(scene: Pick<Scene, 'members'>, shotIndex: number): boolean {
	const { members } = scene;
	let lo = 0;
	let hi = members.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const at = members[mid] ?? -1;
		if (at === shotIndex) return true;
		if (at < shotIndex) lo = mid + 1;
		else hi = mid - 1;
	}
	return false;
}

/**
 * A scene's cuts as ranges to play, with neighbouring cuts joined into one.
 *
 * Playing two adjacent cuts as separate segments would pause on the last frame
 * of the first and seek into the second — a visible hitch at a cut the film
 * itself plays straight through.
 */
export function playRanges(
	shots: readonly Shot[],
	members: readonly number[],
): { start: number; end: number; first: number }[] {
	const ranges: { start: number; end: number; first: number }[] = [];
	let previous = -2;
	for (const i of members) {
		const shot = shots[i];
		if (!shot) continue;
		const open = ranges[ranges.length - 1];
		if (open && i === previous + 1) open.end = shot.end;
		else ranges.push({ start: shot.start, end: shot.end, first: i });
		previous = i;
	}
	return ranges;
}

/**
 * Every scene each cut is in, keyed by cut index.
 *
 * Built once per render: asking every scene about every card is scenes × cuts
 * lookups, and a grouped film has dozens of the one and a thousand of the other.
 */
export function scenesByShot(scenes: readonly Scene[]): Map<number, Scene[]> {
	const map = new Map<number, Scene[]>();
	for (const scene of scenes)
		for (const i of scene.members) {
			const list = map.get(i);
			if (list) list.push(scene);
			else map.set(i, [scene]);
		}
	return map;
}

/**
 * Labels keyed by the cut each is shown on, earliest first: the same answer as
 * `labelsIn` for every cut at once.
 */
export function labelsByShot(
	shots: readonly Shot[],
	labels: readonly CutLabel[],
): Map<number, CutLabel[]> {
	const map = new Map<number, CutLabel[]>();
	for (const label of [...labels].sort((a, b) => a.at - b.at)) {
		// `labelsIn` counts a label as inside [start - ε, end - ε).
		const i = shotAt(shots, label.at + SAME_TIME);
		if (i < 0) continue;
		const list = map.get(i);
		if (list) list.push(label);
		else map.set(i, [label]);
	}
	return map;
}

/** Every label inside `[start, end)`, earliest first. */
export function labelsIn(
	labels: readonly CutLabel[],
	start: number,
	end: number,
): CutLabel[] {
	return labels
		.filter((l) => l.at >= start - SAME_TIME && l.at < end - SAME_TIME)
		.sort((a, b) => a.at - b.at);
}

/**
 * A short id not already used in the note.
 *
 * Random rather than counted, so two edits made at once — a hand edit and the
 * view, or two synced devices — are unlikely to pick the same one.
 */
export function newSceneId(
	notes: FilmNotes,
	random: () => number = Math.random,
): string {
	const taken = new Set(notes.scenes.map((s) => s.id));
	for (;;) {
		const id = Math.floor(random() * 36 ** 6)
			.toString(36)
			.padStart(6, '0');
		if (!taken.has(id)) return id;
	}
}

// --- edits -------------------------------------------------------------------
// Each returns new notes and leaves its argument untouched. Cut arguments are
// indexes into `shots`, the cut list the edit was made on.

/** Adds a scene at the end of the list, holding `indexes`. */
export function addScene(
	notes: FilmNotes,
	shots: readonly Shot[],
	id: string,
	title: string,
	indexes: readonly number[] = [],
): FilmNotes {
	const scene: SceneDef = { id, title, cuts: [], tags: [] };
	return {
		...notes,
		scenes: [...notes.scenes, withCuts(scene, shots, indexes)],
	};
}

export function renameScene(notes: FilmNotes, id: string, title: string): FilmNotes {
	return mapScene(notes, id, (s) => ({ ...s, title }));
}

export function deleteScene(notes: FilmNotes, id: string): FilmNotes {
	return { ...notes, scenes: notes.scenes.filter((s) => s.id !== id) };
}

/** Puts a deleted scene back where it was. */
export function restoreScene(
	notes: FilmNotes,
	scene: SceneDef,
	index: number,
): FilmNotes {
	if (notes.scenes.some((s) => s.id === scene.id)) return notes;
	const scenes = [...notes.scenes];
	scenes.splice(Math.min(Math.max(index, 0), scenes.length), 0, scene);
	return { ...notes, scenes };
}

/** Adds cuts to a scene; a cut already in it is left as it is. */
export function addCuts(
	notes: FilmNotes,
	shots: readonly Shot[],
	id: string,
	indexes: readonly number[],
): FilmNotes {
	return mapScene(notes, id, (s) => withCuts(s, shots, indexes));
}

/**
 * Takes cuts out of a scene.
 *
 * Every stored time inside each cut goes, not only the one the cut is shown
 * by: a cut is shown once however many of its times are stored, so leaving
 * one behind would leave the cut in.
 */
export function removeCuts(
	notes: FilmNotes,
	shots: readonly Shot[],
	id: string,
	indexes: readonly number[],
): FilmNotes {
	const drop = new Set(indexes);
	return mapScene(notes, id, (s) => ({
		...s,
		cuts: s.cuts.filter((t) => !drop.has(shotAt(shots, t))),
	}));
}

/** Tags are one tag whatever their case: "Two shot" and "two shot". */
export function tagKey(tag: string): string {
	return tag.trim().toLocaleLowerCase();
}

export function hasTag(scene: Pick<SceneDef, 'tags'>, tag: string): boolean {
	const key = tagKey(tag);
	return scene.tags.some((t) => tagKey(t) === key);
}

/** Every tag the film's scenes use, as first written, in order of first use. */
export function tagsUsed(scenes: readonly Pick<SceneDef, 'tags'>[]): string[] {
	const seen = new Map<string, string>();
	for (const scene of scenes)
		for (const tag of scene.tags) if (!seen.has(tagKey(tag))) seen.set(tagKey(tag), tag);
	return [...seen.values()];
}

/** Puts a tag on a scene, or takes it off: `on` says which. */
export function setSceneTag(
	notes: FilmNotes,
	id: string,
	tag: string,
	on: boolean,
): FilmNotes {
	const text = tag.trim();
	if (!text) return notes;
	return mapScene(notes, id, (s) => {
		if (hasTag(s, text) === on) return s;
		const key = tagKey(text);
		return {
			...s,
			tags: on ? [...s.tags, text] : s.tags.filter((t) => tagKey(t) !== key),
		};
	});
}

/** Takes a tag off every scene of the film. */
export function removeTagEverywhere(notes: FilmNotes, tag: string): FilmNotes {
	const key = tagKey(tag);
	if (!notes.scenes.some((s) => hasTag(s, tag))) return notes;
	return {
		...notes,
		scenes: notes.scenes.map((s) =>
			hasTag(s, tag) ? { ...s, tags: s.tags.filter((t) => tagKey(t) !== key) } : s,
		),
	};
}

/**
 * Sets the label of one cut; empty text removes it.
 *
 * Every label inside the cut is replaced, because they are shown joined as one
 * and the prompt was filled with that joined text.
 */
export function setLabel(
	notes: FilmNotes,
	shot: Pick<Shot, 'start' | 'end'>,
	text: string,
): FilmNotes {
	const kept = notes.labels.filter(
		(l) => !(l.at >= shot.start - SAME_TIME && l.at < shot.end - SAME_TIME),
	);
	const labels = text ? [...kept, { at: roundTime(shot.start), text }] : kept;
	return { ...notes, labels: labels.sort((a, b) => a.at - b.at) };
}

function mapScene(
	notes: FilmNotes,
	id: string,
	change: (scene: SceneDef) => SceneDef,
): FilmNotes {
	const at = notes.scenes.findIndex((s) => s.id === id);
	const scene = notes.scenes[at];
	if (!scene) return notes;
	const changed = change(scene);
	// Nothing to add, or nothing to rename: the same notes, so a no-op is
	// visibly one.
	if (changed === scene) return notes;
	const scenes = [...notes.scenes];
	scenes[at] = changed;
	return { ...notes, scenes };
}

function withCuts(
	scene: SceneDef,
	shots: readonly Shot[],
	indexes: readonly number[],
): SceneDef {
	const present = new Set(membersOf(shots, scene.cuts));
	const added: number[] = [];
	for (const i of indexes) {
		const shot = shots[i];
		if (!shot || present.has(i)) continue;
		present.add(i);
		added.push(anchorOf(shot));
	}
	if (added.length === 0) return scene;
	return { ...scene, cuts: [...scene.cuts, ...added].sort((a, b) => a - b) };
}

// --- the note ----------------------------------------------------------------

/** The fenced block the plugin owns inside a film's note. */
export const BLOCK_LANGUAGE = 'cinema-scenes';

/** A film's note is its own file name plus this: `Heat.mkv.scenes.md`. */
export const NOTE_SUFFIX = '.scenes.md';

/**
 * The note beside a film.
 *
 * The film's extension is kept in the name, so `Heat.mkv` and `Heat.mp4` in one
 * folder never share a note, and the film can be found from its note by
 * removing the suffix.
 */
export function notePathFor(filmPath: string): string {
	return `${filmPath}${NOTE_SUFFIX}`;
}

export function filmPathForNote(notePath: string): string | null {
	return notePath.endsWith(NOTE_SUFFIX)
		? notePath.slice(0, -NOTE_SUFFIX.length)
		: null;
}

// `\r?` because a note saved by another editor on Windows may have CRLF endings.
const BLOCK = /^```cinema-scenes[^\n]*\n([\s\S]*?)^```[ \t]*\r?$/m;

const SCENE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ParsedNotes {
	/** Null when there is no block, or when it could not be read. */
	notes: FilmNotes | null;
	/**
	 * Why the block could not be read. While this is set nothing is written:
	 * the block is hand-editable, and a half-finished edit must never be
	 * overwritten with whatever the plugin last had in memory.
	 */
	error: string | null;
}

/** Finds and reads the `cinema-scenes` block in a note. */
export function parseNotes(markdown: string): ParsedNotes {
	const match = BLOCK.exec(markdown);
	if (!match) return { notes: null, error: null };
	return parseBlock(match[1] ?? '');
}

/**
 * Reads the JSON inside a `cinema-scenes` block.
 *
 * Strict on purpose: an entry that does not read is an error, not skipped,
 * because skipping it and writing the rest back would delete it.
 */
export function parseBlock(source: string): ParsedNotes {
	const fail = (error: string): ParsedNotes => ({ notes: null, error });
	let raw: unknown;
	try {
		raw = JSON.parse(source.trim() || '{}');
	} catch (err) {
		return fail(
			`The ${BLOCK_LANGUAGE} block is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
		);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return fail(`The ${BLOCK_LANGUAGE} block should be one JSON object.`);
	const { scenes: rawScenes = [], labels: rawLabels = [] } = raw as {
		scenes?: unknown;
		labels?: unknown;
	};
	if (!Array.isArray(rawScenes) || !Array.isArray(rawLabels))
		return fail('"scenes" and "labels" should both be lists.');

	const isTime = (v: unknown): v is number =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0;
	const scenes: SceneDef[] = [];
	const ids = new Set<string>();
	for (const [i, entry] of rawScenes.entries()) {
		const { id, title = '', cuts = [], tags = [] } = (entry ?? {}) as {
			id?: unknown;
			title?: unknown;
			cuts?: unknown;
			tags?: unknown;
		};
		if (
			typeof id !== 'string' ||
			!SCENE_ID.test(id) ||
			typeof title !== 'string' ||
			!Array.isArray(cuts) ||
			!cuts.every(isTime) ||
			!Array.isArray(tags) ||
			!tags.every((t) => typeof t === 'string')
		)
			return fail(
				`Scene ${i + 1} should look like {"id": "a1b2c3", "title": "…", "cuts": [12.5, 80.25], "tags": ["two shot"]}: an id of letters, digits, - or _, each cut as a time in seconds inside it, and tags as text (they can be left out).`,
			);
		if (ids.has(id))
			return fail(`Two scenes have the id "${id}"; each needs its own.`);
		ids.add(id);
		scenes.push({
			id,
			title,
			cuts: [...cuts].sort((a, b) => a - b),
			tags: tagsUsed([{ tags: tags.map((t) => t.trim()).filter(Boolean) }]),
		});
	}
	const labels: CutLabel[] = [];
	for (const [i, entry] of rawLabels.entries()) {
		const { at, text } = (entry ?? {}) as { at?: unknown; text?: unknown };
		if (!isTime(at) || typeof text !== 'string')
			return fail(
				`Label ${i + 1} should look like {"at": 12.5, "text": "…"}, with at in seconds.`,
			);
		labels.push({ at, text });
	}
	return {
		notes: { scenes, labels: labels.sort((a, b) => a.at - b.at) },
		error: null,
	};
}

/** The block as written: one scene or label per line, so a diff reads well. */
export function formatBlock(notes: FilmNotes): string {
	const list = (items: object[]): string =>
		items.length === 0
			? '[]'
			: `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`;
	return [
		'```' + BLOCK_LANGUAGE,
		'{',
		// Tags only where there are some, so a note written before tags existed
		// reads the same after its first edit.
		`  "scenes": ${list(notes.scenes.map((s) => (s.tags.length > 0 ? { id: s.id, title: s.title, tags: s.tags, cuts: s.cuts } : { id: s.id, title: s.title, cuts: s.cuts })))},`,
		`  "labels": ${list(notes.labels.map((l) => ({ at: l.at, text: l.text })))}`,
		'}',
		'```',
	].join('\n');
}

/** Replaces the block in `markdown`, or appends one; everything else is kept. */
export function writeNotes(markdown: string, notes: FilmNotes): string {
	const block = formatBlock(notes);
	// A function, not a string: a title containing `$&` would otherwise be
	// read as a replacement pattern.
	if (BLOCK.test(markdown)) return markdown.replace(BLOCK, () => block);
	const gap =
		markdown.length === 0 || markdown.endsWith('\n\n')
			? ''
			: markdown.endsWith('\n')
				? '\n'
				: '\n\n';
	return `${markdown}${gap}${block}\n`;
}
