import { MediaKind } from '../types';

export const DEFAULT_IMAGE_EXTENSIONS = [
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'bmp',
	'svg',
	'tif',
	'tiff',
	'heic',
	'heif',
];

export const DEFAULT_VIDEO_EXTENSIONS = [
	'mp4',
	'mov',
	'webm',
	'mkv',
	'm4v',
	'avi',
	'ogv',
];

/** Splits a comma/whitespace separated extension list into lowercase, dotless entries. */
export function parseExtensionList(raw: string): string[] {
	return raw
		.split(/[,\s]+/)
		.map((e) => e.trim().toLowerCase().replace(/^\./, ''))
		.filter((e) => e.length > 0);
}

export interface ExtensionTable {
	kindOf(extension: string): MediaKind | null;
}

export function buildExtensionTable(opts: {
	includeImages: boolean;
	includeVideos: boolean;
	extraImageExtensions: string;
	extraVideoExtensions: string;
}): ExtensionTable {
	const images = new Set<string>();
	const videos = new Set<string>();

	if (opts.includeImages) {
		for (const e of DEFAULT_IMAGE_EXTENSIONS) images.add(e);
		for (const e of parseExtensionList(opts.extraImageExtensions))
			images.add(e);
	}
	if (opts.includeVideos) {
		for (const e of DEFAULT_VIDEO_EXTENSIONS) videos.add(e);
		for (const e of parseExtensionList(opts.extraVideoExtensions))
			videos.add(e);
	}

	return {
		kindOf(extension: string): MediaKind | null {
			const ext = extension.toLowerCase();
			if (images.has(ext)) return 'image';
			if (videos.has(ext)) return 'video';
			return null;
		},
	};
}
