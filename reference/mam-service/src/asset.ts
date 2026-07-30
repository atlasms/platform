// The MAM asset — a trimmed system-of-record row for the slice. Lifecycle mirrors the MAM spec
// (created -> processing -> ready -> approved | rejected) and the review-lifecycle design.
export type AssetState = 'created' | 'processing' | 'ready' | 'approved' | 'rejected' | 'expired';

export interface AssetCore {
  title: string;
  fileType: string;
  durationSec?: number;
  resolution?: string;
  aspectRatio?: string;
  audioChannels?: number;
}

export interface Rendition { kind: string; path: string; checksum: { algorithm: string; value: string }; }

export interface Asset {
  id: string;
  channelId: string;
  state: AssetState;
  core: AssetCore;
  renditions: Rendition[];
  version: number;
  expiresAt?: string;    // review-lifecycle: usable-until
  retainUntil?: string;  // review-lifecycle: rejected purge time
}
