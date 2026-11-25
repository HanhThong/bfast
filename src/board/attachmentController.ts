// A board's images: the three routes a picture takes into a ticket's `assets/`.
//
// `pickImage` (a host-side dialog — no bytes cross the bridge), `insertImage`
// (a paste, or a drop carrying a `File`, as base64) and `insertImageFromUri` (a
// drag out of the VS Code explorer, which hands over a uri and no bytes). All
// three end in `attach`, and every one answers its `requestId`: the board is
// holding pending state either way.

import * as vscode from 'vscode';
import { errorMessage } from '../platform/errors';
import { unhandled } from '../platform/exhaustive';
import { MAX_IMAGE_BYTES, type TicketToHost } from '../shared/protocol';
import type { BoardHost } from './boardHost';

/** The image messages, out of everything the board's own half sends. */
export type AttachmentMessage = Extract<
	TicketToHost,
	{ type: 'pickImage' | 'insertImage' | 'insertImageFromUri' }
>;

/** What the file dialog offers, and what a dropped uri has to end in. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];

/** Standard base64, which is all `insertImage` may carry. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class AttachmentController {
	constructor(private readonly host: BoardHost) {}

	async handle(message: AttachmentMessage): Promise<void> {
		switch (message.type) {
			case 'pickImage':
				await this.pickImage(message.requestId, message.id);
				break;
			case 'insertImage':
				await this.insertPostedImage(message.requestId, message.id, message.fileName, message.data);
				break;
			case 'insertImageFromUri':
				await this.insertImageFromUri(message.requestId, message.id, message.uri);
				break;
			default:
				unhandled(message);
		}
	}

	/** The toolbar's image button: dialog, read and copy, all on this side. */
	private async pickImage(requestId: string, id: string): Promise<void> {
		const chosen = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Insert image',
			defaultUri: await this.host.store.folderUri?.(id),
			filters: { Images: [...IMAGE_EXTENSIONS] }
		});

		const uri = chosen?.[0];
		if (!uri) {
			// Cancelled. The board is holding pending state either way, so it still
			// needs to hear back — just with nothing to report.
			this.host.post({ type: 'imageFailed', requestId });
			return;
		}

		await this.copyFile(requestId, id, uri);
	}

	/** A paste, or a drop that carried the bytes with it. */
	private async insertPostedImage(
		requestId: string,
		id: string,
		fileName: string,
		data: string
	): Promise<void> {
		// The webview already checked the cap, but it is the untrusted half of the
		// pair — the same reason the host re-validates every `saveSettings`.
		if (!BASE64.test(data)) {
			this.host.post({ type: 'imageFailed', requestId, message: 'That image could not be read.' });
			return;
		}

		// `Buffer.from` discards anything that is not base64 silently, which is
		// why the shape is checked first rather than after.
		const buffer = Buffer.from(data, 'base64');
		if (buffer.byteLength > MAX_IMAGE_BYTES) {
			this.host.post({ type: 'imageFailed', requestId, message: tooLarge(buffer.byteLength) });
			return;
		}

		await this.attach(
			requestId,
			id,
			fileName,
			new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
		);
	}

	/** A drag out of the VS Code explorer, which hands over a uri and no bytes. */
	private async insertImageFromUri(requestId: string, id: string, uri: string): Promise<void> {
		let parsed: vscode.Uri;
		try {
			parsed = vscode.Uri.parse(uri, true);
		} catch {
			this.host.post({ type: 'imageFailed', requestId, message: 'That is not a file this can copy.' });
			return;
		}

		const extension = parsed.path.slice(parsed.path.lastIndexOf('.') + 1).toLowerCase();
		if (parsed.scheme !== 'file' || !IMAGE_EXTENSIONS.includes(extension)) {
			this.host.post({
				type: 'imageFailed',
				requestId,
				message: 'Drop an image file, or use the image button.'
			});
			return;
		}

		await this.copyFile(requestId, id, parsed);
	}

	/** Reads a file off disk, size-checked before it is pulled into memory. */
	private async copyFile(requestId: string, id: string, uri: vscode.Uri): Promise<void> {
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_IMAGE_BYTES) {
				this.host.post({ type: 'imageFailed', requestId, message: tooLarge(stat.size) });
				return;
			}

			const bytes = await vscode.workspace.fs.readFile(uri);
			await this.attach(requestId, id, uri.path, bytes);
		} catch (error) {
			this.host.post({
				type: 'imageFailed',
				requestId,
				message: errorMessage(error, 'That image could not be read.')
			});
		}
	}

	/** Where all three routes end up. */
	private async attach(
		requestId: string,
		id: string,
		fileName: string,
		bytes: Uint8Array
	): Promise<void> {
		try {
			const path = await this.host.store.addAttachment(id, fileName, bytes);
			const name = path.slice(path.lastIndexOf('/') + 1);
			this.host.post({
				type: 'imageInserted',
				requestId,
				path,
				// The alt text follows the name the file actually got, so a
				// de-duplicating suffix shows up in both halves of the link.
				alt: name.slice(0, name.lastIndexOf('.')) || name
			});
			// Deliberately no `onChanged()`: no ticket appeared, moved or was
			// renamed, so refreshing the tree would be pure noise.
		} catch (error) {
			this.host.post({
				type: 'imageFailed',
				requestId,
				message: errorMessage(error, 'That image could not be saved.')
			});
		}
	}
}

function tooLarge(bytes: number): string {
	const megabytes = (bytes / 1024 / 1024).toFixed(1);
	return (
		`That image is ${megabytes} MB. BFAST copies images into the ticket folder, ` +
		`so it caps them at ${MAX_IMAGE_BYTES / 1024 / 1024} MB — link to it instead.`
	);
}
