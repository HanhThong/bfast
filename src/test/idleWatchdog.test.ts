import * as assert from 'assert';
import {
	DEFAULT_IDLE_TIMEOUT_MS,
	IdleWatchdog,
	idleTimeoutMessage
} from '../platform/idleWatchdog';
import { DEFAULT_IDLE_SECONDS } from '../settings/aiSettings';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts firings, so a test can assert "never" and "exactly once" alike. */
function watch(idleMs: number): { watchdog: IdleWatchdog; fired: () => number } {
	let count = 0;
	const watchdog = new IdleWatchdog(idleMs, () => {
		count += 1;
	});
	return { watchdog, fired: () => count };
}

suite('BFAST idle watchdog', () => {
	test('fires when nothing ever arrives', async () => {
		const { watchdog, fired } = watch(30);
		await wait(200);
		watchdog.stop();
		assert.strictEqual(fired(), 1, 'a child that never says anything is the case this exists for');
	});

	// The regression the whole change exists for: the old wall-clock timer killed
	// runs that were actively streaming.
	test('a run that keeps talking is never stopped', async () => {
		const { watchdog, fired } = watch(40);
		const beat = setInterval(() => watchdog.touch(), 10);

		await wait(250);
		assert.strictEqual(fired(), 0, 'six windows have passed, and it was busy through all of them');

		clearInterval(beat);
		await wait(200);
		assert.strictEqual(fired(), 1, 'and it stops once the talking does');
		watchdog.stop();
	});

	test('fires exactly once, never re-arming after it has', async () => {
		const { watchdog, fired } = watch(20);
		await wait(200);
		assert.strictEqual(fired(), 1);
		watchdog.stop();
	});

	test('stop() prevents it, and is safe twice and after it fired', async () => {
		const { watchdog, fired } = watch(40);
		watchdog.stop();
		watchdog.stop();
		await wait(150);
		assert.strictEqual(fired(), 0);

		const late = watch(20);
		await wait(120);
		late.watchdog.stop();
		assert.strictEqual(late.fired(), 1);
	});

	test('touch() after it fired does not revive it', async () => {
		const { watchdog, fired } = watch(20);
		await wait(120);
		watchdog.touch();
		await wait(120);
		assert.strictEqual(fired(), 1);
		watchdog.stop();
	});
});

suite('BFAST idle timeout message', () => {
	test('names the window that was actually enforced', () => {
		assert.ok(idleTimeoutMessage(180_000).includes('3 minutes'));
		assert.ok(idleTimeoutMessage(60_000).includes('1 minute'));
		assert.ok(!idleTimeoutMessage(60_000).includes('1 minutes'));
		assert.ok(idleTimeoutMessage(45_000).includes('45 seconds'));
	});

	test('says silence, not slowness', () => {
		const message = idleTimeoutMessage(DEFAULT_IDLE_TIMEOUT_MS);
		assert.ok(message.includes('sent nothing'));
		assert.ok(
			!message.includes('took too long'),
			'“took too long” reads as a cap on the work, which is what this stopped being'
		);
	});

	test('takes the subject, so a non-AI caller is not misdescribed', () => {
		assert.ok(idleTimeoutMessage(60_000, '`docker`').startsWith('`docker` sent nothing'));
	});
});

suite('BFAST idle timeout defaults', () => {
	// `aiSettings.ts` declares its own copy rather than importing the watchdog,
	// so the settings form does not drag a Node-only module into the webview
	// bundle. This is what keeps the form's placeholder honest.
	test('the form placeholder matches the window a provider falls back to', () => {
		assert.strictEqual(DEFAULT_IDLE_SECONDS * 1000, DEFAULT_IDLE_TIMEOUT_MS);
	});
});
