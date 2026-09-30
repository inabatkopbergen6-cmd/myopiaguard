/**
 * API client.
 *
 * Same-origin everywhere: in development Vite proxies /api and /live to the Node
 * server, and in production the server serves this bundle itself, so there is no
 * base URL to configure and no cross-origin credential handling to get wrong.
 *
 * Tokens are held in localStorage under two separate keys because a teacher
 * session and a classroom-PC agent token are different kinds of principal; keeping
 * them apart means opening the device view in a tab cannot log a teacher out.
 */

const TOKEN_KEY = 'myopiaguard.token';
const AGENT_KEY = 'myopiaguard.agentToken';
const CLASSROOM_KEY = 'myopiaguard.lastClassroom';

export const authStore = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode) — the app still works for this tab */
    }
  },
  get agentToken() {
    try {
      return localStorage.getItem(AGENT_KEY);
    } catch {
      return null;
    }
  },
  set agentToken(value) {
    try {
      if (value) localStorage.setItem(AGENT_KEY, value);
      else localStorage.removeItem(AGENT_KEY);
    } catch {
      /* ignore */
    }
  },
  get lastClassroomId() {
    try {
      return localStorage.getItem(CLASSROOM_KEY);
    } catch {
      return null;
    }
  },
  set lastClassroomId(value) {
    try {
      if (value) localStorage.setItem(CLASSROOM_KEY, value);
    } catch {
      /* ignore */
    }
  },
  clear() {
    this.token = null;
  },
};

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(code ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /**
   * A dictionary key for a message worth showing a user.
   *
   * Returning a *key* rather than a sentence is deliberate: the UI translates it,
   * so an error raised in Russian is not displayed in English and vice versa. The
   * server's own `detail.reason` is English prose, so it is only used as a last
   * resort for a code this map does not know.
   */
  get messageKey() {
    if (!this.status || this.status === 0) return 'errors.network';
    if (this.status === 401) return 'errors.sessionExpired';
    if (this.status === 403) return 'errors.forbidden';
    if (this.status === 404) return 'errors.notFound';
    if (this.status >= 500) return 'errors.generic';
    switch (this.code) {
      case 'empty_allowlist':
        return 'errors.emptyAllowlist';
      case 'no_live_session':
        return 'errors.noLiveSession';
      case 'seat_level_not_available':
        return 'errors.seatLevel';
      case 'break_not_elapsed':
        return 'errors.breakNotElapsed';
      case 'invalid_seat_label':
        return 'errors.invalidSeatLabel';
      case 'pii_rejected':
        return 'errors.piiRejected';
      case 'conflict':
        return 'errors.conflict';
      case 'invalid_value':
      case 'constraint_violation':
        return 'errors.invalidValue';
      case 'download_failed':
        return 'errors.downloadFailed';
      default:
        // A known code with no key: prefer the server's explanation if it gave one.
        return this.detail?.reason ? null : 'errors.generic';
    }
  }

  /** True when nothing but the server's English reason is available. */
  get hasServerReason() {
    return Boolean(this.detail?.reason);
  }
}

async function request(path, { method = 'GET', body, signal, agentToken, token, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // A device request presents only the seat credential. Sending a teacher's bearer
  // token alongside it would authenticate the request as a *person*, so a stale
  // seat enrolment would come back as a confusing "forbidden" instead of "this
  // machine is not enrolled" — and a dashboard open in the same browser profile
  // would change what a classroom PC is allowed to do.
  const bearer = agentToken ? null : (token ?? authStore.token);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (agentToken) headers['x-agent-token'] = agentToken;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (raw) {
    if (!response.ok) throw new ApiError(response.status, 'request_failed', null);
    return response;
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? 'request_failed', payload?.detail ?? null);
  }
  return payload;
}

export const api = {
  request,

  // ---- session
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  me: () => request('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  updatePreferences: (patch) => request('/api/auth/me/preferences', { method: 'PATCH', body: patch }),
  demoAccounts: () => request('/api/auth/demo-accounts'),

  // ---- teacher
  classrooms: () => request('/api/teacher/classrooms'),
  snapshot: (classroomId, signal) => request(`/api/teacher/classrooms/${classroomId}/snapshot`, { signal }),
  seatDetail: (seatId) => request(`/api/teacher/seats/${seatId}`),
  classroomConfig: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/config`),
  updateClassroomConfig: (classroomId, patch) =>
    request(`/api/teacher/classrooms/${classroomId}/config`, { method: 'PATCH', body: patch }),
  seats: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/seats`),
  addSeats: (classroomId, body) => request(`/api/teacher/classrooms/${classroomId}/seats`, { method: 'POST', body }),
  removeSeat: (seatId) => request(`/api/teacher/seats/${seatId}`, { method: 'DELETE' }),
  startSession: (classroomId, subject) =>
    request(`/api/teacher/classrooms/${classroomId}/session`, { method: 'POST', body: { subject } }),
  endSession: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/session/end`, { method: 'POST', body: {} }),

  // ---- attention mode
  attention: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/attention`),
  broadcast: (classroomId, body) =>
    request(`/api/teacher/classrooms/${classroomId}/attention`, { method: 'POST', body }),
  clearAttention: (classroomId, broadcastId) =>
    request(`/api/teacher/classrooms/${classroomId}/attention/clear`, { method: 'POST', body: { broadcastId } }),

  // ---- focus mode
  focus: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/focus`),
  enableFocus: (classroomId, resourceIds) =>
    request(`/api/teacher/classrooms/${classroomId}/focus`, { method: 'POST', body: { resourceIds } }),
  disableFocus: (classroomId) => request(`/api/teacher/classrooms/${classroomId}/focus`, { method: 'DELETE' }),
  focusCatalog: () => request('/api/teacher/focus/catalog'),

  // ---- reports
  weeklyReport: (classroomId, { weeksAgo = 0, live = false } = {}) =>
    request(`/api/reports/classrooms/${classroomId}/weekly?weeksAgo=${weeksAgo}${live ? '&live=1' : ''}`),
  generateWeeklyReport: (classroomId) =>
    request(`/api/reports/classrooms/${classroomId}/weekly/generate`, { method: 'POST', body: {} }),
  weeklyReportCsvUrl: (classroomId, weeksAgo = 0) =>
    `/api/reports/classrooms/${classroomId}/weekly.csv?weeksAgo=${weeksAgo}`,

  // ---- analytics (admin)
  schoolAnalytics: (windowDays = 7) => request(`/api/analytics/school?windowDays=${windowDays}`),
  analyticsCsvUrl: (windowDays = 7) => `/api/analytics/school/export.csv?windowDays=${windowDays}`,

  // ---- device agent
  agentHello: (agentToken, agentVersion) =>
    request('/api/agent/hello', { method: 'POST', agentToken, body: { agentVersion } }),
  agentHeartbeat: (agentToken) => request('/api/agent/heartbeat', { method: 'POST', agentToken, body: {} }),
  agentState: (agentToken, signal) => request('/api/agent/state', { agentToken, signal }),
  agentBreakShown: (agentToken, breakEventId) =>
    request(`/api/agent/breaks/${breakEventId}/shown`, { method: 'POST', agentToken }),
  agentBreakComplete: (agentToken, breakEventId) =>
    request(`/api/agent/breaks/${breakEventId}/complete`, { method: 'POST', agentToken }),
  agentBreakSkip: (agentToken, breakEventId, reason) =>
    request(`/api/agent/breaks/${breakEventId}/skip`, { method: 'POST', agentToken, body: { reason } }),

  // ---- demo controls (only mounted when the server runs with MG_DEMO=1)
  demoStatus: () => request('/api/demo/status'),
  demoBreakNow: (classroomId, body) =>
    request(`/api/demo/classrooms/${classroomId}/break-now`, { method: 'POST', body }),
  demoStretch: (classroomId, body) =>
    request(`/api/demo/classrooms/${classroomId}/stretch`, { method: 'POST', body }),
  demoResolve: (classroomId, outcome) =>
    request(`/api/demo/classrooms/${classroomId}/resolve`, { method: 'POST', body: { outcome } }),
  demoSeatOffline: (seatId, offline) =>
    request(`/api/demo/seats/${seatId}/offline`, { method: 'POST', body: { offline } }),
  demoAudit: (limit = 30) => request(`/api/demo/audit?limit=${limit}`),
  demoReset: () => request('/api/demo/reset', { method: 'POST', body: {} }),
};

/** Opens a CSV download without leaving the SPA. */
export function downloadCsv(url, token = authStore.token) {
  return fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, 'download_failed', null);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = match?.[1] ?? 'myopiaguard.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  });
}
