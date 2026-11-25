import typescriptEslint from "typescript-eslint";

// Layering, held by the linter rather than by a comment in each file.
//
// Flat config lets the *last* matching block win for a rule, so each block
// below states everything that applies to its files — `restrict` always adds
// the rule that only the composition root assembles features.
const WEBVIEW_SAFE = "This module is bundled into a webview or shared with one; keep `vscode` on the host side.";
const NODE_FREE = "This module is bundled into a webview and has no Node built-ins.";
const NODE_BUILTINS = ["fs", "fs/promises", "path", "os", "child_process", "http", "https", "net", "crypto", "zlib", "util", "stream", "events"];

function restrict({ paths = [], patterns = [] } = {}) {
    return {
        "no-restricted-imports": ["error", {
            paths,
            patterns: [...patterns, {
                group: ["**/modules/*", "!**/modules/core"],
                message: "A feature does not import a module; it is handed what it needs by one.",
            }],
        }],
    };
}

const layering = [{
    // Only the composition root and the feature modules assemble features.
    files: ["src/**"],
    ignores: ["src/extension.ts", "src/modules/**", "src/test/**"],
    rules: restrict(),
}, {
    // `platform/` is what every feature shares, and the webview bundles parts
    // of it, so it never reaches the extension host API.
    files: ["src/platform/**"],
    rules: restrict({ paths: [{ name: "vscode", message: WEBVIEW_SAFE }] }),
}, {
    // The host <-> webview seam and the browser code are Node-free as well:
    // even an `import type` from a module that imports `node:` fails
    // `typecheck:web`.
    files: ["src/shared/**", "src/webview/**"],
    rules: restrict({
        paths: [
            { name: "vscode", message: WEBVIEW_SAFE },
            ...NODE_BUILTINS.map((name) => ({ name, message: NODE_FREE })),
        ],
        patterns: [{ group: ["node:*"], message: NODE_FREE }],
    }),
}];

export default [{
    files: ["**/*.ts", "**/*.tsx"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, ...layering];
