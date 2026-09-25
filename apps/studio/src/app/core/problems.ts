/**
 * A service's 422, placed on a form (EP-16.6, EP-15.2).
 *
 * The services here refuse a write with every reason at once, joined by `; `, and a reason about
 * one field starts with that field's name or path (`name is required`, `video.width must be…`,
 * `settleSeconds must be…`). A reason about a COMBINATION (`mp4 carries h264 video`) belongs to
 * no single control and goes above the form. Placement is a convenience; the text is the
 * service's, unchanged — it is the authority, and the form does not re-check its rules.
 */
export interface Problems {
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly general: readonly string[];
}

export const NO_PROBLEMS: Problems = { fields: {}, general: [] };

/** Split `message` into its reasons, each under the field it starts with when `isField` says so. */
export function placeProblems(message: string, isField: (path: string) => boolean): Problems {
  const fields: Record<string, string[]> = {};
  const general: string[] = [];
  for (const rule of message
    .split('; ')
    .map((r) => r.trim())
    .filter(Boolean)) {
    const path = /^([a-zA-Z]+(?:\.[a-zA-Z]+)?)\b/.exec(rule)?.[1];
    if (path !== undefined && isField(path)) (fields[path] ??= []).push(rule);
    else general.push(rule);
  }
  return { fields, general };
}
