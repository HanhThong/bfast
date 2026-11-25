// What a workspace is called on disk and in a compose project name.
//
// One definition, because Environments and Code Quality both derive folders,
// project names and secret-storage keys from it and must get the same answer.

/**
 * Lower-case and hyphenated, like `slugifyAgentName` — deliberately not
 * `slugifyTitle`, which is built for ticket folder names. Same-named
 * workspaces share a folder; the marker's `sourceRoot` is what tells their
 * environments apart.
 *
 * Exported because the scan feature needs the identical answer in three places
 * — its compose project name, its own home folder, and the suffix on its
 * secret-storage keys. Two definitions of "what is this workspace called" would
 * put a server's credentials under a name its folder does not have.
 */
export function workspaceSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug.length > 0 ? slug : 'workspace';
}
