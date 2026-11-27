// ISO-8601 durations as a `duration` setting stores them (`P30D`, `P1Y6M`, `PT12H`) — added to an
// instant (EP-33.2). Browser-safe like the rest of this package, so Studio can say "purged on …"
// with the same arithmetic the service uses.

const DURATION = /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * `at` + `duration`, in UTC.
 *
 * CALENDAR units are calendar units: `P1M` from 31 January is the last day of February, not
 * 3 March, and `P1Y` from 29 February is 28 February — the clamp a person means by "a month
 * later". Days, weeks and the time part are exact (a day is 24 h: UTC has no DST to skip).
 *
 * Throws on a value that is not a duration — a descriptor's validator refuses those on write, so
 * reaching this with one is a bug, not input.
 */
export function addDuration(at: Date, duration: string): Date {
  const m = DURATION.exec(duration);
  if (!m) throw new RangeError(`not an ISO-8601 duration: ${duration}`);
  const n = (i: number): number => Number(m[i] ?? 0);
  const out = new Date(at.getTime());

  const months = n(1) * 12 + n(2);
  if (months > 0) {
    const day = out.getUTCDate();
    out.setUTCDate(1);
    out.setUTCMonth(out.getUTCMonth() + months);
    // The last day of the target month, if the source day does not exist there.
    const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
    out.setUTCDate(Math.min(day, last));
  }
  const ms = (((n(3) * 7 + n(4)) * 24 + n(5)) * 60 + n(6)) * 60_000 + n(7) * 1000;
  return new Date(out.getTime() + ms);
}
