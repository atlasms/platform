import type {
  Capture,
  Recorder,
  RecorderInput,
  RecordingWindow,
} from '../core/generated/rim.types.ts';

/**
 * The recorder form's model (EP-39 in Studio), pure so it is tested without a DOM. RIM judges a
 * recorder (and says why, field by field); this turns the form into the body RIM reads, and says
 * in words what a recorder's plan and captures mean.
 */

type Day = RecordingWindow['days'][number];

/** From the generated union, so a day the contract gains or loses is a compile error here. */
export const DAYS = Object.keys({
  mon: true,
  tue: true,
  wed: true,
  thu: true,
  fri: true,
  sat: true,
  sun: true,
} satisfies Record<Day, true>) as Day[];

/** File lengths an operator is offered; RIM accepts any divisor of a day. */
export const FILE_MINUTES = [1, 5, 10, 15, 30, 60, 120] as const;

export interface WindowDraft {
  days: Day[];
  from: string;
  to: string;
}

export interface RecorderDraft {
  name: string;
  url: string;
  passphraseSecret: string;
  timezone: string;
  windows: WindowDraft[];
  fileMinutes: number;
  padSeconds: number | null;
  enabled: boolean;
}

/** Every day, all day — what a new recorder starts with, and what "always on" is. */
export const allDay = (): WindowDraft => ({ days: [...DAYS], from: '00:00', to: '24:00' });

export function draftOf(r: Recorder): RecorderDraft {
  return {
    name: r.name,
    url: r.input.url,
    passphraseSecret: r.input.passphraseSecret ?? '',
    timezone: r.timezone,
    windows: r.windows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    fileMinutes: r.fileMinutes,
    padSeconds: r.padSeconds,
    enabled: r.enabled,
  };
}

/** The whole recorder, as the form says it; days in week order however they were ticked. */
export function inputOf(d: RecorderDraft): RecorderInput {
  const secret = d.passphraseSecret.trim();
  return {
    name: d.name.trim(),
    input: { url: d.url.trim(), ...(secret ? { passphraseSecret: secret } : {}) },
    timezone: d.timezone.trim(),
    windows: d.windows.map((w) => ({
      days: DAYS.filter((day) => w.days.includes(day)),
      from: w.from,
      to: w.to,
    })),
    fileMinutes: d.fileMinutes,
    ...(d.padSeconds !== null ? { padSeconds: d.padSeconds } : {}),
    enabled: d.enabled,
  };
}

/** `mon–fri 06:00–24:00; sat, sun 08:00–22:00` — a recorder's windows in one line. */
export function describeWindows(windows: readonly RecordingWindow[]): string {
  return windows
    .map((w) => {
      const idx = DAYS.map((d) => w.days.includes(d));
      const runs: string[] = [];
      for (let i = 0; i < 7;) {
        if (!idx[i]) {
          i += 1;
          continue;
        }
        let j = i;
        while (j + 1 < 7 && idx[j + 1]) j += 1;
        runs.push(j - i >= 2 ? `${DAYS[i]}–${DAYS[j]}` : DAYS.slice(i, j + 1).join(', '));
        i = j + 1;
      }
      return `${runs.join(', ')} ${w.from}–${w.to}`;
    })
    .join('; ');
}

/** A capture's time in the recorder's zone, `HH:MM:SS` — what an operator compares to the air. */
export function localTime(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 19);
  }
}

/** Whether a capture is a hole in the recording — what the list marks. */
export const isHole = (c: Pick<Capture, 'state'>): boolean => c.state === 'missed';
