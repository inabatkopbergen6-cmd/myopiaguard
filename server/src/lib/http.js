/**
 * Small HTTP toolkit: typed API errors, async route wrapping, one error
 * middleware, and the guard that makes the school-analytics layer genuinely
 * aggregate-only (see `aggregateOnlyGuard`).
 */

export class ApiError extends Error {
  constructor(status, code, detail = undefined) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  static notFound(what = 'resource') {
    return new ApiError(404, 'not_found', { what });
  }

  static unauthorized(reason = 'authentication required') {
    return new ApiError(401, 'unauthorized', { reason });
  }

  static forbidden(reason = 'insufficient role') {
    return new ApiError(403, 'forbidden', { reason });
  }

  static conflict(code, detail) {
    return new ApiError(409, code, detail);
  }
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, detail: err.detail ?? null });
  }
  // SQLite constraint failures are client-visible validation problems, not 500s.
  const message = String(err?.message ?? '');
  if (/UNIQUE constraint failed/i.test(message)) {
    return res.status(409).json({ error: 'conflict', detail: { reason: message } });
  }
  if (/CHECK constraint failed/i.test(message)) {
    return res.status(400).json({ error: 'constraint_violation', detail: { reason: message } });
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return res.status(400).json({ error: 'constraint_violation', detail: { reason: message } });
  }
  // A guard violation means we nearly shipped identifiers through an aggregate
  // endpoint. Fail loudly with a 500 so it surfaces in monitoring and tests.
  if (err?.name === 'AggregateLeakError') {
    console.error('[privacy] aggregate-only guard blocked a response:', err.message);
    return res.status(500).json({ error: 'aggregate_guard_violation', detail: { reason: err.message } });
  }
  console.error('[error]', err);
  return res.status(500).json({ error: 'internal_error', detail: null });
}

/**
 * PRIVACY GATE #3 — the aggregate-only boundary.
 *
 * Deliverable 5 requires that seat-level drill-down be impossible at the
 * analytics layer "at the query/API level, not just the UI". Role checks stop
 * the wrong *person*; this guard stops the wrong *data*: it inspects the finished
 * JSON body of every admin response and throws if a seat/student identifier or a
 * seat-label-shaped value appears anywhere in it.
 *
 * Aggregate counts are unaffected ("seatsReporting": 12 is a number, "PC-01" is
 * not). The point is that no code path at this layer can accidentally return a
 * row about one machine, however it was reached.
 */
/**
 * Identifier stems, matched against a normalised key with a trailing plural "s"
 * tolerated — so `seat`, `seats`, `seatId`, `seat_ids`, `seatLabel` and
 * `seatSessionId` are all caught without enumerating every spelling someone might
 * invent. Aggregate *counts* are unaffected because they are named for their
 * quantity (`seatsReporting`, `seatCount`, `contributorSeats`), not for the row
 * they came from.
 */
const FORBIDDEN_STEMS = new Set([
  'seat',
  'seatid',
  'seatlabel',
  'seatname',
  'seatsession',
  'seatsessionid',
  'agenttoken',
  'student',
  'studentid',
  'studentname',
  'studentlabel',
  'device',
  'deviceid',
  'hostname',
  'macaddress',
  'ipaddress',
]);

const SEAT_LABEL_VALUE_RE = /^(PC|Seat)[\s-]?\d{1,3}$/i;

/** `seat_ids` → `seatid`, `students` → `student`, `seatsReporting` → `seatsreporting`. */
function normalizeKey(key) {
  const normalized = String(key).toLowerCase().replace(/[_\s-]/g, '');
  if (normalized.length > 3 && normalized.endsWith('s')) return normalized.slice(0, -1);
  return normalized;
}

export function isForbiddenKey(key) {
  const normalized = normalizeKey(key);
  return FORBIDDEN_STEMS.has(normalized) || FORBIDDEN_STEMS.has(String(key).toLowerCase().replace(/[_\s-]/g, ''));
}

export class AggregateLeakError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AggregateLeakError';
  }
}

export function findAggregateLeaks(payload, path = '$') {
  const leaks = [];
  const walk = (value, where) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (isForbiddenKey(key)) {
          leaks.push(`${where}.${key} (forbidden key)`);
        }
        walk(child, `${where}.${key}`);
      }
      return;
    }
    if (typeof value === 'string' && SEAT_LABEL_VALUE_RE.test(value.trim())) {
      leaks.push(`${where} = "${value}" (seat-label-shaped value)`);
    }
  };
  walk(payload, path);
  return leaks;
}

/**
 * Express middleware factory. Serializes the response through the guard: the
 * route writes to `res.locals.aggregate`, and only a clean payload is sent.
 */
export function aggregateOnlyGuard() {
  return (req, res, next) => {
    res.locals.isAggregateOnly = true;
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const leaks = findAggregateLeaks(payload);
      if (leaks.length > 0) {
        return next(new AggregateLeakError(`blocked ${leaks.length} leak(s): ${leaks.join('; ')}`));
      }
      return originalJson(payload);
    };
    next();
  };
}

/** `?limit=` style parse with clamping, so a bad query cannot blow up a query plan. */
export function intParam(value, fallback, { min = 0, max = 10_000 } = {}) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function boolParam(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(Array.isArray(value) ? value[0] : value).toLowerCase());
}
