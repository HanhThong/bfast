import * as assert from 'assert';
import { EnvironmentError } from '../environments/environmentProvider';
import { allocatePorts, planPorts } from '../environments/portAllocator';

suite('BFAST port allocator', () => {
	test('assigns in range order, skipping reserved ports', () => {
		assert.deepStrictEqual(
			planPorts(['A', 'B', 'C'], { start: 20000, end: 20010 }, new Set([20001])),
			{ A: 20000, B: 20002, C: 20003 }
		);
	});

	test('an exhausted range is undefined, not a partial answer', () => {
		assert.strictEqual(
			planPorts(['A', 'B'], { start: 20000, end: 20000 }, new Set()),
			undefined
		);
		assert.strictEqual(
			planPorts(['A'], { start: 20000, end: 20001 }, new Set([20000, 20001])),
			undefined
		);
		assert.deepStrictEqual(planPorts([], { start: 20000, end: 20000 }, new Set()), {});
	});

	test('a candidate the probe reports taken is walked past', async () => {
		const busy = new Set([20000, 20002]);
		const probed: number[] = [];
		const ports = await allocatePorts(
			['A', 'B'],
			{ start: 20000, end: 20010 },
			new Set([20001]),
			async (port) => {
				probed.push(port);
				return !busy.has(port);
			}
		);
		// 20000 busy, 20001 reserved (never probed), 20002 busy, so A=20003.
		assert.deepStrictEqual(ports, { A: 20003, B: 20004 });
		assert.deepStrictEqual(probed, [20000, 20002, 20003, 20004]);
	});

	test('exhaustion throws no-ports with an actionable message', async () => {
		await assert.rejects(
			allocatePorts(['A', 'B'], { start: 20000, end: 20000 }, new Set(), async () => true),
			(error: unknown) => {
				assert.ok(error instanceof EnvironmentError);
				assert.strictEqual(error.code, 'no-ports');
				return true;
			}
		);
	});
});
