// Loading the Claude Agent SDK, and nothing else.
//
// `@anthropic-ai/claude-agent-sdk` is ESM-only (`"type": "module"`, a single
// `sdk.mjs` export) while the extension host is CommonJS, so it can only be
// reached through a dynamic `import()`. Under `module: Node16` TypeScript emits
// that call verbatim into the CJS output rather than rewriting it to
// `require()` — which is the whole reason this works, and the reason
// `npm run verify:esm` greps the built file for it.
//
// It is its own module so the hazard has exactly one address, and so the
// provider can be unit-tested with a stub loader instead of a real install.

import { AiError } from './aiProvider';

/**
 * A *type query*, not an import statement, so it is erased unconditionally.
 * `import type { … } from …` would work today but is one compiler-flag change
 * away from emitting an interop check for an ESM-only package.
 */
export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk', {
	// The package is ESM-only, and this file compiles to CommonJS: without this
	// TypeScript refuses the type query outright (TS1542). It affects resolution
	// only — the query is still erased, and the runtime `import()` below is what
	// actually loads the module.
	with: { 'resolution-mode': 'import' }
});
export type SdkQuery = SdkModule['query'];
export type SdkOptions = NonNullable<Parameters<SdkQuery>[0]['options']>;
export type SdkLoader = () => Promise<SdkModule>;

const MISSING =
	'The Claude Agent SDK could not be loaded. It ships a binary per platform, so ' +
	'a build made on another operating system carries none for this one — set the ' +
	'Claude executable path in BFAST settings, or use the Claude Code CLI provider.';

let cached: Promise<SdkModule> | undefined;

export const loadClaudeSdk: SdkLoader = () => {
	cached ??= import('@anthropic-ai/claude-agent-sdk').catch((error: unknown) => {
		// A failed load must not stay cached, or installing the SDK would never
		// take effect without reloading the window.
		cached = undefined;
		throw new AiError('not-installed', MISSING, error);
	});
	return cached;
};
