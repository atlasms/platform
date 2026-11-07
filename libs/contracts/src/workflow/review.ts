// Which review point APPROVES the asset (EP-24.7; decided by the product owner 2026-11-06) — pure,
// no dependencies, so it loads in Temporal's workflow sandbox as well as at publish.
//
// A workflow may review one asset at several points. Every point's verdict is recorded in the
// asset's verdict history and moves its own step; only ONE point's approval moves the asset to
// `approved`, and a rejection at any point rejects it. That point is the one marked
// `approving: true`, or — with none marked — the LAST: the review step no other review step can
// follow. Publish refuses a workflow where that is not one step (two marked, a mark on a step that
// is not a review, or several "last" points on parallel paths), so at run time the answer is never
// ambiguous.

import type { HumanTaskConfig, Step, Transition } from './types.ts';

export type ApprovingProblem =
  | { code: 'APPROVING_NOT_REVIEW'; stepId: string }
  | { code: 'DUP_APPROVING'; stepIds: string[] }
  | { code: 'APPROVING_AMBIGUOUS'; stepIds: string[] };

export interface ApprovingAnswer {
  /** The approving review step's point, when the workflow has any review point. */
  reviewPointId?: string;
  stepId?: string;
  problems: ApprovingProblem[];
}

interface Graph {
  steps: readonly Step[];
  transitions: readonly Transition[];
}

/** The review point whose approval approves the asset, by the rule above. */
export function approvingReviewPoint(wf: Graph): ApprovingAnswer {
  const problems: ApprovingProblem[] = [];
  const reviews: Step[] = [];
  const marked: Step[] = [];
  for (const s of wf.steps) {
    if (s.kind !== 'human-task') continue;
    const cfg = s.config as HumanTaskConfig | undefined;
    if (cfg?.reviewPointId !== undefined) reviews.push(s);
    if (cfg?.approving === true) {
      if (cfg.reviewPointId === undefined)
        problems.push({ code: 'APPROVING_NOT_REVIEW', stepId: s.id });
      else marked.push(s);
    }
  }
  if (marked.length > 1) problems.push({ code: 'DUP_APPROVING', stepIds: marked.map((s) => s.id) });

  let chosen: Step | undefined = marked.length === 1 ? marked[0] : undefined;
  if (chosen === undefined && marked.length === 0 && reviews.length > 0) {
    const reach = reachability(wf);
    const ids = new Set(reviews.map((s) => s.id));
    const last = reviews.filter(
      (s) => ![...(reach.get(s.id) ?? [])].some((t) => t !== s.id && ids.has(t)),
    );
    if (last.length === 1) chosen = last[0];
    else
      problems.push({
        code: 'APPROVING_AMBIGUOUS',
        // A cycle through every review point leaves none "last": name them all.
        stepIds: (last.length > 0 ? last : reviews).map((s) => s.id),
      });
  }
  const point = chosen ? (chosen.config as HumanTaskConfig).reviewPointId : undefined;
  return {
    ...(point !== undefined ? { reviewPointId: point, stepId: chosen!.id } : {}),
    problems,
  };
}

/** Every step reachable from each step — by transitions, error paths and compensation handlers. */
function reachability(wf: Graph): Map<string, Set<string>> {
  const next = new Map<string, string[]>();
  const edge = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to]);
  for (const t of wf.transitions) edge(t.from, t.to);
  for (const s of wf.steps) {
    if (typeof s.onError === 'object' && s.onError !== null) edge(s.id, s.onError.transitionTo);
    if (s.compensation !== undefined) edge(s.id, s.compensation);
  }
  const out = new Map<string, Set<string>>();
  for (const s of wf.steps) {
    const seen = new Set<string>();
    const stack = [...(next.get(s.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    out.set(s.id, seen);
  }
  return out;
}
