import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import config from './config.js';

/**
 * Storage is SQLite via Node's built-in `node:sqlite` — no native build step, so
 * a school IT department can deploy this with nothing but Node installed. Every
 * table below is append-mostly event data, which is also what a Postgres
 * migration would look like: the schema is portable, `TEXT` ids are app-generated
 * and timestamps are epoch milliseconds.
 *
 * The CHECK constraints on `seats.label` and `break_events.status` are the last
 * line of defence behind the validators in lib/validation.js.
 */
export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schools (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grades (
  id          TEXT PRIMARY KEY,
  school_id   TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       INTEGER NOT NULL,
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS classrooms (
  id                    TEXT PRIMARY KEY,
  school_id             TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  grade_id              TEXT NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  subject               TEXT NOT NULL DEFAULT 'General',
  -- Language the classroom PCs in this room display, including the full-screen
  -- break challenge. Set per room because a room is provisioned once and its
  -- screens are the ones students actually read; a kiosk should not offer a
  -- language control to whoever sits down.
  language              TEXT NOT NULL DEFAULT 'en',
  -- Configurable cadence (deliverable 3): defaults live in config.CLASSROOM_DEFAULTS
  break_interval_min    INTEGER NOT NULL DEFAULT 20,
  break_duration_sec    INTEGER NOT NULL DEFAULT 20,
  warn_lead_5min        INTEGER NOT NULL DEFAULT 1,
  warn_lead_1min        INTEGER NOT NULL DEFAULT 1,
  long_session_min      INTEGER NOT NULL DEFAULT 45,
  missed_break_grace_sec INTEGER NOT NULL DEFAULT 120,
  offline_after_sec     INTEGER NOT NULL DEFAULT 15,
  created_at            INTEGER NOT NULL,
  UNIQUE (school_id, name)
);

-- PRIVACY: a seat is a workstation. It has no student column by design, and the
-- label is constrained to the machine-label shape so a name cannot be smuggled in.
CREATE TABLE IF NOT EXISTS seats (
  id            TEXT PRIMARY KEY,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  seat_index    INTEGER NOT NULL,
  agent_token   TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  CHECK (label GLOB 'PC-[0-9]*' OR label GLOB 'Seat [0-9]*'),
  UNIQUE (classroom_id, label)
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  school_id      TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('teacher', 'admin')),
  display_name   TEXT NOT NULL,
  title          TEXT,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  -- Per-account interface preferences as a JSON object (currently just the
  -- language). Stored per account so a teacher's choice follows them to another
  -- computer, rather than living only in one browser's localStorage.
  preferences    TEXT,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teacher_classrooms (
  teacher_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, classroom_id)
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token         TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- A lesson session: one teacher, one classroom, one period of time.
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id            TEXT PRIMARY KEY,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  grade_id      TEXT NOT NULL REFERENCES grades(id),
  school_id     TEXT NOT NULL REFERENCES schools(id),
  teacher_id    TEXT NOT NULL REFERENCES users(id),
  subject       TEXT NOT NULL DEFAULT 'General',
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended'))
);

-- One seat's participation in a lesson session. resumed_at is when the current
-- uninterrupted stretch began, which is what the "long session" flag is built on.
CREATE TABLE IF NOT EXISTS seat_sessions (
  id                    TEXT PRIMARY KEY,
  seat_id               TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  classroom_id          TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  grade_id              TEXT NOT NULL REFERENCES grades(id),
  school_id             TEXT NOT NULL REFERENCES schools(id),
  lesson_session_id     TEXT NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  active_seconds        INTEGER NOT NULL DEFAULT 0,
  resumed_at            INTEGER,
  state                 TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'on_break', 'ended')),
  last_heartbeat_at     INTEGER NOT NULL,
  -- When this seat's most recent break resolved (whatever the outcome). The next
  -- break is scheduled from here, which is what keeps the cadence predictable.
  last_break_at         INTEGER,
  agent_version         TEXT
);

CREATE TABLE IF NOT EXISTS break_events (
  id                    TEXT PRIMARY KEY,
  seat_id               TEXT NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  seat_session_id       TEXT NOT NULL REFERENCES seat_sessions(id) ON DELETE CASCADE,
  lesson_session_id     TEXT NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  classroom_id          TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  grade_id              TEXT NOT NULL REFERENCES grades(id),
  school_id             TEXT NOT NULL REFERENCES schools(id),
  -- due_at is the T-0 moment the break is recommended; rows are created as soon
  -- as the *previous* break resolves so countdown warnings have something to hang off.
  due_at                INTEGER NOT NULL,
  started_at            INTEGER,
  resolved_at           INTEGER,
  completed_at          INTEGER,
  duration_sec          INTEGER NOT NULL,
  -- Length of the uninterrupted stretch that triggered this break (drives the
  -- "long visual session" metric and the amber flag on the dashboard).
  stretch_sec           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped', 'missed')),
  instruction_key       TEXT,
  warning_5min_at       INTEGER,
  warning_1min_at       INTEGER,
  warned_late           INTEGER NOT NULL DEFAULT 0,
  note                  TEXT,
  UNIQUE (seat_session_id, due_at)
);

CREATE TABLE IF NOT EXISTS attention_broadcasts (
  id                TEXT PRIMARY KEY,
  lesson_session_id TEXT NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  classroom_id      TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  school_id         TEXT NOT NULL REFERENCES schools(id),
  teacher_id        TEXT NOT NULL REFERENCES users(id),
  message           TEXT NOT NULL,
  duration_sec      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  cleared_at        INTEGER,
  delivered_count   INTEGER NOT NULL DEFAULT 0
);

-- Focus Mode: school-admin-curated catalog of allowed resources…
CREATE TABLE IF NOT EXISTS focus_resources (
  id               TEXT PRIMARY KEY,
  school_id        TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  domain           TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'General',
  description      TEXT,
  default_allowed  INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  UNIQUE (school_id, domain)
);

-- …and the per-session selection the teacher toggles.
CREATE TABLE IF NOT EXISTS focus_sessions (
  id                TEXT PRIMARY KEY,
  lesson_session_id TEXT NOT NULL UNIQUE REFERENCES lesson_sessions(id) ON DELETE CASCADE,
  classroom_id      TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  school_id         TEXT NOT NULL REFERENCES schools(id),
  enabled_by        TEXT NOT NULL REFERENCES users(id),
  enabled_at        INTEGER NOT NULL,
  disabled_at       INTEGER,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS focus_session_resources (
  focus_session_id  TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  resource_id       TEXT NOT NULL REFERENCES focus_resources(id) ON DELETE CASCADE,
  PRIMARY KEY (focus_session_id, resource_id)
);

-- Monday-morning snapshots of the prior Mon–Fri, generated by the weekly job so
-- a teacher's report exists even on a day they never open the dashboard.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id            TEXT PRIMARY KEY,
  classroom_id  TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  week_start    INTEGER NOT NULL,
  week_end      INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  generated_by  TEXT,
  payload       TEXT NOT NULL,
  UNIQUE (classroom_id, week_start)
);

-- Every administrative action that affects a student's screen is auditable.
CREATE TABLE IF NOT EXISTS audit_log (  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  at                 INTEGER NOT NULL,
  actor_user_id      TEXT,
  actor_role         TEXT,
  action             TEXT NOT NULL,
  classroom_id       TEXT,
  seat_id            TEXT,
  detail             TEXT
);

CREATE INDEX IF NOT EXISTS idx_seat_sessions_live ON seat_sessions (lesson_session_id, state);
CREATE INDEX IF NOT EXISTS idx_seat_sessions_seat ON seat_sessions (seat_id, started_at);
CREATE INDEX IF NOT EXISTS idx_breaks_window ON break_events (classroom_id, due_at);
CREATE INDEX IF NOT EXISTS idx_breaks_grade ON break_events (grade_id, due_at);
CREATE INDEX IF NOT EXISTS idx_breaks_seat_session ON break_events (seat_session_id, due_at);
CREATE INDEX IF NOT EXISTS idx_breaks_open ON break_events (status) WHERE status IN ('pending', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_lesson_sessions_classroom ON lesson_sessions (classroom_id, started_at);
CREATE INDEX IF NOT EXISTS idx_attention_live ON attention_broadcasts (classroom_id, cleared_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
`;

let database = null;

/** Bind-parameter hygiene: node:sqlite rejects booleans and undefined. */
function coerceParams(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/**
 * Adds a column to an existing table when it is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that already has the
 * table, so a column added to the schema above would never reach an existing
 * deployment — including the one sitting in `data/` right now. This is the
 * smallest thing that closes that gap honestly: an explicit, idempotent ALTER for
 * each column that has been added since a database was first created.
 *
 * Not a general migration framework, on purpose. If the schema needs to change
 * shape rather than grow, write a real migration step and version it.
 */
export function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** Columns added after the first release. Idempotent, runs on every open. */
function applyMigrations(db) {
  const added = [];
  if (ensureColumn(db, 'users', 'preferences', 'TEXT')) added.push('users.preferences');
  if (ensureColumn(db, 'classrooms', 'language', "TEXT NOT NULL DEFAULT 'en'")) added.push('classrooms.language');
  return added;
}

export function openDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

export function getDb() {
  if (!database) database = openDatabase();
  return database;
}

export function setDb(db) {
  database = db;
  return database;
}

export function closeDatabase() {
  if (database) {
    try {
      database.close();
    } catch {
      /* already closed */
    }
    database = null;
  }
}

export function run(sql, params = [], db = getDb()) {
  return db.prepare(sql).run(...coerceParams(params));
}

export function get(sql, params = [], db = getDb()) {
  return db.prepare(sql).get(...coerceParams(params)) ?? null;
}

export function all(sql, params = [], db = getDb()) {
  return db.prepare(sql).all(...coerceParams(params));
}

/** Single-statement transactions. Nested calls join the outer transaction. */
let txDepth = 0;
export function tx(fn, db = getDb()) {
  if (txDepth > 0) return fn(db);
  txDepth += 1;
  db.exec('BEGIN');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-aborted tx */
    }
    throw error;
  } finally {
    txDepth -= 1;
  }
}

export function audit(entry, db = getDb()) {
  const { actorUserId = null, actorRole = null, action, classroomId = null, seatId = null, detail = null } = entry;
  run(
    `INSERT INTO audit_log (at, actor_user_id, actor_role, action, classroom_id, seat_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.at ?? Date.now(),
      actorUserId,
      actorRole,
      action,
      classroomId,
      seatId,
      detail === null || detail === undefined ? null : JSON.stringify(detail),
    ],
    db,
  );
}
