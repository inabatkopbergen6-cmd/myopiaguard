import { all, get, openDatabase, run, setDb, tx } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { makeId, makeToken } from '../src/lib/ids.js';

/**
 * Fixture builder for tests: one school, one grade, one classroom and N seats —
 * the smallest world in which a lesson and a break can happen. Everything is
 * written with explicit timestamps so a test never depends on the wall clock.
 */
export function createFixture({ dbPath = ':memory:', intervalMin = 20, longSessionMin = 45, seats = 2 } = {}) {
  const db = openDatabase(dbPath);
  setDb(db);

  const at = 1_700_000_000_000; // fixed epoch for determinism
  const ids = {
    school: makeId('sch'),
    grade: makeId('grd'),
    classroom: makeId('cls'),
    teacher: makeId('tch'),
    admin: makeId('adm'),
  };

  tx(() => {
    run('INSERT INTO schools (id, name, created_at) VALUES (?, ?, ?)', [ids.school, 'Test School', at]);
    run('INSERT INTO grades (id, school_id, name, level) VALUES (?, ?, ?, ?)', [
      ids.grade,
      ids.school,
      'Grade 8',
      8,
    ]);
    run(
      `INSERT INTO classrooms (id, school_id, grade_id, name, subject, break_interval_min, break_duration_sec,
                               warn_lead_5min, warn_lead_1min, long_session_min, missed_break_grace_sec,
                               offline_after_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 20, 1, 1, ?, 120, 15, ?)`,
      [ids.classroom, ids.school, ids.grade, 'Room T1', 'Computer Science', intervalMin, longSessionMin, at],
    );
    const { hash, salt } = hashPassword('test-password');
    for (const [id, role, username] of [
      [ids.teacher, 'teacher', 'teacher.test'],
      [ids.admin, 'admin', 'admin.test'],
    ]) {
      run(
        `INSERT INTO users (id, school_id, role, display_name, title, username, password_hash, password_salt, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [id, ids.school, role, role === 'teacher' ? 'Test Teacher' : 'Test Admin', username, hash, salt, at],
      );
    }
    run('INSERT INTO teacher_classrooms (teacher_id, classroom_id) VALUES (?, ?)', [ids.teacher, ids.classroom]);
  });

  const seatRows = [];
  for (let index = 1; index <= seats; index += 1) {
    const id = makeId('seat');
    const label = `PC-${String(index).padStart(2, '0')}`;
    const token = makeToken(12);
    run(
      `INSERT INTO seats (id, classroom_id, label, seat_index, agent_token, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, ids.classroom, label, index, token, at],
    );
    seatRows.push({ id, label, token });
  }

  const classroom = get('SELECT * FROM classrooms WHERE id = ?', [ids.classroom]);

  return {
    at,
    ids,
    classroom,
    seats: seatRows,
    seat: seatRows[0],
    teacherUsername: 'teacher.test',
    adminUsername: 'admin.test',
    password: 'test-password',
    emptyBreakCount: () => Number(get('SELECT COUNT(*) AS count FROM break_events').count),
    allBreaks: () => all('SELECT * FROM break_events ORDER BY due_at'),
    allSeatSessions: () => all('SELECT * FROM seat_sessions'),
  };
}

/** Records everything the scheduler pushes, so tests can assert on delivery. */
export function stubHub() {
  const messages = [];
  const record = (room) => (target, type, payload) => {
    messages.push({ room: `${room}:${target}`, type, payload });
    return 1;
  };
  return {
    messages,
    ofType(type) {
      return messages.filter((message) => message.type === type);
    },
    toSeat: record('seat'),
    toClassroom: record('classroom'),
    toSchool: record('school'),
    broadcast: () => 1,
    close() {},
  };
}
