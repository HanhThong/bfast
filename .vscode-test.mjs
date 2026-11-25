import { defineConfig } from '@vscode/test-cli';

// A headless box (SSH remote, CI container) has no X server, and the VS Code
// test host exits with "Missing X server or $DISPLAY" before a single test
// runs. Chromium's headless Ozone platform draws to nothing and needs no
// display, so it is used exactly when there is none — a desktop keeps its
// visible window, which is where a failing test is easiest to watch.
const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Settings are per-workspace, so the tests need VS Code to have a folder open.
	workspaceFolder: './src/test/fixtures/workspace',
	launchArgs: headless ? ['--ozone-platform=headless', '--disable-gpu'] : []
});
