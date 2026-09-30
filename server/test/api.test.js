import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test, { after, before } from 'node:test';

/**
 * End-to-end HTTP test: the whole product surface against a real server process
 * (in-process, but over a real socket) on a throwaway database.
 *
 * The three things this file exists to prove:
 *   1. The teacher API is complete and seat-scoped, with no student identity anywhere.
 *   2. The admin analytics API cannot emit seat-level data — checked by scanning
 *      the actual response bytes, not by trusting the query.
 *   3. A device agent cannot cheat its way to a better adherence score.
 */

const dbFile = path.join(os.tmpdir(), `myopiaguard-api-test-${Date.now()}.db`);
process.env.MG_DB = dbFile;
process.env.MG_DEMO = '1';
process.env.MG_QUIET = '1';
process.env.MG_SCHEDULER = '0'; // deterministic tests: no background ticking
process.env.PORT = '0';

const { start } = await import('../src/index.js');
const { seedDatabase } = await import('../src/seed.js');
const { all, get, openDatabase, run, setDb } = await import('../src/db.js');

let server;
let baseUrl;
let demo;

/** Minimal fetch wrapper that returns status + parsed body. */
async function call(pathname, { method = 'GET', body, token, agentToken, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (agentToken) headers['x-agent-token'] = agentToken;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (raw) return { status: response.status, text, headers: response.headers };
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { unparsed: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
}

let teacherToken;
let adminToken;
let demoClassroomId;
let seats;

before(async () => {
  await seedDatabase({ force: true, demo: true });
  const started = start({ port: 0 });
  server = started.server;
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const teacherLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher.avery', password: 'myopiaguard' },
  });
  assert.equal(teacherLogin.status, 200, JSON.stringify(teacherLogin.body));
  teacherToken = teacherLogin.body.token;

  const adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin.rivera', password: 'myopiaguard' },
  });
  assert.equal(adminLogin.status, 200);
  adminToken = adminLogin.body.token;

  demoClassroomId = teacherLogin.body.classrooms.find((room) => room.name.includes('Computer Science')).id;
  const seatList = await call(`/api/teacher/classrooms/${demoClassroomId}/seats`, { token: teacherToken });
  seats = seatList.body.seats;
  demo = { teacherLogin: teacherLogin.body };
});

after(async () => {
  server?.close();
  const { closeDatabase } = await import('../src/db.js');
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbFile}${suffix}`);
    } catch {
      /* already gone */
    }
  }
});

test('health reports the seeded school without exposing anything', async () => {
  const { status, body } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.counts.classrooms, 8);
  assert.ok(body.counts.seats >= 80);
});

test('login rejects a wrong password and never returns a hash', async () => {
  const bad = await call('/api/auth/login', { method: 'POST', body: { username: 'teacher.avery', password: 'nope' } });
  assert.equal(bad.status, 401);
  const good = await call('/api/auth/login', { method: 'POST', body: { username: 'teacher.avery', password: 'myopiaguard' } });
  assert.equal(good.status, 200);
  const serialized = JSON.stringify(good.body);
  assert.ok(!/password|hash|salt/i.test(serialized), 'credentials must never leave the server');
});

test('an unauthenticated request is refused', async () => {
  assert.equal((await call('/api/teacher/classrooms')).status, 401);
  assert.equal((await call('/api/analytics/school')).status, 401);
});

test('the teacher sees only their own classrooms', async () => {
  const { status, body } = await call('/api/teacher/classrooms', { token: teacherToken });
  assert.equal(status, 200);
  assert.equal(body.classrooms.length, 2);
  assert.ok(body.classrooms.every((room) => ['Room 208 — Computer Science', 'Room 210 — Mathematics'].includes(room.name)));
});

test('another teacher’s classroom is refused outright', async () => {
  const other = get(`SELECT id FROM classrooms WHERE name LIKE 'Room 401%'`);
  const denied = await call(`/api/teacher/classrooms/${other.id}/snapshot`, { token: teacherToken });
  assert.equal(denied.status, 403);
});

test('the dashboard snapshot is seat-keyed and carries no student identity', async () => {
  const { status, body } = await call(`/api/teacher/classrooms/${demoClassroomId}/snapshot`, { token: teacherToken });
  assert.equal(status, 200);
  assert.equal(body.seats.length, 12);
  assert.ok(body.classAdherence, 'the class-wide average is at the top of the payload');
  assert.ok(body.attention.length > 0, 'the seeded lesson has seats needing attention');

  for (const seat of body.seats) {
    assert.match(seat.label, /^(PC|Seat)[\s-]?\d{1,3}$/);
    assert.deepEqual(
      Object.keys(seat).filter((key) => /student|name|email|user/i.test(key)),
      [],
      `seat ${seat.label} must not carry a person-shaped field`,
    );
  }
  // The three badges the spec requires, plus offline.
  const statuses = new Set(body.seats.map((seat) => seat.status));
  for (const value of statuses) assert.ok(['active', 'on_break', 'offline', 'idle'].includes(value));
  assert.equal(body.counts.seats, 12);
  assert.ok(body.counts.offline >= 1, 'the seeded lesson includes a PC that dropped off');
});

test('the seeded demo lesson really does contain the flagged states', async () => {
  const { body } = await call(`/api/teacher/classrooms/${demoClassroomId}/snapshot`, { token: teacherToken });
  const codes = body.attention.flatMap((entry) => entry.codes);
  assert.ok(codes.includes('repeat_misses'), 'a seat has missed two breaks in a row');
  assert.ok(codes.includes('long_session'), 'a seat is on a long uninterrupted stretch');
  assert.ok(codes.includes('offline_mid_session') || codes.includes('offline_mid_break'), 'a PC is offline mid-lesson');
});

/** Recursively collects every key in a payload, for field-name privacy checks. */
function collectKeys(value, out = []) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    collectKeys(child, out);
  }
  return out;
}

const PERSON_SHAPED = /student|pupil|firstname|lastname|surname|email|dateofbirth|dob|photo|guardian|parent/i;

test('a seat detail card exposes session length and trend but still no PII', async () => {
  const { body } = await call(`/api/teacher/seats/${seats[0].seatId}`, { token: teacherToken });
  assert.equal(body.seat.label, seats[0].label);
  assert.ok(Array.isArray(body.trend) && body.trend.length === 5, 'a five-day adherence trend');
  assert.ok(Array.isArray(body.recentBreaks));
  assert.ok(Array.isArray(body.todaySessions));

  // No field anywhere in the payload can hold a person. (Prose such as "no student
  // identity is recorded" is fine; a `studentName` field is not.)
  const offenders = collectKeys(body).filter((key) => PERSON_SHAPED.test(key));
  assert.deepEqual(offenders, [], `unexpected person-shaped fields: ${offenders.join(', ')}`);
  assert.match(body.privacy, /No student identity/);
});

test('creating a seat with a student name is rejected by the API', async () => {
  const { status, body } = await call(`/api/teacher/classrooms/${demoClassroomId}/seats`, {
    method: 'POST',
    token: teacherToken,
    body: { label: 'Anna Kowalski' },
  });
  assert.equal(status, 400);
  assert.ok(['invalid_seat_label', 'pii_rejected'].includes(body.error));
  assert.equal(all(`SELECT id FROM seats WHERE label NOT LIKE 'PC-%' AND label NOT LIKE 'Seat %'`).length, 0);
});

test('a device agent authenticates with its seat token and gets its own state', async () => {
  const seat = seats[0];
  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: seat.agentToken, body: { agentVersion: 'test/1' } });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.seat.label, seat.label);
  assert.equal(hello.body.lesson.active, true);
  assert.ok(hello.body.config.breakIntervalMin > 0);
  assert.ok(hello.body.pendingBreak || hello.body.activeBreak, 'the agent knows which break is next');

  const unknown = await call('/api/agent/hello', { method: 'POST', agentToken: 'not-a-real-token', body: {} });
  assert.equal(unknown.status, 401);

  const asUser = await call('/api/agent/hello', { method: 'POST', token: teacherToken, body: {} });
  assert.equal(asUser.status, 403, 'a teacher session is not a device');
});

test('an agent cannot complete a break early, and the server times it itself', async () => {
  const seat = seats[1];
  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: seat.agentToken, body: { agentVersion: 'test/1' } });
  const breakId = hello.body.pendingBreak?.breakEventId ?? hello.body.activeBreak?.breakEventId;
  assert.ok(breakId);
  const durationSec = Number(hello.body.pendingBreak?.durationSec ?? hello.body.activeBreak?.durationSec);

  // Show it, then try to claim completion immediately.
  const shown = await call(`/api/agent/breaks/${breakId}/shown`, { method: 'POST', agentToken: seat.agentToken });
  assert.equal(shown.status, 200);
  const early = await call(`/api/agent/breaks/${breakId}/complete`, { method: 'POST', agentToken: seat.agentToken });
  assert.equal(early.status, 409, 'a 20-second break cannot be claimed in 20 milliseconds');
  assert.equal(early.body.error, 'break_not_elapsed');
  assert.equal(early.body.detail.requiredSeconds, durationSec);

  // Rewind the clock the honest way: the server believes its own start time.
  run('UPDATE break_events SET started_at = ? WHERE id = ?', [Date.now() - (durationSec + 2) * 1000, breakId]);
  const done = await call(`/api/agent/breaks/${breakId}/complete`, { method: 'POST', agentToken: seat.agentToken });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'completed');
  assert.equal(done.body.seatLabel, seat.label);
  assert.ok(done.body.completedAt);
});

test('one seat cannot resolve another seat’s break', async () => {
  const victim = seats[2];
  const attacker = seats[3];
  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: victim.agentToken, body: {} });
  const breakId = hello.body.pendingBreak?.breakEventId ?? hello.body.activeBreak?.breakEventId;
  const attempt = await call(`/api/agent/breaks/${breakId}/complete`, { method: 'POST', agentToken: attacker.agentToken });
  assert.equal(attempt.status, 403);
  assert.equal(get('SELECT status FROM break_events WHERE id = ?', [breakId]).status, 'pending');
});

test('a skipped break is recorded as incomplete and still counts', async () => {
  const seat = seats[4];
  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: seat.agentToken, body: {} });
  const breakId = hello.body.pendingBreak?.breakEventId ?? hello.body.activeBreak?.breakEventId;
  await call(`/api/agent/breaks/${breakId}/shown`, { method: 'POST', agentToken: seat.agentToken });
  const skipped = await call(`/api/agent/breaks/${breakId}/skip`, {
    method: 'POST',
    agentToken: seat.agentToken,
    body: { reason: 'dismissed by student' },
  });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, 'skipped');
  assert.match(skipped.body.note, /skipped/i);
});

test('the classroom config is configurable per room and validated', async () => {
  const patched = await call(`/api/teacher/classrooms/${demoClassroomId}/config`, {
    method: 'PATCH',
    token: teacherToken,
    body: { breakIntervalMin: 25, warnLead5Min: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.config.breakIntervalMin, 25);
  assert.equal(patched.body.config.warnLead5Min, false);

  const invalid = await call(`/api/teacher/classrooms/${demoClassroomId}/config`, {
    method: 'PATCH',
    token: teacherToken,
    body: { breakIntervalMin: 1000 },
  });
  assert.equal(invalid.status, 400);
});

test('Attention Mode reaches the room and is explicitly not device control', async () => {
  const sent = await call(`/api/teacher/classrooms/${demoClassroomId}/attention`, {
    method: 'POST',
    token: teacherToken,
    body: { message: 'Please look at the board. <script>x</script>', durationSec: 20 },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.broadcast.message, 'Please look at the board. scriptx/script', 'markup is stripped');
  assert.equal(sent.body.broadcast.capabilities.inputLock, false);
  assert.equal(sent.body.broadcast.capabilities.screenCapture, false);
  assert.equal(sent.body.broadcast.capabilities.appBlocking, false);
  assert.equal(sent.body.broadcast.capabilities.scope, 'lesson-management');

  const status = await call(`/api/teacher/classrooms/${demoClassroomId}/attention`, { token: teacherToken });
  assert.equal(status.body.active.message, sent.body.broadcast.message);

  const cleared = await call(`/api/teacher/classrooms/${demoClassroomId}/attention/clear`, {
    method: 'POST',
    token: teacherToken,
    body: {},
  });
  assert.equal(cleared.body.cleared, true);
  const after = await call(`/api/teacher/classrooms/${demoClassroomId}/attention`, { token: teacherToken });
  assert.equal(after.body.active, null);
  assert.ok(after.body.history.length >= 1, 'the broadcast is auditable afterwards');
});

test('the default Attention Mode message is used when a teacher sends none', async () => {
  const sent = await call(`/api/teacher/classrooms/${demoClassroomId}/attention`, {
    method: 'POST',
    token: teacherToken,
    body: { durationSec: 10 },
  });
  assert.equal(sent.body.broadcast.message, 'Teacher Attention — Please look at the board.');
  await call(`/api/teacher/classrooms/${demoClassroomId}/attention/clear`, { method: 'POST', token: teacherToken, body: {} });
});

test('Focus Mode produces an enforceable policy and refuses an empty allowlist', async () => {
  const catalog = await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, { token: teacherToken });
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.catalog.length >= 4);
  const chosen = catalog.body.catalog.filter((resource) => ['School LMS', 'Google Docs', 'Online IDE'].includes(resource.name));
  assert.equal(chosen.length, 3);

  const empty = await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, {
    method: 'POST',
    token: teacherToken,
    body: { resourceIds: [] },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'empty_allowlist', 'an empty list would block every site');

  const enabled = await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, {
    method: 'POST',
    token: teacherToken,
    body: { resourceIds: chosen.map((resource) => resource.id) },
  });
  assert.equal(enabled.status, 200);
  const policy = enabled.body.policy;
  assert.equal(policy.active, true);
  assert.equal(policy.mode, 'allowlist');
  assert.equal(policy.scope, 'browsing');
  assert.equal(policy.expiresWithLesson, true);
  assert.ok(policy.allowedDomainPatterns.includes('docs.google.com'));
  assert.ok(policy.allowedDomainPatterns.includes('*.docs.google.com'));
  assert.ok(policy.policyVersion > 0, 'the policy is versioned so an agent can spot a stale one');

  // The device sees the same policy.
  const agent = await call('/api/agent/state', { agentToken: seats[0].agentToken });
  assert.equal(agent.body.focusPolicy.active, true);
  assert.equal(agent.body.focusPolicy.policyVersion, policy.policyVersion);

  const disabled = await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, { method: 'DELETE', token: teacherToken });
  assert.equal(disabled.status, 200);
  const agentAfter = await call('/api/agent/state', { agentToken: seats[0].agentToken });
  assert.equal(agentAfter.body.focusPolicy.active, false);
});

test('a weekly report has the five metrics, a Mon–Fri series and a CSV export', async () => {
  const { status, body } = await call(`/api/reports/classrooms/${demoClassroomId}/weekly`, { token: teacherToken });
  assert.equal(status, 200);
  const report = body.report;
  for (const key of ['computerSessions', 'recommendedBreaks', 'completedBreaks', 'breakAdherence', 'longVisualSessions']) {
    assert.ok(report.totals[key] !== undefined, `${key} must be in the report`);
  }
  assert.equal(report.perDay.length, 5);
  assert.deepEqual(report.perDay.map((day) => day.short), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  assert.ok(report.totals.computerSessions > 0);
  assert.ok(report.totals.breakAdherence > 0 && report.totals.breakAdherence <= 100);
  assert.ok(report.perSeat.length > 0, 'a teacher can see their own room per seat');
  assert.ok(report.previousWeek.totals, 'week-over-week context is included');

  const csv = await call(`/api/reports/classrooms/${demoClassroomId}/weekly.csv`, { token: teacherToken, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /MyopiaGuard weekly classroom report/);
  assert.match(csv.text, /Break adherence/);
  assert.match(csv.text, /Long visual sessions/);
  assert.match(csv.text, /Mon,Tue|Monday/);
  assert.match(csv.text, /does not record which student/);
});

test('the weekly report can be generated on demand and read back from storage', async () => {
  const generated = await call(`/api/reports/classrooms/${demoClassroomId}/weekly/generate`, {
    method: 'POST',
    token: teacherToken,
    body: {},
  });
  assert.equal(generated.status, 201);
  assert.ok(generated.body.stored.length >= 1);
  const history = await call(`/api/reports/classrooms/${demoClassroomId}/history`, { token: teacherToken });
  assert.ok(history.body.reports.length >= 1);
  assert.ok(history.body.reports[0].weekLabel.includes('→'));
});

test('a teacher cannot reach the school analytics layer', async () => {
  const { status, body } = await call('/api/analytics/school', { token: teacherToken });
  assert.equal(status, 403);
  // The role gate fires first: a teacher is not an admin, whatever they ask for.
  assert.match(JSON.stringify(body), /requires role: admin/);
});

test('a device agent cannot reach the analytics layer either', async () => {
  const { status } = await call('/api/analytics/school', { agentToken: seats[0].agentToken });
  assert.equal(status, 403);
});

test('the admin analytics payload is aggregate-only, verified byte by byte', async () => {
  const { status, body } = await call('/api/analytics/school?windowDays=7', { token: adminToken });
  assert.equal(status, 200);

  // Every rollup level the spec asks for.
  assert.equal(body.byGrade.length, 4);
  assert.ok(body.byClassroom.length === 8);
  assert.ok(body.visualLoad.byClassroom.length > 0);
  assert.ok(body.visualLoad.bySubject.length > 0);
  assert.ok(body.commonIssue.label.length > 0);
  assert.ok(body.trend.weekly.length > 0);
  assert.ok(body.trend.monthly.length > 0);
  assert.equal(body.privacy.aggregateOnly, true);
  assert.equal(body.access.seatDrilldown, false);

  // The hard guarantee: no seat identifier and no seat-shaped value anywhere.
  const serialized = JSON.stringify(body);
  const { findAggregateLeaks } = await import('../src/lib/http.js');
  assert.deepEqual(findAggregateLeaks(body), [], 'the admin payload must not contain seat-level data');

  // Belt and braces: the actual seeded seat labels must not appear in the bytes.
  for (const seat of seats) {
    assert.ok(!serialized.includes(seat.seatId), `${seat.seatId} leaked into the admin payload`);
    assert.ok(!serialized.includes(seat.label), `the label ${seat.label} leaked into the admin payload`);
  }
});

test('the admin layer exposes no seat-level drill-down route at all', async () => {
  for (const attempt of [
    '/api/analytics/school/seats',
    `/api/analytics/seats/${seats[0].seatId}`,
    '/api/analytics/students',
  ]) {
    const { status } = await call(attempt, { token: adminToken });
    assert.equal(status, 404, `${attempt} must not exist`);
  }

  // Asking for seat-level data by query parameter is refused by name, so the
  // boundary is explicit in the API contract rather than silently ignored.
  for (const attempt of [
    `/api/analytics/school?seatId=${seats[0].seatId}`,
    '/api/analytics/grades?seatIds=1,2',
    '/api/analytics/school?studentId=42',
    '/api/analytics/school/trend?hostname=LAB-PC-04',
  ]) {
    const { status, body } = await call(attempt, { token: adminToken });
    assert.equal(status, 400, `${attempt} must be refused`);
    assert.equal(body.error, 'seat_level_not_available');
  }

  // Querying by classroom is allowed, but only in aggregate.
  const rollup = await call(`/api/analytics/classrooms/${demoClassroomId}/rollup`, { token: adminToken });
  assert.equal(rollup.status, 200);
  const { findAggregateLeaks } = await import('../src/lib/http.js');
  assert.deepEqual(findAggregateLeaks(rollup.body), []);
});

test('a classroom too small to anonymise is suppressed, not reported', async () => {
  // A room with two workstations cannot be reported without identifying them.
  const nowMs = Date.now();
  run('INSERT INTO classrooms (id, school_id, grade_id, name, subject, break_interval_min, break_duration_sec, long_session_min, missed_break_grace_sec, offline_after_sec, created_at) SELECT ?, school_id, grade_id, ?, ?, break_interval_min, break_duration_sec, long_session_min, missed_break_grace_sec, offline_after_sec, ? FROM classrooms LIMIT 1', [
    'cls_tiny',
    'Room TINY — Robotics club',
    'Robotics',
    nowMs,
  ]);
  const classroom = get(`SELECT * FROM classrooms WHERE id = 'cls_tiny'`);
  for (const index of [1, 2]) {
    run('INSERT INTO seats (id, classroom_id, label, seat_index, agent_token, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      `seat_tiny_${index}`,
      classroom.id,
      `PC-0${index}`,
      index,
      `token_tiny_${index}`,
      nowMs,
    ]);
    run(
      `INSERT INTO seat_sessions (id, seat_id, classroom_id, grade_id, school_id, lesson_session_id, started_at, ended_at, active_seconds, state, last_heartbeat_at)
       SELECT ?, ?, ?, ?, ?, id, ?, ?, 600, 'ended', ? FROM lesson_sessions LIMIT 1`,
      [`ses_tiny_${index}`, `seat_tiny_${index}`, classroom.id, classroom.grade_id, classroom.school_id, nowMs - 3600_000, nowMs - 3000_000, nowMs - 3000_000],
    );
    run(
      `INSERT INTO break_events (id, seat_id, seat_session_id, lesson_session_id, classroom_id, grade_id, school_id, due_at, resolved_at, completed_at, duration_sec, stretch_sec, status)
       SELECT ?, ?, ?, id, ?, ?, ?, ?, ?, ?, 20, 1200, 'completed' FROM lesson_sessions LIMIT 1`,
      [
        `brk_tiny_${index}`,
        `seat_tiny_${index}`,
        `ses_tiny_${index}`,
        classroom.id,
        classroom.grade_id,
        classroom.school_id,
        nowMs - 3400_000,
        nowMs - 3400_000,
        nowMs - 3400_000,
      ],
    );
  }

  const { body } = await call('/api/analytics/school?windowDays=7', { token: adminToken });
  const tiny = body.byClassroom.find((row) => row.classroomName.includes('TINY'));
  assert.ok(tiny, 'the room appears in the index');
  assert.equal(tiny.suppressed, true);
  assert.equal(tiny.breakAdherence, undefined, 'no metric is reported for a cohort that small');
  assert.match(tiny.suppressionReason, /Fewer than 5 workstations/);
  assert.ok(body.privacy.suppressedClassrooms >= 1);
  const { findAggregateLeaks } = await import('../src/lib/http.js');
  assert.deepEqual(findAggregateLeaks(body), []);

  run(`DELETE FROM break_events WHERE classroom_id = 'cls_tiny'`);
  run(`DELETE FROM seat_sessions WHERE classroom_id = 'cls_tiny'`);
  run(`DELETE FROM seats WHERE classroom_id = 'cls_tiny'`);
  run(`DELETE FROM classrooms WHERE id = 'cls_tiny'`);
});

test('the school analytics CSV is aggregate-only and downloads', async () => {
  const csv = await call('/api/analytics/school/export.csv?windowDays=7', { token: adminToken, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /MyopiaGuard school analytics \(aggregate only\)/);
  assert.match(csv.text, /Suppression rule/);
  assert.match(csv.text, /Workstations/);
  for (const seat of seats) assert.ok(!csv.text.includes(seat.label), 'no seat label in the export');
});

test('ending the lesson clears seat sessions and turns Focus Mode off', async () => {
  const catalog = await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, { token: teacherToken });
  const chosen = catalog.body.catalog.slice(0, 2).map((resource) => resource.id);
  await call(`/api/teacher/classrooms/${demoClassroomId}/focus`, {
    method: 'POST',
    token: teacherToken,
    body: { resourceIds: chosen },
  });
  const agentBefore = await call('/api/agent/state', { agentToken: seats[0].agentToken });
  assert.equal(agentBefore.body.focusPolicy.active, true);

  const ended = await call(`/api/teacher/classrooms/${demoClassroomId}/session/end`, { method: 'POST', token: teacherToken, body: {} });
  assert.equal(ended.status, 200);

  const agentAfter = await call('/api/agent/state', { agentToken: seats[0].agentToken });
  assert.equal(agentAfter.body.focusPolicy.active, false, 'Focus Mode never outlives its lesson');
  assert.equal(agentAfter.body.lesson.active, false);
  assert.equal(agentAfter.body.pendingBreak, null);
  const remaining = all(`SELECT id FROM seat_sessions WHERE classroom_id = ? AND state != 'ended'`, [demoClassroomId]);
  assert.equal(remaining.length, 0);
});

test('a new lesson can be started after the previous one is ended', async () => {
  const started = await call(`/api/teacher/classrooms/${demoClassroomId}/session`, {
    method: 'POST',
    token: teacherToken,
    body: { subject: 'Computer Science' },
  });
  assert.equal(started.status, 201);
  const again = await call(`/api/teacher/classrooms/${demoClassroomId}/session`, { method: 'POST', token: teacherToken, body: {} });
  assert.equal(again.status, 201, 'starting twice reuses the live session rather than duplicating it');
  assert.equal(again.body.lessonSession.id, started.body.lessonSession.id);

  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: seats[0].agentToken, body: { agentVersion: 'test/1' } });
  assert.equal(hello.body.lesson.active, true);
  assert.ok(hello.body.pendingBreak, 'the seat is back on the cadence');
});

test('the demo controls are honest about what they do, and edit real rows', async () => {
  const status = await call('/api/demo/status', { token: teacherToken });
  assert.equal(status.status, 200);
  assert.equal(status.body.demoMode, true);

  const before = get(`SELECT due_at FROM break_events WHERE status = 'pending' ORDER BY due_at LIMIT 1`);
  const nudged = await call(`/api/demo/classrooms/${demoClassroomId}/break-now`, {
    method: 'POST',
    token: teacherToken,
    body: { inSeconds: 0 },
  });
  assert.equal(nudged.status, 200);
  assert.ok(nudged.body.affected.length > 0);
  const after = get(`SELECT due_at FROM break_events WHERE status = 'pending' ORDER BY due_at LIMIT 1`);
  assert.ok(Number(after.due_at) < Number(before.due_at), 'a real break row was moved, nothing was faked');
});

test('audit trail records every administrative action', async () => {
  const { body } = await call('/api/demo/audit?limit=50', { token: teacherToken });
  const actions = body.entries.map((entry) => entry.action);
  assert.ok(actions.includes('attention.broadcast'));
  assert.ok(actions.includes('attention.cleared'));
  assert.ok(actions.includes('focus.enabled'));
  assert.ok(actions.includes('focus.disabled'));
  assert.ok(actions.includes('lesson.started'));
  assert.ok(actions.includes('lesson.ended'));
  // The audit trail is the school's record: it must say what was sent.
  const broadcast = body.entries.find((entry) => entry.action === 'attention.broadcast');
  assert.ok(broadcast.detail.message.length > 0);
});

// ---------------------------------------------------------------- language

test('the language can be set per account and follows the user back', async () => {
  const teacher = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher.avery', password: 'myopiaguard' },
  });
  const token = teacher.body.token;

  const before = await call('/api/auth/me', { token });
  assert.equal(before.status, 200);
  // A fresh account carries an (empty) preferences object rather than nothing, so
  // the client never has to null-check it.
  assert.deepEqual(before.body.user.preferences, {});

  const saved = await call('/api/auth/me/preferences', {
    method: 'PATCH',
    token,
    body: { language: 'ru' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.preferences.language, 'ru');

  // A new sign-in on a different device must see the same choice.
  const again = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher.avery', password: 'myopiaguard' },
  });
  assert.equal(again.body.user.preferences.language, 'ru');

  const me = await call('/api/auth/me', { token: again.body.token });
  assert.equal(me.body.user.preferences.language, 'ru');

  // Put it back so later tests see a clean account.
  await call('/api/auth/me/preferences', { method: 'PATCH', token, body: { language: 'en' } });
});

test('an unsupported language is refused rather than stored', async () => {
  const teacher = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher.avery', password: 'myopiaguard' },
  });
  const bad = await call('/api/auth/me/preferences', {
    method: 'PATCH',
    token: teacher.body.token,
    body: { language: 'klingon' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_value');
  assert.ok(bad.body.detail.allowed.includes('en'));

  const empty = await call('/api/auth/me/preferences', { method: 'PATCH', token: teacher.body.token, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'nothing_to_update');

  const me = await call('/api/auth/me', { token: teacher.body.token });
  assert.notEqual(me.body.user.preferences.language, 'klingon');
});

test('a classroom carries the language its PCs display, and the device inherits it', async () => {
  const teacher = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'teacher.avery', password: 'myopiaguard' },
  });
  const token = teacher.body.token;
  const rooms = await call('/api/teacher/classrooms', { token });
  const room = rooms.body.classrooms.find((entry) => entry.name.includes('208'));

  const initial = await call(`/api/teacher/classrooms/${room.id}/config`, { token });
  assert.equal(initial.status, 200);
  assert.ok(['en', 'ru'].includes(initial.body.config.language));

  const patched = await call(`/api/teacher/classrooms/${room.id}/config`, {
    method: 'PATCH',
    token,
    body: { language: 'ru' },
  });
  assert.equal(patched.body.config.language, 'ru');

  // The classroom PC is told which language to render in.
  const seatList = await call(`/api/teacher/classrooms/${room.id}/seats`, { token });
  const agent = await call('/api/agent/state', { agentToken: seatList.body.seats[0].agentToken });
  assert.equal(agent.body.config.language, 'ru');

  const bad = await call(`/api/teacher/classrooms/${room.id}/config`, {
    method: 'PATCH',
    token,
    body: { language: 'fr' },
  });
  assert.equal(bad.status, 400);

  await call(`/api/teacher/classrooms/${room.id}/config`, { method: 'PATCH', token, body: { language: 'en' } });
});

// ------------------------------------------------------ language-neutral logs

test('a skipped break records a language-neutral reason code, not English prose', async () => {
  const rooms = await call('/api/teacher/classrooms', { token: teacherToken });
  const room = rooms.body.classrooms.find((entry) => entry.name.includes('208'));
  const seatList = await call(`/api/teacher/classrooms/${room.id}/seats`, { token: teacherToken });
  const seat = seatList.body.seats[0];

  const hello = await call('/api/agent/hello', { method: 'POST', agentToken: seat.agentToken, body: {} });
  const breakId = (hello.body.pendingBreak ?? hello.body.activeBreak)?.breakEventId;
  assert.ok(breakId, 'the seat should have a break to work with');
  await call(`/api/agent/breaks/${breakId}/shown`, { method: 'POST', agentToken: seat.agentToken });
  const skipped = await call(`/api/agent/breaks/${breakId}/skip`, {
    method: 'POST',
    agentToken: seat.agentToken,
    body: { reason: 'student_dismissed' },
  });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, 'skipped');

  // The stored note is a stable code, so one audit log never mixes languages.
  const row = get('SELECT status, note FROM break_events WHERE id = ?', [breakId]);
  assert.equal(row.status, 'skipped');
  assert.equal(row.note, 'student_dismissed');
});

// ---------------------------------------------------- structured translatables

test('attention flags and analytics issues ship machine-readable params, not only English prose', async () => {
  // Drive the state rather than relying on the seed: earlier tests in this file
  // end and restart the lesson, so the seeded flags are already spent.
  await call(`/api/demo/classrooms/${demoClassroomId}/stretch`, {
    method: 'POST',
    token: teacherToken,
    body: { minutes: 60 },
  });
  const snapshot = await call(`/api/teacher/classrooms/${demoClassroomId}/snapshot`, { token: teacherToken });
  const flags = snapshot.body.seats.flatMap((seat) => seat.flags ?? []);
  assert.ok(flags.length > 0, 'a 60-minute stretch should raise at least one flag');
  for (const flag of flags) {
    assert.ok(flag.code, 'every flag carries a stable code');
    assert.ok(flag.params && typeof flag.params === 'object', `${flag.code} must carry params for the client to compose`);
  }
  const longFlag = flags.find((flag) => flag.code === 'long_session');
  if (longFlag) {
    assert.ok(Number.isFinite(longFlag.params.minutes), 'long_session needs a minutes count');
    assert.ok(Number.isFinite(longFlag.params.threshold), 'long_session needs the threshold it breached');
  }

  const analytics = await call('/api/analytics/school?windowDays=7', { token: adminToken });
  assert.ok(analytics.body.commonIssue.code, 'the issue carries a stable code');
  assert.ok(analytics.body.commonIssue.params, 'the issue carries params');
  assert.ok(Array.isArray(analytics.body.commonIssue.ranking));
  for (const issue of analytics.body.commonIssue.ranking) {
    assert.ok(issue.params, `${issue.code} must carry params`);
  }

  // Trend buckets expose the epoch so the UI can format the label itself rather
  // than stripping a hard-coded English prefix off the server's label.
  const weekly = analytics.body.trend.weekly;
  assert.ok(weekly.length > 0);
  for (const point of weekly) {
    assert.ok(Number.isFinite(point.weekStart), 'a weekly bucket must carry weekStart');
  }
});
