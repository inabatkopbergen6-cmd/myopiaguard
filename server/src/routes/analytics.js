import express from 'express';
import { authenticate, requireUser } from '../auth.js';
import { ApiError, aggregateOnlyGuard, handler, intParam } from '../lib/http.js';
import { isForbiddenKey } from '../lib/http.js';
import { iso, now } from '../lib/time.js';
import { ISSUE_TAXONOMY, schoolAnalytics } from '../services/analytics.js';

/**
 * School analytics (deliverable 5) — the admin-only aggregate layer.
 *
 * Four independent controls protect this surface, because "aggregate only" has to
 * survive a future maintainer adding a convenient endpoint:
 *
 *   1. `requireUser('admin')` — only the school admin role reaches it at all.
 *   2. `rejectIdentifierParams()` — a request that *asks* for seat-level data is
 *      refused by name rather than silently ignored, so the boundary is visible in
 *      the API contract instead of only in the response body.
 *   3. `aggregateOnlyGuard()` — inspects the finished response body and refuses to
 *      send anything containing a seat/student identifier or a seat-label-shaped
 *      value. A route here physically cannot return a row about one machine.
 *   4. k-anonymity suppression inside the analytics service — cells built from
 *      fewer than `config.minCohortSeats` workstations are withheld, not reported.
 *
 * There is deliberately no `/seats` route on this router.
 */
const router = express.Router();

/** Refuses `?seatId=…`-style requests explicitly (400) instead of quietly ignoring them. */
function rejectIdentifierParams(req, res, next) {
  const offenders = Object.keys(req.query ?? {}).filter((key) => isForbiddenKey(key));
  if (offenders.length > 0) {
    return next(
      new ApiError(400, 'seat_level_not_available', {
        params: offenders,
        reason:
          'The school analytics layer is aggregate-only. It reports on grades, classrooms and subjects, never on individual workstations or students.',
      }),
    );
  }
  return next();
}

router.use(authenticate, requireUser('admin'), rejectIdentifierParams, aggregateOnlyGuard());

router.get(
  '/school',
  handler((req, res) => {
    const windowDays = intParam(req.query.windowDays, 7, { min: 1, max: 180 });
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays });
    res.json({
      ...analytics,
      exportUrls: {
        csv: `/api/analytics/school/export.csv?windowDays=${windowDays}`,
      },
      access: {
        role: req.auth.role,
        seatDrilldown: false,
        note: 'Admins see grade, classroom and subject rollups. Seat- and student-level data is not available at this layer.',
      },
    });
  }),
);

router.get(
  '/school/trend',
  handler((req, res) => {
    const windowDays = intParam(req.query.windowDays, 7, { min: 1, max: 180 });
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays });
    res.json({
      trend: analytics.trend,
      window: analytics.window,
      privacy: analytics.privacy,
    });
  }),
);

router.get(
  '/grades',
  handler((req, res) => {
    const windowDays = intParam(req.query.windowDays, 7, { min: 1, max: 180 });
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays });
    res.json({ byGrade: analytics.byGrade, window: analytics.window, privacy: analytics.privacy });
  }),
);

/** Aggregate rollup for one classroom: counters only, never its machines. */
router.get(
  '/classrooms/:classroomId/rollup',
  handler((req, res) => {
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays: intParam(req.query.windowDays, 7, { min: 1, max: 180 }) });
    const row = analytics.byClassroom.find((entry) => entry.classroomId === req.params.classroomId);
    if (!row) {
      // Not an error the admin can act on: either it is another school's room or it
      // did not exist in this window. Same response either way.
      throw ApiError.notFound('classroom rollup');
    }
    res.json({
      classroom: row,
      school: analytics.school,
      window: analytics.window,
      privacy: analytics.privacy,
      note: 'Classroom-level rollup. Workstation-level detail is not exposed at the admin layer.',
    });
  }),
);

router.get(
  '/issues',
  handler((req, res) => {
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays: intParam(req.query.windowDays, 7, { min: 1, max: 180 }) });
    res.json({
      commonIssue: analytics.commonIssue,
      taxonomy: ISSUE_TAXONOMY,
      byClassroom: analytics.byClassroom,
      privacy: analytics.privacy,
    });
  }),
);

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

router.get(
  '/school/export.csv',
  handler((req, res) => {
    const windowDays = intParam(req.query.windowDays, 7, { min: 1, max: 180 });
    const analytics = schoolAnalytics({ schoolId: req.auth.schoolId, atMs: now(), windowDays });
    const lines = [];
    lines.push(csvRow(['MyopiaGuard school analytics (aggregate only)']));
    lines.push(csvRow(['School', analytics.school.name]));
    lines.push(csvRow(['Window', `${iso(analytics.window.startIso ? Date.parse(analytics.window.startIso) : analytics.window.start)} → ${iso(Date.parse(analytics.window.endIso ?? analytics.window.end))}`]));
    lines.push(csvRow(['Generated', iso(analytics.generatedAt)]));
    lines.push(csvRow(['Suppression rule', `Cells built from fewer than ${analytics.privacy.minCohortSeats} workstations are withheld`]));
    lines.push('');
    lines.push(csvRow(['School totals', 'Value']));
    for (const [key, value] of Object.entries(analytics.headline)) {
      lines.push(csvRow([key, value ?? '']));
    }
    lines.push('');
    lines.push(csvRow(['Grade', 'Classrooms', 'Workstations', 'Adherence %', 'Computer sessions', 'Recommended breaks', 'Long visual sessions', 'Active hours', 'Withheld']));
    for (const grade of analytics.byGrade) {
      lines.push(
        csvRow([
          grade.gradeName,
          grade.classrooms,
          grade.suppressed ? '' : grade.contributorSeats,
          grade.suppressed ? '' : grade.breakAdherence,
          grade.suppressed ? '' : grade.computerSessions,
          grade.suppressed ? '' : grade.recommendedBreaks,
          grade.suppressed ? '' : grade.longVisualSessions,
          grade.suppressed ? '' : grade.activeHours,
          grade.suppressed ? 'yes' : 'no',
        ]),
      );
    }
    lines.push('');
    lines.push(csvRow(['Classroom', 'Subject', 'Grade', 'Workstations', 'Adherence %', 'Mean stretch (min)', 'Active minutes per workstation', 'Long visual sessions', 'Withheld']));
    for (const row of analytics.byClassroom) {
      lines.push(
        csvRow([
          row.classroomName,
          row.subject,
          row.gradeName,
          row.suppressed ? '' : row.computersReporting,
          row.suppressed ? '' : row.breakAdherence,
          row.suppressed ? '' : row.meanStretchMinutes,
          row.suppressed ? '' : row.activeMinutesPerWorkstation,
          row.suppressed ? '' : row.longVisualSessions,
          row.suppressed ? 'yes' : 'no',
        ]),
      );
    }
    lines.push('');
    lines.push(csvRow(['Trend (weekly)', 'Adherence %', 'Computer sessions', 'Long visual sessions', 'Active hours']));
    for (const point of analytics.trend.weekly) {
      lines.push(csvRow([point.label, point.breakAdherence ?? '', point.computerSessions, point.longVisualSessions, point.activeHours]));
    }
    lines.push('');
    lines.push(csvRow(['Note', 'All figures are rolled up to classroom, grade, subject or school level. No workstation- or student-level data is included.']));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="myopiaguard-school-analytics-${windowDays}d.csv"`);
    res.send(`${lines.join('\n')}\n`);
  }),
);

export default router;
