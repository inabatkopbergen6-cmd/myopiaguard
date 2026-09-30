import express from 'express';
import { assertClassroomAccess, authenticate, requireUser } from '../auth.js';
import config from '../config.js';
import { all, get, run, tx } from '../db.js';
import { ApiError, handler, intParam } from '../lib/http.js';
import { iso, now } from '../lib/time.js';
import { markBreakShown, resolveBreak, scheduleNextBreak } from '../services/sessionState.js';

/**
 * Demo / evaluation controls, mounted only when MG_DEMO=1.
 *
 * A 20-minute break cadence is the product's default and the right default, but it
 * makes a walkthrough unwatchable. These endpoints let a reviewer move a classroom
 * to the interesting state on demand — a break due now, a long uninterrupted
 * stretch, a PC that dropped off mid-lesson — instead of waiting.
 *
 * They are not simulation of *fake* data: every one of them edits the same rows the
 * real product writes, so the scheduler, the dashboard and the reports all react
 * exactly as they would in production.
 */
const router = express.Router();

router.use(authenticate, requireUser('teacher', 'admin'));

router.use((req, res, next) => {
  if (!config.demoMode && process.env.MG_ALLOW_DEMO_TOOLS !== '1') {
    return next(ApiError.forbidden('demo tools are disabled (start the server with MG_DEMO=1)'));
  }
  return next();
});

function loadClassroom(req, source = req.body ?? {}) {
  const classroomId = req.params.classroomId ?? source.classroomId;
  const classroom = get('SELECT * FROM classrooms WHERE id = ?', [classroomId]);
  if (!classroom) throw ApiError.notFound('classroom');
  if (req.auth.role !== 'admin') assertClassroomAccess(req.auth, classroom.id);
  return classroom;
}

function liveSeatSessions(classroomId) {
  return all(
    `SELECT ss.* FROM seat_sessions ss
       JOIN lesson_sessions ls ON ls.id = ss.lesson_session_id
      WHERE ss.classroom_id = ? AND ss.state != 'ended' AND ls.status = 'live'`,
    [classroomId],
  );
}

router.get(
  '/status',
  handler((req, res) => {
    res.json({
      demoMode: config.demoMode,
      timings: config.timings,
      // The simulator is disclosed here rather than hidden, because a reviewer
      // needs to know which seats are real clients and which are stand-ins.
      simulatedClassroomPcs: config.demoMode ? req.app.locals.demoAgents?.liveSeats().length ?? 0 : 0,
      note: 'Demo tools edit the same rows the live scheduler uses, so the dashboard, reports and audit trail all react for real. Simulated classroom PCs stand in for machines that are not running an agent, and a real agent takes precedence for its own seat.',
    });
  }),
);

/** Make the next break due immediately (or in N seconds) for one seat, or all of them. */
router.post(
  '/classrooms/:classroomId/break-now',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const inSeconds = intParam(req.body?.inSeconds, 0, { min: 0, max: 600 });
    const seatId = req.body?.seatId ?? null;
    const affected = tx(() => {
      const target = liveSeatSessions(classroom.id).filter((row) => !seatId || row.seat_id === seatId);
      const results = [];
      for (const seatSession of target) {
        const open = get(
          `SELECT * FROM break_events WHERE seat_session_id = ? AND status IN ('pending','in_progress') ORDER BY due_at LIMIT 1`,
          [seatSession.id],
        );
        if (!open) {
          scheduleNextBreak(seatSession, classroom, now(), { minLeadMs: 0 });
          continue;
        }
        if (open.status === 'in_progress') continue;
        run('UPDATE break_events SET due_at = ?, warning_5min_at = NULL, warning_1min_at = NULL WHERE id = ?', [
          now() + inSeconds * 1000,
          open.id,
        ]);
        results.push({ seatId: seatSession.seat_id, breakEventId: open.id });
      }
      return results;
    });
    res.json({
      affected,
      note:
        inSeconds === 0
          ? 'The scheduler will trigger these within one tick (~1s). Watch the device view and the dashboard.'
          : `Break due in ${inSeconds}s, with countdown warnings scaled to the room's cadence.`,
    });
  }),
);

/** Backdate the current stretch so a seat shows as a long uninterrupted session. */
router.post(
  '/classrooms/:classroomId/stretch',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const minutes = intParam(req.body?.minutes, Number(classroom.long_session_min) + 3, { min: 1, max: 240 });
    const seatId = req.body?.seatId ?? null;
    const affected = tx(() => {
      const results = [];
      for (const seatSession of liveSeatSessions(classroom.id).filter((row) => !seatId || row.seat_id === seatId)) {
        const anchor = now() - minutes * 60_000;
        run(`UPDATE seat_sessions SET resumed_at = ?, state = 'active' WHERE id = ?`, [anchor, seatSession.id]);
        const open = get(
          `SELECT * FROM break_events WHERE seat_session_id = ? AND status = 'pending' ORDER BY due_at LIMIT 1`,
          [seatSession.id],
        );
        if (open) {
          // Keep the break in the future so the amber "long stretch" flag is visible
          // for a few seconds before the overlay takes over.
          run('UPDATE break_events SET due_at = ? WHERE id = ?', [now() + 25_000, open.id]);
        }
        results.push({ seatId: seatSession.seat_id, stretchMinutes: minutes });
      }
      return results;
    });
    res.json({ affected, note: `Stretch backdated to ${minutes} minutes. Breaks are now 25s away, so the amber flag shows first.` });
  }),
);

/** Resolve the open break(s) with a chosen outcome, for demoing adherence maths. */
router.post(
  '/classrooms/:classroomId/resolve',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const outcome = req.body?.outcome ?? 'completed';
    if (!['completed', 'skipped', 'missed'].includes(outcome)) {
      throw new ApiError(400, 'invalid_value', { field: 'outcome', allowed: ['completed', 'skipped', 'missed'] });
    }
    const affected = tx(() => {
      const results = [];
      for (const seatSession of liveSeatSessions(classroom.id)) {
        const open = get(
          `SELECT * FROM break_events WHERE seat_session_id = ? AND status IN ('pending','in_progress') ORDER BY due_at LIMIT 1`,
          [seatSession.id],
        );
        if (!open) continue;
        if (open.status === 'pending') markBreakShown(open.id, { instructionKey: 'demo', atMs: now() });
        const result = resolveBreak({
          breakEventId: open.id,
          outcome,
          atMs: now(),
          note: 'resolved by demo control',
        });
        if (result.changed) results.push({ seatId: seatSession.seat_id, breakEventId: open.id, outcome });
      }
      return results;
    });
    return res.json({ affected, note: `${affected.length} break(s) recorded as ${outcome}.` });
  }),
);

/** Take a seat offline mid-lesson (and back) to exercise the attention rules. */
router.post(
  '/seats/:seatId/offline',
  handler((req, res) => {
    const seat = get('SELECT * FROM seats WHERE id = ?', [req.params.seatId]);
    if (!seat) throw ApiError.notFound('seat');
    if (req.auth.role !== 'admin') assertClassroomAccess(req.auth, seat.classroom_id);
    const offline = req.body?.offline !== false;
    const atMs = now();
    tx(() => {
      const seatSession = get(
        `SELECT * FROM seat_sessions WHERE seat_id = ? AND state != 'ended' ORDER BY started_at DESC LIMIT 1`,
        [seat.id],
      );
      const stamp = offline ? atMs - 120_000 : atMs;
      run('UPDATE seats SET last_seen_at = ? WHERE id = ?', [offline ? atMs - 120_000 : atMs, seat.id]);
      if (seatSession) run('UPDATE seat_sessions SET last_heartbeat_at = ? WHERE id = ?', [stamp, seatSession.id]);
      run(
        `INSERT INTO audit_log (at, actor_user_id, actor_role, action, classroom_id, seat_id, detail)
         VALUES (?, ?, ?, 'demo.seat_toggled', ?, ?, ?)`,
        [atMs, req.auth.userId, req.auth.role, seat.classroom_id, seat.id, JSON.stringify({ offline })],
      );
    });
    res.json({ seatLabel: seat.label, offline, note: offline ? 'Heartbeat backdated: the seat now reads as offline mid-session.' : 'Heartbeat restored.' });
  }),
);

/** Wipe and reseed the demo school. Destructive; demo mode only. */
router.post(
  '/reset',
  handler(async (req, res) => {
    const { seedDatabase } = await import('../seed.js');
    const summary = await seedDatabase({ force: true });
    res.json({ reseeded: true, summary });
  }),
);

router.get(
  '/audit',
  handler((req, res) => {
    const limit = intParam(req.query.limit, 40, { min: 1, max: 200 });
    res.json({
      entries: all(
        `SELECT a.at, a.action, a.actor_role, a.classroom_id, a.seat_id, a.detail, u.display_name AS actor_name,
                c.name AS classroom_name, s.label AS seat_label
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.actor_user_id
           LEFT JOIN classrooms c ON c.id = a.classroom_id
           LEFT JOIN seats s ON s.id = a.seat_id
          ORDER BY a.at DESC LIMIT ?`,
        [limit],
      ).map((row) => ({
        at: iso(row.at),
        action: row.action,
        actor: row.actor_name ?? row.actor_role ?? 'system',
        classroomName: row.classroom_name ?? null,
        seatLabel: row.seat_label ?? null,
        detail: row.detail ? JSON.parse(row.detail) : null,
      })),
    });
  }),
);

export default router;
