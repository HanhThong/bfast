// A zip reader for one purpose: a Playwright `trace.zip`, read on the host so
// the board can show what is inside. Hand-rolled, like `yaml.ts` and
// `webmDemux.ts`, because the one runtime dependency this extension carries is
// the optional Agent SDK and that stays true; `zlib` is Node's own.
//
// Two facts about the file decide the shape:
// - Playwright writes it with yazl, streaming: the local file headers carry
//   zeroed sizes and CRC (general-purpose bit 3, a data descriptor after the
//   bytes), and the truth lives in the **central directory** at the end. So the
//   central directory is the only index read; a local header is consulted for
//   its own name/extra lengths and nothing else.
// - It is never zip64 (only forced or past 4 GB) and never encrypted, so those
//   are refused with a plain sentence rather than half-supported.
//
// Reading is forgiving per entry and strict about structure — the
// `historyFile.ts` posture: a malformed central-directory record ends the walk
// with a warning and what was read so far stands; a CRC mismatch on read is a
// warning too, since the bytes may still parse. Not a zip at all is a
// `ZipError`, the only thing this module throws.

import * as zlib from 'zlib';
import { errorMessage } from '../platform/errors';

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipError';
	}
}

export interface ZipEntry {
	name: string;
	/** Bytes in the archive. */
	compressedSize: number;
	/** Bytes once inflated. */
	size: number;
	/** 0 = stored, 8 = deflate; anything else is `unreadable`. */
	method: number;
	crc32: number;
	localOffset: number;
	/** Set when `read` would refuse it, with the reason. */
	unreadable?: string;
}

export interface ZipArchive {
	readonly entries: readonly ZipEntry[];
	/** Structural complaints, in order; empty for a well-formed archive. */
	readonly warnings: readonly string[];
	has(name: string): boolean;
	entry(name: string): ZipEntry | undefined;
	/** The entry's bytes, inflated. Throws `ZipError` for a name it does not have or cannot read. */
	read(name: string): Buffer;
}

export interface ReadZipOptions {
	/** Most an entry may inflate to; past it `read` throws. Default 256 MB. */
	maxEntryBytes?: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Reads the central directory of `bytes`. Throws `ZipError` when there is none. */
export function readZip(bytes: Buffer, options: ReadZipOptions = {}): ZipArchive {
	const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
	const warnings: string[] = [];
	const eocd = findEndOfCentralDirectory(bytes);
	if (eocd === undefined) {
		throw new ZipError('Not a zip file: no end-of-central-directory record.');
	}
	const diskNumber = bytes.readUInt16LE(eocd + 4);
	const directoryDisk = bytes.readUInt16LE(eocd + 6);
	const count = bytes.readUInt16LE(eocd + 10);
	const directorySize = bytes.readUInt32LE(eocd + 12);
	const directoryOffset = bytes.readUInt32LE(eocd + 16);
	if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		throw new ZipError('zip64 archives are not supported.');
	}
	if (diskNumber !== 0 || directoryDisk !== 0) {
		throw new ZipError('Multi-part zip archives are not supported.');
	}

	const entries: ZipEntry[] = [];
	const byName = new Map<string, ZipEntry>();
	let cursor = directoryOffset;
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
			warnings.push(
				`The central directory ends after ${index} of ${count} entries; the rest could not be read.`
			);
			break;
		}
		const flags = bytes.readUInt16LE(cursor + 8);
		const method = bytes.readUInt16LE(cursor + 10);
		const crc = bytes.readUInt32LE(cursor + 16);
		const compressedSize = bytes.readUInt32LE(cursor + 20);
		const size = bytes.readUInt32LE(cursor + 24);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const extraLength = bytes.readUInt16LE(cursor + 30);
		const commentLength = bytes.readUInt16LE(cursor + 32);
		const localOffset = bytes.readUInt32LE(cursor + 42);
		const nameEnd = cursor + 46 + nameLength;
		if (nameEnd > bytes.length) {
			warnings.push(`Entry ${index} names past the end of the file; the rest could not be read.`);
			break;
		}
		// Bit 11 says utf-8; the alternative is CP437, which for the ASCII names
		// Playwright writes reads identically, so utf-8 throughout.
		const name = bytes.toString('utf8', cursor + 46, nameEnd);
		const entry: ZipEntry = { name, compressedSize, size, method, crc32: crc, localOffset };
		if ((flags & 0x1) !== 0) {
			entry.unreadable = 'encrypted';
		} else if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
			entry.unreadable = `compression method ${method} is not supported`;
		} else if (localOffset + 30 > bytes.length) {
			entry.unreadable = 'its data lies past the end of the file';
		}
		// A repeated name: the later record wins, as every unzip does.
		const previous = byName.get(name);
		if (previous) {
			entries.splice(entries.indexOf(previous), 1);
		}
		entries.push(entry);
		byName.set(name, entry);
		cursor = nameEnd + extraLength + commentLength;
	}

	const read = (name: string): Buffer => {
		const entry = byName.get(name);
		if (!entry) {
			throw new ZipError(`The archive has no entry named \`${name}\`.`);
		}
		if (entry.unreadable) {
			throw new ZipError(`\`${name}\` cannot be read: ${entry.unreadable}.`);
		}
		if (entry.size > maxEntryBytes) {
			throw new ZipError(
				`\`${name}\` inflates to ${(entry.size / 1024 / 1024).toFixed(1)} MB, over what BFAST reads.`
			);
		}
		if (bytes.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
			throw new ZipError(`\`${name}\` does not start where the central directory says.`);
		}
		// The local header's own lengths: yazl writes them equal to the central
		// ones, other writers do not have to.
		const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
		const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
		const start = entry.localOffset + 30 + nameLength + extraLength;
		const end = start + entry.compressedSize;
		if (end > bytes.length) {
			throw new ZipError(`\`${name}\` is cut short: the file ends inside it.`);
		}
		const raw = bytes.subarray(start, end);
		let data: Buffer;
		if (entry.method === METHOD_STORED) {
			data = Buffer.from(raw);
		} else {
			try {
				data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
			} catch (error) {
				throw new ZipError(
					`\`${name}\` could not be inflated: ${errorMessage(error)}`
				);
			}
		}
		if (crc32(data) !== entry.crc32) {
			warnings.push(`\`${name}\` did not match its checksum; its contents may be damaged.`);
		}
		return data;
	};

	return {
		entries,
		warnings,
		has: (name) => byName.has(name),
		entry: (name) => byName.get(name),
		read
	};
}

/**
 * The record sits at the very end unless an archive comment follows it, which
 * may be up to 65535 bytes; scan back that far for the signature whose comment
 * length actually reaches the end of the file.
 */
function findEndOfCentralDirectory(bytes: Buffer): number | undefined {
	if (bytes.length < EOCD_SIZE) {
		return undefined;
	}
	const floor = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
	for (let offset = bytes.length - EOCD_SIZE; offset >= floor; offset--) {
		if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
			const commentLength = bytes.readUInt16LE(offset + 20);
			if (offset + EOCD_SIZE + commentLength === bytes.length) {
				return offset;
			}
		}
	}
	// A signature whose comment length disagrees with the file — a truncated
	// comment, say — is still the record.
	for (let offset = bytes.length - EOCD_SIZE; offset >= floor; offset--) {
		if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
			return offset;
		}
	}
	return undefined;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/** The zip flavour of CRC-32 (IEEE, reflected), as an unsigned 32-bit number. */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let index = 0; index < bytes.length; index++) {
		crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
