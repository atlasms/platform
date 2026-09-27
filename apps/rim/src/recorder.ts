// Recorders (EP-39; ADR-0007) — the pure half: the shape, the checks, and the PLAN.
//
// A recorder records an IP feed inside recording WINDOWS (days and times in its zone). Each file
// covers one grid slot of `fileMinutes` — an hour by default — and is captured from `padSeconds`
// before it to `padSeconds` after it, so neighbouring files overlap and, for those seconds, two
// captures run at once. Consecutive captures alternate between two SLOTS, which the worker leases
// to different pods (ADR-0007 decisions 4, 6, 10): recording 01:00–03:00, slot 0 runs 00:59:55 to
// 02:00:05 and slot 1 runs 01:59:55 to 03:00:05.
//
// The planner is where recording goes wrong quietly — a zone, a DST night, two windows that touch
// at midnight — so it is a pure function over instants, tested without a clock or a database.

export const RECORDER_SCHEMES = ['srt', 'udp', 'rtp', 'rtmp', 'rtmps'] as const;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface RecordingWindow {
  days: Weekday[];
  /** `HH:MM`, in the recorder's zone. */
  from: string;
  /** `HH:MM`, after `from`; `24:00` is the end of the day. */
  to: string;
}

export interface RecorderInput {
  name: string;
  input: {
    /** srt://, udp://, rtp://, rtmp(s):// — never with a credential in it. */
    url: string;
    /** `<secret>/<key>` naming where an SRT passphrase is; the recorder never holds it. */
    passphraseSecret?: string;
  };
  /** IANA zone the windows are in. */
  timezone: string;
  windows: RecordingWindow[];
  fileMinutes?: number;
  padSeconds?: number;
  enabled?: boolean;
}

export interface Recorder {
  id: string;
  channelId: string;
  name: string;
  input: { url: string; passphraseSecret?: string };
  timezone: string;
  windows: RecordingWindow[];
  fileMinutes: number;
  padSeconds: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const DEFAULT_FILE_MINUTES = 60;
export const DEFAULT_PAD_SECONDS = 5;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SECRET_REF = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\/[A-Za-z0-9_.-]{1,253}$/;

const minutesOf = (hhmm: string): number =>
  hhmm === '24:00' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every reason the input cannot be a recorder, or none — each starting with the field it is about. */
export function recorderErrors(input: RecorderInput): string[] {
  const errors: string[] = [];
  const add = (m: string) => errors.push(m);
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 200) {
    add('name is required, up to 200 characters');
  }
  const url = input.input?.url;
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000) {
    add('input.url is required');
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      add('input.url is not a URL');
    }
    if (parsed) {
      const scheme = parsed.protocol.replace(/:$/, '');
      if (!(RECORDER_SCHEMES as readonly string[]).includes(scheme)) {
        add(`input.url must be one of ${RECORDER_SCHEMES.map((s) => `${s}://`).join(', ')}`);
      }
      // A credential in the URL would be in every audit delta and log line that carries the
      // recorder. It has a place of its own.
      if (parsed.username || parsed.password || /passphrase=/i.test(parsed.search)) {
        add('input.url must carry no credential; name its Secret in input.passphraseSecret');
      }
    }
  }
  const secret = input.input?.passphraseSecret;
  if (secret !== undefined && (typeof secret !== 'string' || !SECRET_REF.test(secret))) {
    add('input.passphraseSecret is <secret-name>/<key>');
  }
  if (!isTimeZone(input.timezone)) add('timezone must be an IANA zone, such as Europe/London');

  if (!Array.isArray(input.windows) || input.windows.length === 0 || input.windows.length > 50) {
    add('windows must list 1 to 50 recording windows');
  } else {
    input.windows.forEach((w, i) => {
      const at = `windows[${i}]`;
      if (
        !Array.isArray(w?.days) ||
        w.days.length === 0 ||
        !w.days.every((d) => (WEEKDAYS as readonly string[]).includes(d))
      ) {
        add(`${at}.days must list days from ${WEEKDAYS.join(', ')}`);
      }
      const fromOk = typeof w?.from === 'string' && HHMM.test(w.from);
      const toOk = typeof w?.to === 'string' && (w.to === '24:00' || HHMM.test(w.to));
      if (!fromOk) add(`${at}.from must be HH:MM`);
      if (!toOk) add(`${at}.to must be HH:MM, or 24:00`);
      if (fromOk && toOk && minutesOf(w.to) <= minutesOf(w.from)) {
        add(`${at}.to must be after from — a window across midnight is two windows`);
      }
    });
  }
  const file = input.fileMinutes;
  if (
    file !== undefined &&
    !(Number.isInteger(file) && file >= 1 && file <= 1440 && 1440 % file === 0)
  ) {
    add('fileMinutes must divide a day (1, 5, 10, 15, 30, 60, 120, … 1440)');
  }
  const pad = input.padSeconds;
  if (pad !== undefined && !(Number.isInteger(pad) && pad >= 0 && pad <= 60)) {
    add('padSeconds must be a whole number from 0 to 60');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    add('enabled must be true or false');
  }
  return errors;
}

// --- time zones -------------------------------------------------------------------------------------

interface LocalDate {
  y: number;
  m: number;
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(zone: string, ms: number) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(zone: string, ms: number): number {
  const p = partsIn(zone, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a local wall-clock time names. A time that does not exist (the hour a spring DST
 * change skips) moves forward past the gap; a time that exists twice (the autumn hour) is the
 * EARLIER instant. Both are what a person reading "02:30" on that day most likely meant.
 *
 * On the grid: a spring night's skipped local hour is simply not a file (the day has one file
 * fewer), and an autumn night's repeated hour is in ONE file, two hours long. Every instant is
 * recorded exactly once, and no file is empty (test/recorder.test.ts pins both nights).
 */
export function localToUtc(zone: string, date: LocalDate, minuteOfDay: number): number {
  const naive = Date.UTC(date.y, date.m - 1, date.d, 0, minuteOfDay);
  const candidates = [
    naive - offsetAt(zone, naive - 12 * 3600_000),
    naive - offsetAt(zone, naive + 12 * 3600_000),
  ];
  const valid = candidates
    .filter((c) => {
      const p = partsIn(zone, c);
      return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) === naive;
    })
    .sort((a, b) => a - b);
  // In a spring gap neither maps back; the pre-change offset lands just past the gap.
  return valid[0] ?? candidates[0]!;
}

function localDateOf(zone: string, ms: number): LocalDate {
  const p = partsIn(zone, ms);
  return { y: p.y, m: p.m, d: p.d };
}

function addDays(date: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(date: LocalDate): Weekday {
  // 1970-01-05 was a Monday; a civil date's weekday does not depend on a zone.
  const days = Math.floor(Date.UTC(date.y, date.m - 1, date.d) / 86_400_000);
  return WEEKDAYS[(((days - 4) % 7) + 7) % 7]!;
}

// --- the plan ----------------------------------------------------------------------------------------

/** One file of a recording: the grid slot it covers, the padded span it is captured over, its slot. */
export interface PlannedFile {
  /** The part of the recording this file IS — a grid slot, clipped to the window. */
  fileStart: string;
  fileEnd: string;
  /** `pad` before and after: what the capture runs for. */
  captureFrom: string;
  captureTo: string;
  /** 0 or 1, alternating from one file to the next. The two slots are two workers. */
  slot: 0 | 1;
}

/**
 * The files a recorder records whose start is in `[from, to)`, in order.
 *
 * Windows are expanded day by day in the recorder's zone, merged where they overlap or touch —
 * `22:00–24:00` and the next day's `00:00–02:00` are one recording, not two — and cut on the local
 * grid of `fileMinutes`. Slots alternate along the whole sequence, continuing from `previous` (the
 * last file planned before), so ANY two consecutive captures are on different slots, across
 * windows, days and plan runs alike.
 */
export function planFiles(
  recorder: Pick<Recorder, 'timezone' | 'windows' | 'fileMinutes' | 'padSeconds'>,
  from: number,
  to: number,
  previous?: { slot: 0 | 1 },
): PlannedFile[] {
  const zone = recorder.timezone;
  const first = addDays(localDateOf(zone, from), -1);
  const last = addDays(localDateOf(zone, to), 1);

  // 1. Every window occurrence, as instants.
  const spans: [number, number][] = [];
  for (let day = first; compare(day, last) <= 0; day = addDays(day, 1)) {
    const weekday = weekdayOf(day);
    for (const w of recorder.windows) {
      if (!w.days.includes(weekday)) continue;
      const start = localToUtc(zone, day, minutesOf(w.from));
      const end =
        w.to === '24:00'
          ? localToUtc(zone, addDays(day, 1), 0)
          : localToUtc(zone, day, minutesOf(w.to));
      if (end > start) spans.push([start, end]);
    }
  }
  // 2. Merged where they overlap or touch.
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const top = merged[merged.length - 1];
    if (top && s[0] <= top[1]) top[1] = Math.max(top[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  // 3. The local grid, as instants (a DST night makes one grid step longer or shorter).
  const grid = new Set<number>();
  for (let day = first; compare(day, addDays(last, 1)) <= 0; day = addDays(day, 1)) {
    for (let minute = 0; minute < 1440; minute += recorder.fileMinutes) {
      grid.add(localToUtc(zone, day, minute));
    }
  }
  const points = [...grid].sort((a, b) => a - b);

  const pad = recorder.padSeconds * 1000;
  const files: PlannedFile[] = [];
  let slot: 0 | 1 = previous ? ((1 - previous.slot) as 0 | 1) : 0;
  for (const [start, end] of merged) {
    const cuts = [start, ...points.filter((p) => p > start && p < end), end];
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      const fileStart = cuts[i]!;
      const fileEnd = cuts[i + 1]!;
      if (fileEnd <= fileStart || fileStart < from || fileStart >= to) continue;
      files.push({
        fileStart: new Date(fileStart).toISOString(),
        fileEnd: new Date(fileEnd).toISOString(),
        captureFrom: new Date(fileStart - pad).toISOString(),
        captureTo: new Date(fileEnd + pad).toISOString(),
        slot,
      });
      slot = (1 - slot) as 0 | 1;
    }
  }
  return files;
}

function compare(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}

/**
 * The request body as a RecorderInput — the known keys, each as the client sent it; what is wrong
 * with them is `recorderErrors`' to say, all at once.
 */
export function parseRecorderInput(body: unknown): RecorderInput {
  const b = (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;
  const input = (typeof b['input'] === 'object' && b['input'] !== null ? b['input'] : {}) as Record<
    string,
    unknown
  >;
  return {
    name: b['name'] as string,
    input: {
      url: input['url'] as string,
      ...(input['passphraseSecret'] !== undefined
        ? { passphraseSecret: input['passphraseSecret'] as string }
        : {}),
    },
    timezone: b['timezone'] as string,
    windows: b['windows'] as RecordingWindow[],
    ...(b['fileMinutes'] !== undefined ? { fileMinutes: b['fileMinutes'] as number } : {}),
    ...(b['padSeconds'] !== undefined ? { padSeconds: b['padSeconds'] as number } : {}),
    ...(b['enabled'] !== undefined ? { enabled: b['enabled'] as boolean } : {}),
  };
}
