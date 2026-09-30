import { get } from '../db.js';
import { now } from '../lib/time.js';
import { overlayForSeat } from './attention.js';
import { instructionFor } from './breaks.js';
import { policyForSeat } from './focus.js';
import { classroomConfig, getLiveLessonSession, getLiveSeatSession, getOpenBreak } from './sessionState.js';

/**
 * The single document a classroom PC needs to render itself: who it is, what the
 * lesson is doing, the cadence it should display, any break that is due or on
 * screen, the current Attention Mode overlay, and the Focus Mode policy in force.
 *
 * Used by the REST agent endpoints and by the realtime hub on connect, so an agent
 * that reloads mid-break or reconnects after a network drop converges on exactly
 * the same state as one that never went away.
 */
export function buildAgentState({ seatId, atMs = now(), demoMode = false } = {}) {
  const seat = get(
    `SELECT s.*, c.name AS classroom_name, c.subject, c.school_id, c.grade_id,
            c.language
       FROM seats s JOIN classrooms c ON c.id = s.classroom_id
      WHERE s.id = ?`,
    [seatId],
  );
  if (!seat) return null;

  const lessonSession = getLiveLessonSession(seat.classroom_id);
  const seatSession = lessonSession ? getLiveSeatSession(seat.id) : null;
  const openBreak = seatSession ? getOpenBreak(seatSession.id) : null;
  const config = classroomConfig(seat.classroom_id);
  const grade = get('SELECT name FROM grades WHERE id = ?', [seat.grade_id]);

  return {
    seat: { seatId: seat.id, label: seat.label, seatIndex: seat.seat_index },
    classroom: {
      classroomId: seat.classroom_id,
      name: seat.classroom_name,
      subject: seat.subject,
      gradeName: grade?.name ?? null,
    },
    lesson: lessonSession
      ? {
          lessonSessionId: lessonSession.id,
          subject: lessonSession.subject,
          startedAt: Number(lessonSession.started_at),
          active: true,
        }
      : { lessonSessionId: null, active: false },
    config: {
      breakIntervalMin: config.break_interval_min,
      breakDurationSec: config.break_duration_sec,
      warnLead5Min: Boolean(config.warn_lead_5min),
      warnLead1Min: Boolean(config.warn_lead_1min),
      longSessionMin: config.long_session_min,
      missedBreakGraceSec: config.missed_break_grace_sec,
      offlineAfterSec: config.offline_after_sec,
      heartbeatSeconds: 5,
      /**
       * The language this classroom's screens display, set per room by the teacher
       * or administrator. The device agent renders in it. It is configuration
       * rather than a per-student choice because a classroom PC is a kiosk: the
       * language belongs to the room, not to whoever sits down.
       */
      language: seat.language ?? 'en',
    },
    session: seatSession
      ? {
          seatSessionId: seatSession.id,
          startedAt: Number(seatSession.started_at),
          state: seatSession.state,
          activeSeconds: Number(seatSession.active_seconds ?? 0),
          stretchSeconds:
            seatSession.state === 'active' && seatSession.resumed_at
              ? Math.max(0, Math.round((atMs - Number(seatSession.resumed_at)) / 1000))
              : 0,
        }
      : null,
    // Due but not yet on screen: lets the agent pre-warm and show its own countdown.
    pendingBreak: openBreak
      ? {
          breakEventId: openBreak.id,
          status: openBreak.status,
          dueAt: Number(openBreak.due_at),
          secondsToDue: Math.max(0, Math.round((Number(openBreak.due_at) - atMs) / 1000)),
          durationSec: Number(openBreak.duration_sec),
          instruction: openBreak.instruction_key ? instructionFor(openBreak.instruction_key) : null,
        }
      : null,
    // Already on screen: how a reloaded agent rejoins a break in progress.
    activeBreak:
      openBreak && openBreak.status === 'in_progress'
        ? {
            breakEventId: openBreak.id,
            durationSec: Number(openBreak.duration_sec),
            startedAt: Number(openBreak.started_at),
            elapsedSeconds: Math.max(0, Math.round((atMs - Number(openBreak.started_at)) / 1000)),
            instruction: instructionFor(openBreak.instruction_key),
            longStretch: Number(openBreak.stretch_sec ?? 0) >= Number(config.long_session_min) * 60,
          }
        : null,
    attention: overlayForSeat(seat.id, atMs),
    focusPolicy: policyForSeat(seat.id),
    serverTime: atMs,
    demoMode,
  };
}
