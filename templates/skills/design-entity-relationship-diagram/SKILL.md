---
name: design-entity-relationship-diagram
description: The entities a ticket introduces or changes, as one mermaid erDiagram.
kind: design
style: entity-relationship-diagram
label: Entity-Relationship Diagram
prefix: ERD
types: epic, story
---

An entity-relationship diagram says what the data looks like after this ticket
is done. It is not a picture of the whole database, and it is not a class
diagram: it shows the entities this ticket introduces or changes, plus the ones
they hang off.

**Write exactly one `erDiagram`, and a short paragraph either side of it.**

Read the codebase first. Existing tables, models or schema files are the source
of truth for what an entity is already called and what it already holds — a
diagram that renames `accounts` to `Users` is worse than no diagram, because a
reader will believe it. Where the ticket adds a field to something that exists,
show that entity with the fields that matter to this ticket, not all of them.

Name every relationship. `ACCOUNT ||--o{ SESSION : opens` reads as a sentence
and `ACCOUNT ||--o{ SESSION : ""` does not. Cardinality is the point of the
diagram, so get it right: `||--o{` is one-to-many, `||--||` one-to-one,
`}o--o{` many-to-many, and a `o` on an end means that end is optional.

Give each entity the attributes the ticket actually turns on, with a type and,
where it matters, `PK`, `FK` or `UK`. A list of every column is noise; the
primary key, the foreign keys and the two or three fields the behaviour depends
on are the diagram.

## Structure

The diagram goes in one ```mermaid fence and nothing else does. Above it, one
or two sentences saying what changes. Below it, a short `## Notes` list for
what the diagram cannot show — a uniqueness rule spanning two columns, a
cascade on delete, a field that is nullable only during a migration.

Mermaid keywords, entity names, attribute names and types stay in English
whatever language the prose is written in: they are code, and a translated
`erDiagram` does not render.

---

Return only the document, as markdown, containing exactly one ```mermaid fence.
Do not wrap the whole answer in a code fence, do not repeat the document title as
a heading, do not write or modify any files, and do not explain what you did.
