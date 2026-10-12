// The workflows the checks run. Deterministic code only: it runs in the worker's sandbox, bundled
// at image BUILD time (check 2), never at start-up.
import { condition, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type * as activities from './activities.ts';

const { stamp } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

/** Check 1: an activity and a durable timer on this image's worker. */
export async function probe(image: string): Promise<string> {
  const a = await stamp(`activity on ${image}`);
  await sleep('1 second');
  return `${a}; timer fired`;
}

export const approve = defineSignal<[string]>('approve');

/**
 * Check 3: an instance that WAITS — started, then the server is restarted, then signalled. If its
 * state lives in Postgres it resumes where it was; if not, the signal finds no instance.
 */
export async function waitForApproval(assetId: string): Promise<string> {
  let verdict: string | undefined;
  setHandler(approve, (v) => {
    verdict = v;
  });
  await condition(() => verdict !== undefined);
  return await stamp(`${assetId} ${verdict}`);
}
