import config from '../config.js';
import { all, get, run } from '../db.js';
import { now } from '../lib/time.js';
import { sweepExpiredBroadcasts } from './attention.js';
import { instructionFor, isLongStretch, pickInstruction } from './breaks.js';
import {
  classroomConfig,
  getOpenBreak,
  markBreakShown,
  resolveBreak,
  scheduleNextBreak,
  touchHeartbeat,
} from './sessionState.js';
import { generateWeeklyReport } from './reports.js';

/**
 * The break scheduler is the single source of truth for *when* a child is asked
 * to rest their eyes. Device agents run their own countdown for the overlay, but
 * they never decide the schedule: if an agent is closed and reopened, or a
 * classroom PC loses power, the cadence is unchanged because the server already
 * knew the answer.
 *
 * One tick per second walks every live seat. At classroom scale (tens of seats
 * per room, tens of rooms per school) this is a few hundred indexed row reads a
 * second, which is why a plain SQLite deployment is enough for a whole school.
 */

/** The 5-minute and 1-minute warning leads, scaled down for short demo cadences. */
export function warningOffsets(dueAt, { intervalMin, warnLead5Min = 1, warnLead1Min = 1 }) {
  // A 5-minute warning inside a 2-minute cadence is meaningless, so leads scale
  // with the interval. At the 20-minute default the scale is exactly 1:1 and the
  // product behaves as specified (T-5 and T-1 minutes).
  const scale = Math.min(1, Math.max(0.05, Number(intervalMin) / 20));
  return {
    t5: warnLead5Min ? Number(dueAt) - 5 * 60_000 * scale : null,
    t1: warnLead1Min ? Number(dueAt) - 60_000 * scale : null,
    lead5Sec: Math.round(5 * 60 * scale),
    lead1Sec: Math.round(60 * scale),
    scale,
  };
}

export class BreakScheduler {
  constructor({ hub = null, logger = console, tickMs = config.tickMs, enabled = config.schedulerEnabled } = {}) {
    this.hub = hub;
    this.logger = logger;
    this.tickMs = tickMs;
    this.enabled = enabled;
    this.timer = null;
    this.lastSnapshotAt = new Map();
    this.lastReportCheck = 0;
    this.running = false;
  }

  start() {
    if (this.timer || !this.enabled) return this;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.logger.error?.('[scheduler] tick failed', error);
      }
    }, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  liveSeats(atMs) {
    return all(
      `SELECT ss.*, s.label AS seat_label, s.seat_index
         FROM seat_sessions ss
         JOIN seats s ON s.id = ss.seat_id
         JOIN lesson_sessions ls ON ls.id = ss.lesson_session_id
        WHERE ss.state != 'ended' AND ls.status = 'live'
        ORDER BY s.seat_index`,
      [],
    );
  }

  /** One evaluation pass. Exported so tests can drive it with a fake clock. */
  tick(atMs = now()) {
    const events = [];
    for (const seatSession of this.liveSeats(atMs)) {
      events.push(...this.evaluateSeat(seatSession, atMs));
    }
    const expired = sweepExpiredBroadcasts(atMs, this.hub);
    for (const broadcastId of expired) {
      events.push({ kind: 'attention_expired', broadcastId, classroomId: null });
    }
    this.publishSnapshots(atMs, events);
    this.checkWeeklyReports(atMs, events);
    return events;
  }

  evaluateSeat(seatSession, atMs) {
    const events = [];
    const classroom = classroomConfig(seatSession.classroom_id);
    const onlineMs = Number(classroom.offline_after_sec) * 1000;
    const isOnline = atMs - Number(seatSession.last_heartbeat_at) <= onlineMs;

    if (!isOnline) {
      // An offline seat is frozen, not penalised: we cannot ask a powered-down
      // machine to rest its eyes. A break that was already on screen when the
      // seat vanished is the one exception — that one is a miss.
      const open = getOpenBreak(seatSession.id);
      if (open && open.status === 'in_progress') {
        const deadline = Number(open.started_at) + (Number(open.duration_sec) + Number(classroom.missed_break_grace_sec)) * 1000;
        if (atMs > deadline) {
          const result = resolveBreak({
            breakEventId: open.id,
            outcome: 'missed',
            atMs,
            note: 'seat went offline while the break was on screen',
          });
          if (result.changed) events.push({ kind: 'break_missed', ...this.describe(result), reason: 'offline_mid_break' });
        }
      }
      return events;
    }

    // A stale seat comes back online: nothing else to do, the heartbeat that
    // flipped `isOnline` already re-anchored the cadence in touchHeartbeat.
    let open = getOpenBreak(seatSession.id);

    if (!open) {
      if (seatSession.state === 'active') {
        scheduleNextBreak(seatSession, classroom, atMs);
        open = getOpenBreak(seatSession.id);
      } else {
        return events;
      }
    }
    if (!open) return events;

    const dueAt = Number(open.due_at);
    const offsets = warningOffsets(dueAt, {
      intervalMin: classroom.break_interval_min,
      warnLead5Min: classroom.warn_lead_5min,
      warnLead1Min: classroom.warn_lead_1min,
    });

    // Countdown warnings (deliverable 3): non-blocking, and only ever sent once
    // per break so a student cannot be nagged repeatedly.
    if (offsets.t5 !== null && !open.warning_5min_at && atMs >= offsets.t5 && atMs < dueAt) {
      run('UPDATE break_events SET warning_5min_at = ? WHERE id = ?', [atMs, open.id]);
      const payload = {
        breakEventId: open.id,
        seatLabel: seatSession.seat_label,
        kind: 't5',
        leadSeconds: offsets.lead5Sec,
        dueInSeconds: Math.max(0, Math.round((dueAt - atMs) / 1000)),
        scheduledAt: new Date(dueAt).toISOString(),
      };
      this.sendToSeat(seatSession.seat_id, 'break:warning', payload);
      events.push({ kind: 'warning_sent', seatId: seatSession.seat_id, breakEventId: open.id, level: 't5' });
      open = { ...open, warning_5min_at: atMs };
    }

    if (offsets.t1 !== null && !open.warning_1min_at && atMs >= offsets.t1 && atMs < dueAt) {
      run('UPDATE break_events SET warning_1min_at = ? WHERE id = ?', [atMs, open.id]);
      const payload = {
        breakEventId: open.id,
        seatLabel: seatSession.seat_label,
        kind: 't1',
        leadSeconds: offsets.lead1Sec,
        dueInSeconds: Math.max(0, Math.round((dueAt - atMs) / 1000)),
        scheduledAt: new Date(dueAt).toISOString(),
      };
      this.sendToSeat(seatSession.seat_id, 'break:warning', payload);
      events.push({ kind: 'warning_sent', seatId: seatSession.seat_id, breakEventId: open.id, level: 't1' });
      open = { ...open, warning_1min_at: atMs };
    }

    // T-0
    if (open.status === 'pending' && atMs >= dueAt) {
      const previous = get(
        `SELECT instruction_key FROM break_events
          WHERE seat_session_id = ? AND instruction_key IS NOT NULL
          ORDER BY due_at DESC LIMIT 1`,
        [seatSession.id],
      );
      const instruction = pickInstruction(Math.random, previous?.instruction_key ?? null);
      const result = markBreakShown(open.id, { instructionKey: instruction.key, atMs });
      const stretchSec = Number(result.breakEvent?.stretch_sec ?? 0);
      const payload = {
        breakEventId: open.id,
        seatLabel: seatSession.seat_label,
        durationSec: Number(result.breakEvent?.duration_sec ?? classroom.break_duration_sec),
        instruction: instructionFor(instruction.key),
        startedAt: new Date(atMs).toISOString(),
        stretchSeconds: stretchSec,
        longStretch: isLongStretch(stretchSec, classroom.long_session_min),
      };
      this.sendToSeat(seatSession.seat_id, 'break:start', payload);
      events.push({ kind: 'break_triggered', ...this.describe(result) });
    }

    // A break that never got completed inside its window.
    const current = getOpenBreak(seatSession.id);
    if (current && current.status === 'in_progress') {
      const deadline =
        Number(current.started_at) + (Number(current.duration_sec) + Number(classroom.missed_break_grace_sec)) * 1000;
      if (atMs > deadline) {
        const result = resolveBreak({
          breakEventId: current.id,
          outcome: 'missed',
          atMs,
          note: 'break not completed within the grace window',
        });
        if (result.changed) {
          this.sendToSeat(seatSession.seat_id, 'break:missed', {
            breakEventId: current.id,
            seatLabel: seatSession.seat_label,
          });
          events.push({ kind: 'break_missed', ...this.describe(result), reason: 'timeout' });
        }
      }
    }

    return events;
  }

  describe(result) {
    return {
      seatId: result.seatSession?.seat_id ?? result.breakEvent?.seat_id ?? null,
      seatSessionId: result.seatSession?.id ?? null,
      breakEventId: result.breakEvent?.id ?? null,
      classroomId: result.breakEvent?.classroom_id ?? result.seatSession?.classroom_id ?? null,
      status: result.breakEvent?.status ?? null,
    };
  }

  sendToSeat(seatId, type, payload) {
    this.hub?.toSeat(seatId, type, payload, { kind: 'agent' });
  }

  /** Dashboard freshness: throttled per classroom so a busy room cannot spam teachers. */
  publishSnapshots(atMs, events) {
    if (!this.hub) return;
    const classes = new Set(events.map((event) => event.classroomId).filter(Boolean));
    for (const classroomId of classes) {
      const last = this.lastSnapshotAt.get(classroomId) ?? 0;
      if (atMs - last < config.snapshotThrottleMs) continue;
      this.lastSnapshotAt.set(classroomId, atMs);
      const classroom = get('SELECT * FROM classrooms WHERE id = ?', [classroomId]);
      if (classroom) {
        this.hub.toClassroom(classroomId, 'classroom:changed', { classroomId, at: new Date(atMs).toISOString() });
        this.hub.toSchool(classroom.school_id, 'analytics:stale', { at: new Date(atMs).toISOString() });
      }
    }
  }

  /**
   * Weekly report auto-generation (deliverable 4): Monday morning, for each
   * classroom, snapshot the prior Mon–Fri so the report exists whether or not a
   * teacher logs in that day. Idempotent per (classroom, week).
   */
  checkWeeklyReports(atMs, events) {
    if (atMs - this.lastReportCheck < 60 * 60_000) return;
    this.lastReportCheck = atMs;
    const stamp = new Date(atMs);
    if (stamp.getDay() !== 1) return; // 1 = Monday
    for (const classroom of all('SELECT * FROM classrooms', [])) {
      try {
        const report = generateWeeklyReport({ classroomId: classroom.id, atMs, mode: 'last-complete', store: true });
        events.push({ kind: 'weekly_report_generated', classroomId: classroom.id, weekStart: report.range.startIso });
      } catch (error) {
        this.logger.error?.('[scheduler] weekly report failed', classroom.id, error);
      }
    }
  }
}

export default BreakScheduler;
