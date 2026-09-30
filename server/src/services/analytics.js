import config from '../config.js';
import { all } from '../db.js';
import { iso, monthRanges, now, percent, weekRange } from '../lib/time.js';
import { classroomWeeklyTotals } from './reports.js';

/**
 * School analytics (deliverable 5): Computer → Classroom → Grade → School, in
 * aggregate only.
 *
 * Two independent mechanisms keep this layer blind to individuals:
 *
 *   1. **No seat columns exist in the queries.** Every number below comes from
 *      GROUP BY classroom/grade/subject queries that never select a seat id or a
 *      seat label. There is no per-seat row to forget to filter, and no route
 *      parameter that could request one.
 *   2. **k-anonymity suppression.** A rollup cell built from fewer than
 *      `config.minCohortSeats` workstations is suppressed rather than reported, so
 *      a tiny cohort cannot be reverse-engineered by elimination in a small school.
 *      (School-wide totals are exempt: they are the whole population.)
 *
 * The role check in routes/analytics.js stops the wrong person; `aggregateOnlyGuard`
 * in lib/http.js then inspects the finished response body and refuses to send it if
 * any seat-shaped identifier or value appears. Three layers, one promise.
 */

export const ISSUE_TAXONOMY = Object.freeze([
  {
    code: 'long_sessions',
    label: 'Long uninterrupted sessions',
    description: 'Stretches of screen time that ran past the recommended limit before a break was taken.',
  },
  {
    code: 'missed_breaks',
    label: 'Missed and skipped breaks',
    description: 'Breaks the schedule recommended that students did not complete.',
  },
  {
    code: 'break_drift',
    label: 'Breaks drifting past the warning',
    description: 'Breaks where the countdown warning fired and the challenge still went unfinished.',
  },
]);

/** Rollup for one classroom over a window. Aggregate counters only. */
function classroomRollup(classroom, start, end) {
  // One product-wide "long visual session" threshold, so grade rollups compare
  // like with like across rooms that run different cadences.
  const totals = classroomWeeklyTotals({ classroomId: classroom.id, start, end });
  const longShare = totals.recommendedBreaks ? totals.longVisualSessions / totals.recommendedBreaks : 0;
  const missShare = totals.recommendedBreaks ? (totals.missedBreaks + totals.skippedBreaks) / totals.recommendedBreaks : 0;
  const driftShare = totals.recommendedBreaks ? totals.driftedBreaks / totals.recommendedBreaks : 0;
  const minutesPerSeat = totals.seatsSeen ? totals.activeMinutes / totals.seatsSeen : 0;
  return {
    classroomId: classroom.id,
    classroomName: classroom.name,
    subject: classroom.subject,
    gradeName: classroom.grade_name,
    gradeLevel: classroom.grade_level,
    contributorSeats: totals.seatsSeen,
    computerSessions: totals.computerSessions,
    recommendedBreaks: totals.recommendedBreaks,
    completedBreaks: totals.completedBreaks,
    missedBreaks: totals.missedBreaks,
    skippedBreaks: totals.skippedBreaks,
    longVisualSessions: totals.longVisualSessions,
    driftedBreaks: totals.driftedBreaks,
    activeMinutes: totals.activeMinutes,
    activeMinutesPerWorkstation: totals.seatsSeen ? Math.round(minutesPerSeat) : null,
    breakAdherence: totals.breakAdherence,
    meanStretchMinutes: totals.meanStretchMinutes,
    /** Visual-load index = mean uninterrupted stretch before a break, in minutes. */
    visualLoadIndex: totals.meanStretchMinutes,
    signals: {
      longShare: Math.round(longShare * 1000) / 1000,
      missShare: Math.round(missShare * 1000) / 1000,
      driftShare: Math.round(driftShare * 1000) / 1000,
      minutesPerSeat: Math.round(minutesPerSeat),
    },
  };
}

/**
 * Applies k-anonymity to a rollup row. A suppressed row keeps its identity (so
 * the UI can show "2 classrooms withheld") but carries no metrics.
 */
function applyCohortSuppression(row, minCohortSeats) {
  if (Number(row.contributorSeats ?? 0) >= minCohortSeats) {
    return { ...row, suppressed: false };
  }
  return {
    classroomId: row.classroomId,
    classroomName: row.classroomName,
    subject: row.subject,
    gradeName: row.gradeName,
    gradeLevel: row.gradeLevel,
    contributorSeats: null,
    suppressed: true,
    // English sentence for API consumers; the client composes its own sentence
    // from `suppressionParams` so a translated board is not stitched together
    // from an English fragment.
    suppressionReason: `Fewer than ${minCohortSeats} workstations contributed in this window.`,
    suppressionParams: { minCohortSeats },
  };
}

function aggregate(rows) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.computerSessions += row.computerSessions ?? 0;
      acc.recommendedBreaks += row.recommendedBreaks ?? 0;
      acc.completedBreaks += row.completedBreaks ?? 0;
      acc.missedBreaks += row.missedBreaks ?? 0;
      acc.skippedBreaks += row.skippedBreaks ?? 0;
      acc.longVisualSessions += row.longVisualSessions ?? 0;
      acc.driftedBreaks += row.driftedBreaks ?? 0;
      acc.activeMinutes += row.activeMinutes ?? 0;
      acc.contributorSeats += row.contributorSeats ?? 0;
      acc.longShareSum += row.signals?.longShare ?? 0;
      acc.missShareSum += row.signals?.missShare ?? 0;
      acc.stretchSum += row.meanStretchMinutes ?? 0;
      acc.stretchCount += row.meanStretchMinutes === null || row.meanStretchMinutes === undefined ? 0 : 1;
      return acc;
    },
    {
      computerSessions: 0,
      recommendedBreaks: 0,
      completedBreaks: 0,
      missedBreaks: 0,
      skippedBreaks: 0,
      longVisualSessions: 0,
      driftedBreaks: 0,
      activeMinutes: 0,
      contributorSeats: 0,
      longShareSum: 0,
      missShareSum: 0,
      stretchSum: 0,
      stretchCount: 0,
    },
  );
  const resolved = totals.completedBreaks + totals.missedBreaks + totals.skippedBreaks;
  return {
    classrooms: rows.length,
    computersReporting: totals.contributorSeats,
    computerSessions: totals.computerSessions,
    recommendedBreaks: totals.recommendedBreaks,
    completedBreaks: totals.completedBreaks,
    missedBreaks: totals.missedBreaks,
    skippedBreaks: totals.skippedBreaks,
    longVisualSessions: totals.longVisualSessions,
    driftedBreaks: totals.driftedBreaks,
    activeHours: Math.round((totals.activeMinutes / 60) * 10) / 10,
    activeMinutes: totals.activeMinutes,
    breakAdherence: resolved === 0 ? null : percent(totals.completedBreaks, resolved),
    meanStretchMinutes: totals.stretchCount ? Math.round((totals.stretchSum / totals.stretchCount) * 10) / 10 : null,
    avgLongShare: rows.length ? Math.round((totals.longShareSum / rows.length) * 1000) / 1000 : 0,
    avgMissShare: rows.length ? Math.round((totals.missShareSum / rows.length) * 1000) / 1000 : 0,
  };
}

function gradeRollups(classroomRows, gradesById, minCohortSeats) {
  const byGrade = new Map();
  for (const row of classroomRows) {
    const bucket = byGrade.get(row.gradeLevel) ?? [];
    bucket.push(row);
    byGrade.set(row.gradeLevel, bucket);
  }
  return [...byGrade.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, rows]) => {
      const totals = aggregate(rows.map((row) => ({ ...row, signals: row.signals })));
      const cohort = rows.reduce((total, row) => total + (row.contributorSeats ?? 0), 0);
      const suppressed = cohort < minCohortSeats;
      const grade = gradesById.get(level);
      return {
        gradeLevel: level,
        gradeName: grade?.name ?? `Grade ${level}`,
        classrooms: rows.length,
        suppressed,
        suppressionReason: suppressed ? `Fewer than ${minCohortSeats} workstations contributed.` : null,
        suppressionParams: suppressed ? { minCohortSeats } : null,
        ...(suppressed
          ? { contributorSeats: null }
          : {
              contributorSeats: cohort,
              breakAdherence: totals.breakAdherence,
              computerSessions: totals.computerSessions,
              recommendedBreaks: totals.recommendedBreaks,
              longVisualSessions: totals.longVisualSessions,
              activeHours: totals.activeHours,
              meanStretchMinutes: totals.meanStretchMinutes,
            }),
      };
    });
}

/**
 * Dominant issue across the school.
 *
 * Every candidate is expressed as the same unit — a share of the breaks the
 * schedule recommended — so the ranking compares like with like. A previous
 * version mixed "share of breaks" with "minutes per hour", which let a
 * minutes-based signal win on scale rather than on prevalence.
 */
function dominantIssue(schoolTotals, rows) {
  const totalBreaks = Math.max(1, schoolTotals.recommendedBreaks);
  const missShare = (schoolTotals.missedBreaks + schoolTotals.skippedBreaks) / totalBreaks;
  const longShare = schoolTotals.longVisualSessions / totalBreaks;
  const driftShare = schoolTotals.driftedBreaks / totalBreaks;

  const scores = [
    {
      code: 'missed_breaks',
      share: missShare,
      affectedClassrooms: rows.filter((row) => (row.signals?.missShare ?? 0) > 0.2).length,
      detail: `${schoolTotals.missedBreaks + schoolTotals.skippedBreaks} of ${schoolTotals.recommendedBreaks} recommended breaks were not completed.`,
      params: {
        missed: schoolTotals.missedBreaks + schoolTotals.skippedBreaks,
        recommended: schoolTotals.recommendedBreaks,
      },
    },
    {
      code: 'break_drift',
      share: driftShare,
      affectedClassrooms: rows.filter((row) => (row.signals?.driftShare ?? 0) > 0.2).length,
      detail: `${schoolTotals.driftedBreaks} breaks were warned about and still went unfinished.`,
      params: { drifted: schoolTotals.driftedBreaks },
    },
    {
      code: 'long_sessions',
      share: longShare,
      affectedClassrooms: rows.filter((row) => (row.signals?.longShare ?? 0) > 0.1).length,
      detail: `${schoolTotals.longVisualSessions} breaks followed a stretch of 45 minutes or more.`,
      params: { long: schoolTotals.longVisualSessions },
    },
  ].sort((a, b) => b.share - a.share);

  const top = scores[0] ?? { code: 'none', share: 0, affectedClassrooms: 0, detail: '' };
  const meta = ISSUE_TAXONOMY.find((entry) => entry.code === top.code) ?? ISSUE_TAXONOMY[0];
  return {
    code: top.code,
    label: meta.label,
    description: meta.description,
    detail: top.detail,
    params: top.params ?? {},
    share: Math.round(top.share * 1000) / 10,
    affectedClassrooms: top.affectedClassrooms,
    ranking: scores.map((score) => {
      const entry = ISSUE_TAXONOMY.find((item) => item.code === score.code);
      return {
        code: score.code,
        label: entry?.label ?? score.code,
        share: Math.round(score.share * 1000) / 10,
        affectedClassrooms: score.affectedClassrooms,
        detail: score.detail,
        params: score.params ?? {},
      };
    }),
    unit: 'share of recommended breaks',
  };
}

/**
 * Drops leading trend buckets that contain no teaching at all (weeks before the
 * school had data). A chart with four empty weeks in front of four real ones reads
 * as broken rather than as new; the buckets that are genuinely zero later in the
 * series are kept, because a real drop to zero is information.
 */
function trimEmptyLeadingPoints(points) {
  const firstWithData = points.findIndex((point) => (point.classroomsReporting ?? 0) > 0);
  return firstWithData <= 0 ? points : points.slice(firstWithData);
}

export function schoolAnalytics({ schoolId, atMs = now(), windowDays = 7, storable = true } = {}) {
  const minCohortSeats = config.minCohortSeats;
  const school = all('SELECT * FROM schools WHERE id = ?', [schoolId])[0] ?? null;
  const classrooms = all(
    `SELECT c.id, c.name, c.subject, g.name AS grade_name, g.level AS grade_level
       FROM classrooms c JOIN grades g ON g.id = c.grade_id
      WHERE c.school_id = ? ORDER BY g.level, c.name`,
    [schoolId],
  );
  const grades = all('SELECT * FROM grades WHERE school_id = ? ORDER BY level', [schoolId]);
  const gradesById = new Map(grades.map((grade) => [grade.level, grade]));

  const end = atMs;
  const start = atMs - windowDays * 86_400_000;
  const rows = classrooms.map((classroom) => classroomRollup(classroom, start, end));
  const suppressedRows = rows.map((row) => applyCohortSuppression(row, minCohortSeats));
  const usable = rows.filter((row) => (row.contributorSeats ?? 0) >= minCohortSeats);

  const schoolTotals = aggregate(usable);
  const byGrade = gradeRollups(rows, gradesById, minCohortSeats);

  const bySubject = new Map();
  for (const row of usable) {
    const bucket = bySubject.get(row.subject) ?? [];
    bucket.push(row);
    bySubject.set(row.subject, bucket);
  }
  const subjectRollups = [...bySubject.entries()]
    .map(([subject, entries]) => ({ subject, ...aggregate(entries) }))
    .sort((a, b) => (b.meanStretchMinutes ?? 0) - (a.meanStretchMinutes ?? 0));

  // Highest visual load: rank rooms and subjects by mean uninterrupted stretch.
  const visualLoad = {
    byClassroom: [...usable]
      .sort((a, b) => (b.visualLoadIndex ?? 0) - (a.visualLoadIndex ?? 0))
      .slice(0, 5)
      .map((row) => ({
        classroomName: row.classroomName,
        subject: row.subject,
        gradeName: row.gradeName,
        visualLoadIndex: row.visualLoadIndex,
        meanStretchMinutes: row.meanStretchMinutes,
        activeMinutesPerWorkstation: row.activeMinutesPerWorkstation,
        breakAdherence: row.breakAdherence,
      })),
    bySubject: subjectRollups.slice(0, 5).map((row) => ({
      subject: row.subject,
      visualLoadIndex: row.meanStretchMinutes,
      classrooms: row.classrooms,
      breakAdherence: row.breakAdherence,
      activeHours: row.activeHours,
    })),
  };

  // School-level trend, weekly and monthly.
  //
  // weeksAgo 0 is the most recent week that has already finished, so 7…0 walks back
  // eight consecutive closed weeks: no repeat of the current week, no partial week.
  const weeklyTrend = [];
  for (let weeksAgo = 7; weeksAgo >= 0; weeksAgo -= 1) {
    const range = weekRange(atMs, { mode: 'last-complete', weeksAgo });
    const windowRows = classrooms.map((classroom) => classroomRollup(classroom, range.start, range.end));
    const usableRows = windowRows.filter((row) => (row.contributorSeats ?? 0) >= minCohortSeats);
    const totals = aggregate(usableRows);
    weeklyTrend.push({
      period: 'week',
      // Kept for API consumers; the UI formats `start` itself.
      label: `w/c ${range.label.split(' → ')[0]}`,
      weekStart: range.start,
      weekEnd: range.end,
      start: range.start,
      end: range.end,
      breakAdherence: totals.breakAdherence,
      computerSessions: totals.computerSessions,
      longVisualSessions: totals.longVisualSessions,
      activeHours: totals.activeHours,
      classroomsReporting: usableRows.length,
    });
  }

  const trimmedWeeklyTrend = trimEmptyLeadingPoints(weeklyTrend);

  const monthlyTrend = monthRanges(atMs, 6).map((range) => {
    const windowRows = classrooms.map((classroom) => classroomRollup(classroom, range.start, range.end));
    const usableRows = windowRows.filter((row) => (row.contributorSeats ?? 0) >= minCohortSeats);
    const totals = aggregate(usableRows);
    return {
      period: 'month',
      label: range.label,
      weekStart: range.start,
      weekEnd: range.end,
      start: range.start,
      end: range.end,
      breakAdherence: totals.breakAdherence,
      computerSessions: totals.computerSessions,
      longVisualSessions: totals.longVisualSessions,
      activeHours: totals.activeHours,
      classroomsReporting: usableRows.length,
    };
  });

  return {
    school: {
      id: school?.id ?? schoolId,
      name: school?.name ?? 'School',
    },
    window: {
      start,
      end,
      startIso: iso(start),
      endIso: iso(end),
      days: windowDays,
      // Kept for API consumers; the UI composes from `days`.
      label: `Last ${windowDays} days`,
    },
    privacy: {
      aggregateOnly: true,
      minCohortSeats,
      suppressedClassrooms: suppressedRows.filter((row) => row.suppressed).length,
      note: 'Every figure is rolled up to classroom, grade, subject or school level. MyopiaGuard does not report on individual workstations or students at this layer.',
    },
    headline: {
      ...schoolTotals,
      classrooms: classrooms.length,
      grades: grades.length,
    },
    byGrade,
    byClassroom: suppressedRows.map((row) => ({
      classroomId: row.classroomId,
      classroomName: row.classroomName,
      subject: row.subject,
      gradeName: row.gradeName,
      gradeLevel: row.gradeLevel,
      suppressed: row.suppressed,
      suppressionReason: row.suppressionReason ?? null,
      suppressionParams: row.suppressionParams ?? null,
      ...(row.suppressed
        ? {}
        : {
            computersReporting: row.contributorSeats,
            breakAdherence: row.breakAdherence,
            computerSessions: row.computerSessions,
            recommendedBreaks: row.recommendedBreaks,
            longVisualSessions: row.longVisualSessions,
            activeHours: Math.round((row.activeMinutes / 60) * 10) / 10,
            meanStretchMinutes: row.meanStretchMinutes,
            activeMinutesPerWorkstation: row.activeMinutesPerWorkstation,
            visualLoadIndex: row.visualLoadIndex,
          }),
    })),
    visualLoad,
    commonIssue: dominantIssue(schoolTotals, usable),
    issueTaxonomy: ISSUE_TAXONOMY,
    trend: { weekly: trimmedWeeklyTrend, monthly: trimEmptyLeadingPoints(monthlyTrend) },
    generatedAt: atMs,
    storable,
  };
}
