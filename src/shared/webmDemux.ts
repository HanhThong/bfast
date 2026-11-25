// A WebM (Matroska) demuxer for the board's own player.
//
// Bundled into the webview, so no `vscode`, no `node:`, no DOM — bytes in,
// frames out. It exists because an editor's `<video>` can refuse a container
// its decoders play: VS Code on Windows rejects VP8 WebM that Chrome plays
// (microsoft/vscode#195758), and the failure is in the demuxer, not the
// codec. WebCodecs decodes the same frames without one, provided something
// hands them over one by one with their timestamps — which is all this does.
//
// Reading is forgiving in the `parseHistory` sense: an element it does not
// know is skipped, an unknown-size Segment or Cluster (a recording cut short)
// is read to the end of what is there, and a truncated file yields the frames
// before the cut. What it refuses, it refuses with a `WebmError` that names
// the reason; it never throws anything else on any input.

export interface WebmFrame {
	/** Presentation time, in microseconds — what `EncodedVideoChunk` takes. */
	timestampUs: number;
	keyframe: boolean;
	/** The frame's bytes, a view into the file. */
	data: Uint8Array;
}

export interface WebmVideo {
	/** The WebCodecs codec string — `vp8`, `vp09.…`, `av01.…`, `avc1.…`. */
	codec: string;
	/** The Matroska `CodecID`, for messages. */
	codecId: string;
	width: number;
	height: number;
	/** `CodecPrivate`, which an AVC decoder needs as its `description`. */
	description?: Uint8Array;
	/** From the file's `Duration`, else the last frame plus one frame. */
	durationMs?: number;
	/** Every frame of the first video track, in file order. */
	frames: WebmFrame[];
}

export class WebmError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebmError';
	}
}

/** The element ids this reader knows, with their EBML marker bits kept. */
const ID = {
	EBML: 0x1a45dfa3,
	DocType: 0x4282,
	Segment: 0x18538067,
	SeekHead: 0x114d9b74,
	Info: 0x1549a966,
	TimestampScale: 0x2ad7b1,
	Duration: 0x4489,
	Tracks: 0x1654ae6b,
	TrackEntry: 0xae,
	TrackNumber: 0xd7,
	TrackType: 0x83,
	CodecID: 0x86,
	CodecPrivate: 0x63a2,
	DefaultDuration: 0x23e383,
	Video: 0xe0,
	PixelWidth: 0xb0,
	PixelHeight: 0xba,
	Cluster: 0x1f43b675,
	Timestamp: 0xe7,
	SimpleBlock: 0xa3,
	BlockGroup: 0xa0,
	Block: 0xa1,
	ReferenceBlock: 0xfb,
	Cues: 0x1c53bb6b,
	Chapters: 0x1043a770,
	Tags: 0x1254c367,
	Attachments: 0x1941a469
} as const;

/** Segment-level ids: an unknown-size Cluster ends where one of these begins. */
const SEGMENT_CHILDREN = new Set<number>([
	ID.SeekHead,
	ID.Info,
	ID.Tracks,
	ID.Cluster,
	ID.Cues,
	ID.Chapters,
	ID.Tags,
	ID.Attachments
]);

const VIDEO_TRACK = 1;

interface Vint {
	value: number;
	length: number;
	/** Every value bit set: a size that says "until the parent ends". */
	unknown: boolean;
}

interface Element {
	id: number;
	/** First byte of the element's data. */
	start: number;
	/** One past the last byte of its data, clamped to what is there. */
	end: number;
	unknownSize: boolean;
	/** One past the element, for the caller to continue from. */
	next: number;
}

/** A variable-length integer; `keepMarker` for an id, not for a size. */
function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | undefined {
	if (pos >= bytes.length) {
		return undefined;
	}
	const first = bytes[pos];
	let length = 1;
	let mask = 0x80;
	while (length <= 8 && (first & mask) === 0) {
		mask >>= 1;
		length++;
	}
	if (length > 8 || pos + length > bytes.length) {
		return undefined;
	}
	let value = keepMarker ? first : first & (mask - 1);
	let unknown = !keepMarker && (first & (mask - 1)) === mask - 1;
	for (let i = 1; i < length; i++) {
		const byte = bytes[pos + i];
		value = value * 256 + byte;
		if (byte !== 0xff) {
			unknown = false;
		}
	}
	return { value, length, unknown };
}

function readElement(bytes: Uint8Array, pos: number, parentEnd: number): Element | undefined {
	const id = readVint(bytes, pos, true);
	if (!id) {
		return undefined;
	}
	const size = readVint(bytes, pos + id.length, false);
	if (!size) {
		return undefined;
	}
	const start = pos + id.length + size.length;
	if (start > parentEnd) {
		return undefined;
	}
	const end = size.unknown ? parentEnd : Math.min(parentEnd, start + size.value);
	return { id: id.value, start, end, unknownSize: size.unknown, next: end };
}

function readUint(bytes: Uint8Array, element: Element): number {
	let value = 0;
	for (let i = element.start; i < element.end; i++) {
		value = value * 256 + bytes[i];
	}
	return value;
}

function readFloat(bytes: Uint8Array, element: Element): number | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset + element.start, element.end - element.start);
	if (view.byteLength === 4) {
		return view.getFloat32(0);
	}
	if (view.byteLength === 8) {
		return view.getFloat64(0);
	}
	return undefined;
}

function readAscii(bytes: Uint8Array, element: Element): string {
	let text = '';
	for (let i = element.start; i < element.end; i++) {
		text += String.fromCharCode(bytes[i]);
	}
	return text;
}

function hex2(value: number): string {
	return value.toString(16).padStart(2, '0');
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * The WebCodecs codec string for a track, from its id and `CodecPrivate`.
 * VP9's and AV1's carry profile, level and bit depth in their private data
 * when the muxer wrote it; a sensible default stands in when it did not.
 */
function codecString(codecId: string, priv: Uint8Array | undefined): string | undefined {
	switch (codecId) {
		case 'V_VP8':
			return 'vp8';
		case 'V_VP9': {
			let profile = 0;
			let level = 10;
			let depth = 8;
			if (priv) {
				let pos = 0;
				while (pos + 2 <= priv.length) {
					const id = priv[pos];
					const length = priv[pos + 1];
					if (length === 1 && pos + 2 < priv.length) {
						const value = priv[pos + 2];
						if (id === 1) {
							profile = value;
						} else if (id === 2 && value > 0) {
							level = value;
						} else if (id === 3) {
							depth = value;
						}
					}
					pos += 2 + length;
				}
			}
			return `vp09.${pad2(profile)}.${pad2(level)}.${pad2(depth)}`;
		}
		case 'V_AV1': {
			if (priv && priv.length >= 3) {
				const profile = priv[1] >> 5;
				const level = priv[1] & 0x1f;
				const tier = (priv[2] & 0x80) !== 0 ? 'H' : 'M';
				const high = (priv[2] & 0x40) !== 0;
				const twelve = (priv[2] & 0x20) !== 0;
				const depth = high ? (twelve ? 12 : 10) : 8;
				return `av01.${profile}.${pad2(level)}${tier}.${pad2(depth)}`;
			}
			return 'av01.0.04M.08';
		}
		case 'V_MPEG4/ISO/AVC':
			if (priv && priv.length >= 4) {
				return `avc1.${hex2(priv[1])}${hex2(priv[2])}${hex2(priv[3])}`;
			}
			return undefined;
		default:
			return undefined;
	}
}

interface Track {
	number: number;
	codecId: string;
	codec: string;
	width: number;
	height: number;
	description?: Uint8Array;
	defaultDurationNs?: number;
}

/** Demuxes the first video track of a WebM file. Throws only `WebmError`. */
export function demuxWebm(bytes: Uint8Array): WebmVideo {
	const header = readElement(bytes, 0, bytes.length);
	if (!header || header.id !== ID.EBML) {
		throw new WebmError('The file does not start with an EBML header, so it is not WebM.');
	}
	for (let pos = header.start; pos < header.end; ) {
		const child = readElement(bytes, pos, header.end);
		if (!child) {
			break;
		}
		if (child.id === ID.DocType) {
			const docType = readAscii(bytes, child);
			if (docType !== 'webm' && docType !== 'matroska') {
				throw new WebmError(`The file is ${docType || 'an unknown EBML document'}, not WebM.`);
			}
		}
		pos = child.next;
	}

	let segment: Element | undefined;
	for (let pos = header.next; pos < bytes.length; ) {
		const element = readElement(bytes, pos, bytes.length);
		if (!element) {
			break;
		}
		if (element.id === ID.Segment) {
			segment = element;
			break;
		}
		pos = element.next;
	}
	if (!segment) {
		throw new WebmError('The file has no Segment.');
	}

	let scaleNs = 1_000_000;
	let durationScaled: number | undefined;
	let track: Track | undefined;
	const frames: WebmFrame[] = [];

	const readTrack = (entry: Element): Track | undefined => {
		let number = 0;
		let type = 0;
		let codecId = '';
		let width = 0;
		let height = 0;
		let description: Uint8Array | undefined;
		let defaultDurationNs: number | undefined;
		for (let pos = entry.start; pos < entry.end; ) {
			const child = readElement(bytes, pos, entry.end);
			if (!child) {
				break;
			}
			switch (child.id) {
				case ID.TrackNumber:
					number = readUint(bytes, child);
					break;
				case ID.TrackType:
					type = readUint(bytes, child);
					break;
				case ID.CodecID:
					codecId = readAscii(bytes, child);
					break;
				case ID.CodecPrivate:
					description = bytes.subarray(child.start, child.end);
					break;
				case ID.DefaultDuration:
					defaultDurationNs = readUint(bytes, child);
					break;
				case ID.Video:
					for (let inner = child.start; inner < child.end; ) {
						const field = readElement(bytes, inner, child.end);
						if (!field) {
							break;
						}
						if (field.id === ID.PixelWidth) {
							width = readUint(bytes, field);
						} else if (field.id === ID.PixelHeight) {
							height = readUint(bytes, field);
						}
						inner = field.next;
					}
					break;
			}
			pos = child.next;
		}
		if (type !== VIDEO_TRACK || number === 0) {
			return undefined;
		}
		const codec = codecString(codecId, description);
		if (!codec) {
			throw new WebmError(`The video track is ${codecId || 'of an unnamed codec'}, which this player does not decode.`);
		}
		return {
			number,
			codecId,
			codec,
			width,
			height,
			description: codecId === 'V_MPEG4/ISO/AVC' ? description : undefined,
			defaultDurationNs
		};
	};

	/** One block's header; `undefined` when it is not this track's or is laced. */
	const readBlock = (
		block: Element,
		clusterTs: number,
		keyframe: boolean | undefined
	): void => {
		if (!track) {
			return;
		}
		const number = readVint(bytes, block.start, false);
		if (!number || number.value !== track.number) {
			return;
		}
		const headerEnd = block.start + number.length + 3;
		if (headerEnd > block.end) {
			return;
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		const relative = view.getInt16(block.start + number.length);
		const flags = bytes[block.start + number.length + 2];
		if (((flags >> 1) & 0x03) !== 0) {
			throw new WebmError('The file uses laced blocks, which this player does not read.');
		}
		frames.push({
			timestampUs: Math.round(((clusterTs + relative) * scaleNs) / 1000),
			keyframe: keyframe ?? (flags & 0x80) !== 0,
			data: bytes.subarray(headerEnd, block.end)
		});
	};

	const readCluster = (cluster: Element): number => {
		let clusterTs = 0;
		let pos = cluster.start;
		while (pos < cluster.end) {
			const child = readElement(bytes, pos, cluster.end);
			if (!child) {
				break;
			}
			if (cluster.unknownSize && SEGMENT_CHILDREN.has(child.id)) {
				// The cluster said "until the parent ends" and the parent's next
				// child has begun: that is where it ended.
				return pos;
			}
			switch (child.id) {
				case ID.Timestamp:
					clusterTs = readUint(bytes, child);
					break;
				case ID.SimpleBlock:
					readBlock(child, clusterTs, undefined);
					break;
				case ID.BlockGroup: {
					let block: Element | undefined;
					let referenced = false;
					for (let inner = child.start; inner < child.end; ) {
						const part = readElement(bytes, inner, child.end);
						if (!part) {
							break;
						}
						if (part.id === ID.Block) {
							block = part;
						} else if (part.id === ID.ReferenceBlock) {
							referenced = true;
						}
						inner = part.next;
					}
					if (block) {
						readBlock(block, clusterTs, !referenced);
					}
					break;
				}
			}
			pos = child.next;
		}
		return cluster.end;
	};

	for (let pos = segment.start; pos < segment.end; ) {
		const child = readElement(bytes, pos, segment.end);
		if (!child) {
			break;
		}
		switch (child.id) {
			case ID.Info:
				for (let inner = child.start; inner < child.end; ) {
					const field = readElement(bytes, inner, child.end);
					if (!field) {
						break;
					}
					if (field.id === ID.TimestampScale) {
						scaleNs = readUint(bytes, field) || scaleNs;
					} else if (field.id === ID.Duration) {
						durationScaled = readFloat(bytes, field);
					}
					inner = field.next;
				}
				break;
			case ID.Tracks:
				for (let inner = child.start; inner < child.end && !track; ) {
					const entry = readElement(bytes, inner, child.end);
					if (!entry) {
						break;
					}
					if (entry.id === ID.TrackEntry) {
						track = readTrack(entry);
					}
					inner = entry.next;
				}
				break;
			case ID.Cluster:
				pos = readCluster(child);
				continue;
		}
		pos = child.next;
	}

	if (!track) {
		throw new WebmError('The file has no video track.');
	}
	if (frames.length === 0) {
		throw new WebmError('The file has no video frames — the recording may have been cut short.');
	}
	if (!frames[0].keyframe) {
		throw new WebmError('The file does not begin with a keyframe.');
	}

	let durationMs: number | undefined;
	if (durationScaled !== undefined && Number.isFinite(durationScaled) && durationScaled > 0) {
		durationMs = (durationScaled * scaleNs) / 1_000_000;
	} else {
		const last = frames[frames.length - 1].timestampUs;
		const frameUs = track.defaultDurationNs ? track.defaultDurationNs / 1000 : 40_000;
		durationMs = (last + frameUs) / 1000;
	}

	return {
		codec: track.codec,
		codecId: track.codecId,
		width: track.width,
		height: track.height,
		description: track.description,
		durationMs,
		frames
	};
}
