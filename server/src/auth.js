import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import config from './config.js';
import { all, get, run } from './db.js';
import { ApiError } from './lib/http.js';
import { makeId, makeToken, safeEqual } from './lib/ids.js';
import { now } from './lib/time.js';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, stored) {
  if (!stored?.password_hash || !stored?.password_salt) return false;
  const candidate = scryptSync(password, stored.password_salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(stored.password_hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function createUser({ schoolId, role, displayName, title = null, username, password }, db) {
  const { hash, salt } = hashPassword(password);
  const id = makeId(role === 'admin' ? 'adm' : 'tch');
  run(
    `INSERT INTO users (id, school_id, role, display_name, title, username, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, schoolId, role, displayName, title, username, hash, salt, now()],
    db,
  );
  return { id, schoolId, role, displayName, title, username };
}

export function issueToken(user, db) {
  const token = makeToken(24);
  const at = now();
  run(
    `INSERT INTO auth_tokens (token, user_id, role, created_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, user.id, user.role, at, at + config.tokenTtlMs, at],
    db,
  );
  return token;
}

export function login(username, password) {
  const user = get('SELECT * FROM users WHERE username = ?', [String(username ?? '').trim().toLowerCase()]);
  if (!user || !verifyPassword(password, user)) {
    throw ApiError.unauthorized('invalid credentials');
  }
  const token = issueToken(user);
  return { token, user: publicUser(user) };
}

/** Supported interface languages. Kept here so the API can validate a preference
 *  without importing anything from the web app. */
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'ru']);

/** Parses the stored preferences blob, tolerating anything malformed. */
export function parsePreferences(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function publicUser(user) {
  return {
    id: user.id,
    role: user.role,
    displayName: user.display_name,
    title: user.title ?? null,
    schoolId: user.school_id,
    username: user.username,
    preferences: parsePreferences(user.preferences),
  };
}

/** Merges and stores a preference patch. Returns the resulting object. */
export function savePreferences(userId, patch) {
  const current = parsePreferences(get('SELECT preferences FROM users WHERE id = ?', [userId])?.preferences);
  const next = { ...current, ...patch };
  run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(next), userId]);
  return next;
}

export function userFromToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT t.token, t.expires_at, u.*
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = ?`,
    [token],
  );
  if (!row) return null;
  if (Number(row.expires_at) < now()) {
    run('DELETE FROM auth_tokens WHERE token = ?', [token]);
    return null;
  }
  run('UPDATE auth_tokens SET last_used_at = ? WHERE token = ?', [now(), token]);
  return row;
}

/**
 * Resolves the caller into `req.auth`. Three principal kinds:
 *   - user   : teacher or admin, bearer token
 *   - agent  : a classroom PC presenting its seat's agent token
 * Unknown principals are rejected before any route logic runs.
 */
export function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
    const token = bearer ?? req.query.token ?? null;
    const agentToken = req.get('x-agent-token') ?? req.query.agent ?? null;

    if (token) {
      const row = userFromToken(token);
      if (!row) throw ApiError.unauthorized('token expired or unknown');
      req.auth = {
        kind: 'user',
        role: row.role,
        userId: row.id,
        schoolId: row.school_id,
        displayName: row.display_name,
        preferences: parsePreferences(row.preferences),
        token,
      };
      return next();
    }

    if (agentToken) {
      const seat = get(
        `SELECT s.*, c.school_id, c.grade_id, c.name AS classroom_name, c.break_interval_min,
                c.break_duration_sec, c.warn_lead_5min, c.warn_lead_1min, c.long_session_min,
                c.missed_break_grace_sec, c.offline_after_sec, c.subject
           FROM seats s JOIN classrooms c ON c.id = s.classroom_id
          WHERE s.agent_token = ?`,
        [agentToken],
      );
      if (!seat) throw ApiError.unauthorized('unknown agent token');
      req.auth = {
        kind: 'agent',
        role: 'agent',
        schoolId: seat.school_id,
        seatId: seat.id,
        classroomId: seat.classroom_id,
        seatLabel: seat.label,
        seat,
      };
      run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [now(), seat.id]);
      return next();
    }

    throw ApiError.unauthorized('no credentials presented');
  } catch (error) {
    return next(error);
  }
}

export function requireUser(...roles) {
  return (req, res, next) => {
    if (req.auth?.kind !== 'user') return next(ApiError.forbidden('teacher or admin session required'));
    if (roles.length > 0 && !roles.includes(req.auth.role)) {
      return next(ApiError.forbidden(`requires role: ${roles.join(' or ')}`));
    }
    return next();
  };
}

export function requireAgent(req, res, next) {
  if (req.auth?.kind !== 'agent') return next(ApiError.forbidden('device agent credential required'));
  return next();
}

/** Classrooms a teacher may act on. Admins are intentionally absent: they get
 *  the aggregate analytics surface only, which never exposes a classroom's seats. */
export function teacherClassroomIds(userId) {
  return all('SELECT classroom_id FROM teacher_classrooms WHERE teacher_id = ?', [userId]).map(
    (row) => row.classroom_id,
  );
}

/** Route guard: a teacher can only ever touch their own classrooms. */
export function assertClassroomAccess(auth, classroomId) {
  if (auth.role === 'admin') {
    throw ApiError.forbidden('school admins have aggregate-only access (no classroom or seat drill-down)');
  }
  const allowed = teacherClassroomIds(auth.userId);
  if (!allowed.includes(classroomId)) {
    throw ApiError.forbidden('classroom is not assigned to this teacher');
  }
  return true;
}

export function accessibleClassrooms(auth) {
  if (auth.role === 'admin') return [];
  return all(
    `SELECT c.*, g.name AS grade_name
       FROM classrooms c
       JOIN grades g ON g.id = c.grade_id
       JOIN teacher_classrooms tc ON tc.classroom_id = c.id
      WHERE tc.teacher_id = ?
      ORDER BY g.level, c.name`,
    [auth.userId],
  );
}

export { safeEqual };
