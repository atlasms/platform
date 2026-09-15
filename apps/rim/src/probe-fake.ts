// The probe's test double. Test uploads are random bytes, so it decides by the file NAME — the
// way the sqlite store is the double for Postgres: the same port, no binary, deterministic.

import { basename, extname } from 'node:path';
import type { TechnicalMetadata } from '@atlas/contracts';
import { ProbeRefusal, type Probe } from './probe.ts';

/**
 * By name: `unreadable` in it is a refusal (not media); `toolfail` is the tool failing (ENOENT);
 * `4x3` is standard-definition 4:3 picture; a `.wav`/`.mp3` is audio only; anything else is an
 * HD 16:9 master with two audio channels.
 */
export function fakeProbe(): Probe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async probe(path) {
      calls.push(path);
      const name = basename(path).toLowerCase();
      const ext = extname(name).slice(1);
      if (name.includes('unreadable')) {
        throw new ProbeRefusal('Invalid data found when processing input');
      }
      if (name.includes('toolfail')) {
        throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
      }
      const audio: TechnicalMetadata = {
        container: ext || 'mxf',
        audioCodec: 'pcm_s24le',
        audioChannels: 2,
        durationSec: 10,
      };
      if (ext === 'wav' || ext === 'mp3') return audio;
      return name.includes('4x3')
        ? {
            ...audio,
            videoCodec: 'mpeg2video',
            width: 720,
            height: 576,
            aspectRatio: '4:3',
            frameRate: 25,
          }
        : {
            ...audio,
            videoCodec: 'mpeg2video',
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
            frameRate: 25,
          };
    },
    async available() {
      return true;
    },
  };
}
