import { ApiError } from './http.js';

/**
 * PRIVACY GATE #1 — seat identity.
 *
 * MyopiaGuard never stores or displays a student's name against a machine. The
 * only identity a seat is allowed to carry is a machine-shaped label ("PC-01",
 * "Seat 12"). This validator is the single choke point: seed data, admin-created
 * seats and agent self-registration all pass through it, and the DB has a coarse
 * CHECK constraint behind it as a second line of defence.
 *
 * A label containing a space-separated capitalised word (the shape of a real
 * name) is rejected outright rather than silently accepted.
 */
const SEAT_LABEL_RE = /^(PC|Seat)[\s-]?(\d{1,3})$/i;
const HUMAN_NAME_RE = /\b[A-Z][a-z]{2,}\b/;

export function normalizeSeatLabel(raw) {
  const value = String(raw ?? '').trim();
  const match = SEAT_LABEL_RE.exec(value);
  if (!match) return null;
  const prefix = /^pc$/i.test(match[1]) ? 'PC' : 'Seat';
  const digits = match[2];
  // Two-digit zero padding reads better in a grid ("PC-01" aligns with "PC-12").
  const width = digits.length > 2 ? digits.length : 2;
  const number = String(Number(digits)).padStart(width, '0');
  return prefix === 'PC' ? `PC-${number}` : `Seat ${number}`;
}

export function assertSeatLabel(raw, field = 'label') {
  const normalized = normalizeSeatLabel(raw);
  if (!normalized) {
    throw new ApiError(400, 'invalid_seat_label', {
      field,
      reason: 'Seat labels must identify the workstation, not a person (for example "PC-01" or "Seat 12").',
    });
  }
  if (HUMAN_NAME_RE.test(raw)) {
    throw new ApiError(400, 'pii_rejected', {
      field,
      reason: 'Seat labels may not contain student names — MyopiaGuard is privacy-first by design.',
    });
  }
  return normalized;
}

export function seatNumberOf(label) {
  const match = SEAT_LABEL_RE.exec(String(label ?? ''));
  return match ? Number(match[2]) : null;
}

/**
 * PRIVACY GATE #2 — free-text broadcast.
 *
 * Attention Mode messages are the one place a teacher types arbitrary text, so
 * they are length-capped, angle-bracket stripped (the overlay renders as text,
 * but we do not want to store markup either) and control characters removed.
 */
export function sanitizeMessage(raw, { maxLength = 160, fallback = '' } = {}) {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
}

export function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ApiError(400, 'invalid_value', { field, allowed });
  }
  return value;
}

export function assertPositiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, 'invalid_value', { field, min, max });
  }
  return parsed;
}

export function assertDomain(raw, field = 'domain') {
  const value = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    throw new ApiError(400, 'invalid_domain', { field, value });
  }
  return value;
}
