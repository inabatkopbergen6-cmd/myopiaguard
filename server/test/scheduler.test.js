import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { closeDatabase, get, run } from '../src/db.js';
import { setClock } from '../src/lib/time.js';
import { buildAgentState } from '../src/services/agentState.js';
import { buildClassroomSnapshot } from '../src/services/dashboard.js';
import { BreakScheduler } from '../src/services/scheduler.js';
import {
  classroomConfig,
  endLessonSession,
  getOpenBreak,
  resolveBreak,
  startLessonSession,
  startSeatSession,
  touchHeartbeat,
} from '../src/services/sessionState.js';
import { createFixture, stubHub } from './helpers.js';

/**
 * The scheduler is the product's heartbeat: it decides when a warning appears,
 * when the break overlay takes over, and when a missed break is recorded. These
 * tests drive it with a fake clock, so a 20-minute cadence is verified in
 * microseconds, and they assert on what was actually pushed to the classroom PC.
 *
 * Time only moves through `advance()`, which also sends the heartbeat a real agent
 * sends every 5 seconds. Without that, a jumped clock looks exactly like a machine
 * that has been switched off — which is what the offline tests rely on.
 */

const INTERVAL_MIN = 20;
const LONG_SESSION_MIN = 45;
const DURATION_SEC = 20;
const GRACE_SEC = 120;
const HEARTBEAT_MS = 5000;

let fixture;
let hub;
let scheduler;
let clock;
let live;

beforeEach(() => {
  fixture = createFixture({ intervalMin: INTERVAL_MIN, longSessionMin: LONG_SESSION_MIN, seats: 2 });
  hub = stubHub();
  clock = fixture.at;
  live = [];
  setClock(() => clock);
  scheduler = new BreakScheduler({ hub, logger: { error() {} }, enabled: false });
});

afterEach(() => {
  closeDatabase();
  setClock(null);
});

const minutes = (n) => n * 60_000;

/**
 * Moves the clock forward, heartbeating every live seat along the way — the way a
 * classroom PC does. Pass `{ heartbeat: false }` to simulate machines going away.
 */
function advance(ms, { heartbeat = true } = {}) {
  const target = clock + ms;
  while (clock < target) {
    clock = Math.min(target, clock + HEARTBEAT_MS);
    if (heartbeat) for (const seatSession of live) touchHeartbeat(seatSession.id, clock);
  }
  return clock;
}

const seatByLabel = (label) => fixture.seats.find((entry) => entry.label === label);

/** A teacher starts the lesson and the named PCs join it. */
function startLesson(...labels) {
  const lesson = startLessonSession({ classroom: fixture.classroom, teacherId: fixture.ids.teacher, atMs: clock });
  const joined = labels.map((label) => {
    const seat = seatByLabel(label);
    run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [clock, seat.id]);
    const seatSession = startSeatSession({
      seat: {
        id: seat.id,
        classroom_id: fixture.classroom.id,
        grade_id: fixture.classroom.grade_id,
        school_id: fixture.classroom.school_id,
      },
      lessonSession: lesson,
      agentVersion: 'test-agent',
      atMs: clock,
    });
    live.push(seatSession);
    return { seat, seatSession };
  });
  return { lesson, joined, ...joined[0] };
}

const tick = () => scheduler.tick(clock);

/** Completes (or abandons) whatever break is currently on screen. */
function finishBreak(seatSession, outcome = 'completed', extraMs = DURATION_SEC * 1000) {
  advance(extraMs);
  const open = getOpenBreak(seatSession.id);
  return resolveBreak({ breakEventId: open.id, outcome, atMs: clock });
}

test('a break is scheduled one interval out, with the row created up front', () => {
  const { seatSession } = startLesson('PC-01');
  const open = getOpenBreak(seatSession.id);
  assert.ok(open, 'the pending break exists before it is due, so warnings can attach to it');
  assert.equal(open.status, 'pending');
  assert.equal(Number(open.due_at), clock + minutes(INTERVAL_MIN));
  assert.equal(Number(open.duration_sec), DURATION_SEC);
});

test('nothing happens before the warning window opens', () => {
  startLesson('PC-01');
  advance(minutes(14));
  assert.deepEqual(tick(), []);
  assert.equal(hub.messages.length, 0);
});

test('a T-5 warning is delivered once, then never repeated', () => {
  startLesson('PC-01');
  advance(minutes(15));
  tick();
  advance(minutes(1));
  tick();

  const warnings = hub.ofType('break:warning');
  assert.equal(warnings.length, 1, 'the student must not be nagged');
  assert.equal(warnings[0].payload.kind, 't5');
  assert.equal(warnings[0].payload.leadSeconds, 300);
  assert.equal(warnings[0].payload.seatLabel, 'PC-01');
});

test('a T-1 warning follows the T-5 warning', () => {
  startLesson('PC-01');
  advance(minutes(15));
  tick();
  advance(minutes(4));
  tick();

  const warnings = hub.ofType('break:warning');
  assert.deepEqual(
    warnings.map((message) => message.payload.kind),
    ['t5', 't1'],
  );
  const last = warnings.at(-1);
  assert.equal(last.payload.leadSeconds, 60);
  assert.equal(last.payload.dueInSeconds, 60);
});

test('T-0 takes over the screen, pauses the stretch clock and logs the instruction', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  const events = tick();

  assert.ok(events.some((event) => event.kind === 'break_triggered'));
  const started = hub.ofType('break:start');
  assert.equal(started.length, 1);
  assert.equal(started[0].payload.durationSec, DURATION_SEC);
  assert.ok(started[0].payload.instruction.text.length > 0);

  const seatSessionAfter = get('SELECT * FROM seat_sessions WHERE id = ?', [seatSession.id]);
  assert.equal(seatSessionAfter.state, 'on_break');
  assert.equal(seatSessionAfter.resumed_at, null, 'the stretch clock is paused while the overlay is up');

  const open = getOpenBreak(seatSession.id);
  assert.equal(open.status, 'in_progress');
  assert.equal(Number(open.stretch_sec), INTERVAL_MIN * 60, 'the stretch that led to the break is recorded');
});

test('the same break is never triggered twice', () => {
  startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();
  advance(HEARTBEAT_MS);
  tick();
  advance(HEARTBEAT_MS);
  tick();
  assert.equal(hub.ofType('break:start').length, 1);
});

test('a break that is not completed inside its window is recorded as missed', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();

  advance((DURATION_SEC + GRACE_SEC) * 1000 + HEARTBEAT_MS);
  const events = tick();

  const missed = events.find((event) => event.kind === 'break_missed');
  assert.ok(missed, 'the timeout path must fire');
  assert.equal(missed.reason, 'timeout');
  const row = get(`SELECT * FROM break_events WHERE seat_session_id = ? AND status = 'missed'`, [seatSession.id]);
  assert.ok(row);
  assert.match(row.note, /grace window/);
  assert.equal(hub.ofType('break:missed').length, 1);
});

test('after a break is completed the next one is a full interval later, and break time is not screen time', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();

  const result = finishBreak(seatSession, 'completed');
  assert.equal(result.breakEvent.status, 'completed');
  assert.equal(Number(result.breakEvent.completed_at), clock);

  const next = getOpenBreak(seatSession.id);
  assert.equal(Number(next.due_at), clock + minutes(INTERVAL_MIN));
  const seatSessionAfter = get('SELECT * FROM seat_sessions WHERE id = ?', [seatSession.id]);
  assert.equal(seatSessionAfter.state, 'active');
  // 20 minutes of work banked, with the 20-second break excluded.
  assert.ok(
    Math.abs(Number(seatSessionAfter.active_seconds) - INTERVAL_MIN * 60) <= 1,
    `expected ~${INTERVAL_MIN * 60}s of screen time, got ${seatSessionAfter.active_seconds}`,
  );
});

test('a skipped break resets the cadence without stacking another break on top', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();
  const result = finishBreak(seatSession, 'skipped', 4000);

  assert.equal(result.breakEvent.status, 'skipped');
  assert.equal(Number(getOpenBreak(seatSession.id).due_at), clock + minutes(INTERVAL_MIN), 'the rhythm stays predictable');
});

test('an offline seat is frozen, not punished', () => {
  const { seatSession } = startLesson('PC-01');
  // The PC disappears: the clock moves on and no heartbeats arrive.
  advance(minutes(INTERVAL_MIN + 30), { heartbeat: false });

  assert.deepEqual(tick(), [], 'no warnings, no overlay, no miss for a machine that is switched off');
  assert.equal(hub.ofType('break:start').length, 0);
  assert.equal(getOpenBreak(seatSession.id).status, 'pending', 'the break waits until the seat is back');
});

test('a seat that was away gets a re-anchored cadence, not an instant overlay', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN + 30), { heartbeat: false });
  tick();
  assert.ok(Number(getOpenBreak(seatSession.id).due_at) < clock, 'while away, the break went overdue');

  // The agent reconnects.
  touchHeartbeat(seatSession.id, clock, { agentVersion: 'test-agent' });
  const reanchored = getOpenBreak(seatSession.id);
  assert.ok(Number(reanchored.due_at) > clock, 'the student is not ambushed the moment they sit down');
  assert.equal(Number(reanchored.warned_late), 1);

  // And when it does come due, the agent gets a real overlay rather than a timeout.
  advance(Number(reanchored.due_at) - clock + HEARTBEAT_MS);
  tick();
  assert.equal(hub.ofType('break:start').length, 1);
});

test('a break that was on screen when the seat vanished is still a miss', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();

  advance((DURATION_SEC + GRACE_SEC) * 1000 + HEARTBEAT_MS, { heartbeat: false });
  const events = tick();

  const missed = events.find((event) => event.kind === 'break_missed');
  assert.ok(missed);
  assert.equal(missed.reason, 'offline_mid_break');
  assert.equal(get('SELECT status FROM break_events WHERE seat_session_id = ?', [seatSession.id]).status, 'missed');
});

test('a long uninterrupted stretch is flagged amber and appears in the attention panel', () => {
  const { seatSession } = startLesson('PC-01');
  // The student has been working for 50 minutes: past the room's 45-minute limit.
  advance(minutes(50));
  run('UPDATE seat_sessions SET resumed_at = ? WHERE id = ?', [clock - minutes(50), seatSession.id]);

  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  const seatView = snapshot.seats.find((seat) => seat.label === 'PC-01');
  assert.equal(seatView.longStretch, true);
  assert.equal(seatView.session.stretchSeconds, 50 * 60);
  assert.ok(seatView.flags.some((flag) => flag.code === 'long_session'));

  const attention = snapshot.attention.find((entry) => entry.label === 'PC-01');
  assert.ok(attention, 'the seat is listed for the teacher');
  assert.equal(attention.severity, 'high');
  assert.match(attention.detail, /50 min without a completed break/);
});

test('two breaks in a row not completed puts a seat in the attention list', () => {
  const { seatSession } = startLesson('PC-01');

  advance(minutes(INTERVAL_MIN));
  tick();
  finishBreak(seatSession, 'skipped', 4000);
  advance(minutes(INTERVAL_MIN));
  tick();
  finishBreak(seatSession, 'missed', 4000);

  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  const attention = snapshot.attention.find((entry) => entry.label === 'PC-01');
  assert.ok(attention);
  assert.ok(attention.codes.includes('repeat_misses'));
  assert.equal(attention.counters.skipped + attention.counters.missed, 2);
  assert.equal(attention.counters.completed, 0);
  assert.equal(attention.counters.adherencePct, 0);
});

test('class adherence reflects completed breaks across seats', () => {
  const { lesson, joined } = startLesson('PC-01', 'PC-02');
  const [first, second] = joined;

  advance(minutes(INTERVAL_MIN));
  tick();
  finishBreak(first.seatSession, 'completed', DURATION_SEC * 1000);
  resolveBreak({ breakEventId: getOpenBreak(second.seatSession.id).id, outcome: 'missed', atMs: clock });

  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  assert.equal(snapshot.classAdherence.completed, 1);
  assert.equal(snapshot.classAdherence.missed, 1);
  assert.equal(snapshot.classAdherence.adherencePct, 50);
  assert.equal(snapshot.counts.active, 2);
  assert.equal(snapshot.lessonSession.id, lesson.id);
});

test('an ended lesson closes its seats and resolves open breaks', () => {
  const { lesson, seatSession } = startLesson('PC-01');
  advance(minutes(10));
  endLessonSession(lesson.id, clock, 'test ended the lesson');

  assert.equal(get('SELECT state FROM seat_sessions WHERE id = ?', [seatSession.id]).state, 'ended');
  assert.equal(
    get('SELECT status FROM break_events WHERE seat_session_id = ?', [seatSession.id]).status,
    'missed',
    'a recommended break never just vanishes',
  );
  assert.deepEqual(tick(), [], 'an ended lesson schedules nothing');
});

test('an in-progress break is rejoinable after an agent reload', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();
  advance(8000);

  const state = buildAgentState({ seatId: seatSession.seat_id, atMs: clock });
  assert.ok(state.activeBreak, 'the reloaded agent rejoins the break rather than restarting it');
  assert.equal(state.activeBreak.elapsedSeconds, 8);
  assert.equal(state.activeBreak.durationSec, DURATION_SEC);
  assert.equal(state.session.state, 'on_break');
});

test('the classroom snapshot separates this-lesson counters from the whole day', () => {
  const { seatSession } = startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();
  finishBreak(seatSession, 'completed');

  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  const seatView = snapshot.seats.find((seat) => seat.label === 'PC-01');
  assert.equal(seatView.counters.session.completed, 1);
  assert.equal(seatView.counters.today.completed, 1);
  assert.equal(seatView.counters.session.adherencePct, 100);
  assert.equal(snapshot.window.kind, 'today');
});

test('a classroom with no lesson running shows its seats as idle, not on break', () => {
  run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [clock, seatByLabel('PC-01').id]);
  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  assert.equal(snapshot.lessonSession, null);
  const seatView = snapshot.seats.find((seat) => seat.label === 'PC-01');
  assert.equal(seatView.status, 'idle');
  assert.equal(seatView.nextBreakAt, null);
  assert.equal(snapshot.classAdherence.adherencePct, null);
});

test('the room configuration is what the scheduler obeys', () => {
  run('UPDATE classrooms SET break_interval_min = 45 WHERE id = ?', [fixture.classroom.id]);
  assert.equal(classroomConfig(fixture.classroom.id).break_interval_min, 45);
  const { seatSession } = startLesson('PC-01');
  assert.equal(Number(getOpenBreak(seatSession.id).due_at), clock + minutes(45));
});

test('a seat that never joins stays offline without disturbing the seats that did', () => {
  startLesson('PC-01');
  advance(minutes(INTERVAL_MIN));
  tick();

  const snapshot = buildClassroomSnapshot({ classroomId: fixture.classroom.id, atMs: clock });
  assert.equal(snapshot.seats.find((seat) => seat.label === 'PC-02').status, 'offline');
  assert.equal(snapshot.seats.find((seat) => seat.label === 'PC-01').status, 'on_break');
  assert.equal(snapshot.counts.onBreak, 1);
  assert.equal(snapshot.counts.offline, 1);
});
