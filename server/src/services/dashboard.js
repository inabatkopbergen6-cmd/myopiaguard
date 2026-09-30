import { all, get } from '../db.js';
import { localDayKey, now, percent, startOfLocalDay } from '../lib/time.js';
import { activeStretchSeconds, isLongStretch, summarizeOutcomes } from './breaks.js';
import { classroomConfig, getLiveLessonSession } from './sessionState.js';

/**
 * Builds the live classroom snapshot behind the teacher dashboard (deliverable 1).
 *
 * Everything in here is derived from event rows at read time rather than cached
 * counters, so the board cannot drift: if a heartbeat is late, the seat is
 * offline; if a stretch is long, it is amber. Two windows are reported side by
 * side — the lesson in progress, and the school day so far — because "this
 * session" and "today" answer different questions.
 *
 * Identity note: a snapshot is keyed by seat, and a seat has no student field to
 * leak. The only human-readable strings here are machine labels from `seats.label`,
 * which lib/validation.js constrains to the "PC-01" / "Seat 12" shape.
 */

export const SEAT_STATUS = Object.freeze({
  ACTIVE: 'active',
  ON_BREAK: 'on_break',
  OFFLINE: 'offline',
  IDLE: 'idle',
  ENDED: 'ended',
});

export const ATTENTION_CODES = Object.freeze({
  REPEAT_MISSES: 'repeat_misses',
  LONG_SESSION: 'long_session',
  OFFLINE_MID_SESSION: 'offline_mid_session',
  OFFLINE_MID_BREAK: 'offline_mid_break',
});

const ATTENTION_META = {
  [ATTENTION_CODES.REPEAT_MISSES]: { severity: 'high', label: 'Missed 2+ breaks in a row' },
  [ATTENTION_CODES.LONG_SESSION]: { severity: 'high', label: 'Long uninterrupted session' },
  [ATTENTION_CODES.OFFLINE_MID_BREAK]: { severity: 'high', label: 'Went offline during a break' },
  [ATTENTION_CODES.OFFLINE_MID_SESSION]: { severity: 'medium', label: 'Offline mid-session' },
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function breaksBetween(classroomId, start, end) {
  return all(
    `SELECT id, seat_id, seat_session_id, status, due_at, started_at, resolved_at, duration_sec,
            stretch_sec, instruction_key, warning_5min_at, warning_1min_at
       FROM break_events
      WHERE classroom_id = ? AND due_at >= ? AND due_at < ?
      ORDER BY due_at`,
    [classroomId, start, end],
  );
}

function liveSeatSessions(lessonSessionId) {
  return all(
    `SELECT * FROM seat_sessions WHERE lesson_session_id = ? AND state != 'ended'`,
    [lessonSessionId],
  );
}

export function classroomContext(classroomId) {
  return get(
    `SELECT c.*, g.name AS grade_name, g.level AS grade_level, sc.name AS school_name
       FROM classrooms c
       JOIN grades g ON g.id = c.grade_id
       JOIN schools sc ON sc.id = c.school_id
      WHERE c.id = ?`,
    [classroomId],
  );
}

export function buildClassroomSnapshot({ classroomId, atMs = now(), trendDays = 5 } = {}) {
  const classroom = classroomContext(classroomId);
  if (!classroom) return null;

  const config = classroomConfig(classroomId);
  const offlineMs = Number(config.offline_after_sec) * 1000;
  const lessonSession = getLiveLessonSession(classroomId);
  const seats = all('SELECT * FROM seats WHERE classroom_id = ? ORDER BY seat_index', [classroomId]);

  const todayStart = startOfLocalDay(atMs);
  const todayBreaks = breaksBetween(classroomId, todayStart, atMs + 1);
  const todayBySeat = groupBy(todayBreaks, (row) => row.seat_id);

  const sessionBreaks = lessonSession
    ? breaksBetween(classroomId, Number(lessonSession.started_at), atMs + 1)
    : [];
  const sessionBySeat = groupBy(sessionBreaks, (row) => row.seat_id);

  const seatSessions = lessonSession ? liveSeatSessions(lessonSession.id) : [];
  const sessionBySeatId = new Map(seatSessions.map((row) => [row.seat_id, row]));

  // Five-day adherence trend per seat, for the detail card's sparkline.
  const trendStart = todayStart - (trendDays - 1) * 86_400_000;
  const trendRows = breaksBetween(classroomId, trendStart, atMs + 1);
  const trendBySeatDay = new Map();
  for (const row of trendRows) {
    const key = `${row.seat_id}|${localDayKey(Number(row.due_at))}`;
    const bucket = trendBySeatDay.get(key) ?? [];
    bucket.push(row);
    trendBySeatDay.set(key, bucket);
  }

  const seatViews = seats.map((seat) => {
    const seatSession = sessionBySeatId.get(seat.id) ?? null;
    const sessionCounters = summarizeOutcomes(sessionBySeat.get(seat.id) ?? []);
    const todayCounters = summarizeOutcomes(todayBySeat.get(seat.id) ?? []);
    const online = seatSession
      ? atMs - Number(seatSession.last_heartbeat_at) <= offlineMs
      : seat.last_seen_at
        ? atMs - Number(seat.last_seen_at) <= offlineMs
        : false;

    const openBreak = (sessionBySeat.get(seat.id) ?? []).find(
      (row) => row.status === 'pending' || row.status === 'in_progress',
    ) ?? null;

    let status = SEAT_STATUS.IDLE;
    if (seatSession) {
      if (!online) status = SEAT_STATUS.OFFLINE;
      else if (seatSession.state === 'on_break') status = SEAT_STATUS.ON_BREAK;
      else status = SEAT_STATUS.ACTIVE;
    } else if (!online) {
      status = SEAT_STATUS.OFFLINE;
    }

    const stretchSeconds = seatSession ? activeStretchSeconds(seatSession, atMs) : 0;
    const longStretch = seatSession ? isLongStretch(stretchSeconds, config.long_session_min) : false;

    const trend = Array.from({ length: trendDays }, (_, index) => {
      const dayStart = trendStart + index * 86_400_000;
      const dayKey = localDayKey(dayStart);
      const rows = trendBySeatDay.get(`${seat.id}|${dayKey}`) ?? [];
      const summary = summarizeOutcomes(rows);
      return {
        dayKey,
        start: dayStart,
        adherencePct: summary.adherencePct,
        resolved: summary.resolved,
        missed: summary.missed + summary.skipped,
      };
    });

    const flags = [];
    if (sessionCounters.consecutiveNonCompleted >= 2) {
      flags.push({
        code: ATTENTION_CODES.REPEAT_MISSES,
        ...ATTENTION_META[ATTENTION_CODES.REPEAT_MISSES],
        // `detail` is the English sentence, kept for API consumers. The client
        // composes its own from these numbers so a translated board is not
        // stitched together from half-English fragments.
        detail: `${sessionCounters.consecutiveNonCompleted} breaks in a row not completed.`,
        streak: sessionCounters.consecutiveNonCompleted,
        params: { streak: sessionCounters.consecutiveNonCompleted },
      });
    }
    if (longStretch) {
      flags.push({
        code: ATTENTION_CODES.LONG_SESSION,
        ...ATTENTION_META[ATTENTION_CODES.LONG_SESSION],
        detail: `${Math.round(stretchSeconds / 60)} min without a completed break (threshold ${config.long_session_min} min).`,
        stretchSeconds,
        params: { minutes: Math.round(stretchSeconds / 60), threshold: Number(config.long_session_min) },
      });
    }
    if (seatSession && !online) {
      const duringBreak = seatSession.state === 'on_break' || openBreak?.status === 'in_progress';
      const code = duringBreak ? ATTENTION_CODES.OFFLINE_MID_BREAK : ATTENTION_CODES.OFFLINE_MID_SESSION;
      const silentSeconds = Math.round((atMs - Number(seatSession.last_heartbeat_at)) / 1000);
      flags.push({
        code,
        ...ATTENTION_META[code],
        detail: duringBreak
          ? 'Lost contact while the break overlay was on screen.'
          : `No heartbeat for ${silentSeconds}s.`,
        lastHeartbeatAt: Number(seatSession.last_heartbeat_at),
        params: { seconds: silentSeconds },
      });
    }

    return {
      seatId: seat.id,
      label: seat.label,
      seatIndex: seat.seat_index,
      status,
      online,
      lastSeenAt: seatSession ? Number(seatSession.last_heartbeat_at) : seat.last_seen_at ? Number(seat.last_seen_at) : null,
      session: seatSession
        ? {
            id: seatSession.id,
            startedAt: Number(seatSession.started_at),
            state: seatSession.state,
            activeSeconds: Number(seatSession.active_seconds ?? 0),
            stretchSeconds,
            totalActiveSeconds: Number(seatSession.active_seconds ?? 0) + stretchSeconds,
            lastBreakAt: seatSession.last_break_at ? Number(seatSession.last_break_at) : null,
            agentVersion: seatSession.agent_version ?? null,
          }
        : null,
      currentBreak: openBreak
        ? {
            id: openBreak.id,
            status: openBreak.status,
            dueAt: Number(openBreak.due_at),
            startedAt: openBreak.started_at ? Number(openBreak.started_at) : null,
            durationSec: Number(openBreak.duration_sec),
            instructionKey: openBreak.instruction_key ?? null,
            stretchSeconds: Number(openBreak.stretch_sec ?? 0),
          }
        : null,
      nextBreakAt: openBreak && openBreak.status === 'pending' ? Number(openBreak.due_at) : null,
      secondsToNextBreak:
        openBreak && openBreak.status === 'pending'
          ? Math.max(0, Math.round((Number(openBreak.due_at) - atMs) / 1000))
          : null,
      counters: { today: todayCounters, session: sessionCounters },
      adherencePct: todayCounters.adherencePct,
      longStretch,
      flags,
      trend,
    };
  });

  const summaries = seatViews.map((seat) => seat.counters.today);
  const totals = summaries.reduce(
    (acc, summary) => {
      acc.completed += summary.completed;
      acc.skipped += summary.skipped;
      acc.missed += summary.missed;
      acc.resolved += summary.resolved;
      acc.pending += summary.pending;
      return acc;
    },
    { completed: 0, skipped: 0, missed: 0, resolved: 0, pending: 0 },
  );
  const seatAdherenceValues = summaries.map((s) => s.adherencePct).filter((value) => value !== null);

  const attention = seatViews
    .filter((seat) => seat.flags.length > 0)
    .map((seat) => {
      const worst = [...seat.flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])[0];
      return {
        seatId: seat.seatId,
        label: seat.label,
        severity: worst.severity,
        headline: worst.label,
        codes: seat.flags.map((flag) => flag.code),
        flags: seat.flags,
        status: seat.status,
        adherencePct: seat.adherencePct,
        // One line a teacher can act on without reading the whole card.
        detail:
          seat.flags.find((flag) => flag.detail)?.detail ??
          'Needs a check-in during the next break window.',
        counters: seat.counters.today,
      };
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.label.localeCompare(b.label));

  return {
    classroom: {
      id: classroom.id,
      name: classroom.name,
      subject: classroom.subject,
      gradeName: classroom.grade_name,
      gradeLevel: classroom.grade_level,
      schoolId: classroom.school_id,
      schoolName: classroom.school_name,
      /** Language the classroom PCs in this room display. */
      language: classroom.language ?? 'en',
      breakIntervalMin: classroom.break_interval_min,
      breakDurationSec: classroom.break_duration_sec,
      warnLead5Min: Boolean(classroom.warn_lead_5min),
      warnLead1Min: Boolean(classroom.warn_lead_1min),
      longSessionMin: classroom.long_session_min,
      missedBreakGraceSec: classroom.missed_break_grace_sec,
      offlineAfterSec: classroom.offline_after_sec,
    },
    lessonSession: lessonSession
      ? {
          id: lessonSession.id,
          subject: lessonSession.subject,
          startedAt: Number(lessonSession.started_at),
          status: lessonSession.status,
        }
      : null,
    window: { kind: 'today', start: todayStart, label: 'Today' },
    generatedAt: atMs,
    counts: {
      seats: seatViews.length,
      active: seatViews.filter((seat) => seat.status === SEAT_STATUS.ACTIVE).length,
      onBreak: seatViews.filter((seat) => seat.status === SEAT_STATUS.ON_BREAK).length,
      offline: seatViews.filter((seat) => seat.status === SEAT_STATUS.OFFLINE).length,
      idle: seatViews.filter((seat) => seat.status === SEAT_STATUS.IDLE).length,
      flagged: attention.length,
    },
    classAdherence: {
      ...totals,
      adherencePct: totals.resolved === 0 ? null : percent(totals.completed, totals.resolved),
      meanSeatAdherencePct:
        seatAdherenceValues.length === 0
          ? null
          : Math.round((seatAdherenceValues.reduce((a, b) => a + b, 0) / seatAdherenceValues.length) * 10) / 10,
    },
    seats: seatViews,
    attention,
  };
}

/** Detail card for one seat: session length, last break, adherence trend, recent breaks. */
export function buildSeatDetail({ seatId, atMs = now(), historyLimit = 12 } = {}) {
  const seat = get('SELECT * FROM seats WHERE id = ?', [seatId]);
  if (!seat) return null;
  const snapshot = buildClassroomSnapshot({ classroomId: seat.classroom_id, atMs });
  const seatView = snapshot?.seats.find((entry) => entry.seatId === seatId);
  if (!seatView) return null;

  const recentBreaks = all(
    `SELECT id, status, due_at, started_at, resolved_at, completed_at, duration_sec, stretch_sec,
            instruction_key, warning_5min_at, warning_1min_at, note
       FROM break_events
      WHERE seat_id = ?
      ORDER BY due_at DESC LIMIT ?`,
    [seatId, historyLimit],
  ).map((row) => ({
    id: row.id,
    status: row.status,
    dueAt: Number(row.due_at),
    startedAt: row.started_at ? Number(row.started_at) : null,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    durationSec: Number(row.duration_sec),
    stretchSeconds: Number(row.stretch_sec ?? 0),
    instructionKey: row.instruction_key ?? null,
    warned: Boolean(row.warning_5min_at || row.warning_1min_at),
    note: row.note ?? null,
  }));

  const todaySessions = all(
    `SELECT id, started_at, ended_at, active_seconds FROM seat_sessions
      WHERE seat_id = ? AND started_at >= ?
      ORDER BY started_at DESC`,
    [seatId, startOfLocalDay(atMs)],
  ).map((row) => ({
    id: row.id,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at ? Number(row.ended_at) : null,
    activeSeconds: Number(row.active_seconds ?? 0),
  }));

  return {
    seat: {
      seatId: seat.id,
      label: seat.label,
      seatIndex: seat.seat_index,
      classroomId: seat.classroom_id,
      classroomName: snapshot.classroom.name,
      gradeName: snapshot.classroom.gradeName,
    },
    status: seatView.status,
    session: seatView.session,
    currentBreak: seatView.currentBreak,
    nextBreakAt: seatView.nextBreakAt,
    secondsToNextBreak: seatView.secondsToNextBreak,
    counters: seatView.counters,
    flags: seatView.flags,
    trend: seatView.trend,
    recentBreaks,
    todaySessions,
    generatedAt: atMs,
  };
}

/** All classrooms a school has, for the admin picker (names only, no seats). */
export function classroomIndex(schoolId) {
  return all(
    `SELECT c.id, c.name, c.subject, g.name AS grade_name, g.level AS grade_level
       FROM classrooms c JOIN grades g ON g.id = c.grade_id
      WHERE c.school_id = ? ORDER BY g.level, c.name`,
    [schoolId],
  );
}
