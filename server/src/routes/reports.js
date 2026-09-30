import express from 'express';
import { assertClassroomAccess, authenticate, requireUser } from '../auth.js';
import { get } from '../db.js';
import { ApiError, handler, intParam } from '../lib/http.js';
import { iso, now } from '../lib/time.js';
import { computeWeeklyReport, generateWeeklyReport, listStoredReports, reportToCsv, storedReport } from '../services/reports.js';

/**
 * Weekly classroom report (deliverable 4).
 *
 * A report can be read live for any week or read back from the Monday-morning
 * snapshot the scheduler stored. Both paths return the identical shape, so the
 * in-app table, the CSV and the printable view never disagree.
 */
const router = express.Router();
router.use(authenticate, requireUser('teacher', 'admin'));

function loadClassroom(req) {
  const classroom = get(
    `SELECT c.*, g.name AS grade_name, sc.name AS school_name
       FROM classrooms c JOIN grades g ON g.id = c.grade_id JOIN schools sc ON sc.id = c.school_id
      WHERE c.id = ?`,
    [req.params.classroomId],
  );
  if (!classroom) throw ApiError.notFound('classroom');
  assertClassroomAccess(req.auth, classroom.id);
  return classroom;
}

function buildReport(req) {
  const classroom = loadClassroom(req);
  const weeksAgo = intParam(req.query.weeksAgo, 0, { min: 0, max: 52 });
  const mode = req.query.mode === 'current' ? 'current' : 'last-complete';
  const atMs = now();

  let report = null;
  let source = 'live';
  if (weeksAgo === 0 && mode === 'last-complete') {
    // The stored Monday snapshot is authoritative when it exists.
    const listed = listStoredReports(classroom.id);
    const newest = listed[0];
    if (newest && req.query.live !== '1') {
      const stored = storedReport(classroom.id, Date.parse(newest.weekStart));
      if (stored) {
        report = stored;
        source = 'stored weekly job';
      }
    }
  }
  if (!report) report = computeWeeklyReport({ classroomId: classroom.id, atMs, mode, weeksAgo });
  return { classroom, report, source, weeksAgo, mode };
}

router.get(
  '/classrooms/:classroomId/weekly',
  handler((req, res) => {
    const { report, source } = buildReport(req);
    res.json({
      report,
      source,
      stored: listStoredReports(req.params.classroomId),
      exportUrls: {
        csv: `/api/reports/classrooms/${req.params.classroomId}/weekly.csv?weeksAgo=${intParam(req.query.weeksAgo, 0, { min: 0, max: 52 })}`,
      },
    });
  }),
);

/** Force the weekly job for this classroom (also runs automatically on Monday). */
router.post(
  '/classrooms/:classroomId/weekly/generate',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const report = generateWeeklyReport({
      classroomId: classroom.id,
      atMs: now(),
      mode: req.body?.mode === 'current' ? 'current' : 'last-complete',
      weeksAgo: intParam(req.body?.weeksAgo, 0, { min: 0, max: 52 }),
      generatedBy: req.auth.userId,
      store: true,
    });
    res.status(201).json({ report, stored: listStoredReports(classroom.id) });
  }),
);

router.get(
  '/classrooms/:classroomId/weekly.csv',
  handler((req, res) => {
    const { report } = buildReport(req);
    const filename = `myopiaguard-${report.classroom.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${report.range.label.replace(/[^0-9]/g, '').slice(0, 8)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(reportToCsv(report));
  }),
);

/** Compact JSON for a printable view; the web app renders this to PDF via the browser. */
router.get(
  '/classrooms/:classroomId/weekly/print',
  handler((req, res) => {
    const { report, source } = buildReport(req);
    res.json({
      report,
      source,
      print: {
        title: `MyopiaGuard weekly report — ${report.classroom.name}`,
        subtitle: `${report.classroom.gradeName} · ${report.classroom.subject} · week of ${report.range.label}`,
        generatedAt: iso(report.generatedAt),
        footer: 'Seats are workstations. MyopiaGuard does not record which student used which computer.',
      },
    });
  }),
);

router.get(
  '/classrooms/:classroomId/history',
  handler((req, res) => {
    loadClassroom(req);
    res.json({ reports: listStoredReports(req.params.classroomId) });
  }),
);

export default router;
