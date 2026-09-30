import { all, get, run, tx } from '../db.js';
import { makeId } from '../lib/ids.js';
import { formatDuration, iso, localDayKey, now, percent, weekRange } from '../lib/time.js';
import { summarizeOutcomes } from './breaks.js';

/**
 * Weekly classroom report (deliverable 4).
 *
 * The five headline numbers are defined once, here, and reused by the API, the
 * CSV/PDF exports and the Monday job so the in-app table can never disagree with
 * a downloaded file:
 *
 *   Computer sessions    how many seat sessions ran in the Mon–Fri window
 *   Recommended breaks   breaks the scheduler put in front of students
 *   Completed breaks     breaks that ran to the end of the countdown
 *   Break adherence      completed ÷ (completed + skipped + missed)
 *   Long visual sessions stretches of screen time that ran past the room's
 *                        long-session threshold before a break was taken
 */

/**
 * "Long visual session" has one product-wide definition: an uninterrupted stretch
 * of 45 minutes — double the default 20-minute cadence.
 *
 * The room's own `long_session_min` drives the *live* amber flag on the dashboard,
 * where the room's cadence is the right reference. Reports and school rollups use
 * this fixed threshold instead, because comparing grades only means something if
 * every classroom is judged against the same line.
 */
export const LONG_VISUAL_SESSION_SEC = 45 * 60;

export const METRIC_DEFINITIONS = Object.freeze([
  {
    key: 'computerSessions',
    label: 'Computer sessions',
    unit: 'sessions',
    description: 'Each time a classroom PC joined a lesson session during the week.',
  },
  {
    key: 'recommendedBreaks',
    label: 'Recommended breaks',
    unit: 'breaks',
    description: 'Breaks the schedule asked for, whether or not they were taken.',
  },
  {
    key: 'completedBreaks',
    label: 'Completed breaks',
    unit: 'breaks',
    description: 'Challenges that ran the full countdown.',
  },
  {
    key: 'breakAdherence',
    label: 'Break adherence',
    unit: '%',
    description: 'Completed ÷ (completed + skipped + missed). Breaks not yet due are excluded.',
  },
  {
    key: 'longVisualSessions',
    label: 'Long visual sessions',
    unit: 'stretches',
    description: 'Continuous stretches of 45 minutes or more of screen time before a break.',
  },
]);

/** Rows for the report window, resolved by due date so a break counts in the week it was asked for. */
function breaksInWindow(classroomId, start, end) {
  return all(
    `SELECT b.status, b.due_at, b.started_at, b.resolved_at, b.stretch_sec, b.duration_sec, b.seat_id,
            b.warning_5min_at, b.warning_1min_at, s.label AS seat_label
       FROM break_events b
       JOIN seats s ON s.id = b.seat_id
      WHERE b.classroom_id = ? AND b.due_at >= ? AND b.due_at < ?
      ORDER BY b.due_at`,
    [classroomId, start, end],
  );
}

function sessionsInWindow(classroomId, start, end) {
  return all(
    `SELECT id, seat_id, started_at, ended_at, active_seconds
       FROM seat_sessions
      WHERE classroom_id = ? AND started_at >= ? AND started_at < ?`,
    [classroomId, start, end],
  );
}

export function computeWeeklyReport({ classroomId, atMs = now(), mode = 'last-complete', weeksAgo = 0 } = {}) {
  const classroom = get(
    `SELECT c.*, g.name AS grade_name, g.level AS grade_level, sc.name AS school_name
       FROM classrooms c
       JOIN grades g ON g.id = c.grade_id
       JOIN schools sc ON sc.id = c.school_id
      WHERE c.id = ?`,
    [classroomId],
  );
  if (!classroom) return null;

  const range = weekRange(atMs, { mode, weeksAgo });
  const breaks = breaksInWindow(classroomId, range.start, range.end);
  const sessions = sessionsInWindow(classroomId, range.start, range.end);

  const summary = summarizeOutcomes(breaks);
  const longThresholdSec = LONG_VISUAL_SESSION_SEC;
  const longVisualSessions = breaks.filter((row) => Number(row.stretch_sec) >= longThresholdSec).length;

  const perDay = range.days.map((day) => {
    const dayBreaks = breaks.filter((row) => Number(row.due_at) >= day.start && Number(row.due_at) < day.end);
    const daySessions = sessions.filter(
      (row) => Number(row.started_at) >= day.start && Number(row.started_at) < day.end,
    );
    const daySummary = summarizeOutcomes(dayBreaks);
    return {
      ...day,
      computerSessions: daySessions.length,
      recommendedBreaks: dayBreaks.length,
      completedBreaks: daySummary.completed,
      skippedBreaks: daySummary.skipped,
      missedBreaks: daySummary.missed,
      longVisualSessions: dayBreaks.filter((row) => Number(row.stretch_sec) >= longThresholdSec).length,
      breakAdherence: daySummary.adherencePct,
      activeMinutes: Math.round(daySessions.reduce((total, row) => total + Number(row.active_seconds ?? 0), 0) / 60),
    };
  });

  const bySeat = new Map();
  for (const row of breaks) {
    const entry = bySeat.get(row.seat_id) ?? { seatId: row.seat_id, seatLabel: row.seat_label, rows: [] };
    entry.rows.push(row);
    bySeat.set(row.seat_id, entry);
  }
  const perSeat = [...bySeat.values()]
    .map((entry) => {
      const seatSummary = summarizeOutcomes(entry.rows);
      const seatSessions = sessions.filter((row) => row.seat_id === entry.seatId);
      return {
        seatId: entry.seatId,
        seatLabel: entry.seatLabel,
        computerSessions: seatSessions.length,
        recommendedBreaks: entry.rows.length,
        completedBreaks: seatSummary.completed,
        skippedBreaks: seatSummary.skipped,
        missedBreaks: seatSummary.missed,
        longVisualSessions: entry.rows.filter((row) => Number(row.stretch_sec) >= longThresholdSec).length,
        breakAdherence: seatSummary.adherencePct,
        consecutiveMisses: seatSummary.consecutiveNonCompleted,
        activeMinutes: Math.round(seatSessions.reduce((total, row) => total + Number(row.active_seconds ?? 0), 0) / 60),
      };
    })
    .sort((a, b) => String(a.seatLabel).localeCompare(String(b.seatLabel), undefined, { numeric: true }));

  const totals = {
    computerSessions: sessions.length,
    recommendedBreaks: breaks.length,
    completedBreaks: summary.completed,
    skippedBreaks: summary.skipped,
    missedBreaks: summary.missed,
    pendingBreaks: summary.pending,
    breakAdherence: summary.adherencePct,
    longVisualSessions,
    activeMinutes: Math.round(sessions.reduce((total, row) => total + Number(row.active_seconds ?? 0), 0) / 60),
    seatsReporting: perSeat.length,
  };

  // Week-over-week context: the same window one week earlier, so a teacher can
  // see whether the routine is actually improving.
  const previousRange = weekRange(atMs, { mode, weeksAgo: weeksAgo + 1 });
  const previousBreaks = breaksInWindow(classroomId, previousRange.start, previousRange.end);
  const previousSummary = summarizeOutcomes(previousBreaks);
  const previousSessions = sessionsInWindow(classroomId, previousRange.start, previousRange.end);

  return {
    classroom: {
      id: classroom.id,
      name: classroom.name,
      subject: classroom.subject,
      gradeName: classroom.grade_name,
      gradeLevel: classroom.grade_level,
      schoolName: classroom.school_name,
      breakIntervalMin: classroom.break_interval_min,
      breakDurationSec: classroom.break_duration_sec,
      longSessionMin: classroom.long_session_min,
    },
    range: {
      start: range.start,
      end: range.end,
      startIso: range.startIso,
      endIso: range.endIso,
      label: range.label,
    },
    metrics: METRIC_DEFINITIONS,
    totals,
    perDay,
    perSeat,
    previousWeek: {
      range: { start: previousRange.start, end: previousRange.end, label: previousRange.label },
      totals: {
        computerSessions: previousSessions.length,
        recommendedBreaks: previousBreaks.length,
        completedBreaks: previousSummary.completed,
        breakAdherence: previousSummary.adherencePct,
        longVisualSessions: previousBreaks.filter((row) => Number(row.stretch_sec) >= longThresholdSec).length,
      },
    },
    deltas: {
      adherencePct:
        summary.adherencePct === null || previousSummary.adherencePct === null
          ? null
          : Math.round((summary.adherencePct - previousSummary.adherencePct) * 10) / 10,
      sessions: sessions.length - previousSessions.length,
      recommendedBreaks: breaks.length - previousBreaks.length,
    },
    generatedAt: now(),
  };
}

/** Computes and stores a report snapshot. Idempotent per (classroom, week). */
export function generateWeeklyReport({ classroomId, atMs = now(), mode = 'last-complete', weeksAgo = 0, generatedBy = null, store = true } = {}) {
  const report = computeWeeklyReport({ classroomId, atMs, mode, weeksAgo });
  if (!report) return null;
  if (store) {
    tx(() => {
      const existing = get('SELECT id FROM weekly_reports WHERE classroom_id = ? AND week_start = ?', [
        classroomId,
        report.range.start,
      ]);
      const id = existing?.id ?? makeId('wkr');
      if (existing) {
        run(
          `UPDATE weekly_reports SET generated_at = ?, generated_by = ?, payload = ? WHERE id = ?`,
          [now(), generatedBy, JSON.stringify(report), id],
        );
      } else {
        run(
          `INSERT INTO weekly_reports (id, classroom_id, week_start, week_end, generated_at, generated_by, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            classroomId,
            report.range.start,
            report.range.end,
            now(),
            generatedBy,
            JSON.stringify(report),
          ],
        );
      }
    });
  }
  return report;
}

export function storedReport(classroomId, weekStart) {
  const row = get('SELECT * FROM weekly_reports WHERE classroom_id = ? AND week_start = ?', [
    classroomId,
    weekStart,
  ]);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.payload), storedAt: iso(row.generated_at), storedBy: row.generated_by };
  } catch {
    return null;
  }
}

export function listStoredReports(classroomId) {
  return all(
    `SELECT id, week_start, week_end, generated_at, generated_by FROM weekly_reports
      WHERE classroom_id = ? ORDER BY week_start DESC LIMIT 26`,
    [classroomId],
  ).map((row) => ({
    id: row.id,
    weekStart: iso(row.week_start),
    weekEnd: iso(row.week_end),
    weekLabel: `${localDayKey(row.week_start)} → ${localDayKey(row.week_end - 86_400_000)}`,
    generatedAt: iso(row.generated_at),
    automatic: row.generated_by === null,
  }));
}

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (cells) => cells.map(csvCell).join(',');

/** Sectioned CSV: summary, then the Mon–Fri series, then per-seat detail. */
export function reportToCsv(report) {
  const lines = [];
  lines.push(csvRow(['MyopiaGuard weekly classroom report']));
  lines.push(csvRow(['Classroom', report.classroom.name]));
  lines.push(csvRow(['Subject', report.classroom.subject]));
  lines.push(csvRow(['Grade', report.classroom.gradeName]));
  lines.push(csvRow(['School', report.classroom.schoolName]));
  lines.push(csvRow(['Week', report.range.label]));
  lines.push(csvRow(['Generated', iso(report.generatedAt)]));
  lines.push(csvRow(['Break cadence', `${report.classroom.breakIntervalMin} min / ${report.classroom.breakDurationSec}s`]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Value']));
  for (const metric of METRIC_DEFINITIONS) {
    lines.push(csvRow([metric.label, report.totals[metric.key] ?? '—']));
  }
  lines.push(csvRow(['Active screen time', formatDuration(report.totals.activeMinutes * 60_000)]));
  lines.push(csvRow(['Seats reporting', report.totals.seatsReporting]));
  lines.push('');
  lines.push(csvRow(['Day', 'Computer sessions', 'Recommended breaks', 'Completed', 'Skipped', 'Missed', 'Adherence %', 'Long visual sessions']));
  for (const day of report.perDay) {
    lines.push(
      csvRow([
        day.weekday,
        day.computerSessions,
        day.recommendedBreaks,
        day.completedBreaks,
        day.skippedBreaks,
        day.missedBreaks,
        day.breakAdherence ?? '',
        day.longVisualSessions,
      ]),
    );
  }
  lines.push('');
  lines.push(csvRow(['Seat', 'Computer sessions', 'Recommended', 'Completed', 'Skipped', 'Missed', 'Adherence %', 'Long visual sessions']));
  for (const seat of report.perSeat) {
    lines.push(
      csvRow([
        seat.seatLabel,
        seat.computerSessions,
        seat.recommendedBreaks,
        seat.completedBreaks,
        seat.skippedBreaks,
        seat.missedBreaks,
        seat.breakAdherence ?? '',
        seat.longVisualSessions,
      ]),
    );
  }
  lines.push('');
  lines.push(csvRow(['Note', 'Seats are workstations. MyopiaGuard does not record which student used which computer.']));
  return `${lines.join('\n')}\n`;
}

/** Compact shape for the school analytics rollup (aggregate only). */
export function classroomWeeklyTotals({ classroomId, start, end, longThresholdSec = LONG_VISUAL_SESSION_SEC }) {
  const breaks = breaksInWindow(classroomId, start, end);
  const summary = summarizeOutcomes(breaks);
  const sessions = sessionsInWindow(classroomId, start, end);
  const stretches = breaks.map((row) => Number(row.stretch_sec)).filter((value) => value > 0);
  return {
    computerSessions: sessions.length,
    recommendedBreaks: breaks.length,
    completedBreaks: summary.completed,
    missedBreaks: summary.missed,
    skippedBreaks: summary.skipped,
    breakAdherence: summary.adherencePct,
    longVisualSessions: breaks.filter((row) => Number(row.stretch_sec) >= longThresholdSec).length,
    // Breaks that were put on screen well after the moment they were due — the
    // countdown warning fired and the break still ran late. Distinct from
    // `missedBreaks`, which is about breaks that were never completed at all.
    driftedBreaks: breaks.filter(
      (row) => row.started_at && Number(row.started_at) - Number(row.due_at) > 60_000,
    ).length,
    activeMinutes: Math.round(sessions.reduce((total, row) => total + Number(row.active_seconds ?? 0), 0) / 60),
    meanStretchMinutes: stretches.length
      ? Math.round((stretches.reduce((a, b) => a + b, 0) / stretches.length / 60) * 10) / 10
      : null,
    // Reported so the rollup can apply k-anonymity to the workstation cohort.
    seatsSeen: new Set(sessions.map((row) => row.seat_id)).size,
  };
}
