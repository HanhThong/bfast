// Builds small zip archives the way writers actually do, so `zipFile.ts` is
// tested against the shapes it will meet rather than one tidy layout: yazl's
// streamed entries (bit 3, zeroed local sizes, a data descriptor after the
// bytes), entries with sizes known up front, and stored ones. No zip library —
// the reader under test is the only one in the repo, and a fixture built by it
// would prove nothing.

import * as zlib from 'zlib';
import { crc32 } from '../testing/zipFile';

export interface ZipFixtureEntry {
	name: string;
	data: Buffer | string;
	/** Default deflate. */
	method?: 'store' | 'deflate';
	/** yazl's streaming shape: local sizes zero, data descriptor after the bytes. Default true. */
	streamed?: boolean;
}

export interface ZipFixtureOptions {
	comment?: string;
	/** Write this in place of the real CRC for the named entry. */
	corruptCrcOf?: string;
	/** Central directory sentinels that mean zip64. */
	zip64?: boolean;
	/** Mark the named entry encrypted (bit 0). */
	encrypt?: string;
}

export function buildZip(entries: ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
		const method = entry.method === 'store' ? 0 : 8;
		const packed = method === 8 ? zlib.deflateRawSync(data) : data;
		const streamed = entry.streamed !== false;
		const crc = options.corruptCrcOf === entry.name ? (crc32(data) ^ 0xdeadbeef) >>> 0 : crc32(data);
		const flags = (streamed ? 0x8 : 0) | (options.encrypt === entry.name ? 0x1 : 0) | 0x800;
		const name = Buffer.from(entry.name, 'utf8');

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(streamed ? 0 : crc, 14);
		local.writeUInt32LE(streamed ? 0 : packed.length, 18);
		local.writeUInt32LE(streamed ? 0 : data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, name, packed);
		let written = local.length + name.length + packed.length;
		if (streamed) {
			const descriptor = Buffer.alloc(16);
			descriptor.writeUInt32LE(0x08074b50, 0);
			descriptor.writeUInt32LE(crc, 4);
			descriptor.writeUInt32LE(packed.length, 8);
			descriptor.writeUInt32LE(data.length, 12);
			parts.push(descriptor);
			written += descriptor.length;
		}

		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(flags, 8);
		record.writeUInt16LE(method, 10);
		record.writeUInt16LE(0, 12);
		record.writeUInt16LE(0, 14);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(packed.length, 20);
		record.writeUInt32LE(data.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt16LE(0, 30);
		record.writeUInt16LE(0, 32);
		record.writeUInt16LE(0, 34);
		record.writeUInt16LE(0, 36);
		record.writeUInt32LE(0, 38);
		record.writeUInt32LE(offset, 42);
		central.push(record, name);
		offset += written;
	}

	const directory = Buffer.concat(central);
	const comment = Buffer.from(options.comment ?? '', 'utf8');
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
	end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
	end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
	end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
	end.writeUInt16LE(comment.length, 20);
	return Buffer.concat([...parts, directory, end, comment]);
}
