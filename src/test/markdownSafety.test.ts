import * as assert from 'assert';
import { safeLinkHref, UNDERLINE_PATTERN } from '../shared/markdownSafety';

suite('Markdown safety', () => {
	test('lets ordinary links through unchanged', () => {
		assert.strictEqual(safeLinkHref('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
		assert.strictEqual(safeLinkHref('http://example.com'), 'http://example.com');
		assert.strictEqual(safeLinkHref('mailto:someone@example.com'), 'mailto:someone@example.com');
		// The scheme is matched case-insensitively, as a browser would.
		assert.strictEqual(safeLinkHref('HTTPS://example.com'), 'HTTPS://example.com');
	});

	test('refuses every scheme that could do something', () => {
		for (const href of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'data:text/html;base64,PHNjcmlwdD4=',
			'vscode://file/etc/passwd',
			'command:workbench.action.terminal.new',
			'file:///etc/passwd'
		]) {
			assert.strictEqual(safeLinkHref(href), undefined, href);
		}
	});

	test('whitespace and control characters cannot smuggle a scheme past', () => {
		// A browser strips these before resolving, so the check has to as well.
		assert.strictEqual(safeLinkHref('java\nscript:alert(1)'), undefined);
		assert.strictEqual(safeLinkHref('java\tscript:alert(1)'), undefined);
		assert.strictEqual(safeLinkHref(' javascript:alert(1)'), undefined);
		assert.strictEqual(safeLinkHref('java script:alert(1)'), undefined);
		assert.strictEqual(safeLinkHref('\u0000javascript:alert(1)'), undefined);
		// The allow-list is what makes this safe: an encoded scheme simply is not
		// on it, so no unescaping arms race is needed.
		assert.strictEqual(safeLinkHref('&#106;avascript:alert(1)'), undefined);
	});

	test('a link with no scheme stays plain text', () => {
		// There is nothing for a relative href to resolve to inside a webview.
		assert.strictEqual(safeLinkHref('other.md'), undefined);
		assert.strictEqual(safeLinkHref('#section'), undefined);
		assert.strictEqual(safeLinkHref('//example.com'), undefined);
		assert.strictEqual(safeLinkHref(''), undefined);
	});

	test('the underline pattern matches one pair at a time', () => {
		assert.strictEqual(UNDERLINE_PATTERN.exec('<u>x</u>')?.[1], 'x');
		// Non-greedy: two underlines on a line stay two, not one long one.
		assert.strictEqual(UNDERLINE_PATTERN.exec('<u>a</u> and <u>b</u>')?.[1], 'a');
		// Inner markup is left for the inline lexer to deal with.
		assert.strictEqual(UNDERLINE_PATTERN.exec('<u>a **b**</u>')?.[1], 'a **b**');
		// It spans lines, because a paragraph can wrap.
		assert.strictEqual(UNDERLINE_PATTERN.exec('<u>a\nb</u>')?.[1], 'a\nb');
	});

	test('the underline pattern ignores anything that is not a closed pair', () => {
		assert.strictEqual(UNDERLINE_PATTERN.exec('<u>unclosed'), null);
		assert.strictEqual(UNDERLINE_PATTERN.exec('not <u>x</u>'), null);
		assert.strictEqual(UNDERLINE_PATTERN.exec('<script>x</script>'), null);
		assert.strictEqual(UNDERLINE_PATTERN.exec('<ul>x</ul>'), null);
	});
});
