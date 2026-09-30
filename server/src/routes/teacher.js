import express from 'express';
import {
  SUPPORTED_LANGUAGES,
  accessibleClassrooms,
  assertClassroomAccess,
  authenticate,
  requireUser,
} from '../auth.js';
import { all, audit, get, run, tx } from '../db.js';
import { ApiError, boolParam, handler, intParam } from '../lib/http.js';
import { makeId, makeToken } from '../lib/ids.js';
import { iso, now } from '../lib/time.js';
import { assertPositiveInt, assertSeatLabel, sanitizeMessage } from '../lib/validation.js';
import {
  ATTENTION_DURATIONS,
  DEFAULT_ATTENTION_MESSAGE,
  attentionHistory,
  broadcastAttention,
  clearAttention,
  getActiveBroadcast,
} from '../services/attention.js';
import { buildClassroomSnapshot, buildSeatDetail, classroomIndex } from '../services/dashboard.js';
import {
  createResource,
  disableFocusMode,
  enableFocusMode,
  focusHistory,
  focusStatus,
  listResources,
  updateResource,
} from '../services/focus.js';
import { classroomConfig, getLiveLessonSession, startLessonSession } from '../services/sessionState.js';
import { endLessonSession } from '../services/sessionState.js';
import { closeFocusForLesson } from '../services/focus.js';

/**
 * Teacher-facing API. Every route is scoped to a classroom the signed-in teacher
 * is actually assigned to (`assertClassroomAccess`), and no route here ever reads
 * a student identifier — because none exists to read.
 */
const router = express.Router();
router.use(authenticate, requireUser('teacher', 'admin'));

function loadClassroom(req) {
  const classroomId = req.params.classroomId;
  const classroom = get(
    `SELECT c.*, g.name AS grade_name, g.level AS grade_level, sc.name AS school_name
       FROM classrooms c JOIN grades g ON g.id = c.grade_id JOIN schools sc ON sc.id = c.school_id
      WHERE c.id = ?`,
    [classroomId],
  );
  if (!classroom) throw ApiError.notFound('classroom');
  assertClassroomAccess(req.auth, classroomId);
  return classroom;
}

/** The shape the setup page reads. One builder, so GET and PATCH cannot drift. */
function classroomConfigView(classroom) {
  return {
    classroomId: classroom.id,
    language: classroom.language ?? 'en',
    breakIntervalMin: classroom.break_interval_min,
    breakDurationSec: classroom.break_duration_sec,
    warnLead5Min: Boolean(classroom.warn_lead_5min),
    warnLead1Min: Boolean(classroom.warn_lead_1min),
    longSessionMin: classroom.long_session_min,
    missedBreakGraceSec: classroom.missed_break_grace_sec,
    offlineAfterSec: classroom.offline_after_sec,
  };
}

function deviceUrlFor(req, token) {
  const base = process.env.MG_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`;
  return `${base}/device?token=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------- classrooms

router.get(
  '/classrooms',
  handler((req, res) => {
    const classrooms = accessibleClassrooms(req.auth);
    res.json({
      classrooms: classrooms.map((classroom) => ({
        id: classroom.id,
        name: classroom.name,
        subject: classroom.subject,
        gradeName: classroom.grade_name,
        gradeLevel: classroom.grade_level,
        breakIntervalMin: classroom.break_interval_min,
        breakDurationSec: classroom.break_duration_sec,
        seatCount: Number(get('SELECT COUNT(*) AS count FROM seats WHERE classroom_id = ?', [classroom.id]).count),
        live: Boolean(getLiveLessonSession(classroom.id)),
      })),
    });
  }),
);

router.get(
  '/classrooms/:classroomId/snapshot',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const snapshot = buildClassroomSnapshot({ classroomId: classroom.id, atMs: now() });
    res.json({
      ...snapshot,
      attentionBroadcast: getActiveBroadcast(classroom.id),
      focus: focusStatus(classroom.id).active ? focusStatus(classroom.id) : { active: false },
    });
  }),
);

router.get(
  '/classrooms/:classroomId/config',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    res.json({
      config: classroomConfigView(classroom),
      defaults: classroomConfig(classroom.id),
      note: 'Break cadence is configurable per classroom. Changes apply to breaks scheduled after they are saved.',
    });
  }),
);

const CONFIG_FIELDS = {
  breakIntervalMin: { column: 'break_interval_min', min: 2, max: 120 },
  breakDurationSec: { column: 'break_duration_sec', min: 5, max: 300 },
  longSessionMin: { column: 'long_session_min', min: 5, max: 240 },
  missedBreakGraceSec: { column: 'missed_break_grace_sec', min: 10, max: 900 },
  offlineAfterSec: { column: 'offline_after_sec', min: 5, max: 600 },
};

router.patch(
  '/classrooms/:classroomId/config',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const body = req.body ?? {};
    const sets = [];
    const params = [];
    for (const [key, spec] of Object.entries(CONFIG_FIELDS)) {
      if (body[key] === undefined) continue;
      const value = assertPositiveInt(body[key], key, { min: spec.min, max: spec.max });
      sets.push(`${spec.column} = ?`);
      params.push(value);
    }
    for (const key of ['warnLead5Min', 'warnLead1Min']) {
      if (body[key] === undefined) continue;
      sets.push(`${key === 'warnLead5Min' ? 'warn_lead_5min' : 'warn_lead_1min'} = ?`);
      params.push(body[key] ? 1 : 0);
    }
    // The language the classroom PCs in this room display. Validated against the
    // supported list so an unsupported code cannot be stored and silently ignored.
    if (body.language !== undefined) {
      const language = String(body.language).toLowerCase();
      if (!SUPPORTED_LANGUAGES.includes(language)) {
        throw new ApiError(400, 'invalid_value', { field: 'language', allowed: SUPPORTED_LANGUAGES });
      }
      sets.push('language = ?');
      params.push(language);
    }
    if (sets.length === 0) {
      throw new ApiError(400, 'nothing_to_update', {
        allowed: [...Object.keys(CONFIG_FIELDS), 'warnLead5Min', 'warnLead1Min', 'language'],
      });
    }

    tx(() => {
      run(`UPDATE classrooms SET ${sets.join(', ')} WHERE id = ?`, [...params, classroom.id]);
      audit({
        actorUserId: req.auth.userId,
        actorRole: req.auth.role,
        action: 'classroom.config_updated',
        classroomId: classroom.id,
        detail: body,
      });
    });

    const updated = loadClassroom(req);
    // Agents pick the new cadence up on their next heartbeat or session event.
    req.app.locals.hub?.toClassroom(classroom.id, 'classroom:config', classroomConfigView(updated));

    res.json({ config: classroomConfigView(updated) });
  }),
);

// ------------------------------------------------------------------- seating

router.get(
  '/classrooms/:classroomId/seats',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const seats = all('SELECT * FROM seats WHERE classroom_id = ? ORDER BY seat_index', [classroom.id]);
    res.json({
      classroom: { id: classroom.id, name: classroom.name, gradeName: classroom.grade_name },
      // Enrollment material for setting up a classroom PC. Machine identity only.
      seats: seats.map((seat) => ({
        seatId: seat.id,
        label: seat.label,
        seatIndex: seat.seat_index,
        agentToken: seat.agent_token,
        deviceUrl: deviceUrlFor(req, seat.agent_token),
        lastSeenAt: seat.last_seen_at ? iso(seat.last_seen_at) : null,
      })),
      privacy: 'A seat is a workstation label. There is no field here for a student name, and labels are validated to the "PC-01"/"Seat 12" form.',
    });
  }),
);

router.post(
  '/classrooms/:classroomId/seats',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const body = req.body ?? {};
    const created = tx(() => {
      const results = [];
      if (body.count !== undefined) {
        const count = assertPositiveInt(body.count, 'count', { min: 1, max: 60 });
        const prefix = body.prefix === 'Seat' ? 'Seat' : 'PC';
        const existing = all('SELECT label FROM seats WHERE classroom_id = ?', [classroom.id]).map((row) => row.label);
        let index = Number(get('SELECT COALESCE(MAX(seat_index), 0) AS max FROM seats WHERE classroom_id = ?', [classroom.id]).max);
        for (let i = 0; i < count; i += 1) {
          let candidate;
          do {
            index += 1;
            candidate = assertSeatLabel(prefix === 'PC' ? `PC-${index}` : `Seat ${index}`, 'label');
          } while (existing.includes(candidate));
          const id = makeId('seat');
          const token = makeToken(18);
          run(
            `INSERT INTO seats (id, classroom_id, label, seat_index, agent_token, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, classroom.id, candidate, index, token, now()],
          );
          results.push({ seatId: id, label: candidate, seatIndex: index, agentToken: token });
        }
      } else {
        const label = assertSeatLabel(body.label, 'label');
        const index = Number(get('SELECT COALESCE(MAX(seat_index), 0) AS max FROM seats WHERE classroom_id = ?', [classroom.id]).max) + 1;
        const id = makeId('seat');
        const token = makeToken(18);
        run(
          `INSERT INTO seats (id, classroom_id, label, seat_index, agent_token, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, classroom.id, label, index, token, now()],
        );
        results.push({ seatId: id, label, seatIndex: index, agentToken: token });
      }
      audit({
        actorUserId: req.auth.userId,
        actorRole: req.auth.role,
        action: 'seats.created',
        classroomId: classroom.id,
        detail: { labels: results.map((row) => row.label) },
      });
      return results;
    });
    res.status(201).json({ seats: created });
  }),
);

router.delete(
  '/seats/:seatId',
  handler((req, res) => {
    const seat = get('SELECT * FROM seats WHERE id = ?', [req.params.seatId]);
    if (!seat) throw ApiError.notFound('seat');
    assertClassroomAccess(req.auth, seat.classroom_id);
    tx(() => {
      run('DELETE FROM seats WHERE id = ?', [seat.id]);
      audit({
        actorUserId: req.auth.userId,
        actorRole: req.auth.role,
        action: 'seat.removed',
        classroomId: seat.classroom_id,
        detail: { label: seat.label },
      });
    });
    res.json({ ok: true, removed: seat.label });
  }),
);

router.get(
  '/seats/:seatId',
  handler((req, res) => {
    const seat = get('SELECT * FROM seats WHERE id = ?', [req.params.seatId]);
    if (!seat) throw ApiError.notFound('seat');
    assertClassroomAccess(req.auth, seat.classroom_id);
    const detail = buildSeatDetail({ seatId: seat.id, atMs: now() });
    res.json({ ...detail, privacy: 'Session metrics for one workstation. No student identity is recorded or displayed.' });
  }),
);

// ------------------------------------------------------------------ sessions

router.post(
  '/classrooms/:classroomId/session',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const subject = req.body?.subject ? sanitizeMessage(req.body.subject, { maxLength: 60 }) : null;
    const lessonSession = tx(() => {
      const session = startLessonSession({
        classroom,
        teacherId: req.auth.userId,
        subject,
        atMs: now(),
      });
      audit({
        actorUserId: req.auth.userId,
        actorRole: req.auth.role,
        action: 'lesson.started',
        classroomId: classroom.id,
        detail: { lessonSessionId: session.id, subject: session.subject },
      });
      return session;
    });

    // Nudge every connected PC to join; agents reply with /agent/hello.
    req.app.locals.hub?.toClassroom(classroom.id, 'session:started', {
      lessonSessionId: lessonSession.id,
      classroomId: classroom.id,
      subject: lessonSession.subject,
      breakIntervalMin: classroom.break_interval_min,
      breakDurationSec: classroom.break_duration_sec,
    });

    res.status(201).json({
      lessonSession: {
        id: lessonSession.id,
        subject: lessonSession.subject,
        startedAt: iso(lessonSession.started_at),
        status: lessonSession.status,
      },
    });
  }),
);

router.post(
  '/classrooms/:classroomId/session/end',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const existing = getLiveLessonSession(classroom.id);
    if (!existing) throw ApiError.conflict('no_live_session', { classroomId: classroom.id });
    tx(() => {
      closeFocusForLesson(existing.id); // Focus Mode never outlives its lesson
      endLessonSession(existing.id, now(), 'teacher ended the lesson');
      audit({
        actorUserId: req.auth.userId,
        actorRole: req.auth.role,
        action: 'lesson.ended',
        classroomId: classroom.id,
        detail: { lessonSessionId: existing.id },
      });
    });
    req.app.locals.hub?.toClassroom(classroom.id, 'session:ended', {
      lessonSessionId: existing.id,
      classroomId: classroom.id,
      reason: 'teacher ended the lesson',
    });
    res.json({ ok: true, lessonSessionId: existing.id });
  }),
);

// ----------------------------------------------------------- attention mode

router.get(
  '/classrooms/:classroomId/attention',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    res.json({
      active: getActiveBroadcast(classroom.id),
      history: attentionHistory(classroom.id, intParam(req.query.limit, 20, { min: 1, max: 100 })),
      defaultMessage: DEFAULT_ATTENTION_MESSAGE,
      durations: ATTENTION_DURATIONS,
      scope: 'Attention Mode is a lesson-management prompt. It cannot lock input, capture a screen, or block an application.',
    });
  }),
);

router.post(
  '/classrooms/:classroomId/attention',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const broadcast = broadcastAttention({
      classroomId: classroom.id,
      teacherId: req.auth.userId,
      message: req.body?.message ?? null,
      durationSec: req.body?.durationSec ?? 30,
      hub: req.app.locals.hub,
      actor: req.auth,
    });
    res.status(201).json({ broadcast });
  }),
);

router.post(
  '/classrooms/:classroomId/attention/clear',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const result = clearAttention({
      classroomId: classroom.id,
      teacherId: req.auth.userId,
      broadcastId: req.body?.broadcastId ?? null,
      hub: req.app.locals.hub,
      actor: req.auth,
    });
    res.json(result);
  }),
);

// --------------------------------------------------------------- focus mode

router.get(
  '/classrooms/:classroomId/focus',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    res.json({
      status: focusStatus(classroom.id),
      catalog: listResources(classroom.school_id, { includeDisabled: boolParam(req.query.includeDisabled, false) }),
      history: focusHistory(classroom.id, 10),
      scope:
        'Focus Mode restricts browsing to approved resources for the current lesson on school-managed devices. It does not lock input, capture screens or block applications, and it expires with the lesson.',
    });
  }),
);

router.post(
  '/classrooms/:classroomId/focus',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const resourceIds = Array.isArray(req.body?.resourceIds) ? req.body.resourceIds : [];
    const result = enableFocusMode(
      { classroomId: classroom.id, teacherId: req.auth.userId, resourceIds, strict: req.body?.strict !== false },
      req.auth,
    );
    // The enforcement hook: every connected agent receives the policy document.
    req.app.locals.hub?.toClassroom(classroom.id, 'focus:policy', result.policy, { kind: 'agent' });
    req.app.locals.hub?.toClassroom(classroom.id, 'focus:changed', { classroomId: classroom.id, active: true });
    res.json({
      status: focusStatus(classroom.id),
      policy: result.policy,
      delivery: {
        transport: 'websocket + next heartbeat',
        policyVersion: result.policy.policyVersion,
        note: 'Agents apply the policy on receipt and re-assert it on every heartbeat, so a reload cannot escape it.',
      },
    });
  }),
);

router.delete(
  '/classrooms/:classroomId/focus',
  handler((req, res) => {
    const classroom = loadClassroom(req);
    const result = disableFocusMode({ classroomId: classroom.id }, req.auth);
    if (result.policy) {
      req.app.locals.hub?.toClassroom(classroom.id, 'focus:policy', result.policy, { kind: 'agent' });
      req.app.locals.hub?.toClassroom(classroom.id, 'focus:changed', { classroomId: classroom.id, active: false });
    }
    res.json({ status: focusStatus(classroom.id), ...result });
  }),
);

// School-admin-managed catalog, surfaced for teachers so they see the same list.
router.get(
  '/focus/catalog',
  handler((req, res) => {
    res.json({
      catalog: listResources(req.auth.schoolId, { includeDisabled: req.auth.role === 'admin' }),
      configurable: req.auth.role === 'admin',
    });
  }),
);

router.post(
  '/focus/catalog',
  requireUser('admin'),
  handler((req, res) => {
    const resource = createResource({ schoolId: req.auth.schoolId, ...(req.body ?? {}) }, req.auth);
    res.status(201).json({ resource });
  }),
);

router.patch(
  '/focus/catalog/:resourceId',
  requireUser('admin'),
  handler((req, res) => {
    const existing = get('SELECT * FROM focus_resources WHERE id = ? AND school_id = ?', [
      req.params.resourceId,
      req.auth.schoolId,
    ]);
    if (!existing) throw ApiError.notFound('focus resource');
    res.json({ resource: updateResource(req.params.resourceId, req.body ?? {}, req.auth) });
  }),
);

/** Reference data for the teacher shell: the classrooms in the signed-in school. */
router.get(
  '/school/classrooms',
  handler((req, res) => {
    res.json({ classrooms: classroomIndex(req.auth.schoolId) });
  }),
);

export { router as teacherRouter };
export default router;
