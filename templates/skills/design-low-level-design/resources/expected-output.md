One shape this document can take — not a template to fill in. Keep the sections
this ticket needs, drop the rest, add the ones it asks for, and use a diagram
only where a diagram says it better.

---

<One or two sentences: what this ticket builds, and where it sits in the codebase.>

## Components

| <Component> | Responsibility | Lives in |
|---|---|---|
| `<Name>` | <what it owns — and, where it matters, what it deliberately leaves alone> | `<path/in/the/repo>` |

```mermaid
classDiagram
    class <Service> {
        -<collaborator>: <Dependency>
        +<operation>(<name>: <type>) <Result>
    }
    class <Dependency> {
        <<interface>>
        +<operation>(<name>: <type>) <Result>
    }
    <Service> --> <Dependency> : <what it uses it for>
```

## Contracts

- `<operation>(<name>: <type>) <Result>` — <what it does, what it returns, and
  what it does on the failure that matters: the error raised, and what state is
  left behind.>

## <The path through it>

<Prose, a list of numbered steps, or a small `flowchart` — whichever this ticket
actually needs. Skip it entirely when a sequence diagram on this ticket already
says it.>

## Decisions

- <What was chosen, the alternative that was rejected, and the reason a reader
  would otherwise ask about.>

## Notes

- <What nothing above carries: an invariant, a transaction boundary, what is
  retried, what runs in the background, the order a migration has to run in.>
