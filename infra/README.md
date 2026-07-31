# Local development infrastructure

Real servers for local work: Postgres, NATS (JetStream) and RabbitMQ.

```sh
docker compose -f infra/docker-compose.dev.yml up -d
docker compose -f infra/docker-compose.dev.yml ps
docker compose -f infra/docker-compose.dev.yml down      # keep data
docker compose -f infra/docker-compose.dev.yml down -v   # drop data too
```

Ports are deliberately non-default so this never collides with a Postgres or Redis you already run:

| Service                | Host port | Credentials                             |
| ---------------------- | --------- | --------------------------------------- |
| Postgres               | `55432`   | `atlas` / `atlas`, db `atlas`           |
| NATS client            | `54222`   | none                                    |
| NATS monitoring        | `58222`   | none — `http://localhost:58222/healthz` |
| RabbitMQ AMQP          | `55672`   | `atlas` / `atlas`                       |
| RabbitMQ management UI | `15672`   | `atlas` / `atlas`                       |

RabbitMQ is here only because [ADR-0001](../docs/adr/0001-message-broker.md) compared it against
NATS and the harness must stay re-runnable. **NATS JetStream is the broker Atlas uses.**

## Not a deployment topology

Single node, no TLS, default credentials, data in named volumes. Production install, upgrade,
backup and DR are in [the operations runbook](../docs/operations/17-operations-runbook.md).

## Tests do not need any of this

CI runs no containers. `@atlas/data` uses `node:sqlite` in-memory and `@atlas/messaging` ships an
`InMemoryBroker`. This compose file is for development and for spikes.

## Troubleshooting

**RabbitMQ exits immediately with `Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces`** —
a known Docker Desktop volume-permission failure. The volume is unrecoverable once it happens:

```sh
docker rm -f atlas-rabbitmq
docker volume rm atlas-dev_rabbitdata
docker compose -f infra/docker-compose.dev.yml up -d rabbitmq
```
