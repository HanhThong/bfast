import * as assert from 'assert';
import { crc32, readZip, ZipError } from '../testing/zipFile';
import { buildZip } from './zipFixture';

suite('Zip reader', () => {
	test('reads streamed, buffered and stored entries by the central directory alone', () => {
		const big = Buffer.alloc(20_000, 'trace line\n');
		const zip = buildZip([
			{ name: 'trace.trace', data: big },
			{ name: 'trace.stacks', data: '{"files":[],"stacks":[]}', streamed: false },
			{ name: 'resources/a.jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), method: 'store' }
		]);
		const archive = readZip(zip);
		assert.deepStrictEqual(
			archive.entries.map((entry) => entry.name),
			['trace.trace', 'trace.stacks', 'resources/a.jpeg']
		);
		assert.ok(archive.has('trace.trace'));
		assert.strictEqual(archive.entry('trace.trace')?.size, big.length);
		assert.strictEqual(archive.entry('trace.trace')?.method, 8);
		assert.strictEqual(archive.entry('resources/a.jpeg')?.method, 0);
		assert.ok(archive.read('trace.trace').equals(big));
		assert.strictEqual(archive.read('trace.stacks').toString(), '{"files":[],"stacks":[]}');
		assert.deepStrictEqual([...archive.read('resources/a.jpeg')], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
		assert.deepStrictEqual(archive.warnings, []);
	});

	test('an archive comment does not hide the end record', () => {
		const zip = buildZip([{ name: 'a.txt', data: 'hello' }], { comment: 'written by a test' });
		assert.strictEqual(readZip(zip).read('a.txt').toString(), 'hello');
	});

	test('a repeated name keeps the later record', () => {
		const zip = buildZip([
			{ name: 'a.txt', data: 'first' },
			{ name: 'a.txt', data: 'second' }
		]);
		const archive = readZip(zip);
		assert.strictEqual(archive.entries.length, 1);
		assert.strictEqual(archive.read('a.txt').toString(), 'second');
	});

	test('a checksum mismatch is a warning, not a refusal', () => {
		const zip = buildZip([{ name: 'a.txt', data: 'hello' }], { corruptCrcOf: 'a.txt' });
		const archive = readZip(zip);
		assert.strictEqual(archive.read('a.txt').toString(), 'hello');
		assert.match(archive.warnings[0], /a\.txt.*checksum/);
	});

	test('what it cannot read is named, and refused only when asked for', () => {
		const zip = buildZip([{ name: 'secret.txt', data: 'x' }, { name: 'open.txt', data: 'y' }], {
			encrypt: 'secret.txt'
		});
		const archive = readZip(zip);
		assert.strictEqual(archive.entry('secret.txt')?.unreadable, 'encrypted');
		assert.strictEqual(archive.read('open.txt').toString(), 'y');
		assert.throws(() => archive.read('secret.txt'), (error: unknown) => error instanceof ZipError);
		assert.throws(() => archive.read('missing.txt'), /no entry named/);
	});

	test('refuses zip64 and what is not a zip with a ZipError', () => {
		assert.throws(() => readZip(buildZip([{ name: 'a', data: 'a' }], { zip64: true })), /zip64/);
		for (const bytes of [Buffer.alloc(0), Buffer.from('PK not really'), Buffer.alloc(4096, 7)]) {
			assert.throws(() => readZip(bytes), (error: unknown) => error instanceof ZipError);
		}
	});

	test('a damaged entry fails alone; the rest still read', () => {
		// Incompressible bytes, so the deflate stream is long enough to damage.
		const noise = Buffer.alloc(5000);
		let seed = 12345;
		for (let index = 0; index < noise.length; index++) {
			seed = (seed * 1103515245 + 12345) >>> 0;
			noise[index] = seed >>> 24;
		}
		const whole = buildZip([
			{ name: 'a.txt', data: 'aaaa' },
			{ name: 'b.bin', data: noise }
		]);
		const bEntry = readZip(whole).entry('b.bin')!;
		// Zero a stretch of b's deflate stream in place: the directory is intact,
		// a is untouched, b either fails to inflate or fails its checksum.
		const damaged = Buffer.from(whole);
		damaged.fill(0, bEntry.localOffset + 60, bEntry.localOffset + 260);
		const archive = readZip(damaged);
		assert.strictEqual(archive.read('a.txt').toString(), 'aaaa');
		let refused = false;
		try {
			archive.read('b.bin');
		} catch (error) {
			refused = error instanceof ZipError;
		}
		assert.ok(refused || archive.warnings.some((warning) => /b\.bin.*checksum/.test(warning)));
	});

	test('a size cap stops an entry inflating past it', () => {
		const zip = buildZip([{ name: 'big.txt', data: Buffer.alloc(10_000, 'z') }]);
		assert.throws(() => readZip(zip, { maxEntryBytes: 1000 }).read('big.txt'), /over what BFAST reads/);
	});

	test('crc32 is the zip flavour', () => {
		assert.strictEqual(crc32(Buffer.from('')), 0);
		assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
	});
});
