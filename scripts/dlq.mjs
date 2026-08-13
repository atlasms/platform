// The dead-letter inspection and replay tool (EP-03.4).
//
//   ATLAS_NATS_URL=nats://localhost:54222 node --import tsx scripts/dlq.mjs list
//   ATLAS_NATS_URL=... node --import tsx scripts/dlq.mjs list --limit 100
//   ATLAS_NATS_URL=... node --import tsx scripts/dlq.mjs replay <message-id>
//   ATLAS_NATS_URL=... node --import tsx scripts/dlq.mjs replay-all --yes
//
// A script rather than an endpoint, deliberately. Replay re-delivers production events, so it is
// an operator action taken from a shell with credentials — not something reachable over HTTP where
// it would need its own authorization story, and where a misrouted request could replay a month of
// events. If it ever becomes an endpoint it belongs behind `ops:write` in Logging & Analytics.
//
// Outside the workspace, like the smoke suite: it talks to a real broker and nothing in CI should
// pick it up.

import { NatsBroker } from '../libs/messaging-nats/src/index.ts';

const [, , command, ...rest] = process.argv;
const url = process.env.ATLAS_NATS_URL;

if (!url) {
  console.error('ATLAS_NATS_URL is not set. Point it at the broker, e.g. nats://localhost:54222');
  process.exit(2);
}

const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};

// A DISTINCT service identity, so this tool never shares a durable consumer with a running
// service. Sharing one would make the tool compete for messages and quietly steal deliveries from
// the very service an operator is trying to repair.
const broker = await NatsBroker.connect({ servers: url, service: `dlq-tool-${process.pid}` });

try {
  switch (command) {
    case 'count': {
      console.log(await broker.deadLetterCount());
      break;
    }

    case 'list': {
      const limit = Number(flag('limit', '25'));
      const entries = await broker.listDeadLetters(limit);
      if (entries.length === 0) {
        console.log('No dead letters.');
        break;
      }
      console.log(`${entries.length} dead letter(s), newest first:\n`);
      for (const e of entries) {
        const recoverable = e.message ? '' : '  [ORIGINAL GONE — cannot be replayed]';
        console.log(`  ${e.id}`);
        console.log(`    subject   ${e.subject}`);
        console.log(`    attempts  ${e.attempts}`);
        console.log(`    consumer  ${e.consumer ?? '(unknown)'}`);
        console.log(`    failed    ${e.failedAt ?? '(unknown)'}${recoverable}`);
        // No `error` on JetStream: the advisory says the consumer gave up, never why the handler
        // threw. Point at where that actually lives rather than printing "undefined".
        if (e.error) console.log(`    error     ${e.error}`);
        else console.log(`    error     (not recorded by the broker — see the consumer's logs)`);
        console.log('');
      }
      break;
    }

    case 'replay': {
      const id = rest[0];
      if (!id) {
        console.error('usage: dlq.mjs replay <message-id>');
        process.exitCode = 2;
        break;
      }
      const result = await broker.replay(id);
      console.log(result.replayed ? `replayed ${id}` : `NOT replayed: ${result.reason}`);
      if (!result.replayed) process.exitCode = 1;
      break;
    }

    case 'replay-all': {
      // Guarded, because this is the command that can re-deliver a month of events by accident.
      // Replay is at-least-once and is NOT a rollback: it cannot undo partial work a failed
      // attempt left behind, and consumer idempotency is the only thing making it safe.
      if (!rest.includes('--yes')) {
        const n = await broker.deadLetterCount();
        console.error(`Refusing to replay ${n} message(s) without --yes.`);
        console.error('Replay re-delivers real events. Read `list` first.');
        process.exitCode = 2;
        break;
      }
      const entries = await broker.listDeadLetters(Number(flag('limit', '100')));
      let ok = 0;
      for (const e of entries) {
        const result = await broker.replay(e.id);
        if (result.replayed) ok += 1;
        else console.error(`  skipped ${e.id}: ${result.reason}`);
      }
      console.log(`replayed ${ok} of ${entries.length}`);
      break;
    }

    default:
      console.error('usage: dlq.mjs <count|list|replay <id>|replay-all --yes> [--limit N]');
      process.exitCode = 2;
  }
} finally {
  await broker.close();
}
