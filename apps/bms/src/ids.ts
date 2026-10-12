// A ULID that is a FUNCTION of its inputs. An activity may run more than once (Temporal retries
// it after a crash), and what it names — a task, a child instance — must be the same thing every
// time, or a retry creates a second one. The time part is a real time (the instance's start), so
// the id still sorts with its neighbours; the random part is a hash of what makes it unique.
import { createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function derivedUlid(timeMs: number, seed: string): string {
  let time = '';
  let t = Math.max(0, Math.floor(timeMs));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const hash = createHash('sha256').update(seed).digest();
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(hash[i] ?? 0); // 80 bits
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}
