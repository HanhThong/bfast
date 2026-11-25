<One sentence: which flow this is, and what starts it.>

```mermaid
sequenceDiagram
    actor <Who starts it>
    participant <Service>
    participant <Dependency>

    <Who starts it>->><Service>: <what they ask for>
    <Service>->><Dependency>: <the call, named as the code names it>
    <Dependency>-->><Service>: <what comes back>
    alt <the condition that branches>
        <Service>-->><Who starts it>: <the success>
    else <the other case>
        <Service>-->><Who starts it>: <the failure, as the user sees it>
    end
```

## Notes

- <What the arrows cannot carry: a retry, a timeout, an idempotency key, what is
  left half-done if the last step fails.>
