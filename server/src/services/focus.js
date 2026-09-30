import { all, audit, get, run, tx } from '../db.js';
import { makeId } from '../lib/ids.js';
import { ApiError } from '../lib/http.js';
import { now } from '../lib/time.js';
import { assertDomain } from '../lib/validation.js';
import { getLessonSession } from './sessionState.js';

/**
 * Focus Mode (deliverable 7) — session-scoped website allowlist.
 *
 * This module owns the *policy*: which resources a school offers, what the
 * teacher selected for this lesson, and the exact document a device agent is
 * asked to enforce. It deliberately does NOT contain the enforcement mechanism.
 *
 * The mechanism is a technical decision documented in docs/FOCUS_MODE_DECISION.md,
 * with a working reference implementation in extensions/myopiaguard-focus/ (a
 * Manifest V3 Chrome extension using declarativeNetRequest). `buildPolicyDocument()`
 * below is the enforcement hook: whatever the school already manages devices with
 * — Chrome Enterprise policy, Google Workspace for Education, or an MDM — consumes
 * the same document shape.
 *
 * Scope, stated plainly: Focus Mode restricts *browsing* to approved resources, in
 * one lesson, on machines the school manages. It is not device control, it has no
 * keyboard or screen-monitoring capability, and it expires with the lesson.
 */

const DOMAIN_WILDCARDS = (domain) => [`${domain}`, `*.${domain}`];

export function listResources(schoolId, { includeDisabled = false } = {}) {
  return all(
    `SELECT * FROM focus_resources
      WHERE school_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
      ORDER BY category, name`,
    [schoolId],
  ).map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    category: row.category,
    description: row.description ?? null,
    defaultAllowed: Boolean(row.default_allowed),
    enabled: Boolean(row.enabled),
  }));
}

export function createResource({ schoolId, name, domain, category = 'General', description = null, defaultAllowed = false }, actor = {}) {
  const normalizedDomain = assertDomain(domain);
  const cleanName = String(name ?? '').trim().slice(0, 80);
  if (!cleanName) throw new ApiError(400, 'invalid_value', { field: 'name' });
  const id = makeId('res');
  tx(() => {
    run(
      `INSERT INTO focus_resources (id, school_id, name, domain, category, description, default_allowed, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, schoolId, cleanName, normalizedDomain, category, description, defaultAllowed ? 1 : 0, now()],
    );
    audit({
      actorUserId: actor.userId ?? null,
      actorRole: actor.role ?? null,
      action: 'focus.resource_created',
      detail: { resourceId: id, domain: normalizedDomain, name: cleanName },
    });
  });
  return get('SELECT * FROM focus_resources WHERE id = ?', [id]);
}

export function updateResource(id, patch, actor = {}) {
  const existing = get('SELECT * FROM focus_resources WHERE id = ?', [id]);
  if (!existing) throw ApiError.notFound('focus resource');
  const fields = [];
  const params = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    params.push(String(patch.name).trim().slice(0, 80));
  }
  if (patch.domain !== undefined) {
    fields.push('domain = ?');
    params.push(assertDomain(patch.domain));
  }
  if (patch.category !== undefined) {
    fields.push('category = ?');
    params.push(String(patch.category).trim().slice(0, 40));
  }
  if (patch.description !== undefined) {
    fields.push('description = ?');
    params.push(patch.description === null ? null : String(patch.description).slice(0, 240));
  }
  if (patch.defaultAllowed !== undefined) {
    fields.push('default_allowed = ?');
    params.push(patch.defaultAllowed ? 1 : 0);
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (fields.length === 0) return existing;
  tx(() => {
    run(`UPDATE focus_resources SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
    audit({
      actorUserId: actor.userId ?? null,
      actorRole: actor.role ?? null,
      action: 'focus.resource_updated',
      detail: { resourceId: id, patch },
    });
  });
  return get('SELECT * FROM focus_resources WHERE id = ?', [id]);
}

export function getActiveFocusSession(lessonSessionId) {
  return get(
    `SELECT * FROM focus_sessions WHERE lesson_session_id = ? AND status = 'active' ORDER BY enabled_at DESC LIMIT 1`,
    [lessonSessionId],
  );
}

export function focusSessionResources(focusSessionId) {
  return all(
    `SELECT r.* FROM focus_resources r
       JOIN focus_session_resources sr ON sr.resource_id = r.id
      WHERE sr.focus_session_id = ?
      ORDER BY r.category, r.name`,
    [focusSessionId],
  );
}

/** What the teacher's Focus Mode panel renders for the current lesson. */
export function focusStatus(classroomId) {
  const lessonSession = get(
    `SELECT * FROM lesson_sessions WHERE classroom_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1`,
    [classroomId],
  );
  if (!lessonSession) {
    return { active: false, lessonSession: null, selectedResourceIds: [], policy: null, since: null };
  }
  const focus = getActiveFocusSession(lessonSession.id);
  if (!focus) {
    return {
      active: false,
      lessonSession: { id: lessonSession.id, startedAt: Number(lessonSession.started_at) },
      selectedResourceIds: [],
      policy: null,
      since: null,
    };
  }
  const resources = focusSessionResources(focus.id);
  return {
    active: true,
    lessonSession: { id: lessonSession.id, startedAt: Number(lessonSession.started_at) },
    focusSessionId: focus.id,
    selectedResourceIds: resources.map((row) => row.id),
    selectedResources: resources.map((row) => ({ id: row.id, name: row.name, domain: row.domain, category: row.category })),
    since: Number(focus.enabled_at),
    policy: buildPolicyDocument({ focusSession: focus, resources }),
  };
}

/**
 * The enforcement hook: the exact document a device agent is asked to apply.
 * Versioned so an agent can tell a stale policy from a fresh one and fail closed.
 */
export function buildPolicyDocument({ focusSession, resources }) {
  const allowedDomains = resources.map((row) => ({
    name: row.name,
    domain: row.domain,
    category: row.category,
  }));
  return {
    policyId: focusSession.id,
    policyVersion: Number(focusSession.enabled_at),
    active: focusSession.status === 'active',
    mode: 'allowlist',
    scope: 'browsing', // explicitly not device control: no input lock, no capture
    allowedDomains,
    // The flat pattern list is what a declarativeNetRequest/MDM rule set consumes.
    allowedDomainPatterns: allowedDomains.flatMap((entry) => DOMAIN_WILDCARDS(entry.domain)),
    blockedPageMessage:
      'Focus Mode is on for this lesson. This site is not on the approved list — ask your teacher if you need it.',
    studentFacingSummary: resources.length
      ? `Focus Mode: ${resources.map((row) => row.name).join(', ')}`
      : 'Focus Mode: no resources approved yet — ask your teacher.',
    expiresWithLesson: true,
    requireExtension: true,
    updatedAt: new Date(Number(focusSession.enabled_at)).toISOString(),
  };
}

export function enableFocusMode({ classroomId, teacherId, resourceIds = [], strict = true }, actor = {}) {
  const lessonSession = get(
    `SELECT * FROM lesson_sessions WHERE classroom_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1`,
    [classroomId],
  );
  if (!lessonSession) throw ApiError.conflict('no_live_session', { classroomId });

  const resources = resourceIds.length
    ? all(
        `SELECT * FROM focus_resources
          WHERE school_id = ? AND enabled = 1 AND id IN (${resourceIds.map(() => '?').join(', ')})`,
        [get('SELECT school_id FROM classrooms WHERE id = ?', [classroomId]).school_id, ...resourceIds],
      )
    : [];

  if (strict && resources.length === 0) {
    throw new ApiError(400, 'empty_allowlist', {
      reason: 'Select at least one approved resource, or Focus Mode would block every site.',
    });
  }

  const focusSession = tx(() => {
    // One Focus Mode record per lesson: switching it off and back on must reopen
    // the same record, not try to insert a second one for the same lesson.
    const existing = get('SELECT * FROM focus_sessions WHERE lesson_session_id = ?', [lessonSession.id]);
    let record;
    if (existing) {
      run('DELETE FROM focus_session_resources WHERE focus_session_id = ?', [existing.id]);
      run(
        `UPDATE focus_sessions SET status = 'active', enabled_at = ?, disabled_at = NULL, enabled_by = ? WHERE id = ?`,
        [now(), teacherId, existing.id],
      );
      record = get('SELECT * FROM focus_sessions WHERE id = ?', [existing.id]);
    } else {
      const id = makeId('foc');
      const schoolId = get('SELECT school_id FROM classrooms WHERE id = ?', [classroomId]).school_id;
      run(
        `INSERT INTO focus_sessions (id, lesson_session_id, classroom_id, school_id, enabled_by, enabled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [id, lessonSession.id, classroomId, schoolId, teacherId, now()],
      );
      record = get('SELECT * FROM focus_sessions WHERE id = ?', [id]);
    }
    for (const resource of resources) {
      run('INSERT INTO focus_session_resources (focus_session_id, resource_id) VALUES (?, ?)', [record.id, resource.id]);
    }
    audit({
      actorUserId: actor.userId ?? teacherId,
      actorRole: actor.role ?? 'teacher',
      action: existing ? 'focus.updated' : 'focus.enabled',
      classroomId,
      detail: { focusSessionId: record.id, resources: resources.map((row) => row.domain) },
    });
    return record;
  });

  return {
    focusSession,
    resources,
    policy: buildPolicyDocument({ focusSession, resources }),
    lessonSessionId: lessonSession.id,
  };
}

export function disableFocusMode({ classroomId, reason = 'teacher disabled focus mode' }, actor = {}) {
  const focus = tx(() => {
    const active = get(
      `SELECT fs.* FROM focus_sessions fs
        JOIN lesson_sessions ls ON ls.id = fs.lesson_session_id
       WHERE fs.classroom_id = ? AND fs.status = 'active' AND ls.status = 'live'`,
      [classroomId],
    );
    if (!active) return null;
    run(`UPDATE focus_sessions SET status = 'disabled', disabled_at = ? WHERE id = ?`, [now(), active.id]);
    audit({
      actorUserId: actor.userId ?? null,
      actorRole: actor.role ?? null,
      action: 'focus.disabled',
      classroomId,
      detail: { focusSessionId: active.id, reason },
    });
    return get('SELECT * FROM focus_sessions WHERE id = ?', [active.id]);
  });
  return {
    disabled: Boolean(focus),
    policy: focus
      ? {
          policyId: focus.id,
          policyVersion: Number(focus.disabled_at ?? now()),
          active: false,
          mode: 'off',
          scope: 'browsing',
          allowedDomains: [],
          allowedDomainPatterns: [],
          studentFacingSummary: 'Focus Mode is off.',
          expiresWithLesson: true,
          requireExtension: true,
          updatedAt: new Date(Number(focus.disabled_at ?? now())).toISOString(),
        }
      : null,
    focusSessionId: focus?.id ?? null,
  };
}

/** Called when a lesson ends: Focus Mode is session-scoped and must never outlive it. */
export function closeFocusForLesson(lessonSessionId) {
  const active = getActiveFocusSession(lessonSessionId);
  if (!active) return null;
  run(`UPDATE focus_sessions SET status = 'disabled', disabled_at = ? WHERE id = ?`, [now(), active.id]);
  return active.id;
}

/** Resolves the policy a specific seat's agent should be enforcing right now. */
export function policyForSeat(seatId) {
  const seat = get('SELECT * FROM seats WHERE id = ?', [seatId]);
  if (!seat) return null;
  const lessonSession = get(
    `SELECT * FROM lesson_sessions WHERE classroom_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1`,
    [seat.classroom_id],
  );
  if (!lessonSession) {
    return { policyId: null, policyVersion: 0, active: false, mode: 'off', allowedDomains: [], allowedDomainPatterns: [] };
  }
  const focus = getActiveFocusSession(lessonSession.id);
  if (!focus) {
    return {
      policyId: null,
      policyVersion: 0,
      active: false,
      mode: 'off',
      allowedDomains: [],
      allowedDomainPatterns: [],
      studentFacingSummary: 'Focus Mode is off.',
    };
  }
  return buildPolicyDocument({ focusSession: focus, resources: focusSessionResources(focus.id) });
}

export function focusHistory(classroomId, limit = 20) {
  return all(
    `SELECT fs.*, u.display_name AS enabled_by_name,
            (SELECT COUNT(*) FROM focus_session_resources sr WHERE sr.focus_session_id = fs.id) AS resource_count
       FROM focus_sessions fs
       LEFT JOIN users u ON u.id = fs.enabled_by
      WHERE fs.classroom_id = ?
      ORDER BY fs.enabled_at DESC LIMIT ?`,
    [classroomId, limit],
  ).map((row) => ({
    id: row.id,
    lessonSessionId: row.lesson_session_id,
    enabledAt: Number(row.enabled_at),
    disabledAt: row.disabled_at ? Number(row.disabled_at) : null,
    status: row.status,
    enabledByName: row.enabled_by_name ?? null,
    resourceCount: Number(row.resource_count ?? 0),
  }));
}

export { getLessonSession };
