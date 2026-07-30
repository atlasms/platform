// Minimal ULID generator (Crockford base32, 26 chars) matching common.schema.json#/$defs/Ulid.
// Fine for dev/tests; swap for the `ulid` package (monotonic factory) in production.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // excludes I, L, O, U

export function ulid(time: number = Date.now()): string {
  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i++) { ts = ENC[t % 32] + ts; t = Math.floor(t / 32); }
  let rnd = '';
  for (let i = 0; i < 16; i++) rnd += ENC[Math.floor(Math.random() * 32)];
  return ts + rnd;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (s: string): boolean => ULID_RE.test(s);
