<One or two sentences: what this ticket changes about the data.>

```mermaid
erDiagram
    <PARENT> ||--o{ <CHILD> : <verb>
    <PARENT> {
        uuid id PK
        <type> <name> <UK, when it is unique>
    }
    <CHILD> {
        uuid id PK
        uuid <parent>_id FK
        <type> <name>
    }
```

## Notes

- <A rule the diagram cannot carry: a composite uniqueness, a delete cascade, a
  column that is nullable only until the backfill finishes.>
