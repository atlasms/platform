// NATS-style subject matching: '*' matches exactly one token, '>' matches one-or-more trailing
// tokens (must be last). e.g. 'atlas.*.asset.*.ready', 'atlas.ch12.>'.
export function matchSubject(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i; // must consume at least one token
    if (i >= s.length) return false;
    if (p[i] === '*') continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}
