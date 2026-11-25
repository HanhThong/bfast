# Ticket folder names

Every ticket is a folder in the tracker, and the folder's name is the ticket's id followed
by a slug of its title:

```
.tracker/
  EP-1-Authentication/
    ST-1.1-Sign_in_with_email/
      AC-1.1.1-Wrong_password_shows_an_error/
        TC-1.1.1.1-Unknown_email_same_error/
```

Those names are what git, Windows and every other tool see, and they nest four deep — so
they are kept short. This page is the specification for how a name is made, and for
**Shorten Long Ticket Folder Names**, the command that brings folders named under the
old, longer rule into line.

## The name

`<id>-<Slug>`, **at most 40 characters, the id included.**

- **The id** is the ticket's full id — `AC-1.1.1`, not `AC-1` — so a folder names itself
  without its ancestors having to be walked. It is never shortened.
- **The slug** is the title with the characters Windows forbids in a name removed and
  whitespace turned into `_`. It gets what the id leaves: 35 characters after `EP-1-`, 29
  after `TC-1.1.1.1-`. However long an id grows, its slug keeps at least 12.
- **It is cut on a word boundary** when one is near: a word that fits exactly is kept,
  and a `,` or `;` left dangling at the cut is dropped.
- **The slug is only for reading.** The tracker finds a ticket by its id and its place in
  the nesting, and the whole title stays in `metadata.yaml` — a shorter slug loses words
  in a folder listing and nothing else.

Every route that names a folder follows the rule: **New…**, the **Generate** commands,
**Rename**, and the MCP server's `create_ticket` and `rename_ticket`.

A tracker with long titles, before and after:

| Ticket | Old rule (slug ≤ 60) | New rule (name ≤ 40) |
|---|---|---|
| ST-1.1 | `ST-1.1-Create_a_player_account_with_email_and_password_right_inside` (67) | `ST-1.1-Create_a_player_account_with` (35) |
| AC-1.1.1 | `AC-1.1.1-Create_a_new_account_with_email,_display_name_and_password` (67) | `AC-1.1.1-Create_a_new_account_with` (34) |
| TC-1.1.1.1 | `TC-1.1.1.1-Registers_with_email,_display_name_and_password_and_lands` (68) | `TC-1.1.1.1-Registers_with_email,_display` (40) |

In the real tracker this rule was made for, the deepest file went from 245 characters from the
repository root to 158.

## Why 40: a path budget

Windows has two limits that every program not written for long paths lives under — git
unless its `core.longpaths` setting is on, Windows Explorer, many build tools: a **file's**
full path must stay under 260 characters, and a **folder's** under 248. They count from
the drive letter, so where the repository is checked out counts too.

A tracker nests four levels deep (epic → story → criterion → test case), and its deepest
file is `.tracker/<epic>/<story>/<criterion>/<test case>/metadata.yaml`. At 40 characters
a name, that is at most **186 characters** from the repository root. The 70 or so left
over cover a clone under a user profile, and an [environment](../environments/README.md)'s
worktree under the default `%TEMP%\bfast-worktrees\<workspace>\<ticket>\` — a second
checkout of the whole repository, tracker included, in a folder whose own path is about
70 characters long.

**Sub-epics spend that budget.** An epic may hold other epics beside its stories
(`EP-1/EP-1.2/ST-1.2.1/…`), and each sub-epic level adds another folder of up to 40
characters — and lengthens every id below it, which leaves the slugs less. One level of
sub-epic still fits the Windows worktree case above; deeper nesting is allowed but is
the user's trade.

Under the old rule the slug alone could be 60 characters, with the id on top at every
level, so the same path could reach almost 300 before the checkout's location was even
counted. The tracker above reached 255 of the 260 in a clone at the root of a drive, and an
environment's worktree of it could not be checked out at all.

The budget is a margin, not a guarantee: an `assets/` image inside a deep test case, or a
tracker folder nested deeper than `.tracker`, spends some of it. A long path in an
environment is handled on its own terms — see [Long paths on
Windows](../environments/README.md#long-paths-on-windows).

## Folders named under the old rule

**Nothing renames a folder behind your back.** A folder named under the old rule keeps its
name and keeps working, since nothing but a title fallback ever reads a slug back.
Renaming a ticket's title re-slugs its folder under the new rule. To bring every folder in
at once, run the command below.

## Shorten Long Ticket Folder Names

In the **Tickets** section's `…` menu, and in the command palette as **BFAST: Shorten Long
Ticket Folder Names**.

1. It finds every ticket folder whose name is **longer than 40 characters**. When there is
   none it says so, and that is all.
2. It asks once, with the count: *Shorten 117 ticket folder names?*
3. It renames each one to the name the ticket would get if it were made today —
   `<id>-<Slug>` by the rules above, from the title in `metadata.yaml`. The id is the one
   the nesting gives the ticket, as Rename does, so a folder whose name claimed a different
   one (the sidebar's *Id does not match its folder*) is corrected on the way.
4. It reports how many it renamed. A folder it could not rename is listed with the reason,
   and every other folder is still renamed.

It works **deepest first**: renaming a test case's folder leaves its criterion's path as it
was, and renaming the criterion afterwards carries the already-renamed test case along.
**Nothing is ever overwritten** — a folder whose new name is already taken (two
duplicate-id tickets with the same title, after a bad merge) is skipped and reported.
Running it again picks up only what is still too long.

**Only folder names change.** Everything else stays exactly as it was:

- the ticket's id, title, status and description;
- `metadata.yaml`, `updatedAt` included — so a board open mid-edit still saves;
- `history.md` — no entry is written, because a folder's name is not a change to the
  ticket;
- design documents and `assets/`, which move with their folder;
- test runs and environments, which are keyed by id and live outside the tracker.

The sidebar and every open board reload by themselves. A ticket's board stays open,
because a board is keyed by id, not by path.

### Before you run it

- **Commit or stash your other changes first**, so git shows the command's work as renames
  and nothing else — and commit the renames on their own.
- **Branches made before the renames merge through git's rename detection.** An edit on an
  environment's `story/…` branch to a file whose folder was renamed on `master` follows the
  file to its new name; a commit that holds nothing but renames is what keeps that easy.
- **Close editor tabs showing a ticket's files as text.** Like Rename, the command moves
  folders on disk, and a tab open on a file inside one shows it as deleted.
- **Not while an AI run is editing tickets.** A board run that may edit other tickets is
  given the files it may touch by path, when it starts.
- **Implement's handoff files** (`.bfast/implement/prompts/<id>.md`) name ticket folders by
  path; one written before the renames points at the old folder until Implement writes it
  again.
- **Other checkouts keep the old names** — a teammate's clone, an environment's worktree —
  until they pull or merge the commit.

## Sub-epics and the shared ordinal sequence

An epic can contain epics as well as stories. Ids keep their grammar —
`<PREFIX>-<every ancestor's ordinal>.<its own>` — and a sub-epic is simply `EP-1.2`.

A tree id records only the **leaf's** type, so an ancestor is found by ordinal alone. If
`EP-1.2` and `ST-1.2` could both sit under `EP-1`, then `TC-1.2.1.1` would name a test
case under `AC-1.2.1` (of the story) *and* one under `ST-1.2.1` (of the sub-epic). So
within one parent, **every type that can have children shares one ordinal sequence**
(`nextOrdinal`, `isContainerType` in `trackerPaths.ts`): under an epic, sub-epics and
stories count together — `EP-1.1`, `ST-1.2`, `EP-1.3`. Test cases still count apart from
acceptance criteria (`AC-1.1.1` and `TC-1.1.1` under one story), because a test case has
no children and so can never be an ancestor. A tracker with no sub-epic has one container
type per parent and its ids are exactly what they were.

A hand-made clash (`EP-1.2` and `ST-1.2` under one epic) loads both — the bad-merge rule,
keyed on `ordinalKey` rather than the id — and the **story keeps its plain id** while the
epic takes the rank (`EP-1.2#2`) and a *Duplicate id* warning. That order is what keeps an
older tracker's ids stable: an epic folder copied into another by hand used to be skipped,
and now loads, but it can never rename a story people already link to. A folder with a `metadata.yaml` but nothing else naming
its type is still read as a story under an epic (`fallbackChildType`).

## Where a test case can sit

A test case may sit under **any ticket but another test case** (`allowedChildTypes`):

| Under | What it is |
|---|---|
| an acceptance criterion | the runnable form of that one criterion — `TC-1.2.1.1` |
| a story | a test that crosses several of the story's criteria — `TC-1.2.3` |
| an epic (or a sub-epic) | a journey across several of the epic's stories — `TC-1.4` |

Its ordinal is counted apart from the containers beside it, for the reason above: a test case
is never an ancestor, so `ST-1.1`, `TC-1.1` and `EP-1.2` under one epic name three different
tickets. Only an epic sits at the top level, so a test case always has a parent. Run Tests on any
ticket collects every test case below it, wherever it hangs.

The sidebar's eye button (**Hide Test Cases** / **Show Test Cases**, `bfast.hideTestCases` /
`bfast.showTestCases`) drops test case rows from the tree, in the lazy tree and under a filter
alike. It is one person's way of reading the tree, so it is kept in `workspaceState` and never in
`bfast.json`; the view's title says *Test cases hidden* while it is on, and an acceptance
criterion loses its expander, since nothing else can sit under one. Nothing else changes: a
board, Run Tests and the MCP tools still see every test case, and opening a hidden test case's
board selects nothing in the tree.

## Changing a ticket's type

An epic can become a story and a story an epic — **Change Type to Story** / **Change Type
to Epic** on the ticket's context menu (`bfast.convertToStory` / `bfast.convertToEpic` →
`changeType`). No other pair converts (`convertibleTypes`): a criterion and a test case
have shapes of their own that no conversion could honestly produce.

- **The ordinal stays.** An epic and a story share one ordinal sequence under their parent,
  so `EP-1.2` becomes `ST-1.2` and no sibling's id moves. Only a ticket caught in a
  hand-made clash (`EP-1.2#2`) takes the next free ordinal instead, resolving the clash.
- **What moves:** the description file (`Epic.mdx` ↔ `Story.mdx`), the `id` in
  `metadata.yaml`, and the folder name. Title, description, status, `createdAt`, design
  documents and `assets/` stay. One `changed — type — from — to` entry is written and
  `updatedAt` is bumped: unlike a folder rename, this *is* a change to the ticket.
- **Refused, writing nothing** (`typeChangeRefusal`), when the hierarchy would break: a
  top-level epic (a story must sit under an epic), and any ticket that still holds
  children the new type cannot — an epic with stories or sub-epics, a story with criteria.
  Test cases travel either way, since both an epic and a story can hold them. Children are never converted along: a story's criteria have nowhere to go
  under an epic.
- **Refused by the command while the ticket has an environment**: its worktree, branch and
  stack are named after the id.
- An open board for the ticket is closed and reopened on the new id. Every ticket **linked**
  to it (see **Links** below) is re-pointed at the new id with no history entry — the link
  did not change, only how one end is spelled. Anything else that names the old id — a
  mention in another description, a commit message — is the user's to update; the
  confirmation says so.

## Links

A ticket can be linked to any other ticket, whatever the two types and wherever they sit in
the tree. Seven relations, four kinds:

| Relation (this ticket …) | The other ticket records | `metadata.yaml` key |
|---|---|---|
| blocks | is blocked by | `blocks` / `blockedBy` |
| is blocked by | blocks | `blockedBy` / `blocks` |
| relates to | relates to | `relatesTo` |
| duplicates | is duplicated by | `duplicates` / `duplicatedBy` |
| is duplicated by | duplicates | `duplicatedBy` / `duplicates` |
| clones | is cloned by | `clones` / `clonedBy` |
| is cloned by | clones | `clonedBy` / `clones` |

```yaml
# ST-1.1's metadata.yaml           # ST-1.2's metadata.yaml
blocks: ST-1.2, ST-1.3             blockedBy: ST-1.1
relatesTo: EP-2                    
```

`src/data/ticketLinks.ts` is the table, Node-free, read by the store, the board and the MCP
tools alike.

- **Stored on both tickets.** Each side is written in its own ticket's `metadata.yaml`, under its
  own relation's key: one flat key per relation, the ids comma-separated, a key written only when
  it holds an id. Storing one side and deriving the other would mean reading the whole tracker to
  draw one board — the scan the lazy tree exists to avoid.
- **A link is not an edit of the description.** Linking writes the metadata and one history entry
  on each ticket (`linked — blocks — to: ST-1.2`, `unlinked — … — from: …`) and does **not** bump
  `updatedAt`, for the `addAttachment` reason: a board open mid-edit on either ticket must still
  be able to save. Every other write re-reads the metadata from disk, so it keeps the links.
- **Non-events and refusals.** The same link again writes nothing; `relates to` is its own
  inverse, so linking it from the other side is the same link. A link to itself, or to an id the
  tracker does not hold, is refused.
- **Reading is forgiving.** Ids split on commas or whitespace, any case; something that is not a
  ticket id is dropped. A link whose ticket is gone — deleted by hand, lost in a merge — is still
  listed, without a target, so the board can say *Not in the tracker* and offer to remove it.
  Removing it takes it off this side alone; there is no other side left.
- **Delete** takes the other side of every link the deleted subtree held off the tickets that
  remain, each with an `unlinked` entry saying *`<id>` was deleted.* A link between two tickets
  that both go needs nothing. Best-effort: the folder is gone first, and a link left behind is
  only ever a *Not in the tracker* row.
- **A type change** re-points the other side (see above). The ticket's own links are the index
  of who names it, so no scan is needed.
- **Where:** a board's **Description** tab ends in a *Linked tickets* section, grouped by
  relation — a row opens that ticket's board, × removes the link from both. **Link ticket** there,
  or **Link to Ticket…** on the sidebar's context menu (`bfast.linkTicket`), asks for the relation
  and then the ticket in two quick picks. Over MCP, `link_tickets` / `unlink_tickets` (the `write`
  function), and `get_ticket` answers a ticket's `links`.
