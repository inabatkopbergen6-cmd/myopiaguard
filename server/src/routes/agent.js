import express from 'express';
import { authenticate, requireAgent } from '../auth.js';
import { get, run } from '../db.js';
import { ApiError, handler } from '../lib/http.js';
import { now } from '../lib/time.js';
import { BREAK_INSTRUCTIONS, instructionFor } from '../services/breaks.js';
import { buildAgentState } from '../services/agentState.js';
import { overlayForSeat } from '../services/attention.js';
import { policyForSeat } from '../services/focus.js';
import {
  getBreakEvent,
  getLiveLessonSession,
  getLiveSeatSession,
  markBreakShown,
  resolveBreak,
  startSeatSession,
  touchHeartbeat,
} from '../services/sessionState.js';

/**
 * Device agent API. A classroom PC authenticates with its seat's agent token and
 * is treated as untrusted input: a break can only be completed or skipped once,
 * only for the seat that owns it, and only while it is actually open. A student
 * cannot POST their way to a better adherence score.
 */
const router = express.Router();
router.use(authenticate, requireAgent);

function seatContext(req) {
  const seat = get(
    `SELECT s.*, c.name AS classroom_name, c.subject, c.school_id, c.grade_id, c.break_interval_min,
            c.break_duration_sec, c.warn_lead_5min, c.warn_lead_1min, c.long_session_min,
            c.missed_break_grace_sec, c.offline_after_sec, c.language
       FROM seats s JOIN classrooms c ON c.id = s.classroom_id
      WHERE s.id = ?`,
    [req.auth.seatId],
  );
  if (!seat) throw ApiError.notFound('seat');
  return seat;
}

/** Thin wrapper: the document itself is built in services/agentState.js so the
 *  realtime hub can reuse it verbatim when an agent reconnects. */
function agentState(req, seat, atMs = now()) {
  return buildAgentState({ seatId: seat.id, atMs, demoMode: Boolean(req.app.locals.demoMode) });
}

router.post(
  '/hello',
  handler((req, res) => {
    const seat = seatContext(req);
    const atMs = now();
    run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [atMs, seat.id]);
    const lessonSession = getLiveLessonSession(seat.classroom_id);
    if (lessonSession) {
      startSeatSession({
        seat,
        lessonSession,
        agentVersion: String(req.body?.agentVersion ?? 'unknown').slice(0, 40),
        atMs,
      });
    }
    res.json(agentState(req, seat, atMs));
  }),
);

router.post(
  '/heartbeat',
  handler((req, res) => {
    const seat = seatContext(req);
    const atMs = now();
    run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [atMs, seat.id]);
    const lessonSession = getLiveLessonSession(seat.classroom_id);
    if (lessonSession) {
      const live = getLiveSeatSession(seat.id);
      if (!live || live.lesson_session_id !== lessonSession.id) {
        startSeatSession({
          seat,
          lessonSession,
          agentVersion: String(req.body?.agentVersion ?? 'unknown').slice(0, 40),
          atMs,
        });
      } else {
        touchHeartbeat(live.id, atMs, { agentVersion: String(req.body?.agentVersion ?? '').slice(0, 40) || null });
      }
    }
    res.json(agentState(req, seat, atMs));
  }),
);

router.get(
  '/state',
  handler((req, res) => {
    const seat = seatContext(req);
    res.json(agentState(req, seat));
  }),
);

/** The student's browser says the overlay is on screen. Records the real start. */
router.post(
  '/breaks/:breakEventId/shown',
  handler((req, res) => {
    const breakEvent = getBreakEvent(req.params.breakEventId);
    if (!breakEvent) throw ApiError.notFound('break');
    if (breakEvent.seat_id !== req.auth.seatId) throw ApiError.forbidden('this break belongs to another seat');
    const result = markBreakShown(breakEvent.id, { instructionKey: breakEvent.instruction_key, atMs: now() });
    req.app.locals.hub?.toClassroom(breakEvent.classroom_id, 'classroom:changed', {
      classroomId: breakEvent.classroom_id,
    });
    res.json({
      breakEventId: result.breakEvent?.id ?? null,
      status: result.breakEvent?.status ?? null,
      durationSec: Number(result.breakEvent?.duration_sec ?? 20),
      instruction: instructionFor(result.breakEvent?.instruction_key),
    });
  }),
);

/**
 * Completing a challenge. The server re-derives the elapsed time from its own
 * clock, so a modified client cannot claim a 20-second break in 200ms.
 */
router.post(
  '/breaks/:breakEventId/complete',
  handler((req, res) => {
    const breakEvent = getBreakEvent(req.params.breakEventId);
    if (!breakEvent) throw ApiError.notFound('break');
    if (breakEvent.seat_id !== req.auth.seatId) throw ApiError.forbidden('this break belongs to another seat');
    const atMs = now();
    const elapsedMs = breakEvent.started_at ? atMs - Number(breakEvent.started_at) : null;
    const requiredMs = Number(breakEvent.duration_sec) * 1000;
    if (elapsedMs !== null && elapsedMs < requiredMs * 0.9) {
      throw new ApiError(409, 'break_not_elapsed', {
        elapsedSeconds: Math.round(elapsedMs / 1000),
        requiredSeconds: Number(breakEvent.duration_sec),
        reason: 'The challenge must run to the end of the countdown.',
      });
    }
    const result = resolveBreak({ breakEventId: breakEvent.id, outcome: 'completed', atMs });
    req.app.locals.hub?.toClassroom(breakEvent.classroom_id, 'classroom:changed', {
      classroomId: breakEvent.classroom_id,
    });
    res.json({
      breakEventId: result.breakEvent.id,
      status: result.breakEvent.status,
      completedAt: result.breakEvent.completed_at ? new Date(Number(result.breakEvent.completed_at)).toISOString() : null,
      durationSec: Number(result.breakEvent.duration_sec),
      elapsedSeconds: elapsedMs === null ? null : Math.round(elapsedMs / 1000),
      seatLabel: req.auth.seatLabel,
    });
  }),
);

/** Dismissed early: logged as Skipped/Incomplete, which counts against adherence. */
router.post(
  '/breaks/:breakEventId/skip',
  handler((req, res) => {
    const breakEvent = getBreakEvent(req.params.breakEventId);
    if (!breakEvent) throw ApiError.notFound('break');
    if (breakEvent.seat_id !== req.auth.seatId) throw ApiError.forbidden('this break belongs to another seat');
    const result = resolveBreak({
      breakEventId: breakEvent.id,
      outcome: 'skipped',
      atMs: now(),
      note: String(req.body?.reason ?? 'overlay dismissed early').slice(0, 120),
    });
    req.app.locals.hub?.toClassroom(breakEvent.classroom_id, 'classroom:changed', {
      classroomId: breakEvent.classroom_id,
    });
    res.json({
      breakEventId: result.breakEvent.id,
      status: result.breakEvent.status,
      seatLabel: req.auth.seatLabel,
      note: 'Recorded as skipped. The next break is scheduled normally so the rhythm stays predictable.',
    });
  }),
);

/** Focus Mode enforcement acknowledgement/telemetry from the extension or agent. */
router.post(
  '/focus/report',
  handler((req, res) => {
    const policy = policyForSeat(req.auth.seatId);
    const ctx = seatContext(req);
    run(
      `INSERT INTO audit_log (at, actor_user_id, actor_role, action, classroom_id, seat_id, detail)
       VALUES (?, NULL, 'agent', 'focus.enforcement_report', ?, ?, ?)`,
      [
        now(),
        ctx.classroom_id,
        ctx.id,
        JSON.stringify({
          applied: Boolean(req.body?.applied),
          policyVersion: req.body?.policyVersion ?? null,
          activePolicyVersion: policy?.policyVersion ?? 0,
          enforcer: String(req.body?.enforcer ?? 'unknown').slice(0, 60),
        }),
      ],
    );
    res.json({ policy, acknowledged: true });
  }),
);

/** The instruction pool, so an offline agent can keep rotating copy from cache. */
router.get(
  '/instruction-pool',
  handler((req, res) => {
    res.json({ instructions: BREAK_INSTRUCTIONS.map((entry) => ({ key: entry.key, text: entry.text })) });
  }),
);

export default router;
