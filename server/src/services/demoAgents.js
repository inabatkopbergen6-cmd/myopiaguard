import config from '../config.js';
import { all } from '../db.js';
import { now } from '../lib/time.js';
import { getOpenBreak, getLiveSeatSession, resolveBreak, startSeatSession, touchHeartbeat } from './sessionState.js';

/**
 * Demo classroom-PC simulator.
 *
 * A seeded school has no classroom PCs actually running, so every seat would read
 * offline and the dashboard would show nothing but grey — an accurate picture of a
 * room where nobody has switched a computer on, and a useless demo.
 *
 * This pool stands in for those machines. Two rules keep it honest:
 *
 *   1. **It only runs in demo mode** (MG_DEMO=1) and says so in the UI and in
 *      `/api/demo/status`. A real deployment never constructs it.
 *   2. **A real agent always wins.** Before touching a seat, the pool checks
 *      whether a genuine agent socket is attached to it; if one is, the seat is
 *      left completely alone. Opening the device view for PC-04 while the
 *      simulator is running hands that seat over to the real client.
 *
 * It drives the same lifecycle functions a real agent drives (heartbeat,
 * completion, skip), so nothing about the scheduler or the reports is bypassed —
 * it is a client, not a shortcut.
 */
export class DemoAgentPool {
  constructor({ hub = null, logger = console, intervalMs = 5000, completionRate = 0.88 } = {}) {
    this.hub = hub;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.completionRate = completionRate;
    this.timer = null;
    this.seatCursor = 0;
    this.ticks = 0;
  }

  /** True when a genuine agent socket owns this seat right now. */
  hasRealAgent(seatId) {
    if (!this.hub) return false;
    return this.hub.connectionsIn(`seat:${seatId}`, 'agent').length > 0;
  }

  /**
   * A classroom where every single machine is switched on is not a realistic
   * classroom, and it hides the offline state from a reviewer. The pool therefore
   * leaves a small deterministic set of seats alone (one in every eleven), so those
   * read as offline exactly as a powered-down PC would.
   */
  isPortrayedOffline(seat) {
    const digits = /(\d+)$/.exec(String(seat.label ?? ''))?.[1];
    if (!digits) return false;
    return Number(digits) % 11 === 0;
  }

  liveSeats() {
    return all(
      `SELECT s.id, s.label, s.classroom_id, c.grade_id, c.school_id, c.break_interval_min
         FROM seats s
         JOIN classrooms c ON c.id = s.classroom_id
         JOIN lesson_sessions ls ON ls.classroom_id = c.id AND ls.status = 'live'
        GROUP BY s.id
        ORDER BY s.id`,
      [],
    );
  }

  start() {
    if (this.timer || !config.demoMode) return this;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.logger.error?.('[demo-agents] tick failed', error);
      }
    }, this.intervalMs);
    this.timer.unref?.();
    const seats = this.liveSeats().length;
    if (seats > 0) {
      this.logger.log?.(`[demo-agents] simulating ${seats} classroom PC(s); real agents take precedence per seat`);
    }
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(atMs = now()) {
    this.ticks += 1;
    const handled = [];
    for (const seat of this.liveSeats()) {
      if (this.hasRealAgent(seat.id)) continue;
      if (this.isPortrayedOffline(seat)) continue;
      handled.push(this.stepSeat(seat, atMs));
    }
    return handled.filter(Boolean);
  }

  stepSeat(seat, atMs) {
    let seatSession = getLiveSeatSession(seat.id);
    if (!seatSession) {
      const lesson = all(
        `SELECT * FROM lesson_sessions WHERE classroom_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1`,
        [seat.classroom_id],
      )[0];
      if (!lesson) return null;
      seatSession = startSeatSession({ seat, lessonSession: lesson, agentVersion: 'demo-simulator/1.0', atMs });
      return { seatId: seat.id, action: 'joined' };
    }

    touchHeartbeat(seatSession.id, atMs, { agentVersion: 'demo-simulator/1.0' });

    // Finish whatever break is on screen, on time, the way a student would. The
    // completion rate is below 1 so the dashboard and reports show a realistic mix
    // of completed, skipped and missed breaks rather than a perfect room.
    const open = getOpenBreak(seatSession.id);
    if (open && open.status === 'in_progress') {
      const deadline = Number(open.started_at) + Number(open.duration_sec) * 1000;
      if (atMs >= deadline) {
        const outcome = Math.random() < this.completionRate ? 'completed' : 'skipped';
        const result = resolveBreak({
          breakEventId: open.id,
          outcome,
          atMs,
          note: outcome === 'skipped' ? 'simulated early dismissal' : null,
        });
        if (result.changed) {
          this.hub?.toClassroom(seat.classroom_id, 'classroom:changed', { classroomId: seat.classroom_id }, { kind: 'teacher' });
          return { seatId: seat.id, action: `break_${outcome}` };
        }
      }
    }

    return null;
  }
}

export default DemoAgentPool;
