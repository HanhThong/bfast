import * as assert from 'assert';
import { ProcessError, runProcess, summariseStderr } from '../platform/runProcess';

/**
 * The test host is Electron, so `process.execPath` is VS Code itself;
 * `ELECTRON_RUN_AS_NODE` turns it back into a plain node — cheap and
 * deterministic, with no reliance on a `node` being on PATH.
 */
function node(
	script: string,
	extra?: {
		idleTimeoutMs?: number;
		onOutput?: (t: string, c: 'stdout' | 'stderr') => void;
		maxBufferedOutput?: number;
	}
) {
	return runProcess({
		executable: process.execPath,
		args: ['-e', script],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		...extra
	});
}

suite('BFAST run process', () => {
	test('captures stdout and the exit code', async () => {
		const result = await node("process.stdout.write('hi')").completed;
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, 'hi');
	});

	test('a non-zero exit rejects with the stderr summary and the result attached', async () => {
		const run = node("process.stderr.write('first\\nthe actual complaint'); process.exit(3)");
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof ProcessError);
		assert.strictEqual(error.code, 'failed');
		assert.strictEqual(error.message, 'the actual complaint');
		assert.strictEqual(error.result?.code, 3);
	});

	test('a missing executable maps to not-installed', async () => {
		const run = runProcess({ executable: 'bfast-definitely-not-a-binary', args: [] });
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof ProcessError);
		assert.strictEqual(error.code, 'not-installed');
	});

	test('a child that goes quiet is killed and rejects with timeout', async () => {
		const run = node('setTimeout(() => undefined, 60000)', { idleTimeoutMs: 300 });
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof ProcessError);
		assert.strictEqual(error.code, 'timeout');
	});

	// The regression this window exists for: a `docker compose up --build` streams
	// its build for far longer than any ceiling anyone would pick, and is plainly
	// alive while it does. Only silence may stop it.
	test('a child that keeps talking outlives the idle window', async () => {
		const result = await node(
			"let n = 0; const t = setInterval(() => { process.stdout.write('.'); " +
				"if (++n === 25) { clearInterval(t); process.exit(0); } }, 20);",
			{ idleTimeoutMs: 150 }
		).completed;
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout.length, 25);
	});

	test('cancel rejects with the given reason and is idempotent', async () => {
		const run = node('setTimeout(() => undefined, 60000)');
		run.cancel('enough');
		run.cancel('twice is fine');
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof ProcessError);
		assert.strictEqual(error.code, 'cancelled');
		assert.strictEqual(error.message, 'enough');
		// After settling it is a no-op, not a throw.
		run.cancel();
	});

	test('streams output while the process runs', async () => {
		const seen: string[] = [];
		await node("process.stdout.write('a'); process.stderr.write('b')", {
			onOutput: (text, channel) => seen.push(`${channel}:${text}`)
		}).completed;
		assert.ok(seen.includes('stdout:a'));
		assert.ok(seen.includes('stderr:b'));
	});

	test('maxBufferedOutput keeps only the tail of each channel', async () => {
		const result = await node("process.stdout.write('abcdefghij')", {
			maxBufferedOutput: 4
		}).completed;
		assert.strictEqual(result.stdout, 'ghij');

		// The failure summary still works, because the complaint is at the end.
		const run = node("process.stderr.write('noise\\nthe actual complaint'); process.exit(1)", {
			maxBufferedOutput: 20
		});
		const error = await run.completed.then(
			() => assert.fail('should have rejected'),
			(failure: unknown) => failure
		);
		assert.ok(error instanceof ProcessError);
		assert.strictEqual(error.message, 'the actual complaint');
	});

	test('maxBufferedOutput never leaves a lone surrogate at the head of the tail', async () => {
		// 'a🎉bcd' is six UTF-16 units; a cap of 4 cuts between the pair's halves.
		const result = await node("process.stdout.write('a\\u{1F389}bcd')", {
			maxBufferedOutput: 4
		}).completed;
		assert.strictEqual(result.stdout, 'bcd');
	});

	// The test runner's shell wrap depends on this: without verbatim arguments
	// Node escapes embedded quotes by MSVCRT rules, which cmd does not parse.
	(process.platform === 'win32' ? test : test.skip)(
		'windowsVerbatimArguments hands the line to cmd byte-for-byte',
		async () => {
			const result = await runProcess({
				executable: process.env.ComSpec ?? 'cmd.exe',
				args: ['/d', '/s', '/c', '"echo "hi there""'],
				windowsVerbatimArguments: true
			}).completed;
			assert.strictEqual(result.stdout.trim(), '"hi there"');
		}
	);

	// Stop must reach what the shell started, not only the shell: a signal to
	// `sh` alone leaves a test runner and its browsers recording on.
	(process.platform === 'win32' ? test.skip : test)(
		'killTree stops the whole process group, not only the shell',
		async () => {
			let printed = '';
			const run = runProcess({
				executable: '/bin/sh',
				// The shell prints the sleep's pid, then waits on it.
				args: ['-c', 'sleep 30 & echo $!; wait'],
				killTree: true,
				onOutput: (text) => {
					printed += text;
				}
			});
			for (let attempt = 0; attempt < 200 && !printed.includes('\n'); attempt += 1) {
				await new Promise((next) => setTimeout(next, 10));
			}
			const pid = Number(printed.trim());
			assert.ok(Number.isInteger(pid) && pid > 0, `the sleep's pid was read: ${JSON.stringify(printed)}`);

			run.cancel('enough');
			const error = await run.completed.then(
				() => assert.fail('should have rejected'),
				(failure: unknown) => failure
			);
			assert.ok(error instanceof ProcessError);
			assert.strictEqual(error.code, 'cancelled');

			// Give the group a moment to die; then the sleep must be gone too.
			for (let attempt = 0; attempt < 50; attempt += 1) {
				try {
					process.kill(pid, 0);
				} catch {
					return;
				}
				await new Promise((next) => setTimeout(next, 20));
			}
			assert.fail('the sleep survived the cancel');
		}
	);

	test('summariseStderr takes the last non-empty line, capped', () => {
		assert.strictEqual(summariseStderr('one\ntwo\n\n'), 'two');
		assert.strictEqual(summariseStderr(''), 'The command failed without an error message.');
		assert.strictEqual(summariseStderr(`${'x'.repeat(400)}`).length, 300);
	});

	test('an interactive child keeps stdin open and reads what is written later', async () => {
		const run = runProcess({
			executable: process.execPath,
			args: [
				'-e',
				"let all='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{all+=d});process.stdin.on('end',()=>{process.stdout.write(all.toUpperCase());})"
			],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			interactive: true
		});
		assert.ok(run.stdin, 'an interactive run hands its stdin back');
		run.stdin.write('first\n');
		await new Promise((resolve) => setTimeout(resolve, 100));
		run.stdin.write('second\n');
		run.stdin.end();
		const result = await run.completed;
		assert.strictEqual(result.stdout, 'FIRST\nSECOND\n');
	});

	test('a plain request has no stdin handle and its stdin is closed at once', async () => {
		const run = runProcess({
			executable: process.execPath,
			args: ['-e', "process.stdin.on('end',()=>process.stdout.write('closed'));process.stdin.resume()"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
		});
		assert.strictEqual(run.stdin, undefined);
		assert.strictEqual((await run.completed).stdout, 'closed');
	});
});
