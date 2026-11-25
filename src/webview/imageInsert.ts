// Getting an image from a paste, a drop or a file dialog into a shape the host
// can write. Kept out of the components so they stay about rendering.

import { MAX_IMAGE_BYTES } from '../shared/protocol';

/** Extensions the host will accept from a dropped uri. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];

/** What the board asks the host to copy into the ticket's `assets/` folder. */
export type ImageSource =
	| { kind: 'pick' }
	| { kind: 'bytes'; fileName: string; data: string }
	| { kind: 'uri'; uri: string };

/** What a drop turned out to be carrying. */
export type DropPayload =
	| { kind: 'file'; file: File }
	| { kind: 'uri'; uri: string }
	/** Ordinary text: leave it to the browser, which will insert it for us. */
	| { kind: 'text' }
	| { kind: 'unsupported' };

function isImageFile(file: File): boolean {
	return file.type.startsWith('image/') || hasImageExtension(file.name);
}

/**
 * What to do with a drop.
 *
 * A drag from the OS file manager arrives as a real `File`. A drag out of the
 * VS Code explorer usually does not: the workbench puts `text/uri-list` on the
 * transfer instead, and Electron no longer exposes a path on the `File`, so the
 * uri is all there is to go on and the host has to read it.
 */
export function readDrop(dataTransfer: DataTransfer): DropPayload {
	const file = [...dataTransfer.files].find(isImageFile);
	if (file) {
		return { kind: 'file', file };
	}

	const uri = firstUri(dataTransfer.getData('text/uri-list'));
	if (uri) {
		return { kind: 'uri', uri };
	}

	// A text drop is a normal textarea drop; the browser does it better than we
	// would, so it is left alone.
	if (dataTransfer.types.includes('text/plain')) {
		return { kind: 'text' };
	}

	return { kind: 'unsupported' };
}

/** The image on the clipboard, if a paste carried one. */
export function readPaste(clipboardData: DataTransfer | null): File | undefined {
	if (!clipboardData) {
		return undefined;
	}

	for (const item of clipboardData.items) {
		if (item.kind === 'file' && item.type.startsWith('image/')) {
			const file = item.getAsFile();
			if (file) {
				return file;
			}
		}
	}

	return undefined;
}

/**
 * The file as base64. A webview may only post strings and json-serializable
 * values back to the extension, so the bytes cannot travel as a typed array.
 */
export async function toBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());

	// `String.fromCharCode(...bytes)` overflows the argument stack well before
	// the size cap, so the string is built a chunk at a time.
	const CHUNK = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}

	return btoa(binary);
}

/** A screenshot has no name worth keeping, so it gets a datestamped one. */
export function pastedFileName(mimeType: string): string {
	const subtype = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
	const now = new Date();
	const stamp = [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		'-',
		pad(now.getHours()),
		pad(now.getMinutes()),
		pad(now.getSeconds())
	].join('');

	return `pasted-${stamp}.${subtype}`;
}

export function tooLargeMessage(bytes: number): string {
	const megabytes = (bytes / 1024 / 1024).toFixed(1);
	return (
		`That image is ${megabytes} MB. BFAST copies images into the ticket folder, ` +
		`so it caps them at ${MAX_IMAGE_BYTES / 1024 / 1024} MB — link to it instead.`
	);
}

function pad(value: number): string {
	return `${value}`.padStart(2, '0');
}

function hasImageExtension(name: string): boolean {
	const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	return IMAGE_EXTENSIONS.includes(extension);
}

/** The first real entry of a `text/uri-list`, whose `#` lines are comments. */
function firstUri(uriList: string): string | undefined {
	const line = uriList
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry !== '' && !entry.startsWith('#'));

	return line && hasImageExtension(line) ? line : undefined;
}
