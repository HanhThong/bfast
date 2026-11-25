# Commit Ticket

Right-click a ticket in the sidebar → **Commit Ticket…** (`bfast.commitTicket`, menu group
`6_implement@2`). Once a ticket has been reviewed, this commits **its files in the tracker** —
and nothing else — to the git repository the tracker lives in.

It is a manual gesture on purpose: "reviewed" is the user's judgement, not a status BFAST can
read, so nothing commits on its own.

## What is committed

The ticket's folder, as `git status` sees it:

| Changed path | Goes in |
|---|---|
| the description, `metadata.yaml`, `history.md`, design documents, `assets/` | the ticket's own files |
| anything inside a child ticket's folder (`ST-1.2-…/`, `AC-1.2.1-…/`) | the tickets under it |
| a **deleted** path under a sibling folder claiming the same id | wherever that path would have gone — it is the folder's old name after a rename |

When only the ticket's own files changed, they are committed without asking. When tickets under
it changed too, a pick offers **`<id>` only** or **`<id>` and the tickets under it**, each with its
file count.

The old-location rule is load-bearing: BFAST renames a slug with a plain file-system rename, so
git sees the old folder deleted and the new one untracked. Committing the new folder alone would
leave both in the commit's tree — a duplicate ticket for everyone who pulls it.

## How it is committed

```
git rev-parse --show-toplevel --show-prefix          (cwd: the ticket folder)
git status --porcelain=v1 -z --untracked-files=all -- <parent folder>
git add -A          --pathspec-from-file=- --pathspec-file-nul
git commit --only --message <message> --pathspec-from-file=- --pathspec-file-nul
git rev-parse --short HEAD
```

- **`--only`**: whatever else the user has staged stays staged and stays out of this commit.
- **Paths on stdin**, with `GIT_LITERAL_PATHSPECS=1`: a subtree can pass Windows' command-line
  limit, and a slug may hold `[` or `*`, which a pathspec would read as a glob.
- The message is an argv element (`shell: false`), so a title is never shell-interpreted.
- The repository's own hooks and signing configuration apply; BFAST passes no `--no-verify`.
- Every call carries `-c core.longpaths=true` (`gitArgs`, the environments rule).

## The message

Pre-filled from `git.commitMessage` in `.vscode/bfast.json` (General tab), default
`{{id}}: {{title}}`, and editable in the input box before committing. Placeholders: `{{id}}`,
`{{key}}`, `{{title}}`, `{{type}}`, `{{status}}`; an unknown token is left as written and named
by the form, never refused. The rendered message is collapsed to one line.

The `git` block follows every other block: parse forgiving, validate strict, omitted when empty.

## Outcomes

| Situation | What the user sees |
|---|---|
| git is not installed | error: "Git is not installed, or not on the PATH." |
| the tracker is not in a repository git can use | error, with git's own line |
| no changed file for the ticket | info: "Nothing to commit for `<id>`…" |
| pick or input box dismissed | nothing |
| git refuses (hook failed, no identity, …) | error with git's message; nothing is rolled back — the paths stay staged |
| committed | info: "Committed `<id>` as `<hash>` (N files)." with **Show Source Control** |

## Uncommitted changes

The sidebar marks every ticket with uncommitted changes, the way the Explorer marks a file —
so it is clear which tickets Commit Ticket has something to commit for before anyone right-clicks.

| Mark | Meaning |
|---|---|
| `M`, git's *modified* colour | the ticket's **own** files changed: description, `metadata.yaml`, `history.md`, a design document, `assets/` — or its folder was renamed |
| `U`, git's *untracked* colour | every one of its files is new to git: a ticket never committed |
| `•`, git's *modified* colour | the ticket itself is clean, but a ticket somewhere below it is not — findable with the tree collapsed |

- It is a `FileDecorationProvider` on the `bfast-ticket:` scheme, not a character in the label,
  so the label a filter matches and a screen reader speaks is unchanged — and the board, a
  custom editor on that same resource, wears the mark on its tab.
- The changes are one `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all`
  over the tracker folder (`trackerStatus`). A path belongs to the **deepest** run of
  ticket-named folders around it (`changedTicketFolders`, pure); that folder is turned into a
  ticket by `ticketAt` — by nesting, never by the folder name's id. A folder that is gone
  resolves to nothing and is not marked.
- A renamed folder shows git a deleted folder and an untracked one; when a sibling claiming the
  same id lost files, the new folder is `M`, not `U`.
- It looks again after every tracker refresh, after Commit Ticket, and whenever the built-in git
  extension's model of a repository moves (a commit or a stage from Source Control or a
  terminal), debounced. `--no-optional-locks` keeps the look from writing the index, which the
  git extension would report as the next change — a loop.
- No git, no repository, or a tracker git ignores: no marks, and nothing said — Commit Ticket is
  where that is reported in words.

## What it does not do

- It writes **nothing into the ticket**: no history entry, no status change, no `updatedAt`
  bump — a commit is not a change to the ticket, and a bump would fail the next save of a board
  open mid-edit.
- It never pushes.
- It does not commit code in an environment's worktree; that is the coding agent's and the
  user's, in that worktree's own window.
