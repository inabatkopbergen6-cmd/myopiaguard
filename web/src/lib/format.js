/**
 * Presentation helpers. Every metric in this product is read at a glance.
 *
 * Locale handling: this module is not React, so it cannot call `useI18n()`. The
 * provider pushes the active locale and the language's format strings in via
 * `setFormatLocale()` / `setFormatStrings()`, and every formatter below reads
 * them. That keeps ~20 call sites unchanged instead of threading a locale through
 * each one, and it means a formatter added later is locale-correct by default.
 *
 * Status maps are keyed, not translated: components call `t(SEAT_STATUS[s].key)`.
 * That is what keeps this file free of a dependency on the dictionary.
 */

let currentLocale = 'en-GB';

/** Format strings for durations and relative times, supplied by the dictionary. */
let strings = {
  hoursMinutes: '{h}h {m}m',
  minutesSeconds: '{m}m {s}s',
  seconds: '{s}s',
  percent: '{n}%',
  relative: {
    never: 'never',
    justNow: 'just now',
    secondsAgo: '{n}s ago',
    minutesAgo: '{n}m ago',
    hoursAgo: '{n}h ago',
    daysAgo: '{n}d ago',
  },
  countdown: {
    dueNow: 'due now',
    inSeconds: 'in {n}s',
    inMinutes: 'in {n}m',
  },
  weekdaysShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

export function setFormatLocale(locale) {
  currentLocale = locale || 'en-GB';
}

export function setFormatStrings(next) {
  if (next && typeof next === 'object') strings = { ...strings, ...next };
}

export const getFormatLocale = () => currentLocale;

/** `{name}` interpolation against a plain object. */
const fill = (template, params) =>
  String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));

/** Locale-aware number: Russian groups thousands with a space, English with a comma. */
export function number(value, options = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(currentLocale, options).format(n);
}

export function pct(value, { dash = '—' } = {}) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return dash;
  // One decimal, trimmed when it is a whole number — and the decimal separator
  // follows the locale (84.6% vs 84,6%).
  const formatted = new Intl.NumberFormat(currentLocale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(Number(value));
  return fill(strings.percent, { n: formatted });
}

/**
 * "4m 20s" / "1h 04m" — the unit letters and the ordering come from the
 * language, so Russian reads "4 мин 20 с" without any component changes.
 */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return fill(strings.hoursMinutes, { h, m: String(m).padStart(2, '0') });
  if (m > 0) return fill(strings.minutesSeconds, { m, s: String(s).padStart(2, '0') });
  return fill(strings.seconds, { s });
}

export const mmss = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export const clockTime = (ms) =>
  ms ? new Date(Number(ms)).toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' }) : '—';

export const dateTime = (ms) =>
  ms
    ? new Date(Number(ms)).toLocaleString(currentLocale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export const shortDate = (ms) =>
  ms ? new Date(Number(ms)).toLocaleDateString(currentLocale, { day: 'numeric', month: 'short' }) : '—';

/** Short weekday name for chart axes, from the language's own list. */
export const weekdayShort = (ms) => {
  const index = (new Date(Number(ms)).getDay() + 6) % 7; // 0 = Monday
  return strings.weekdaysShort?.[index] ?? new Date(Number(ms)).toLocaleDateString(currentLocale, { weekday: 'short' });
};

/** Full weekday name, used in table headers and report tables. */
export const weekdayLong = (ms) =>
  new Date(Number(ms)).toLocaleDateString(currentLocale, { weekday: 'long' });

export function relativeTime(ms, from = Date.now()) {
  if (!ms) return strings.relative.never;
  const diff = Math.max(0, Number(from) - Number(ms));
  if (diff < 10_000) return strings.relative.justNow;
  if (diff < 60_000) return fill(strings.relative.secondsAgo, { n: Math.round(diff / 1000) });
  if (diff < 3_600_000) return fill(strings.relative.minutesAgo, { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return fill(strings.relative.hoursAgo, { n: Math.round(diff / 3_600_000) });
  return fill(strings.relative.daysAgo, { n: Math.round(diff / 86_400_000) });
}

/** Countdown text for the "next break in…" column. */
export function countdown(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds <= 0) return strings.countdown.dueNow;
  if (seconds < 90) return fill(strings.countdown.inSeconds, { n: Math.round(seconds) });
  return fill(strings.countdown.inMinutes, { n: Math.round(seconds / 60) });
}

/**
 * Status maps. `key` resolves through `t()`; `tone` selects the badge colour.
 * Keyed rather than literal so this module never needs the dictionary.
 */
export const SEAT_STATUS = {
  active: { key: 'status.active', descKey: 'status.activeDesc', tone: 'active' },
  on_break: { key: 'status.on_break', descKey: 'status.on_breakDesc', tone: 'break' },
  offline: { key: 'status.offline', descKey: 'status.offlineDesc', tone: 'offline' },
  idle: { key: 'status.idle', descKey: 'status.idleDesc', tone: 'idle' },
};

export const BREAK_STATUS = {
  completed: { key: 'breakStatus.completed', tone: 'active' },
  skipped: { key: 'breakStatus.skipped', tone: 'attention' },
  missed: { key: 'breakStatus.missed', tone: 'danger' },
  in_progress: { key: 'breakStatus.in_progress', tone: 'break' },
  pending: { key: 'breakStatus.pending', tone: 'neutral' },
};

export const ATTENTION_LABELS = {
  repeat_misses: 'attentionFlag.repeat_misses',
  long_session: 'attentionFlag.long_session',
  offline_mid_session: 'attentionFlag.offline_mid_session',
  offline_mid_break: 'attentionFlag.offline_mid_break',
};

/** Adherence tone: green when the routine is holding, amber when it is slipping. */
export function adherenceTone(value) {
  if (value === null || value === undefined) return 'none';
  if (value >= 85) return 'good';
  if (value >= 70) return 'ok';
  if (value >= 50) return 'warn';
  return 'bad';
}

export const adherenceClass = (value) => {
  const tone = adherenceTone(value);
  if (tone === 'warn' || tone === 'bad') return 'meter__fill--warn';
  return '';
};

export function initials(name = '') {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
