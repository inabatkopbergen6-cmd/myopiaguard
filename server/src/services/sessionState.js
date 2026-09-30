import { all, get, run, tx } from '../db.js';
import { makeId } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { activeStretchSeconds, computeNextBreakDue, OPEN_STATUSES, RESOLVED_STATUSES } from './breaks.js';

/**
 * Seat-session lifecycle.
 *
 * Every state change that affects the break clock happens here, and only here, so
 * there is exactly one definition of "the student is working" versus "the student
 * is resting". Both the agent routes and the scheduler drive these functions;
 * neither writes schedule columns directly.
 *
 * The accumulator model: `active_seconds` holds time banked from finished
 * stretches while `resumed_at` anchors the stretch in progress. Pausing (a break
 * going up, or the agent going away) banks the stretch and clears the anchor, so
 * no figure depends on a ticking counter and nothing drifts over a lesson.
 */

export const DEFAULT_CLASSROOM = Object.freeze({
  break_interval_min: 20,
  break_duration_sec: 20,
  warn_lead_5min: 1,
  warn_lead_1min: 1,
  long_session_min: 45,
  missed_break_grace_sec: 120,
  offline_after_sec: 15,
});

export function getClassroom(id) {
  return get('SELECT * FROM classrooms WHERE id = ?', [id]);
}

export function classroomConfig(classroomId) {
  return { ...DEFAULT_CLASSROOM, ...(getClassroom(classroomId) ?? {}) };
}

export function getLessonSession(id) {
  return get('SELECT * FROM lesson_sessions WHERE id = ?', [id]);
}

export function getLiveLessonSession(classroomId) {
  return get(
    `SELECT * FROM lesson_sessions
      WHERE classroom_id = ? AND status = 'live'
      ORDER BY started_at DESC LIMIT 1`,
    [classroomId],
  );
}

export function getSeatSessionById(id) {
  return get('SELECT * FROM seat_sessions WHERE id = ?', [id]);
}

export function getLiveSeatSession(seatId) {
  return get(
    `SELECT * FROM seat_sessions
      WHERE seat_id = ? AND state != 'ended'
      ORDER BY started_at DESC LIMIT 1`,
    [seatId],
  );
}

export function getOpenBreak(seatSessionId) {
  return get(
    `SELECT * FROM break_events
      WHERE seat_session_id = ? AND status IN ('pending', 'in_progress')
      ORDER BY due_at LIMIT 1`,
    [seatSessionId],
  );
}

export function getBreakEvent(id) {
  return get('SELECT * FROM break_events WHERE id = ?', [id]);
}

export function getLastResolvedBreak(seatSessionId) {
  return get(
    `SELECT * FROM break_events
      WHERE seat_session_id = ? AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC LIMIT 1`,
    [seatSessionId],
  );
}

function accrueActiveSeconds(seatSession, atMs) {
  return Number(seatSession.active_seconds ?? 0) + activeStretchSeconds(seatSession, atMs);
}

/** Opens (or reuses) the live lesson session for a classroom. */
export function startLessonSession({ classroom, teacherId, subject = null, atMs = now() }) {
  const existing = getLiveLessonSession(classroom.id);
  if (existing) return existing;
  const id = makeId('les');
  run(
    `INSERT INTO lesson_sessions (id, classroom_id, grade_id, school_id, teacher_id, subject, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live')`,
    [id, classroom.id, classroom.grade_id, classroom.school_id, teacherId, subject ?? classroom.subject, atMs],
  );
  return getLessonSession(id);
}

/** Ends a lesson: every participating seat session is closed and cleared. */
export function endLessonSession(lessonSessionId, atMs = now(), reason = 'lesson ended') {
  return tx(() => {
    run(`UPDATE lesson_sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'live'`, [
      atMs,
      lessonSessionId,
    ]);
    const open = all(`SELECT * FROM seat_sessions WHERE lesson_session_id = ? AND state != 'ended'`, [
      lessonSessionId,
    ]);
    for (const seatSession of open) {
      closeSeatSession(seatSession, atMs, reason);
    }
    return getLessonSession(lessonSessionId);
  });
}

/**
 * Creates the pending break row for the stretch that is currently running.
 *
 * Creating the row *before* the break comes due is what lets the 5-minute and
 * 1-minute warnings attach to a real recommendation, and what lets the dashboard
 * count down to a break it already knows about.
 */
export function scheduleNextBreak(seatSession, classroom, atMs = now(), { minLeadMs = 30_000 } = {}) {
  const last = getLastResolvedBreak(seatSession.id);
  const baseAt = last?.resolved_at ?? seatSession.started_at;
  const { dueAt, lateAdjusted } = computeNextBreakDue({
    baseAt,
    intervalMin: classroom.break_interval_min ?? DEFAULT_CLASSROOM.break_interval_min,
    atMs,
    minLeadMs,
  });
  const id = makeId('brk');
  run(
    `INSERT INTO break_events (id, seat_id, seat_session_id, lesson_session_id, classroom_id, grade_id, school_id,
                               due_at, duration_sec, stretch_sec, status, warned_late)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
    [
      id,
      seatSession.seat_id,
      seatSession.id,
      seatSession.lesson_session_id,
      seatSession.classroom_id,
      seatSession.grade_id,
      seatSession.school_id,
      dueAt,
      classroom.break_duration_sec ?? DEFAULT_CLASSROOM.break_duration_sec,
      lateAdjusted ? 1 : 0,
    ],
  );
  return getBreakEvent(id);
}

/** A device agent announcing itself. Opens a seat session when a lesson is live. */
export function startSeatSession({ seat, lessonSession, agentVersion = null, atMs = now() }) {
  return tx(() => {
    const live = getLiveSeatSession(seat.id);
    if (live && live.lesson_session_id === lessonSession.id) {
      run('UPDATE seat_sessions SET last_heartbeat_at = ?, agent_version = COALESCE(?, agent_version) WHERE id = ?', [
        atMs,
        agentVersion,
        live.id,
      ]);
      return getSeatSessionById(live.id);
    }
    if (live && live.lesson_session_id !== lessonSession.id) {
      closeSeatSession(live, atMs, 'superseded by a new lesson session');
    }

    const id = makeId('ses');
    run(
      `INSERT INTO seat_sessions (id, seat_id, classroom_id, grade_id, school_id, lesson_session_id,
                                  started_at, active_seconds, resumed_at, state, last_heartbeat_at, agent_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
      [
        id,
        seat.id,
        seat.classroom_id,
        seat.grade_id,
        seat.school_id,
        lessonSession.id,
        atMs,
        atMs,
        atMs,
        agentVersion,
      ],
    );
    const seatSession = getSeatSessionById(id);
    // minLeadMs 0: the first stretch starts now, so the full interval applies.
    scheduleNextBreak(seatSession, classroomConfig(seat.classroom_id), atMs, { minLeadMs: 0 });
    return getSeatSessionById(id);
  });
}

export function touchHeartbeat(seatSessionId, atMs = now(), { agentVersion = null } = {}) {
  const seatSession = getSeatSessionById(seatSessionId);
  if (!seatSession || seatSession.state === 'ended') return seatSession;

  const classroom = classroomConfig(seatSession.classroom_id);
  const wasStale = atMs - Number(seatSession.last_heartbeat_at) > Number(classroom.offline_after_sec) * 1000;

  run(
    `UPDATE seat_sessions SET last_heartbeat_at = ?, agent_version = COALESCE(?, agent_version) WHERE id = ?`,
    [atMs, agentVersion, seatSessionId],
  );

  // A seat that was away gets its cadence re-anchored instead of being handed an
  // instantly-overdue break the second it reconnects.
  if (wasStale && seatSession.state === 'active') {
    const open = getOpenBreak(seatSessionId);
    if (open && open.status === 'pending' && Number(open.due_at) < atMs) {
      run('UPDATE break_events SET due_at = ?, warned_late = 1, warning_5min_at = NULL, warning_1min_at = NULL WHERE id = ?', [
        atMs + 30_000,
        open.id,
      ]);
    } else if (!open) {
      scheduleNextBreak(getSeatSessionById(seatSessionId), classroom, atMs);
    }
  }
  return getSeatSessionById(seatSessionId);
}

/** Internal: closes an open seat session, banking time and resolving any open break. */
function closeSeatSession(seatSession, atMs, reason) {
  if (!seatSession || seatSession.state === 'ended') return seatSession;
  run(
    `UPDATE seat_sessions SET state = 'ended', ended_at = ?, active_seconds = ?, resumed_at = NULL WHERE id = ?`,
    [atMs, accrueActiveSeconds(seatSession, atMs), seatSession.id],
  );
  const open = getOpenBreak(seatSession.id);
  if (open) {
    // Recommended but never completed: it counts as missed rather than vanishing.
    run(`UPDATE break_events SET status = 'missed', resolved_at = ?, note = ? WHERE id = ?`, [
      atMs,
      `unresolved when ${reason}`,
      open.id,
    ]);
  }
  return getSeatSessionById(seatSession.id);
}

export function endSeatSession(seatSessionId, atMs = now(), reason = 'session ended') {
  return tx(() => closeSeatSession(getSeatSessionById(seatSessionId), atMs, reason));
}

/** T-0: the break overlay is going up. Pauses the stretch clock. */
export function markBreakShown(breakEventId, { instructionKey = null, atMs = now() } = {}) {
  return tx(() => {
    const breakEvent = getBreakEvent(breakEventId);
    if (!breakEvent) return { breakEvent: null, seatSession: null, changed: false };
    if (RESOLVED_STATUSES.includes(breakEvent.status)) {
      return { breakEvent, seatSession: getSeatSessionById(breakEvent.seat_session_id), changed: false };
    }
    const seatSession = getSeatSessionById(breakEvent.seat_session_id);
    const stretchSec = activeStretchSeconds(seatSession, atMs);
    run(
      `UPDATE break_events
          SET status = 'in_progress',
              started_at = COALESCE(started_at, ?),
              instruction_key = COALESCE(?, instruction_key),
              stretch_sec = CASE WHEN stretch_sec = 0 THEN ? ELSE stretch_sec END
        WHERE id = ?`,
      [atMs, instructionKey, stretchSec, breakEventId],
    );
    if (seatSession && seatSession.state !== 'ended') {
      run(`UPDATE seat_sessions SET state = 'on_break', active_seconds = ?, resumed_at = NULL WHERE id = ?`, [
        accrueActiveSeconds(seatSession, atMs),
        seatSession.id,
      ]);
    }
    return { breakEvent: getBreakEvent(breakEventId), seatSession: getSeatSessionById(seatSession?.id), changed: true };
  });
}

/**
 * Resolves a break and restarts the cadence.
 *
 * `completed` — the challenge ran to the end.
 * `skipped`   — the student dismissed it early (counts against adherence).
 * `missed`    — the deadline passed with no completion: the overlay never
 *               appeared, or the seat went offline mid-break.
 *
 * Both `skipped` and `missed` still restart the stretch clock. Stacking another
 * break immediately on top of a refused one would be the opposite of the
 * "predictable, never abrupt" principle the product is built on.
 */
export function resolveBreak({ breakEventId, outcome, atMs = now(), note = null }) {
  if (!RESOLVED_STATUSES.includes(outcome)) {
    throw new Error(`resolveBreak: unsupported outcome "${outcome}"`);
  }
  return tx(() => {
    const breakEvent = getBreakEvent(breakEventId);
    if (!breakEvent) return { changed: false, breakEvent: null, seatSession: null };
    if (RESOLVED_STATUSES.includes(breakEvent.status)) {
      return {
        changed: false,
        alreadyResolved: true,
        breakEvent,
        seatSession: getSeatSessionById(breakEvent.seat_session_id),
      };
    }

    const seatSession = getSeatSessionById(breakEvent.seat_session_id);
    run(
      `UPDATE break_events
          SET status = ?,
              resolved_at = ?,
              completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
              note = COALESCE(?, note)
        WHERE id = ?`,
      [outcome, atMs, outcome, atMs, note, breakEventId],
    );

    let updated = seatSession;
    if (seatSession && seatSession.state !== 'ended') {
      run(
        `UPDATE seat_sessions
            SET state = 'active', active_seconds = ?, resumed_at = ?, last_break_at = ?
          WHERE id = ?`,
        [accrueActiveSeconds(seatSession, atMs), atMs, atMs, seatSession.id],
      );
      updated = getSeatSessionById(seatSession.id);
      const classroom = getClassroom(seatSession.classroom_id);
      if (classroom) scheduleNextBreak(updated, classroom, atMs);
    }

    return { changed: true, breakEvent: getBreakEvent(breakEventId), seatSession: updated };
  });
}

export { OPEN_STATUSES, RESOLVED_STATUSES };
