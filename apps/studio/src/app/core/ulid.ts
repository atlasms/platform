// A ULID for the browser (Crockford base32, 26 chars) matching common.schema.json#/$defs/Ulid —
// the same shape libs/contracts mints, which Studio does not import (its schema loader is
// Node's). Studio mints one thing: the id of a rule it grants (user-editor.ts). Random bits from
// the platform's CSPRNG, not Math.random, since an id in a policy rule is audited for life.

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // excludes I, L, O, U

export function ulid(time: number = Date.now()): string {
  let ts = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    ts = ENC[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rnd = '';
  for (const b of bytes) rnd += ENC[b % 32];
  return ts + rnd;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
