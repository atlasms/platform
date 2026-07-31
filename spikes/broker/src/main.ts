// EP-03.0 runner.
//
//   docker compose -f infra/docker-compose.dev.yml up -d
//   npm run spike -w @atlas/broker-spike
//
// Prints a markdown report; the numbers are pasted into docs/adr/0001-message-broker.md.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NatsJetStreamBroker } from './nats-broker.ts';
import { RabbitMqBroker } from './rabbit-broker.ts';
import {
  t1SubjectFidelity,
  t2LoadSpike,
  t3DurabilityAcrossRestart,
  t4RedeliveryAndDlq,
  t5PublishBeforeConsumer,
  type ScenarioResult,
} from './scenarios.ts';
import type { SpikeBroker } from './types.ts';

const exec = promisify(execFile);
const LOAD = Number(process.env['SPIKE_LOAD'] ?? 20_000);
const DURABLE = 2_000;

interface Candidate {
  broker: SpikeBroker;
  container: string;
  image: string;
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec('docker', args, { windowsHide: true });
  return stdout.trim();
}

/** Image size and steady-state memory — the operational half of the decision. */
async function opsFacts(c: Candidate): Promise<Record<string, string>> {
  const size = await docker('image', 'inspect', c.image, '--format', '{{.Size}}').catch(() => '0');
  const mem = await docker('stats', c.container, '--no-stream', '--format', '{{.MemUsage}}').catch(
    () => 'n/a',
  );
  return {
    'image size': `${(Number(size) / 1024 / 1024).toFixed(0)} MB`,
    'memory after load': mem.split('/')[0]?.trim() ?? 'n/a',
  };
}

async function restartContainer(name: string, waitFor: () => Promise<boolean>): Promise<void> {
  await docker('restart', name);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await waitFor().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not come back within 60s`);
}

async function healthy(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

async function run(
  c: Candidate,
): Promise<{ results: ScenarioResult[]; ops: Record<string, string> }> {
  const results: ScenarioResult[] = [];
  console.log(`\n=== ${c.broker.name} ===`);

  await c.broker.connect();
  await c.broker.reset();
  await c.broker.close();
  await c.broker.connect(); // clean slate

  for (const scenario of [
    () => t1SubjectFidelity(c.broker),
    () => t2LoadSpike(c.broker, LOAD),
    () => t4RedeliveryAndDlq(c.broker),
    () => t5PublishBeforeConsumer(c.broker),
  ]) {
    const r = await scenario();
    results.push(r);
    console.log(`  ${r.pass === false ? 'FAIL' : 'ok  '}  ${r.name} — ${r.detail}`);
  }

  const ops = await opsFacts(c);

  // T3 restarts the container, so it runs last.
  const t3 = await t3DurabilityAcrossRestart(c.broker, DURABLE, () =>
    restartContainer(c.container, async () => {
      const probe = candidateFor(c.container);
      const ok = await healthy(() => probe.connect());
      await probe.close().catch(() => undefined);
      return ok;
    }),
  );
  results.push(t3);
  console.log(`  ${t3.pass === false ? 'FAIL' : 'ok  '}  ${t3.name} — ${t3.detail}`);

  await c.broker.reset();
  await c.broker.close();
  return { results, ops };
}

function candidateFor(container: string): SpikeBroker {
  return container === 'atlas-nats' ? new NatsJetStreamBroker() : new RabbitMqBroker();
}

function table(name: string, results: ScenarioResult[], ops: Record<string, string>): string {
  const lines = [`### ${name}`, '', '| scenario | result | detail |', '|---|:---:|---|'];
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.pass === false ? '❌' : '✅'} | ${r.detail} |`);
  }
  lines.push('', '| metric | value |', '|---|---:|');
  for (const r of results) {
    for (const [k, v] of Object.entries(r.metrics)) lines.push(`| ${k} | ${v} |`);
  }
  for (const [k, v] of Object.entries(ops)) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

const nats: Candidate = {
  broker: new NatsJetStreamBroker(),
  container: 'atlas-nats',
  image: 'nats:2.10-alpine',
};
const rabbit: Candidate = {
  broker: new RabbitMqBroker(),
  container: 'atlas-rabbitmq',
  image: 'rabbitmq:4-management-alpine',
};

const a = await run(nats);
const b = await run(rabbit);

console.log('\n\n--- REPORT ---\n');
console.log(table(nats.broker.name, a.results, a.ops));
console.log('');
console.log(table(rabbit.broker.name, b.results, b.ops));

const failed = [...a.results, ...b.results].filter((r) => r.pass === false);
console.log(`\n${failed.length} scenario failure(s).`);
process.exit(0);
