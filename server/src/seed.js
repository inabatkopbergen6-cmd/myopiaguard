import { hashPassword } from './auth.js';
import config, { CLASSROOM_DEFAULTS, DEMO_TIMINGS } from './config.js';
import { closeDatabase, all, get, getDb, run, tx } from './db.js';
import { DEMO_CLASSROOM_NAME, DEMO_PASSWORD } from './demo.js';
import { pathToFileURL } from 'node:url';
import { makeId, makeToken, mulberry32 } from './lib/ids.js';
import { DAY, HOUR, MINUTE, localDayKey, now, startOfLocalDay, startOfLocalWeek } from './lib/time.js';
import { generateWeeklyReport } from './services/reports.js';

/**
 * Seeds a realistic school so every screen in the product has something true to
 * show: a week of past lessons, this morning's periods, and one lesson happening
 * right now with the interesting states already present (a PC that dropped off,
 * a seat that has missed two breaks in a row, a long uninterrupted stretch).
 *
 * Generated from a fixed PRNG seed, so the demo school is the same on every
 * machine and a screenshot in the docs can be reproduced exactly.
 *
 * Two things this file deliberately never creates: a student name, and a seat
 * label that is not machine-shaped. Seats are written through `assertSeatLabel`
 * like every other entry point, and the plan below only ever describes rooms and
 * workstations — the model has nowhere to put a child's name.
 */

const rand = mulberry32(20260930);

const pick = (items) => items[Math.floor(rand() * items.length) % items.length];
const between = (min, max) => min + rand() * (max - min);
const intBetween = (min, max) => Math.round(between(min, max));
const chance = (probability) => rand() < probability;

// `DEMO_PASSWORD` and `DEMO_CLASSROOM_NAME` are imported from `./demo.js` and
// re-exported here, so anything that already imports them from the seed keeps
// working while the single definition lives somewhere with no import cycle.
export { DEMO_CLASSROOM_NAME, DEMO_PASSWORD };

const SCHOOL = { name: 'Riverside Secondary School' };

const GRADES = [
  { level: 7, name: 'Grade 7' },
  { level: 8, name: 'Grade 8' },
  { level: 9, name: 'Grade 9' },
  { level: 10, name: 'Grade 10' },
];

/**
 * Classroom plan. `adherence` is the historical completion rate the generator
 * aims for in the most recent week, which produces the rollup used throughout the
 * product docs: Grade 7 ≈ 91%, Grade 8 ≈ 76%, Grade 9 ≈ 68%, Grade 10 ≈ 63%.
 *
 * `visualLoad` does two things: it scales how often a refused break lets the
 * stretch run long, and it biases the baseline stretch upward, so screen-intensive
 * Computing rooms rise to the top of the "highest visual load" ranking — which is
 * what a school would actually expect to see.
 *
 * `periodDensity` is how often the room is timetabled in a day. Computing rooms
 * are busier than the others, which is why they carry most of the school's breaks.
 */
const CLASSROOMS = [
  { grade: 7, name: 'Room 112 — Science', subject: 'Science', seats: 12, adherence: 0.91, visualLoad: 0.04, periodDensity: 0.42, teacher: 'lindqvist' },
  { grade: 7, name: 'Room 114 — Humanities', subject: 'Humanities', seats: 12, adherence: 0.9, visualLoad: 0.04, periodDensity: 0.44, teacher: 'lindqvist' },
  { grade: 8, name: DEMO_CLASSROOM_NAME, subject: 'Computer Science', seats: 12, adherence: 0.84, visualLoad: 0.2, periodDensity: 0.46, teacher: 'avery' },
  { grade: 8, name: 'Room 210 — Mathematics', subject: 'Mathematics', seats: 12, adherence: 0.69, visualLoad: 0.06, periodDensity: 0.44, teacher: 'avery' },
  { grade: 9, name: 'Room 305 — Computer Science', subject: 'Computer Science', seats: 11, adherence: 0.66, visualLoad: 0.26, periodDensity: 0.52, teacher: 'okafor' },
  { grade: 9, name: 'Room 307 — Design & Technology', subject: 'Design & Technology', seats: 10, adherence: 0.7, visualLoad: 0.12, periodDensity: 0.48, teacher: 'okafor' },
  { grade: 10, name: 'Room 401 — Computer Science', subject: 'Computer Science', seats: 12, adherence: 0.6, visualLoad: 0.3, periodDensity: 0.56, teacher: 'moreau' },
  { grade: 10, name: 'Room 403 — Media Studies', subject: 'Media Studies', seats: 11, adherence: 0.65, visualLoad: 0.16, periodDensity: 0.5, teacher: 'moreau' },
];

/**
 * How many weeks of lesson history to generate, and how much worse the oldest
 * week was. A flat history would make the school trend chart a straight line and
 * hide whether the product is looking at real behaviour change; a mild documented
 * ramp (older weeks worse) gives the trend something true to show.
 */
const HISTORY_WEEKS = 4;
const ADHERENCE_RAMP = [0.86, 0.9, 0.95, 1]; // oldest → most recent

const TEACHERS = [
  { username: 'teacher.avery', displayName: 'Ms. Avery', title: 'Computing teacher', access: [DEMO_CLASSROOM_NAME, 'Room 210 — Mathematics'] },
  { username: 'teacher.okafor', displayName: 'Mr. Okafor', title: 'Design & Technology teacher', access: ['Room 305 — Computer Science', 'Room 307 — Design & Technology'] },
  { username: 'teacher.lindqvist', displayName: 'Ms. Lindqvist', title: 'Science teacher', access: ['Room 112 — Science', 'Room 114 — Humanities'] },
  { username: 'teacher.moreau', displayName: 'Mr. Moreau', title: 'Media & Computing teacher', access: ['Room 401 — Computer Science', 'Room 403 — Media Studies'] },
];

const ADMINS = [{ username: 'admin.rivera', displayName: 'Principal Rivera', title: 'School administrator' }];

/** School-admin-configurable Focus Mode catalog — the extensible allowlist. */
const FOCUS_CATALOG = [
  { name: 'School LMS', domain: 'lms.riverside.example.edu', category: 'Core learning', description: 'Assignments, resources and grades.', defaultAllowed: true },
  { name: 'Google Docs', domain: 'docs.google.com', category: 'Productivity', description: 'Documents, sheets and slides.', defaultAllowed: true },
  { name: 'Online IDE', domain: 'ide.riverside.example.edu', category: 'Computing', description: 'In-browser coding environment for CS lessons.', defaultAllowed: true },
  { name: 'Research database', domain: 'research.riverside.example.edu', category: 'Reference', description: 'School-subscribed reference library.', defaultAllowed: false },
  { name: 'Classroom quizzes', domain: 'quiz.riverside.example.edu', category: 'Assessment', description: 'Low-stakes in-class quizzes.', defaultAllowed: false },
  { name: 'School email', domain: 'mail.riverside.example.edu', category: 'Communication', description: 'Staff and student mail.', defaultAllowed: false },
  { name: 'Typing tutor', domain: 'typing.riverside.example.edu', category: 'Practice', description: 'Keyboard skills practice.', defaultAllowed: false },
  { name: 'Khan Academy', domain: 'khanacademy.org', category: 'Reference', description: 'Mathematics and science lessons.', defaultAllowed: false },
];

/** Lessons a computer room typically runs in a school day. */
const PERIODS = [
  { start: [8, 50], end: [9, 40] },
  { start: [9, 50], end: [10, 40] },
  { start: [11, 0], end: [11, 50] },
  { start: [12, 40], end: [13, 30] },
  { start: [13, 40], end: [14, 30] },
  { start: [14, 40], end: [15, 30] },
];

const INSTRUCTION_KEYS = ['farthest-object', 'window-distance', 'far-wall', 'farthest-point', 'opposite-corner', 'ceiling-distance'];

const atTime = (dayStartMs, [hours, minutes]) => dayStartMs + hours * HOUR + minutes * MINUTE;

function wipe() {
  const tables = [
    'focus_session_resources',
    'focus_sessions',
    'focus_resources',
    'attention_broadcasts',
    'break_events',
    'seat_sessions',
    'lesson_sessions',
    'weekly_reports',
    'teacher_classrooms',
    'auth_tokens',
    'audit_log',
    'seats',
    'classrooms',
    'grades',
    'users',
    'schools',
  ];
  for (const table of tables) run(`DELETE FROM ${table}`);
}

function addTotals(a, b) {
  return {
    sessions: a.sessions + b.sessions,
    recommended: a.recommended + b.recommended,
    completed: a.completed + b.completed,
    longSessions: a.longSessions + b.longSessions,
  };
}

/**
 * One classroom's history for one school day: several lesson periods, each with
 * its own seat sessions and every break the cadence would have asked for.
 */
function seedDay({ classroom, seats, dayStart, adherence, visualLoad, periodDensity, intervalMin, durationSec, longSessionMin, cutoffMs }) {
  // ~2.7 periods a day for a 12-workstation room: about 140 seat sessions across a
  // five-day week, which is the worked example the product docs use.
  const periods = PERIODS.filter(() => chance(periodDensity)).slice(0, 4);
  if (periods.length === 0) periods.push(PERIODS[1]);
  const usedSeats = seats.filter(() => chance(0.88));
  // Screen-intensive rooms take their breaks later even when they do take them.
  const stretchBiasSec = Math.round(visualLoad * 60 * 25);

  let totals = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };

  for (const period of periods) {
    const startAt = atTime(dayStart, period.start);
    const endAt = atTime(dayStart, period.end);
    if (startAt > cutoffMs) continue;

    const lessonId = makeId('les');
    run(
      `INSERT INTO lesson_sessions (id, classroom_id, grade_id, school_id, teacher_id, subject, started_at, ended_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ended')`,
      [
        lessonId,
        classroom.id,
        classroom.grade_id,
        classroom.school_id,
        classroom.teacher_id,
        classroom.subject,
        startAt,
        Math.min(endAt, cutoffMs),
      ],
    );

    for (const seat of usedSeats) {
      const joinAt = startAt + intBetween(0, 3) * MINUTE;
      const leaveAt = Math.min(endAt - intBetween(0, 4) * MINUTE, cutoffMs);
      if (leaveAt - joinAt < 10 * MINUTE) continue;

      const seatSessionId = makeId('ses');
      run(
        `INSERT INTO seat_sessions (id, seat_id, classroom_id, grade_id, school_id, lesson_session_id,
                                    started_at, ended_at, active_seconds, resumed_at, state, last_heartbeat_at, last_break_at, agent_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ended', ?, ?, ?)`,
        [
          seatSessionId,
          seat.id,
          classroom.id,
          classroom.grade_id,
          classroom.school_id,
          lessonId,
          joinAt,
          leaveAt,
          Math.round(between(0.82, 0.97) * ((leaveAt - joinAt) / 1000)),
          leaveAt,
          leaveAt,
          `chrome-kiosk/1.${intBetween(0, 9)}`,
        ],
      );
      totals.sessions += 1;

      let dueAt = joinAt + intervalMin * MINUTE;
      // The stretch that triggers a break is the time since the last *completed*
      // break, so a refused break makes the next one longer — which is exactly how
      // a real "long visual session" happens, and what the metric counts.
      let stretchSec = Math.round(intervalMin * 60 + stretchBiasSec + between(-45, 60));
      let wrongInARow = 0;

      while (dueAt < leaveAt) {
        // After three refusals the next break is always taken — no student in the
        // data is a lost cause, which also keeps the generated world believable.
        const isCompleted = chance(adherence) || wrongInARow >= 3;
        const status = isCompleted ? 'completed' : chance(0.62) ? 'missed' : 'skipped';
        // When the overlay goes up says as much as whether it was finished: a
        // completed break can still have been taken minutes late, and a refused one
        // may have been opened and abandoned. Both show up as "taken late".
        const lateStart = chance(0.22) ? intBetween(60, 200) * 1000 : intBetween(0, 8) * 1000;
        const startedAt = isCompleted || chance(0.55) ? dueAt + lateStart : null;
        const resolvedAt = dueAt + (isCompleted ? durationSec * 1000 + intBetween(-1200, 2500) : intBetween(5, 90) * 1000);

        if (stretchSec >= longSessionMin * 60) totals.longSessions += 1;
        totals.recommended += 1;
        if (isCompleted) totals.completed += 1;
        wrongInARow = isCompleted ? 0 : wrongInARow + 1;

        run(
          `INSERT INTO break_events (id, seat_id, seat_session_id, lesson_session_id, classroom_id, grade_id, school_id,
                                     due_at, started_at, resolved_at, completed_at, duration_sec, stretch_sec, status,
                                     instruction_key, warning_5min_at, warning_1min_at, warned_late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            makeId('brk'),
            seat.id,
            seatSessionId,
            lessonId,
            classroom.id,
            classroom.grade_id,
            classroom.school_id,
            dueAt,
            startedAt,
            resolvedAt,
            status === 'completed' ? resolvedAt : null,
            durationSec,
            stretchSec,
            status,
            pick(INSTRUCTION_KEYS),
            dueAt - 5 * MINUTE <= joinAt ? null : dueAt - 5 * MINUTE,
            dueAt - MINUTE <= joinAt ? null : dueAt - MINUTE,
          ],
        );

        dueAt = resolvedAt + intervalMin * MINUTE;
        stretchSec = isCompleted
          ? Math.round(intervalMin * 60 + stretchBiasSec + between(-45, 60))
          : // The screen stayed on: the next break inherits this stretch plus a full
            // interval, with higher-load rooms drifting further past the limit.
            Math.round(stretchSec + intervalMin * 60 + between(-30, 240) + (chance(visualLoad) ? intBetween(4, 16) * 60 : 0));
      }
    }
  }

  return totals;
}

/**
 * The lesson in progress right now. Three seats carry a scripted history so the
 * Attention Needed panel has something in it the moment the dashboard opens:
 * PC-05 has dropped offline, PC-08 has missed two breaks in a row, and PC-03 is
 * on a long uninterrupted stretch with a break twenty seconds away.
 */
function seedLiveLesson({ classroom, seats, intervalMin, durationSec, longSessionMin }) {
  const liveStart = Math.max(startOfLocalDay(now()) + 8 * HOUR, now() - 22 * MINUTE);
  const lessonId = makeId('les');
  run(
    `INSERT INTO lesson_sessions (id, classroom_id, grade_id, school_id, teacher_id, subject, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live')`,
    [lessonId, classroom.id, classroom.grade_id, classroom.school_id, classroom.teacher_id, classroom.subject, liveStart],
  );

  const offlineIndex = 4;
  const repeatMissIndex = 7;
  const longStretchIndex = 2;

  seats.forEach((seat, index) => {
    const seatSessionId = makeId('ses');
    const isOffline = index === offlineIndex;
    const lastHeartbeat = isOffline ? now() - 4 * MINUTE : now() - intBetween(1, 4) * 1000;
    // Exactly one seat is mid-way through a stretch long enough to be flagged, so
    // the amber state is visible on first load. Every other seat is somewhere
    // normal in its own cadence — otherwise the Attention panel would list the
    // whole room and tell a teacher nothing.
    const anchor =
      index === longStretchIndex
        ? now() - (longSessionMin + 3) * MINUTE
        : now() - intBetween(20, Math.max(45, intervalMin * 60 - 25)) * 1000;

    run(
      `INSERT INTO seat_sessions (id, seat_id, classroom_id, grade_id, school_id, lesson_session_id,
                                  started_at, active_seconds, resumed_at, state, last_heartbeat_at, last_break_at, agent_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 'chrome-kiosk/1.4')`,
      [
        seatSessionId,
        seat.id,
        classroom.id,
        classroom.grade_id,
        classroom.school_id,
        lessonId,
        liveStart,
        Math.max(0, Math.round((anchor - liveStart) / 1000)),
        anchor,
        lastHeartbeat,
      ],
    );

    const history = [];
    if (index === repeatMissIndex) history.push('missed', 'missed');
    if (index === longStretchIndex) history.push('completed');
    if (index % 5 === 1) history.push('completed');
    if (index % 7 === 3) history.push('skipped');

    let cursor = liveStart + intervalMin * MINUTE;
    for (const status of history) {
      run(
        `INSERT INTO break_events (id, seat_id, seat_session_id, lesson_session_id, classroom_id, grade_id, school_id,
                                   due_at, started_at, resolved_at, completed_at, duration_sec, stretch_sec, status,
                                   instruction_key, warning_5min_at, warning_1min_at, warned_late)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          makeId('brk'),
          seat.id,
          seatSessionId,
          lessonId,
          classroom.id,
          classroom.grade_id,
          classroom.school_id,
          cursor,
          status === 'missed' ? null : cursor + 2000,
          cursor + 30_000,
          status === 'completed' ? cursor + 30_000 : null,
          durationSec,
          (index === longStretchIndex ? longSessionMin + 4 : intervalMin) * 60,
          status,
          pick(INSTRUCTION_KEYS),
          cursor - 5 * MINUTE,
          cursor - MINUTE,
        ],
      );
      cursor += intervalMin * MINUTE;
    }

    // The break each seat is working towards. The long-stretch seat's break is due
    // in ~20s so both the amber flag and the overlay are reachable in a walkthrough.
    const dueAt =
      index === longStretchIndex
        ? now() + 20_000
        : index === repeatMissIndex
          ? now() + 45_000
          : now() + intBetween(30, Math.max(60, intervalMin * 60 - 20)) * 1000;
    run(
      `INSERT INTO break_events (id, seat_id, seat_session_id, lesson_session_id, classroom_id, grade_id, school_id,
                                 due_at, duration_sec, stretch_sec, status, warned_late)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', 0)`,
      [
        makeId('brk'),
        seat.id,
        seatSessionId,
        lessonId,
        classroom.id,
        classroom.grade_id,
        classroom.school_id,
        isOffline ? now() + 10 * MINUTE : dueAt,
        durationSec,
      ],
    );

    run('UPDATE seat_sessions SET last_break_at = ? WHERE id = ? AND last_break_at IS NULL', [cursor, seatSessionId]);
  });

  return { lessonId, offlineIndex, repeatMissIndex, longStretchIndex };
}

export async function seedDatabase({ force = false, demo = config.demoMode } = {}) {
  const existing = Number(get('SELECT COUNT(*) AS count FROM classrooms').count);
  if (existing > 0 && !force) {
    return { skipped: true, reason: 'database already contains data (pass --force to reseed)', classrooms: existing };
  }

  const summary = tx(() => {
    if (force) wipe();

    const schoolId = makeId('sch');
    const createdAt = now();
    run('INSERT INTO schools (id, name, created_at) VALUES (?, ?, ?)', [schoolId, SCHOOL.name, createdAt]);

    const gradeIds = new Map();
    for (const grade of GRADES) {
      const id = makeId('grd');
      run('INSERT INTO grades (id, school_id, name, level) VALUES (?, ?, ?, ?)', [id, schoolId, grade.name, grade.level]);
      gradeIds.set(grade.level, id);
    }

    // One shared credential hash for the seeded accounts: these are demo logins,
    // and docs/DEPLOYMENT.md says plainly that they must be replaced.
    const { hash: passwordHash, salt: passwordSalt } = hashPassword(DEMO_PASSWORD);
    const teacherIds = new Map();
    for (const teacher of TEACHERS) {
      const id = makeId('tch');
      run(
        `INSERT INTO users (id, school_id, role, display_name, title, username, password_hash, password_salt, created_at)
         VALUES (?, ?, 'teacher', ?, ?, ?, ?, ?, ?)`,
        [id, schoolId, teacher.displayName, teacher.title, teacher.username, passwordHash, passwordSalt, createdAt],
      );
      teacherIds.set(teacher.username, id);
      // Plans reference teachers by short name ("avery"), accounts by login
      // ("teacher.avery"); index both so a classroom plan cannot silently miss.
      teacherIds.set(teacher.username.replace(/^teacher\./, ''), id);
    }
    for (const admin of ADMINS) {
      run(
        `INSERT INTO users (id, school_id, role, display_name, title, username, password_hash, password_salt, created_at)
         VALUES (?, ?, 'admin', ?, ?, ?, ?, ?, ?)`,
        [makeId('adm'), schoolId, admin.displayName, admin.title, admin.username, passwordHash, passwordSalt, createdAt],
      );
    }

    for (const resource of FOCUS_CATALOG) {
      run(
        `INSERT INTO focus_resources (id, school_id, name, domain, category, description, default_allowed, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          makeId('res'),
          schoolId,
          resource.name,
          resource.domain,
          resource.category,
          resource.description,
          resource.defaultAllowed ? 1 : 0,
          createdAt,
        ],
      );
    }

    const classroomRows = [];
    for (const plan of CLASSROOMS) {
      const id = makeId('cls');
      const isDemoRoom = plan.name === DEMO_CLASSROOM_NAME;
      // Only the walkthrough room runs at the accelerated cadence; every other room
      // keeps the product default of a break every 20 minutes.
      const timings = demo && isDemoRoom ? { ...CLASSROOM_DEFAULTS, ...DEMO_TIMINGS } : CLASSROOM_DEFAULTS;
      run(
        `INSERT INTO classrooms (id, school_id, grade_id, name, subject, break_interval_min, break_duration_sec,
                                 warn_lead_5min, warn_lead_1min, long_session_min, missed_break_grace_sec,
                                 offline_after_sec, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        [
          id,
          schoolId,
          gradeIds.get(plan.grade),
          plan.name,
          plan.subject,
          timings.breakIntervalMin,
          timings.breakDurationSec,
          timings.longSessionMin,
          timings.missedBreakGraceSec,
          timings.offlineAfterSec,
          createdAt,
        ],
      );

      const seats = [];
      for (let index = 1; index <= plan.seats; index += 1) {
        const seatId = makeId('seat');
        const label = `PC-${String(index).padStart(2, '0')}`;
        run(
          `INSERT INTO seats (id, classroom_id, label, seat_index, agent_token, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [seatId, id, label, index, makeToken(18), createdAt, createdAt],
        );
        seats.push({ id: seatId, label, seat_index: index });
      }

      const teacherId = teacherIds.get(plan.teacher);
      run('INSERT INTO teacher_classrooms (teacher_id, classroom_id) VALUES (?, ?)', [teacherId, id]);

      classroomRows.push({
        id,
        name: plan.name,
        subject: plan.subject,
        grade_id: gradeIds.get(plan.grade),
        school_id: schoolId,
        teacher_id: teacherId,
        break_interval_min: timings.breakIntervalMin,
        break_duration_sec: timings.breakDurationSec,
        long_session_min: timings.longSessionMin,
        seats,
        plan,
      });
    }

    // ---- History: the last four complete Mon–Fri weeks, then today up to now.
    const todayStart = startOfLocalDay(now());
    /*
     * The Monday of the most recent Mon–Fri that has actually finished.
     *
     * This mirrors `weekRange(mode: 'last-complete')` exactly, and it has to: a
     * report for "last complete week" reads *this* week, so if the seeded history
     * is anchored anywhere else the report is empty.
     *
     * The bug this replaces was `startOfLocalWeek(now() - 7 * DAY)`, which is the
     * previous week unconditionally. Those two agree only when today is a weekend:
     *    Sat/Sun → most recent finished Mon–Fri is this week's   → same answer
     *    Mon–Fri → most recent finished Mon–Fri is *last* week's → off by one week
     * So seeding on a weekday produced four weeks of history ending a week earlier
     * than every "last complete week" window the app asks for, and the weekly
     * report — which prefers the stored snapshot — rendered zeros across the board.
     * Verified: with today = Sunday, the report window is Mon 28 Sep – Fri 2 Oct,
     * and the old anchor placed the whole seeded history in the week before it.
     */
    const currentMonday = startOfLocalWeek(now());
    const lastCompleteMonday =
      now() < currentMonday + 5 * DAY ? currentMonday - 7 * DAY : currentMonday;
    const totals = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };
    const historyTotals = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };
    const perClassroom = [];

    for (const classroom of classroomRows) {
      // Historical cadence stays at the product default so the weekly report reads
      // like a real school week even when the walkthrough room is running fast.
      const shared = {
        classroom,
        seats: classroom.seats,
        visualLoad: classroom.plan.visualLoad,
        periodDensity: classroom.plan.periodDensity,
        intervalMin: CLASSROOM_DEFAULTS.breakIntervalMin,
        durationSec: CLASSROOM_DEFAULTS.breakDurationSec,
        longSessionMin: CLASSROOM_DEFAULTS.longSessionMin,
      };

      let newestWeek = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };
      let allWeeks = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };

      for (let weekIndex = 0; weekIndex < HISTORY_WEEKS; weekIndex += 1) {
        // weekIndex 0 is the oldest week; the last one is the most recent complete week.
        const weeksAgo = HISTORY_WEEKS - 1 - weekIndex;
        const weekStart = lastCompleteMonday - weeksAgo * 7 * DAY;
        const adherence = Math.min(0.98, classroom.plan.adherence * ADHERENCE_RAMP[weekIndex]);
        let weekTotals = { sessions: 0, recommended: 0, completed: 0, longSessions: 0 };
        for (let dayIndex = 0; dayIndex < 5; dayIndex += 1) {
          const dayStart = weekStart + dayIndex * DAY;
          if (dayStart > now()) continue;
          weekTotals = addTotals(weekTotals, seedDay({ ...shared, adherence, dayStart, cutoffMs: now() }));
        }
        allWeeks = addTotals(allWeeks, weekTotals);
        if (weeksAgo === 0) newestWeek = weekTotals;
      }

      // Today, up to 25 minutes ago — the live lesson supplies the rest, so the
      // dashboard's "Today" window is populated without double-counting.
      const todayTotals = seedDay({
        ...shared,
        adherence: classroom.plan.adherence,
        dayStart: todayStart,
        cutoffMs: now() - 25 * MINUTE,
      });

      // `totals` is quoted as the weekly-report example, so it covers the most
      // recent complete week plus today — not all four weeks.
      const current = addTotals(newestWeek, todayTotals);
      totals.sessions += current.sessions;
      totals.recommended += current.recommended;
      totals.completed += current.completed;
      totals.longSessions += current.longSessions;
      historyTotals.sessions += allWeeks.sessions;
      historyTotals.recommended += allWeeks.recommended;
      historyTotals.completed += allWeeks.completed;
      historyTotals.longSessions += allWeeks.longSessions;

      perClassroom.push({
        name: classroom.name,
        subject: classroom.subject,
        adherenceTarget: classroom.plan.adherence,
        lastCompleteWeek: newestWeek,
        today: todayTotals,
        allWeeks,
      });
    }

    const demoClassroom = classroomRows.find((classroom) => classroom.name === DEMO_CLASSROOM_NAME) ?? classroomRows[0];
    const live = seedLiveLesson({
      classroom: demoClassroom,
      seats: demoClassroom.seats,
      intervalMin: demoClassroom.break_interval_min,
      durationSec: demoClassroom.break_duration_sec,
      longSessionMin: demoClassroom.long_session_min,
    });

    return {
      schoolName: SCHOOL.name,
      schoolId,
      demoClassroomId: demoClassroom.id,
      demoClassroomName: demoClassroom.name,
      demoSeatLabels: demoClassroom.seats.map((seat) => seat.label),
      liveLessonId: live.lessonId,
      totals,
      historyTotals,
      historyWeeks: HISTORY_WEEKS,
      perClassroom,
      classrooms: classroomRows.length,
      seats: classroomRows.reduce((total, classroom) => total + classroom.seats.length, 0),
      demoPassword: DEMO_PASSWORD,
      demoMode: demo,
      todayKey: localDayKey(now()),
    };
  });

  // Monday's job, run once at seed time so the report page has a stored snapshot to
  // read from and the "weekly job" path is exercised end to end.
  const stored = [];
  for (const classroom of getClassroomsForSeed()) {
    try {
      const report = generateWeeklyReport({ classroomId: classroom.id, atMs: now(), mode: 'last-complete', store: true });
      stored.push({ classroomName: classroom.name, weekLabel: report.range.label, adherence: report.totals.breakAdherence });
    } catch (error) {
      console.warn('[seed] weekly report failed for', classroom.name, error.message);
    }
  }
  summary.weeklyReports = stored;

  return summary;
}

function getClassroomsForSeed() {
  return all('SELECT id, name FROM classrooms ORDER BY name');
}

/** CLI entry: `npm run seed` / `npm run seed:demo`. */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');
  const demo = args.includes('--demo') || config.demoMode;
  const summary = await seedDatabase({ force, demo });

  if (summary.skipped) {
    console.log('[seed] nothing to do:', summary.reason);
    console.log('[seed] re-run with --force to wipe and reseed.');
    return;
  }

  console.log('');
  console.log(`  Seeded ${summary.schoolName}`);
  console.log(`  ${summary.classrooms} classrooms · ${summary.seats} workstations`);
  console.log('');
  console.log('  Weekly report example (last complete Mon–Fri, all classrooms):');
  console.log(`    Computer sessions   ${summary.totals.sessions}`);
  console.log(`    Recommended breaks  ${summary.totals.recommended}`);
  console.log(`    Completed breaks    ${summary.totals.completed}`);
  console.log(`    Break adherence     ${Math.round((summary.totals.completed / Math.max(1, summary.totals.recommended)) * 100)}%`);
  console.log(`    Long visual sessions ${summary.totals.longSessions}`);
  console.log('');
  console.log('  Demo classroom:', summary.demoClassroomName);
  console.log('  Sign in with:');
  console.log(`    teacher.avery / ${summary.demoPassword}   (${summary.demoClassroomName}, Room 210 — Mathematics)`);
  console.log(`    admin.rivera  / ${summary.demoPassword}   (school analytics, aggregate only)`);
  console.log('');
  console.log('  Device agent: open the web app and choose "Classroom PC", or use the');
  console.log('  enrolment URLs listed on the teacher dashboard.');
  console.log('');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then(() => {
      closeDatabase();
      process.exit(0);
    })
    .catch((error) => {
      console.error('[seed] failed', error);
      process.exit(1);
    });
}

export default seedDatabase;
