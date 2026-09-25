// Folder watchers (EP-15.2; rim.md §13a) — a Source of kind `watch`.
//
// A watcher names a folder under its CHANNEL's own directory of RIM's watch root and is scanned
// on a timer. Polling, not inotify: a broadcast drop folder is usually an NFS or SMB share, and
// inotify on a network mount sees only what THIS host writes — nothing the playout box or the
// editor's workstation drops there. A scan works on every filesystem.
//
// This file is the pure half: the shape, the checks, and the rules for which files are
// candidates and where a watcher's folder is. The scanning — lease, settle, copy, commit — is
// the service's.

import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export type AfterPickup = 'delete' | 'keep';

export interface WatcherInput {
  name: string;
  /** Relative to `<watchRoot>/<channelId>/`. */
  path: string;
  settleSeconds?: number;
  extensions?: string[];
  afterPickup?: AfterPickup;
  enabled?: boolean;
}

export interface Watcher {
  id: string;
  channelId: string;
  name: string;
  path: string;
  settleSeconds: number;
  extensions?: string[];
  afterPickup: AfterPickup;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * One file taken by one watcher: the ledger that makes a pickup idempotent (rim.md §9, "watcher
 * double-pickup"). Committed in the transaction that creates the job, so a crash after the
 * commit and before the source is removed finds the row on the next scan — and removes the file
 * instead of ingesting it twice. `sizeBytes`/`mtimeMs` let a scan skip a file it already took
 * without reading it again, which `keep` needs: otherwise every scan would re-hash the folder.
 */
export interface Pickup {
  watcherId: string;
  channelId: string;
  /** The file's name in the watched folder. */
  name: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  jobId: string;
  at: string;
}

export const DEFAULT_SETTLE_SECONDS = 10;

/**
 * Names that are never a finished file: hidden files, and what copy tools write while a transfer
 * is still going (rsync's `.name.XXXX` is hidden; browsers and FTP clients use suffixes).
 */
const PARTIAL = /(\.part|\.partial|\.tmp|\.temp|\.crdownload|\.filepart|~)$/i;

export function isCandidate(name: string, extensions?: readonly string[]): boolean {
  if (name.startsWith('.') || PARTIAL.test(name)) return false;
  if (!extensions || extensions.length === 0) return true;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return extensions.includes(name.slice(dot + 1).toLowerCase());
}

/** Every reason the input cannot be a watcher, or none. */
export function watcherErrors(input: WatcherInput): string[] {
  const errors: string[] = [];
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 200) {
    errors.push('name is required, up to 200 characters');
  }
  if (typeof input.path !== 'string' || input.path.trim() === '' || input.path.length > 500) {
    errors.push('path is required, up to 500 characters');
  } else if (isAbsolute(input.path) || input.path.split(/[\\/]/).includes('..')) {
    errors.push("path is relative to the channel's watch directory, and never climbs out of it");
  }
  const settle = input.settleSeconds;
  if (settle !== undefined && !(Number.isInteger(settle) && settle >= 1 && settle <= 3600)) {
    errors.push('settleSeconds must be a whole number from 1 to 3600');
  }
  if (input.extensions !== undefined) {
    if (!Array.isArray(input.extensions) || input.extensions.length > 50) {
      errors.push('extensions must be a list of at most 50');
    } else if (
      !input.extensions.every((e) => typeof e === 'string' && /^[a-z0-9]{1,10}$/.test(e))
    ) {
      errors.push('extensions are lowercase letters and digits, without the dot');
    }
  }
  if (
    input.afterPickup !== undefined &&
    input.afterPickup !== 'delete' &&
    input.afterPickup !== 'keep'
  ) {
    errors.push('afterPickup must be delete or keep');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    errors.push('enabled must be true or false');
  }
  return errors;
}

/** The folder's path as written, normalised — what "two watchers on one folder" compares. */
export const normalisedPath = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.')
    .join('/');

/**
 * Where a watcher's folder is on disk — or why it is not usable.
 *
 * The channel's directory is part of the path on purpose: the watch root is shared by every
 * channel, so a path relative to the ROOT would let one channel's administrator watch another's
 * drops. Containment is checked on the REAL path, so a symlink inside the channel's directory
 * cannot lead out of it either. A folder that does not exist is not an error here — a share can
 * be mounted after the watcher is written; the scan reports it.
 */
export async function watchDir(
  root: string,
  channelId: string,
  path: string,
): Promise<{ dir: string } | { missing: string } | { escapes: string }> {
  const base = resolve(root);
  const channelDir = resolve(base, channelId);
  // The channel id comes from the gateway, not the client — and it is still checked: it becomes
  // a path segment, and nothing that becomes a path is trusted by construction.
  if (!channelDir.startsWith(base + sep) || /[\\/]/.test(channelId)) {
    return { escapes: channelDir };
  }
  const dir = resolve(channelDir, normalisedPath(path));
  if (dir !== channelDir && !dir.startsWith(channelDir + sep)) return { escapes: dir };
  let real: string;
  let realChannel: string;
  try {
    real = await realpath(dir);
    realChannel = await realpath(channelDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: dir };
    throw err;
  }
  if (real !== realChannel && !real.startsWith(realChannel + sep)) return { escapes: real };
  return { dir: real };
}

/**
 * The request body as a WatcherInput — only the known keys, each as the client sent it; what is
 * wrong with them is `watcherErrors`' to say, so the refusal names every problem at once.
 */
export function parseWatcherInput(body: unknown): WatcherInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { name: '', path: '' };
  }
  const b = body as Record<string, unknown>;
  return {
    name: b['name'] as string,
    path: b['path'] as string,
    ...(b['settleSeconds'] !== undefined ? { settleSeconds: b['settleSeconds'] as number } : {}),
    ...(b['extensions'] !== undefined ? { extensions: b['extensions'] as string[] } : {}),
    ...(b['afterPickup'] !== undefined ? { afterPickup: b['afterPickup'] as AfterPickup } : {}),
    ...(b['enabled'] !== undefined ? { enabled: b['enabled'] as boolean } : {}),
  };
}
