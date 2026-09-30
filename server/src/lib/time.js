/**
 * All timestamps in MyopiaGuard are stored as epoch milliseconds (INTEGER).
 * The API surfaces ISO strings; the UI formats for display.
 *
 * Everything that needs a calendar day (weekly reports, daily trend buckets)
 * works in *school local time*. Rather than depend on the server's TZ database
 * we take an explicit offset in minutes and shift, which keeps the maths
 * testable and lets a client in another region ask for its own school day.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Swappable clock so scheduler tests can advance time without sleeping. */
let clockSource = () => Date.now();

export function now() {
  return clockSource();
}

export function setClock(fn) {
  clockSource = fn ?? (() => Date.now());
}

export function advanceClock(ms) {
  const base = clockSource();
  clockSource = () => base + ms;
}

export function iso(ms) {
  if (ms === null || ms === undefined) return null;
  return new Date(Number(ms)).toISOString();
}

export function minutes(n) {
  return n * MINUTE;
}

export function seconds(n) {
  return n * 1000;
}

/** Server-local UTC offset in minutes, matching Date#getTimezoneOffset semantics. */
export function serverOffsetMinutes(at = Date.now()) {
  return -new Date(at).getTimezoneOffset();
}

function shifted(ms, offsetMinutes) {
  return new Date(Number(ms) + offsetMinutes * MINUTE);
}

/** Local calendar day as `YYYY-MM-DD` for the given offset. */
export function localDayKey(ms, offsetMinutes = serverOffsetMinutes(ms)) {
  return shifted(ms, offsetMinutes).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday in school-local time. */
export function localWeekday(ms, offsetMinutes = serverOffsetMinutes(ms)) {
  return shifted(ms, offsetMinutes).getUTCDay();
}

/** Midnight at the start of the local day containing `ms`. */
export function startOfLocalDay(ms, offsetMinutes = serverOffsetMinutes(ms)) {
  const d = shifted(ms, offsetMinutes);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - offsetMinutes * MINUTE;
}

/** Midnight local on the Monday of the week containing `ms`. */
export function startOfLocalWeek(ms, offsetMinutes = serverOffsetMinutes(ms)) {
  const day = startOfLocalDay(ms, offsetMinutes);
  const weekday = localWeekday(day, offsetMinutes); // 0 = Sun
  const backToMonday = (weekday + 6) % 7;
  return day - backToMonday * DAY;
}

/**
 * The reporting window: Monday 00:00 → Saturday 00:00 local.
 *
 * `mode: 'last-complete'` (the default, and what the weekly job uses) always
 * returns a window that has already fully closed, so a Monday-morning report
 * covers the prior Mon–Fri. `weeksAgo` then counts back from that most recent
 * closed week: 0 is last week, 1 the week before, and so on — so a trend series
 * cannot accidentally repeat the same week (which is what an offset applied to
 * the *current* week would do).
 *
 * `mode: 'current'` gives the week in progress, for a live view.
 */
export function weekRange(referenceMs, { offsetMinutes = serverOffsetMinutes(referenceMs), mode = 'last-complete', weeksAgo = 0 } = {}) {
  const currentMonday = startOfLocalWeek(referenceMs, offsetMinutes);
  let anchorMonday;

  if (mode === 'current') {
    anchorMonday = currentMonday;
  } else {
    // The Monday of the most recent week whose Friday has already passed.
    const saturday = currentMonday + 5 * DAY;
    anchorMonday = referenceMs < saturday ? currentMonday - 7 * DAY : currentMonday;
  }

  const start = anchorMonday - weeksAgo * 7 * DAY;
  const end = start + 5 * DAY; // exclusive; Friday 23:59:59 falls inside
  return {
    start,
    end,
    startIso: iso(start),
    endIso: iso(end),
    label: `${localDayKey(start, offsetMinutes)} → ${localDayKey(end - 1, offsetMinutes)}`,
    days: Array.from({ length: 5 }, (_, i) => {
      const dayStart = start + i * DAY;
      return {
        index: i,
        weekday: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i],
        short: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i],
        dayKey: localDayKey(dayStart, offsetMinutes),
        start: dayStart,
        end: dayStart + DAY,
      };
    }),
  };
}

/** "1h 04m", "12m 30s", "45s" — used for session length and break counters. */export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function percent(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Midnight local on the first of the month containing `ms`. */
export function startOfLocalMonth(ms, offsetMinutes = serverOffsetMinutes(ms)) {
  const d = shifted(ms, offsetMinutes);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - offsetMinutes * MINUTE;
}

/** Chronological month buckets ending with the month containing `referenceMs`. */
export function monthRanges(referenceMs, count, offsetMinutes = serverOffsetMinutes(referenceMs)) {
  const ranges = [];
  let start = startOfLocalMonth(referenceMs, offsetMinutes);
  for (let i = 0; i < count; i += 1) {
    const previous = shifted(start - 1, offsetMinutes);
    previous.setUTCDate(1);
    previous.setUTCHours(0, 0, 0, 0);
    const previousStart = previous.getTime() - offsetMinutes * MINUTE;
    ranges.unshift({
      start: previousStart,
      end: start,
      label: localDayKey(previousStart, offsetMinutes).slice(0, 7),
    });
    start = previousStart;
  }
  return ranges;
}
