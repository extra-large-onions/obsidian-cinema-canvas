import { App, Component, TAbstractFile, TFile } from 'obsidian';
import {
	EMPTY_NOTES,
	FilmNotes,
	filmPathForNote,
	formatBlock,
	notePathFor,
	parseNotes,
	writeNotes,
} from './scenes';

interface Entry {
	notes: FilmNotes;
	error: string | null;
}

/**
 * The scenes and cut labels of every film, read from and written to a note
 * beside the film.
 *
 * Unlike the shot and sound caches this is not rebuildable — it is your own
 * work — so it lives with the film as an ordinary note. It syncs and versions
 * with the vault, survives clearing every cache, and can be read without the
 * plugin. The note is `<film file name>.scenes.md`, and the plugin owns exactly
 * one fenced `cinema-scenes` block inside it: anything else written in the note
 * is left alone.
 */
export class SceneStore extends Component {
	/** Film path -> what its note says. Absent means not read yet. */
	private readonly entries = new Map<string, Entry>();
	/** Bumped per read, so a slow read never overwrites a newer one. */
	private readonly reads = new Map<string, number>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly app: App) {
		super();
	}

	override onload(): void {
		const vault = this.app.vault;
		this.registerEvent(vault.on('modify', (file) => this.onNoteChanged(file)));
		this.registerEvent(vault.on('create', (file) => this.onNoteChanged(file)));
		this.registerEvent(vault.on('delete', (file) => this.onDelete(file)));
		this.registerEvent(
			vault.on('rename', (file, oldPath) => void this.onRename(file, oldPath)),
		);
	}

	override onunload(): void {
		this.listeners.clear();
		this.entries.clear();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * What the film's note says.
	 *
	 * Never null: a film without a note simply has no scenes. The first call for
	 * a film starts reading its note and returns empty notes; `onChange` fires
	 * when the read lands.
	 */
	get(film: TFile): FilmNotes {
		const entry = this.entries.get(film.path);
		if (entry) return entry.notes;
		if (!this.reads.has(film.path)) void this.readNote(film.path);
		return EMPTY_NOTES;
	}

	/** True once the note has been read, or found not to exist. */
	isLoaded(film: TFile): boolean {
		return this.entries.has(film.path);
	}

	/**
	 * Why the note's block could not be read, or null.
	 *
	 * While this is set every edit is refused, so a half-typed hand edit in the
	 * note is never overwritten.
	 */
	errorFor(film: TFile): string | null {
		return this.entries.get(film.path)?.error ?? null;
	}

	notePath(film: TFile): string {
		return notePathFor(film.path);
	}

	/**
	 * Applies `change` to the film's notes and writes the note, creating it the
	 * first time.
	 *
	 * The change is applied to what is on disk at the moment of writing, not to
	 * what was last read, so an edit made in the note a second ago is kept.
	 *
	 * @returns false when nothing was written because the block does not parse.
	 */
	async update(
		film: TFile,
		change: (notes: FilmNotes) => FilmNotes,
	): Promise<boolean> {
		const path = notePathFor(film.path);
		const note = this.app.vault.getFileByPath(path);
		if (!note) {
			const notes = change(EMPTY_NOTES);
			await this.app.vault.create(path, this.newNote(film, path, notes));
			this.set(film.path, { notes, error: null });
			return true;
		}

		const outcome: { notes: FilmNotes | null; error: string | null } = {
			notes: null,
			error: null,
		};
		await this.app.vault.process(note, (data) => {
			const parsed = parseNotes(data);
			if (parsed.error) {
				outcome.error = parsed.error;
				return data;
			}
			outcome.notes = change(parsed.notes ?? EMPTY_NOTES);
			return writeNotes(data, outcome.notes);
		});
		if (!outcome.notes) {
			this.set(film.path, {
				notes: this.entries.get(film.path)?.notes ?? EMPTY_NOTES,
				error: outcome.error,
			});
			return false;
		}
		this.set(film.path, { notes: outcome.notes, error: null });
		return true;
	}

	// --- internals ------------------------------------------------------------

	/**
	 * Not `load`: that is `Component.load()`, which `addChild` calls to run
	 * `onload`, and shadowing it would leave the vault listeners unregistered.
	 */
	private async readNote(filmPath: string): Promise<void> {
		const read = (this.reads.get(filmPath) ?? 0) + 1;
		this.reads.set(filmPath, read);
		let entry: Entry;
		try {
			const note = this.app.vault.getFileByPath(notePathFor(filmPath));
			if (!note) {
				entry = { notes: EMPTY_NOTES, error: null };
			} else {
				const parsed = parseNotes(await this.app.vault.read(note));
				entry = {
					// A block that stopped parsing keeps showing the last good
					// scenes, with the error beside them, until it is fixed.
					notes:
						parsed.notes ??
						(parsed.error ? this.entries.get(filmPath)?.notes : null) ??
						EMPTY_NOTES,
					error: parsed.error,
				};
			}
		} catch (err) {
			entry = {
				notes: this.entries.get(filmPath)?.notes ?? EMPTY_NOTES,
				error: `The scene note could not be read (${err instanceof Error ? err.message : String(err)}).`,
			};
		}
		if (this.reads.get(filmPath) !== read) return;
		this.set(filmPath, entry);
	}

	private set(filmPath: string, entry: Entry): void {
		this.entries.set(filmPath, entry);
		for (const listener of this.listeners) listener();
	}

	/** A note written or edited by hand: re-read it, if its film is being shown. */
	private onNoteChanged(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const film = filmPathForNote(file.path);
		if (film === null || !this.reads.has(film)) return;
		void this.readNote(film);
	}

	private onDelete(file: TAbstractFile): void {
		const noteOf = filmPathForNote(file.path);
		if (noteOf !== null && this.reads.has(noteOf)) {
			this.set(noteOf, { notes: EMPTY_NOTES, error: null });
			return;
		}
		this.entries.delete(file.path);
		this.reads.delete(file.path);
	}

	/**
	 * Keeps a film and its note together.
	 *
	 * Renaming or moving a film renames its note to match, through the file
	 * manager so links to the note follow. Renaming the note by hand detaches
	 * it, and both films involved are re-read.
	 */
	private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(file instanceof TFile)) return;
		const renamedNote = filmPathForNote(oldPath);
		if (renamedNote !== null) {
			for (const film of [renamedNote, filmPathForNote(file.path)])
				if (film !== null && this.reads.has(film)) void this.readNote(film);
			return;
		}

		const oldNote = this.app.vault.getFileByPath(notePathFor(oldPath));
		// Every file in the vault passes through here; only a film with a note,
		// or one a view has asked about, is any of this store's business.
		if (!oldNote && !this.reads.has(oldPath)) return;
		const target = notePathFor(file.path);
		// A folder move carries the note along with the film, so by the time
		// the film's event arrives the note may already be where it belongs.
		if (oldNote && !this.app.vault.getFileByPath(target)) {
			try {
				await this.app.fileManager.renameFile(oldNote, target);
			} catch (err) {
				console.error('Cinema canvas: could not move the scene note', err);
			}
		}
		const entry = this.entries.get(oldPath);
		this.entries.delete(oldPath);
		this.reads.delete(oldPath);
		if (entry) this.set(file.path, entry);
		void this.readNote(file.path);
	}

	private newNote(film: TFile, notePath: string, notes: FilmNotes): string {
		const link = this.app.fileManager.generateMarkdownLink(film, notePath);
		return [
			`Scenes and cut labels for ${link}.`,
			'',
			'Cinema Canvas reads and writes only the block below. Name scenes and label cuts in the cut view, or edit the block by hand: times are seconds from the start of the film. Anything else in this note is yours.',
			'',
			formatBlock(notes),
			'',
		].join('\n');
	}
}
