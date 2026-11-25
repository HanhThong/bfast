// The one platform-shell wrap in BFAST.
//
// `runProcess` spawns with `shell: false`, which is what makes an argument list
// reach a binary byte-for-byte and nothing ever get interpreted on the way. But
// two features are configured with a *shell line* rather than an argument list —
// `tests.command` and `scan.command` — and a line is inherently the shell's: on
// Windows `npm` and `npx` are `.cmd` shims a bare `spawn` cannot launch, and
// pipes and `&&` belong to the shell everywhere.
//
// It lives in `platform/` rather than beside either caller, for the
// reason `idleWatchdog.ts` and `semaphore.ts` do: two subsystems need it, and a
// fix to the Windows verbatim-argument rule below has to reach both. A second
// copy is exactly the drift this placement prevents.

export interface ShellInvocation {
	executable: string;
	args: string[];
	/** Passed straight to `spawn`; see the note in `shellCommand`. */
	windowsVerbatimArguments?: boolean;
}

/**
 * Wraps a shell line so `runProcess` can launch it.
 *
 * On win32 the wrap supplies its own outer quotes, which `/s` strips, and asks
 * for verbatim arguments so the user's line reaches `cmd` byte-for-byte instead
 * of being re-escaped by MSVCRT rules `cmd` does not parse.
 *
 * `platform` is an explicit parameter rather than a read of `process.platform`
 * so both branches are testable on one machine.
 */
export function shellCommand(line: string, platform: NodeJS.Platform): ShellInvocation {
	if (platform === 'win32') {
		return {
			executable: process.env.ComSpec ?? 'cmd.exe',
			args: ['/d', '/s', '/c', `"${line}"`],
			windowsVerbatimArguments: true
		};
	}
	return { executable: '/bin/sh', args: ['-c', line] };
}

/**
 * A value quoted so the platform shell reads it as exactly one argument,
 * whatever it contains — for `{{file}}` in `tests.evidenceCommand`, a path that
 * carries a ticket title's apostrophes and dollar signs and a file name that
 * arrived from git. BFAST quotes rather than the template, because the template
 * cannot know which dialect it will run under.
 *
 * POSIX: single quotes, an embedded `'` spliced in as `'\''`. Nothing expands
 * inside single quotes, so `$(`, a backtick and `;` are all inert. `cmd.exe`:
 * double quotes, which cannot hold a `"` (a Windows path cannot either) and
 * still expand `%VAR%` — so a `%` is refused rather than risked.
 */
export function quoteShellArgument(value: string, platform: NodeJS.Platform): string {
	if (platform === 'win32') {
		if (value.includes('"') || value.includes('%')) {
			throw new Error(`\`${value}\` cannot be quoted safely for cmd.exe.`);
		}
		return `"${value}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
