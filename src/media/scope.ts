/**
 * Folder scope: the comma-separated folder list from settings.
 * Empty list means "the whole vault". Matching is recursive and
 * case-insensitive, so `src/` also covers `src/2024/b-roll`.
 */
export class FolderScope {
	/** Normalized, lowercase folder prefixes. Empty array = whole vault. */
	private readonly prefixes: string[];

	constructor(raw: string) {
		this.prefixes = FolderScope.parse(raw);
	}

	static parse(raw: string): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const part of raw.split(',')) {
			const normalized = part
				.trim()
				.replace(/\\/g, '/')
				.replace(/^\/+/, '')
				.replace(/\/+$/, '')
				.toLowerCase();
			// A lone "/" or "." means the vault root, which is the whole vault.
			if (normalized === '' || normalized === '.') continue;
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			out.push(normalized);
		}
		return out;
	}

	get isWholeVault(): boolean {
		return this.prefixes.length === 0;
	}

	/** Folder list as configured, for display. */
	get folders(): readonly string[] {
		return this.prefixes;
	}

	/** True when a vault-relative file path falls inside the scope. */
	includes(path: string): boolean {
		if (this.isWholeVault) return true;
		const lower = path.toLowerCase();
		return this.prefixes.some(
			(p) => lower === p || lower.startsWith(p + '/'),
		);
	}
}
