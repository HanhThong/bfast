---
name: design-low-level-design
description: How this ticket is built inside — free-form, in whatever mix of prose, structure and diagrams the design needs.
kind: design
style: low-level-design
label: Low Level Design
prefix: LLD
types: epic, story
---

A low level design says how this ticket is **built**: the modules or classes that
do the work, the contracts between them, the data they carry, the paths through
them, and the decisions a reviewer would want to argue about before any code
exists.

**This document has no fixed shape, and that is deliberate.** The
entity-relationship diagram and the sequence diagram are one picture each; a low
level design is whatever this particular ticket needs in order to be understood.
Use the headings that fit it, in the order that reads, with as much prose, as
many lists, tables, signatures and diagrams — or as few — as the work actually
calls for. Write what the ticket needs and then stop: a section kept because a
template had it is padding, and padding is what makes a design go unread.

Read the codebase first. Whatever you name — a class, a module, a field, a file,
an endpoint — is named the way the repository already names it, and put where the
repository would put it. A design that invents a `Manager` where the code has
services, or splits one file into three because the picture looks tidier, is a
design nobody can follow to a diff.

Be concrete enough to disagree with. `+issue(accountId: Uuid, ttl: Duration)
Session, throws ExpiredAccount` is a contract someone can review; "a method to
issue sessions" is a sentence that survives any implementation, including the
wrong one. The same goes for the state a component owns, the shape of what
crosses a boundary, and the error each layer turns into which.

Stay in your lane. Where this ticket already has an entity-relationship diagram
or a sequence diagram, point at it rather than redrawing it — what is stored and
how one flow runs are those documents' jobs, and three documents disagreeing
about the same thing is worse than one that is silent.

Say where the work does *not* go, because that is the half a reader cannot infer:
what a component refuses to do, which errors cross which boundary, what is
transactional, what is idempotent, what runs in the background, what is left for
a later ticket.

## Structure

Yours to choose — there is no template to fill in, and no section is required.
These are the ones that usually earn their place, in the order they usually earn
it: what is being built and where it sits; the components and their
responsibilities; the contracts or signatures the ticket turns on; the data
structures; the path through the system when it works and when it does not; the
decisions taken and what was rejected; and the notes that nothing else carries.
Take the ones this ticket needs.

Every diagram goes in its own ```mermaid fence — a `classDiagram` for structure,
a `flowchart` for a decision path, a `stateDiagram-v2` for a lifecycle. Use as
many as earn their place, or none at all: a paragraph that says it plainly beats
a picture drawn out of duty.

Mermaid keywords, class and member names, types, identifiers, file paths and
endpoints stay in English whatever language the prose is written in: they are
code, and a translated `classDiagram` does not render.

---

Return only the document, as markdown, with each diagram in its own ```mermaid
fence. Do not wrap the whole answer in a code fence, do not repeat the document
title as a heading, do not write or modify any files, and do not explain what you
did.
