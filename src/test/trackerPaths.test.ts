import * as assert from 'assert';
import {
	allowedChildTypes,
	assetFileName,
	convertibleTypes,
	typeChangeRefusal,
	buildId,
	buildTreeId,
	deslugify,
	folderName,
	isSidecarPath,
	localOf,
	nextOrdinal,
	parseFolderName,
	parseId,
	parseLocalSegment,
	parseTreeId,
	slugifyTitle,
	suffixFileName,
	typeFromContentFile
} from '../data/trackerPaths';

suite('Tracker paths', () => {
	test('slugifies a title into something every OS accepts', () => {
		assert.strictEqual(slugifyTitle('Sign in with email'), 'Sign_in_with_email');
		assert.strictEqual(slugifyTitle('Fix: the login bug'), 'Fix_the_login_bug');
		assert.strictEqual(slugifyTitle('a/b\c*d?e'), 'abcde');
		assert.strictEqual(slugifyTitle('  padded  '), 'padded');
		assert.strictEqual(slugifyTitle(''), 'Untitled');
		assert.strictEqual(slugifyTitle('***'), 'Untitled');
		assert.strictEqual(slugifyTitle('trailing dot.'), 'trailing_dot');
		// Reserved Windows device names cannot be a folder on their own.
		assert.strictEqual(slugifyTitle('CON'), 'CON_');
		assert.strictEqual(slugifyTitle('nul'), 'nul_');
		// Hyphens and non-ASCII are fine in a name.
		assert.strictEqual(slugifyTitle('Sign-in với email'), 'Sign-in_với_email');
	});

	test('caps a long slug on a word boundary', () => {
		const slug = slugifyTitle('word '.repeat(40));

		assert.ok(slug.length <= 60, `${slug.length} should be at most 60`);
		assert.ok(!slug.endsWith('_'), slug);
		assert.ok(slug.startsWith('word_word'), slug);
	});

	test('a cut on a word boundary keeps the last word, and drops a dangling comma', () => {
		// "display" ends exactly at the cap: it stays.
		assert.strictEqual(
			slugifyTitle('Registers with email, display name and password', 29),
			'Registers_with_email,_display'
		);
		// Cut after "email," — a name must not end in the comma.
		assert.strictEqual(slugifyTitle('Registers with email, display name', 21), 'Registers_with_email');
	});

	test('a folder name is at most 40 characters, the id included', () => {
		const long = 'Registers with email, display name and password and lands straight on the map';
		for (const id of ['EP-1', 'ST-1.1', 'AC-1.1.1', 'TC-1.1.1.1', 'TC-12.10.13.14']) {
			const name = folderName(id, long);
			assert.ok(name.length <= 40, `${name} is ${name.length} characters`);
			assert.strictEqual(parseFolderName(name).id, id);
		}

		// What one real tracker's deepest tickets became — docs/tracker/ quotes them.
		assert.strictEqual(
			folderName('ST-1.1', 'Tạo tài khoản người chơi bằng email và mật khẩu ngay trong game'),
			'ST-1.1-Tạo_tài_khoản_người_chơi_bằng'
		);
		assert.strictEqual(
			folderName(
				'AC-1.1.1',
				'Tạo tài khoản mới bằng email, tên hiển thị và mật khẩu rồi vào thẳng bản đồ'
			),
			'AC-1.1.1-Tạo_tài_khoản_mới_bằng_email'
		);
		assert.strictEqual(folderName('TC-1.1.1.1', long), 'TC-1.1.1.1-Registers_with_email,_display');
		// A title that fits is left whole.
		assert.strictEqual(folderName('EP-1', 'Authentication'), 'EP-1-Authentication');
	});

	test('however long an id grows, its folder keeps some of the title', () => {
		const id = 'TC-111111111.222222222.333333333.444444444';

		assert.strictEqual(folderName(id, 'Passwordless sign-in'), `${id}-Passwordless`);
	});

	test('builds and parses a folder name', () => {
		// The folder carries the full id, so it identifies itself without its
		// ancestors having to be walked.
		assert.strictEqual(folderName('AC-1.2.1', 'Wrong password'), 'AC-1.2.1-Wrong_password');

		assert.deepStrictEqual(parseFolderName('AC-1.2.1-Wrong_password'), {
			id: 'AC-1.2.1',
			type: 'ac',
			ordinals: [1, 2, 1],
			slug: 'Wrong_password'
		});
		// A folder that is not a ticket parses to nothing but its own name.
		assert.deepStrictEqual(parseFolderName('assets'), { slug: 'assets' });
	});

	test('normalises a hand-typed prefix and reads a top-level id', () => {
		assert.strictEqual(parseFolderName('ep-1-Auth').id, 'EP-1');
		assert.deepStrictEqual(parseFolderName('EP-1-Auth').ordinals, [1]);
	});

	test('a slug containing a hyphen survives the round trip', () => {
		const name = folderName('ST-1.1', 'Sign-in with email');

		assert.strictEqual(name, 'ST-1.1-Sign-in_with_email');
		assert.strictEqual(parseFolderName(name).slug, 'Sign-in_with_email');
	});

	test('deslugifies back to a usable title', () => {
		assert.strictEqual(deslugify('Sign_in_with_email'), 'Sign in with email');
		assert.strictEqual(deslugify(''), 'Untitled');
	});

	test('builds a hierarchical id from the ancestors ordinals', () => {
		assert.strictEqual(buildId([], 'epic', 1), 'EP-1');
		assert.strictEqual(buildId([1], 'story', 2), 'ST-1.2');
		assert.strictEqual(buildId([1, 2], 'ac', 1), 'AC-1.2.1');
		assert.strictEqual(buildId([1, 2, 1], 'testcase', 1), 'TC-1.2.1.1');
		// A test case hanging off the story rather than an AC.
		assert.strictEqual(buildId([1, 2], 'testcase', 3), 'TC-1.2.3');
	});

	test('parses an id back and names its own segment', () => {
		assert.deepStrictEqual(parseId('TC-1.2.1.1'), { type: 'testcase', ordinals: [1, 2, 1, 1] });
		assert.strictEqual(parseId('nonsense'), undefined);

		assert.strictEqual(localOf('AC-1.2.1'), 'AC-1');
		assert.strictEqual(localOf('TC-1.2.3'), 'TC-3');
		assert.strictEqual(localOf('EP-1'), 'EP-1');
		// Not an id we recognise: give it back rather than inventing a label.
		assert.strictEqual(localOf('nonsense'), 'nonsense');
	});

	test('a tree id carries a duplicate’s rank on the segment it disambiguates', () => {
		assert.strictEqual(buildTreeId([{ ordinal: 1 }], 'epic'), 'EP-1');
		assert.strictEqual(buildTreeId([{ ordinal: 1, rank: 2 }], 'epic'), 'EP-1#2');
		// The first story under the second EP-1, and a second ST-1.1 under the first.
		assert.strictEqual(buildTreeId([{ ordinal: 1, rank: 2 }, { ordinal: 1 }], 'story'), 'ST-1#2.1');
		assert.strictEqual(buildTreeId([{ ordinal: 1 }, { ordinal: 1, rank: 2 }], 'story'), 'ST-1.1#2');

		for (const id of ['EP-1', 'EP-1#2', 'ST-1#2.1', 'ST-1.1#2', 'TC-1#2.1.1#3.1']) {
			const parsed = parseTreeId(id);
			assert.ok(parsed, id);
			assert.strictEqual(buildTreeId(parsed.segments, parsed.type), id);
		}
		assert.deepStrictEqual(parseTreeId('ST-1#2.1'), {
			type: 'story',
			segments: [{ ordinal: 1, rank: 2 }, { ordinal: 1 }]
		});
		assert.strictEqual(parseTreeId('nonsense'), undefined);

		// A rank is the tree's alone: in a folder name or a metadata id it is
		// drift, never accepted.
		assert.strictEqual(parseId('EP-1#2'), undefined);
		assert.deepStrictEqual(parseFolderName('EP-1#2-Auth'), { slug: 'EP-1#2-Auth' });
	});

	test('a key shows its own rank but never an ancestor’s', () => {
		assert.strictEqual(localOf('EP-1#2'), 'EP-1#2');
		assert.strictEqual(localOf('ST-1#2.1'), 'ST-1');
		assert.strictEqual(localOf('ST-1.1#2'), 'ST-1#2');
	});

	test('parses the own-ordinal off either an id or a bare segment', () => {
		assert.deepStrictEqual(parseLocalSegment('AC-2'), { type: 'ac', ordinal: 2 });
		assert.deepStrictEqual(parseLocalSegment('AC-1.2.3'), { type: 'ac', ordinal: 3 });
		assert.strictEqual(parseLocalSegment('assets'), undefined);
	});

	test('names the content file each type lives in', () => {
		assert.strictEqual(typeFromContentFile('TestCase.mdx'), 'testcase');
		assert.strictEqual(typeFromContentFile('ac.MDX'), 'ac');
		assert.strictEqual(typeFromContentFile('Bug.mdx'), undefined);
	});

	test('encodes where each type may be created', () => {
		assert.deepStrictEqual(allowedChildTypes(undefined), ['epic']);
		assert.deepStrictEqual(allowedChildTypes('epic'), ['epic', 'story', 'testcase']);
		assert.deepStrictEqual(allowedChildTypes('story'), ['ac', 'testcase']);
		assert.deepStrictEqual(allowedChildTypes('ac'), ['testcase']);
		assert.deepStrictEqual(allowedChildTypes('testcase'), []);
	});

	test('the next ordinal skips past the highest, gaps included', () => {
		const siblings = [
			{ type: 'ac', ordinal: 1 },
			{ type: 'ac', ordinal: 3 },
			{ type: 'testcase', ordinal: 1 }
		] as const;

		// Never reuses the id a deleted AC-2 had.
		assert.strictEqual(nextOrdinal(siblings, 'ac'), 4);
		assert.strictEqual(nextOrdinal(siblings, 'testcase'), 2);
		assert.strictEqual(nextOrdinal([], 'epic'), 1);
	});

	test('only an epic and a story can trade types', () => {
		assert.deepStrictEqual(convertibleTypes('epic'), ['story']);
		assert.deepStrictEqual(convertibleTypes('story'), ['epic']);
		assert.deepStrictEqual(convertibleTypes('ac'), []);
		assert.deepStrictEqual(convertibleTypes('testcase'), []);
	});

	test('a type change is refused when the hierarchy would break', () => {
		const change = { key: 'EP-1.2', parentType: 'epic', childTypes: [] } as const;
		assert.strictEqual(typeChangeRefusal({ ...change, type: 'epic', target: 'story' }), undefined);
		assert.strictEqual(
			typeChangeRefusal({ ...change, key: 'ST-1.2', type: 'story', target: 'epic' }),
			undefined
		);

		// A story cannot sit at the top level.
		assert.match(
			typeChangeRefusal({ key: 'EP-1', type: 'epic', target: 'story', parentType: undefined, childTypes: [] }) ?? '',
			/top level/
		);
		// Children the new type cannot hold are refused, never converted along.
		assert.match(
			typeChangeRefusal({ ...change, type: 'epic', target: 'story', childTypes: ['story', 'epic'] }) ?? '',
			/2 children/
		);
		assert.match(
			typeChangeRefusal({ ...change, key: 'ST-1.2', type: 'story', target: 'epic', childTypes: ['ac'] }) ?? '',
			/a child/
		);
		assert.match(
			typeChangeRefusal({ ...change, key: 'AC-1.2.1', type: 'ac', target: 'testcase', parentType: 'story' }) ?? '',
			/cannot become a test case/
		);
	});

	test('sub-epics and stories under one epic share one ordinal sequence', () => {
		// Both can have children, and a tree id records only the leaf's type:
		// `EP-1.1` beside `ST-1.1` would give both a `TC-1.1.1.1` descendant.
		const siblings = [
			{ type: 'epic', ordinal: 1 },
			{ type: 'story', ordinal: 2 }
		] as const;
		assert.strictEqual(nextOrdinal(siblings, 'epic'), 3);
		assert.strictEqual(nextOrdinal(siblings, 'story'), 3);
	});

	test('an asset name keeps its extension and loses everything unsafe', () => {
		assert.strictEqual(assetFileName('diagram.png'), 'diagram.png');
		assert.strictEqual(assetFileName('My Photo.PNG'), 'My_Photo.png');
		// A name with no usable extension gets one, or the image will not render.
		assert.strictEqual(assetFileName('image'), 'image.png');
		assert.strictEqual(assetFileName('archive.tar.gz'), 'archive.tar.gz');
		assert.strictEqual(assetFileName('screenshot', '.jpg'), 'screenshot.jpg');
		// Reserved Windows names and leading dots are `slugifyTitle`'s job already.
		assert.strictEqual(assetFileName('con.png'), 'con_.png');
		assert.strictEqual(assetFileName('.gitignore'), 'gitignore.png');
		// Legal in a file name, but they break a url or the `![alt](path)` syntax.
		assert.strictEqual(assetFileName('a#b(c)[d]%e.png'), 'abcde.png');
	});

	test('an asset name cannot carry a path out of the assets folder', () => {
		assert.strictEqual(assetFileName('../../etc/passwd'), 'passwd.png');
		assert.strictEqual(assetFileName('C:\\Users\\me\\shot.png'), 'shot.png');
		assert.strictEqual(assetFileName('sub/dir/flow.svg'), 'flow.svg');
		// Nothing left to name it with still has to produce something writable.
		assert.strictEqual(assetFileName(''), 'image.png');
		assert.strictEqual(assetFileName('///'), 'image.png');
	});

	test('a long asset stem is cut without eating the extension', () => {
		const name = assetFileName(`${'a'.repeat(200)}.png`);
		assert.ok(name.endsWith('.png'), name);
		assert.ok(name.length <= 44, `${name.length}`);
	});

	test('a taken asset name gets a numbered sibling', () => {
		assert.strictEqual(suffixFileName('diagram.png', 1), 'diagram-1.png');
		assert.strictEqual(suffixFileName('archive.tar.gz', 2), 'archive.tar-2.gz');
		assert.strictEqual(suffixFileName('noext', 1), 'noext-1');
	});
	// Relative to the tracker root: the first segment is a ticket folder or a
	// stray, never a sidecar; deeper, `assets` always is. Test runs are not in
	// the tracker any more, so an `evidence` folder is just a folder.
	test('a sidecar path is one inside a ticket’s assets folder', () => {
		assert.ok(isSidecarPath('EP-1-Auth/ST-1.1-Sign_in/TC-1.1.1-Smoke/assets/x.png'));
		assert.ok(isSidecarPath('EP-1-Auth\\assets\\a.png'));
		assert.ok(isSidecarPath('EP-1-Auth/assets'));
		assert.ok(!isSidecarPath('EP-1-Auth/metadata.yaml'));
		assert.ok(!isSidecarPath('EP-1-Auth/ST-1.1-Sign_in/TC-1.1.1-Smoke/TestCase.mdx'));
		assert.ok(!isSidecarPath('EP-1-Auth/ST-1.1-Sign_in/TC-1.1.1-Smoke/evidence/2026/x.webm'));
		// A root-level folder called assets is somebody's stray folder, not a sidecar.
		assert.ok(!isSidecarPath('assets/diagram.png'));
		assert.ok(!isSidecarPath(''));
	});
});

