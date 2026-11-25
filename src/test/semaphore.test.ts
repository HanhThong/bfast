// The window-wide cap, driven directly. No `vscode` import in the module under
// test, so nothing here needs the extension host beyond the runner itself.

import * as assert from 'assert';
import { sharedLimiter } from '../platform/semaphore';

/** Lets every already-resolved continuation run. */
const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 20; turn++) {
		await Promise.resolve();
	}
};

suite('sharedLimiter', () => {
	test('caps holders across every group, not per group', async () => {
		let limit = 3;
		const slots = sharedLimiter(() => limit);
		const first = {};
		const second = {};

		let held = 0;
		let peak = 0;
		const releases: (() => void)[] = [];
		const take = async (group: object): Promise<void> => {
			const release = await slots.acquire(group);
			held++;
			peak = Math.max(peak, held);
			releases.push(() => {
				held--;
				release();
			});
		};

		// Five apiece: without a shared cap this would sit at six.
		const all = [
			...Array.from({ length: 5 }, () => take(first)),
			...Array.from({ length: 5 }, () => take(second))
		];

		await settle();
		assert.strictEqual(held, 3, 'the cap is the window’s, not each batch’s');

		while (releases.length > 0) {
			releases.shift()!();
			await settle();
		}
		await Promise.all(all);
		assert.strictEqual(peak, 3, 'the cap held for the whole run');
	});

	// The reason this is not a plain FIFO queue: under one, a second ticket's
	// whole batch waits out the first's, which is the complaint a shared cap is
	// meant not to reintroduce.
	test('groups take turns, so a second batch starts before the first drains', async () => {
		const slots = sharedLimiter(() => 1);
		const first = {};
		const second = {};
		const order: string[] = [];
		const releases: (() => void)[] = [];

		const take = (group: object, name: string): Promise<void> =>
			slots.acquire(group).then((release) => {
				order.push(name);
				releases.push(release);
			});

		// The first batch asks for three slots before the second asks for two.
		const all = [
			take(first, 'a1'),
			take(first, 'a2'),
			take(first, 'a3'),
			take(second, 'b1'),
			take(second, 'b2')
		];

		await settle();
		assert.deepStrictEqual(order, ['a1'], 'a limit of one lets exactly one through');

		while (releases.length > 0) {
			releases.shift()!();
			await settle();
		}
		await Promise.all(all);

		// Under FIFO this would be a1 a2 a3 b1 b2, and the second ticket's tab
		// would sit at `waiting` for the whole of the first's batch.
		assert.deepStrictEqual(order, ['a1', 'a2', 'b1', 'a3', 'b2'], 'the two batches alternate');
	});

	test('a release called twice does not inflate the cap', async () => {
		const slots = sharedLimiter(() => 1);
		const group = {};

		const release = await slots.acquire(group);
		let second = false;
		const queued = slots.acquire(group).then((next) => {
			second = true;
			return next;
		});

		release();
		release();
		await settle();
		assert.strictEqual(second, true);

		// If the double release had counted twice, a third holder would get in.
		let third = false;
		void slots.acquire(group).then(() => (third = true));
		await settle();
		assert.strictEqual(third, false, 'the cap survived the double release');

		(await queued)();
		await settle();
		assert.strictEqual(third, true);
	});

	test('the limit is read as each slot is taken, not captured', async () => {
		let limit = 1;
		const slots = sharedLimiter(() => limit);
		const group = {};

		const release = await slots.acquire(group);
		let opened = 0;
		void slots.acquire(group).then(() => opened++);
		void slots.acquire(group).then(() => opened++);
		await settle();
		assert.strictEqual(opened, 0);

		// A save in the settings form lands mid-run; the next release honours it.
		limit = 3;
		release();
		await settle();
		assert.strictEqual(opened, 2, 'both waiters fit under the raised limit');
	});
});
