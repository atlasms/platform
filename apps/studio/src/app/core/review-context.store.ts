import { Injectable, signal } from '@angular/core';

/**
 * The review task a person opened an asset FROM (EP-24.7): the workflow review point they are
 * reviewing at, and whether that point's approval approves the asset or only passes it on to the
 * next point. Set by the Inbox when a review task opens its asset; read by the asset's Review
 * section, which names the point on the verdict and gives a pass as `final: false`.
 *
 * Kept in memory, per asset, for the session — never persisted: it is a hint from the task in
 * hand, and a reload that loses it leaves an ordinary verdict on the asset, which MAM and BMS both
 * accept (a verdict naming no point decides every point). The workflow's rule, not this hint, says
 * which point approves; a pass given where the asset could have been approved is still recorded.
 */
export interface ReviewContext {
  reviewPointId: string;
  /** False when this point's approval only passes the asset on (the task says `approving: false`). */
  approving: boolean;
}

@Injectable({ providedIn: 'root' })
export class ReviewContextStore {
  private readonly byAsset = signal<ReadonlyMap<string, ReviewContext>>(new Map());

  /** The review the asset was opened for, if any. */
  for(assetId: string): ReviewContext | undefined {
    return this.byAsset().get(assetId);
  }

  open(assetId: string, context: ReviewContext): void {
    this.byAsset.update((m) => new Map(m).set(assetId, { ...context }));
  }

  /** The verdict was given: the task in hand is done. */
  done(assetId: string): void {
    this.byAsset.update((m) => {
      if (!m.has(assetId)) return m;
      const next = new Map(m);
      next.delete(assetId);
      return next;
    });
  }
}
