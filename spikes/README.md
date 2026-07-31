# Spikes

Time-boxed investigations that answer a question with evidence. Each one produces a **written
artifact** — normally an [ADR](../docs/adr/README.md) — and the harness stays in the repo so the
numbers can be re-run and disputed later.

Spikes are workspace packages so their dependencies resolve normally, but they deliberately have
**no `test` script**: they need real servers, and CI has none. `nx run-many -t test` cannot reach
them. Lint and typecheck still apply, so they cannot silently rot.

| Spike                | Question                              | Outcome                                                         |
| -------------------- | ------------------------------------- | --------------------------------------------------------------- |
| [`broker/`](broker/) | NATS JetStream or RabbitMQ? (EP-03.0) | [ADR-0001](../docs/adr/0001-message-broker.md) — NATS JetStream |

## Running one

```sh
docker compose -f infra/docker-compose.dev.yml up -d
npm run spike -w @atlas/broker-spike           # SPIKE_LOAD=20000 by default
```

The broker spike restarts containers as part of the durability scenario, so don't run it against
anything you care about.
