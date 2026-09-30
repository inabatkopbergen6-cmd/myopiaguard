import { all, audit, get, run, tx } from '../db.js';
import { makeId } from '../lib/ids.js';
import { ApiError } from '../lib/http.js';
import { now } from '../lib/time.js';
import { sanitizeMessage } from '../lib/validation.js';

/**
 * Attention Mode (deliverable 6) — a classroom-management broadcast, not remote
 * control.
 *
 * The distinction is enforced in the payload itself: every broadcast carries an
 * explicit capability statement declaring that it cannot lock input, cannot
 * capture a screen and cannot block an application. There is no code path in this
 * module that sends anything a device agent could interpret as device control,
 * and every broadcast is written to the audit log with the message text.
 *
 * Delivery is best-effort and honest about it: the count returned to the teacher
 * is how many agents acknowledged the overlay, not how many were asked.
 */

export const DEFAULT_ATTENTION_MESSAGE = 'Teacher Attention — Please look at the board.';

export const ATTENTION_CAPABILITIES = Object.freeze({
  inputLock: false,
  screenCapture: false,
  appBlocking: false,
  windowControl: false,
  scope: 'lesson-management',
});

export const ATTENTION_DURATIONS = Object.freeze([10, 20, 30, 45, 60, 120]);

function toView(row, { nowMs = now(), deliveredCount = null } = {}) {
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  const clearedAt = row.cleared_at ? Number(row.cleared_at) : null;
  return {
    id: row.id,
    classroomId: row.classroom_id,
    lessonSessionId: row.lesson_session_id,
    message: row.message,
    durationSec: Number(row.duration_sec),
    createdAt: Number(row.created_at),
    expiresAt,
    clearedAt,
    active: clearedAt === null && expiresAt > nowMs,
    secondsRemaining: clearedAt === null && expiresAt > nowMs ? Math.ceil((expiresAt - nowMs) / 1000) : 0,
    deliveredCount: deliveredCount ?? Number(row.delivered_count ?? 0),
    capabilities: ATTENTION_CAPABILITIES,
  };
}

function liveLessonSession(classroomId) {
  return get(
    `SELECT * FROM lesson_sessions WHERE classroom_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1`,
    [classroomId],
  );
}

export function getActiveBroadcast(classroomId, atMs = now()) {
  const row = get(
    `SELECT * FROM attention_broadcasts
      WHERE classroom_id = ? AND cleared_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
    [classroomId, atMs],
  );
  return toView(row, { nowMs: atMs });
}

export function attentionHistory(classroomId, limit = 20) {
  return all(
    `SELECT ab.*, u.display_name AS teacher_name FROM attention_broadcasts ab
       LEFT JOIN users u ON u.id = ab.teacher_id
      WHERE ab.classroom_id = ? ORDER BY ab.created_at DESC LIMIT ?`,
    [classroomId, limit],
  ).map((row) => ({ ...toView(row), teacherName: row.teacher_name ?? null, past: true }));
}

/**
 * Sends the overlay to every connected seat in the classroom.
 * `hub` is optional so this is testable without a socket server.
 */
export function broadcastAttention({ classroomId, teacherId, message = null, durationSec = 30, hub = null, actor = {} } = {}) {
  const classroom = get('SELECT * FROM classrooms WHERE id = ?', [classroomId]);
  if (!classroom) throw ApiError.notFound('classroom');
  const lessonSession = liveLessonSession(classroomId);
  if (!lessonSession) {
    throw ApiError.conflict('no_live_session', {
      classroomId,
      reason: 'Start the lesson session before broadcasting to the room.',
    });
  }

  const text = sanitizeMessage(message, { maxLength: 160, fallback: DEFAULT_ATTENTION_MESSAGE });
  const duration = Math.min(600, Math.max(5, Number.parseInt(durationSec, 10) || 30));
  const createdAt = now();
  const id = makeId('att');
  const expiresAt = createdAt + duration * 1000;

  const payload = {
    broadcastId: id,
    classroomId,
    lessonSessionId: lessonSession.id,
    message: text,
    durationSec: duration,
    createdAt,
    expiresAt,
    capabilities: ATTENTION_CAPABILITIES,
  };

  const delivered = hub
    ? hub.toClassroom(classroomId, 'attention:show', payload, { kind: 'agent' })
    : 0;

  tx(() => {
    run(
      `INSERT INTO attention_broadcasts (id, lesson_session_id, classroom_id, school_id, teacher_id, message,
                                        duration_sec, created_at, expires_at, delivered_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        lessonSession.id,
        classroomId,
        classroom.school_id,
        teacherId,
        text,
        duration,
        createdAt,
        expiresAt,
        delivered,
      ],
    );
    audit({
      actorUserId: actor.userId ?? teacherId,
      actorRole: actor.role ?? 'teacher',
      action: 'attention.broadcast',
      classroomId,
      detail: { broadcastId: id, message: text, durationSec: duration, delivered },
    });
  });

  // Tell the teacher dashboards too, so the "Clear" control and countdown appear.
  hub?.toClassroom(classroomId, 'attention:broadcast', { ...payload, deliveredCount: delivered }, { kind: 'teacher' });

  return toView(get('SELECT * FROM attention_broadcasts WHERE id = ?', [id]), { deliveredCount: delivered });
}

export function clearAttention({ classroomId, teacherId = null, broadcastId = null, reason = 'cleared by teacher', hub = null, actor = {} } = {}) {
  const cleared = tx(() => {
    const row = broadcastId
      ? get('SELECT * FROM attention_broadcasts WHERE id = ? AND classroom_id = ?', [broadcastId, classroomId])
      : get(
          `SELECT * FROM attention_broadcasts
            WHERE classroom_id = ? AND cleared_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`,
          [classroomId, now()],
        );
    if (!row || row.cleared_at) return null;
    run('UPDATE attention_broadcasts SET cleared_at = ? WHERE id = ?', [now(), row.id]);
    audit({
      actorUserId: actor.userId ?? teacherId,
      actorRole: actor.role ?? 'teacher',
      action: 'attention.cleared',
      classroomId,
      detail: { broadcastId: row.id, reason },
    });
    return get('SELECT * FROM attention_broadcasts WHERE id = ?', [row.id]);
  });

  if (!cleared) return { cleared: false, broadcast: null };

  const payload = { broadcastId: cleared.id, classroomId, reason, capabilities: ATTENTION_CAPABILITIES };
  hub?.toClassroom(classroomId, 'attention:clear', payload, { kind: 'agent' });
  hub?.toClassroom(classroomId, 'attention:clear', payload, { kind: 'teacher' });

  return { cleared: true, broadcast: toView(cleared) };
}

/** Builds the overlay a seat should currently be showing (used on connect/reconnect). */
export function overlayForSeat(seatId, atMs = now()) {
  const seat = get('SELECT * FROM seats WHERE id = ?', [seatId]);
  if (!seat) return null;
  const broadcast = getActiveBroadcast(seat.classroom_id, atMs);
  if (!broadcast) return null;
  return broadcast;
}

/**
 * Auto-dismiss on expiry. Agents expire their own overlay on a local timer (that
 * is the mechanism a student experiences), and this sweep makes the server-side
 * state agree, so a teacher's dashboard never shows a stale "live" broadcast.
 * Driven from the scheduler tick.
 */
export function sweepExpiredBroadcasts(atMs = now(), hub = null) {
  const expired = all(
    `SELECT * FROM attention_broadcasts
      WHERE cleared_at IS NULL AND expires_at <= ?`,
    [atMs],
  );
  for (const row of expired) {
    run('UPDATE attention_broadcasts SET cleared_at = ? WHERE id = ?', [atMs, row.id]);
    const payload = { broadcastId: row.id, classroomId: row.classroom_id, reason: 'duration elapsed' };
    hub?.toClassroom(row.classroom_id, 'attention:clear', payload, { kind: 'agent' });
    hub?.toClassroom(row.classroom_id, 'attention:clear', payload, { kind: 'teacher' });
  }
  return expired.map((row) => row.id);
}
