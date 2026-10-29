/**
 * Fetching pinned model files into the plugin folder.
 *
 * Shared by the sound analysis and the lighting readout. Node's own `https`
 * rather than `requestUrl`, so a file streams to disk with progress instead of
 * sitting whole in memory.
 */

import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { rename, rm } from 'fs/promises';
import { get as httpsGet } from 'https';

/**
 * A model file one of the analyses needs, pinned to one exact build.
 *
 * Each URL names a fixed revision rather than a branch, and the bytes are
 * checked against the SHA-256 of the files the analysis was verified with, so
 * an upstream change can never swap in a different network unnoticed.
 */
export interface ModelFile {
	name: string;
	url: string;
	bytes: number;
	sha256: string;
}

/**
 * Streams `model.url` to `target`, following redirects, and only moves it into
 * place once its size and SHA-256 match.
 */
export function fetchVerified(
	model: ModelFile,
	target: string,
	onBytes: (received: number) => void,
): Promise<void> {
	const part = `${target}.part`;
	return new Promise<void>((resolve, reject) => {
		const request = (url: string, redirects: number): void => {
			httpsGet(
				url,
				{ headers: { 'User-Agent': 'obsidian-cinema-canvas' } },
				(response) => {
					const status = response.statusCode ?? 0;
					const location = response.headers.location;
					if (status >= 300 && status < 400 && location) {
						response.resume();
						if (redirects <= 0) {
							reject(new Error(`Too many redirects fetching ${model.name}.`));
							return;
						}
						request(new URL(location, url).toString(), redirects - 1);
						return;
					}
					if (status !== 200) {
						response.resume();
						reject(new Error(`Fetching ${model.name} failed: HTTP ${status}.`));
						return;
					}
					const hash = createHash('sha256');
					const out = createWriteStream(part);
					let received = 0;
					response.on('data', (chunk: Buffer) => {
						hash.update(chunk);
						received += chunk.length;
						onBytes(received);
					});
					response.on('error', (err) => {
						out.destroy();
						reject(err);
					});
					out.on('error', reject);
					out.on('finish', () => {
						void (async () => {
							const digest = hash.digest('hex');
							if (received !== model.bytes || digest !== model.sha256) {
								await rm(part, { force: true });
								reject(
									new Error(
										`${model.name} did not match the expected file (${received} bytes, sha256 ${digest.slice(0, 12)}…). Nothing was installed.`,
									),
								);
								return;
							}
							await rename(part, target);
							resolve();
						})().catch(reject);
					});
					response.pipe(out);
				},
			).on('error', reject);
		};
		request(model.url, 5);
	});
}
