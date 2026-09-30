# API reference

Base URL is the server origin. All requests and responses are JSON unless noted.
Timestamps are ISO‑8601 strings on the wire; durations are seconds unless the field
name says otherwise.

## Authentication

| Principal | Credential | Header |
| --- | --- | --- |
| Teacher / admin | Bearer token from `POST /api/auth/login` | `Authorization: Bearer <token>` |
| Classroom PC agent | The seat's enrolment token | `X-Agent-Token: <token>` |

Tokens may also be passed as `?token=` / `?agent=` for the WebSocket upgrade,
since browsers cannot set headers on a WebSocket handshake.

### Roles

- **teacher** — snapshot, seat detail, reports, Attention Mode, Focus Mode; scoped
  to the classrooms assigned to them. A classroom they are not assigned to is
  `403`, not an empty result.
- **admin** — aggregate analytics only. Any teacher endpoint returns `403`
  ("school admins have aggregate-only access"), and the analytics router refuses
  seat-level query parameters by name.
- **agent** — the device contract: state, heartbeat, break outcomes, policy.

---

## Auth

### `POST /api/auth/login`
```json
{ "username": "teacher.avery", "password": "myopiaguard" }
→ 200 { "token": "...", "user": { "id", "role", "displayName", "schoolId" }, "classrooms": [...] }
```
`401` on bad credentials. Hashes are never returned.

### `GET /api/auth/me`
Current user plus `serverTime`. Used by the SPA on load to restore a session.

### `POST /api/auth/logout`
Revokes the presented token.

### `PATCH /api/auth/me/preferences`
```json
{ "language": "ru" }
→ 200 { "preferences": { "language": "ru" } }
```
Validated against the supported list (`en`, `ru`); an unsupported code is `400
invalid_value` rather than stored and silently ignored. `GET /api/auth/me` returns
`user.preferences` so a client can adopt the choice on sign-in.

### `GET /api/auth/demo-accounts`
Public, **and only in demo mode** (`MG_DEMO=1`); otherwise returns an empty list so
a real deployment cannot be enumerated for usernames.

---

## Teacher

### `GET /api/teacher/classrooms`
Rooms assigned to the signed-in teacher, with grade, subject, cadence, seat count
and whether a lesson is live.

### `GET /api/teacher/classrooms/:id/snapshot`
The live board. Everything the dashboard renders.

```json
{
  "classroom": { "name", "subject", "gradeName", "breakIntervalMin", "breakDurationSec", "longSessionMin", "offlineAfterSec" },
  "lessonSession": { "id", "subject", "startedAt", "status" },
  "window": { "kind": "today", "start" },
  "counts": { "seats": 12, "active": 10, "onBreak": 2, "offline": 0, "idle": 0, "flagged": 1 },
  "classAdherence": { "completed", "skipped", "missed", "resolved", "pending", "adherencePct", "meanSeatAdherencePct" },
  "seats": [{
    "seatId": "seat_…", "label": "PC-01", "status": "active|on_break|offline|idle",
    "online": true, "lastSeenAt": 1759161000000,
    "session": { "id", "startedAt", "state", "activeSeconds", "stretchSeconds", "totalActiveSeconds", "lastBreakAt", "agentVersion" },
    "currentBreak": { "id", "status", "dueAt", "startedAt", "durationSec", "instructionKey" },
    "nextBreakAt": 1759161120000, "secondsToNextBreak": 92,
    "counters": { "today": {...}, "session": {...} },
    "adherencePct": 83.3, "longStretch": false,
    "flags": [{ "code", "severity", "label", "detail" }],
    "trend": [{ "dayKey", "adherencePct", "resolved", "missed" }]
  }],
  "attention": [{ "seatId", "label", "severity", "headline", "codes", "detail", "counters" }],
  "attentionBroadcast": { "id", "message", "secondsRemaining", "deliveredCount" } | null
}
```

Flag codes: `repeat_misses` (two breaks in a row not completed), `long_session`
(uninterrupted stretch past the room's threshold), `offline_mid_session`,
`offline_mid_break`.

### `GET /api/teacher/seats/:seatId`
Detail card for one workstation: session length, last break, both adherence
windows, the five-day trend, the last 12 breaks, today's sessions. No person-
shaped field exists in the response.

### `GET|POST /api/teacher/classrooms/:id/seats`
Enrol workstations. `POST { "label": "PC-13" }` or `{ "count": 12, "prefix": "PC" }`.
Returns each seat's `agentToken` and a ready-to-use `deviceUrl`.

Invalid labels are rejected (`400 invalid_seat_label`, `400 pii_rejected`) — a
student name cannot be stored here.

### `DELETE /api/teacher/seats/:seatId`
Removes a workstation and its token.

### `GET|PATCH /api/teacher/classrooms/:id/config`
Break cadence for the room.

| Field | Range | Meaning |
| --- | --- | --- |
| `language` | `en` or `ru` | Language the classroom PCs in this room display, including the full-screen break challenge |
| `breakIntervalMin` | 2–120 | Screen time between breaks (default 20) |
| `breakDurationSec` | 5–300 | Length of the distance break (default 20) |
| `longSessionMin` | 5–240 | Amber long-session threshold (default 45) |
| `missedBreakGraceSec` | 10–900 | Grace after the challenge before a break is missed |
| `offlineAfterSec` | 5–600 | Heartbeat silence before a seat reads offline |
| `warnLead5Min` / `warnLead1Min` | boolean | Pre-break warnings on/off |

### `POST /api/teacher/classrooms/:id/session`
Starts (or reuses) the live lesson. Agents are told over the socket and join.
`POST .../session/end` closes it, ends seat sessions, resolves open breaks as
missed, and turns Focus Mode off.

---

## Attention Mode

### `GET /api/teacher/classrooms/:id/attention`
Active broadcast, history, the default message, the allowed durations, and the
scope statement.

### `POST /api/teacher/classrooms/:id/attention`
```json
{ "message": "Eyes on the board please.", "durationSec": 30 }
→ 201 { "broadcast": { "id", "message", "durationSec", "expiresAt", "deliveredCount", "capabilities" } }
```
`message` is optional (default *"Teacher Attention — Please look at the board."*),
sanitised to 160 plain-text characters. `409 no_live_session` if the lesson has not
started. Every broadcast declares:

```json
"capabilities": { "inputLock": false, "screenCapture": false, "appBlocking": false, "windowControl": false, "scope": "lesson-management" }
```

### `POST /api/teacher/classrooms/:id/attention/clear`
Clears the current broadcast on every screen. It also clears itself when the
duration elapses.

---

## Focus Mode

### `GET /api/teacher/classrooms/:id/focus`
Current status, the school's resource catalogue, recent sessions, scope statement.

### `POST /api/teacher/classrooms/:id/focus`
```json
{ "resourceIds": ["res_…", "res_…"] }
→ 200 { "status": {...}, "policy": { "policyId", "policyVersion", "active", "mode": "allowlist", "scope": "browsing",
         "allowedDomains": [{ "name", "domain", "category" }],
         "allowedDomainPatterns": ["docs.google.com", "*.docs.google.com"],
         "studentFacingSummary", "expiresWithLesson": true } }
```
`400 empty_allowlist` if nothing is selected — an empty list would block every
site. The policy is pushed to every agent immediately and re-asserted on each
heartbeat.

### `DELETE /api/teacher/classrooms/:id/focus`
Turns Focus Mode off and pushes an inactive policy.

### `GET /api/teacher/focus/catalog` · `POST /api/teacher/focus/catalog` (admin) · `PATCH /api/teacher/focus/catalog/:resourceId` (admin)
The school-configurable approved-resource list. Domains are validated, not trusted.

---

## Reports

### `GET /api/reports/classrooms/:id/weekly?weeksAgo=0&live=0`
Monday–Friday report. Reads the stored Monday snapshot when one exists, otherwise
computes live.

```json
{ "report": {
    "classroom": {...}, "range": { "label": "2026-09-21 → 2026-09-25", "days": [...] },
    "metrics": [{ "key", "label", "unit", "description" }],
    "totals": { "computerSessions", "recommendedBreaks", "completedBreaks", "skippedBreaks", "missedBreaks",
                "breakAdherence", "longVisualSessions", "activeMinutes", "seatsReporting" },
    "perDay": [{ "short", "dayKey", "computerSessions", "recommendedBreaks", "completedBreaks", "breakAdherence", "longVisualSessions" }],
    "perSeat": [{ "seatLabel", "breakAdherence", "longVisualSessions", ... }],
    "previousWeek": {...}, "deltas": { "adherencePct", "sessions", "recommendedBreaks" }
  },
  "source": "stored weekly job | computed from this week's events" }
```

Metric definitions live on the server (`services/reports.js`) and are returned in
`metrics`, so the table, the CSV and the printed page cannot disagree.

### `GET /api/reports/classrooms/:id/weekly.csv`
Sectioned CSV: summary, Mon–Fri series, per-seat detail, and the privacy note.

### `POST /api/reports/classrooms/:id/weekly/generate`
Forces and stores the snapshot for this week (the scheduler does this itself on
Monday morning).

### `GET /api/reports/classrooms/:id/history`
Stored snapshots, newest first.

---

## School analytics (admin only, aggregate only)

Four independent controls apply to this router: the admin role gate, refusal of
seat-level query parameters, a response guard that scans the finished payload for
seat identifiers, and k-anonymity suppression inside the queries.

### `GET /api/analytics/school?windowDays=7`

```json
{
  "school": { "id", "name" },
  "window": { "days": 7, "label": "Last 7 days" },
  "privacy": { "aggregateOnly": true, "minCohortSeats": 5, "suppressedClassrooms": 0, "note": "..." },
  "headline": { "classrooms", "grades", "computersReporting", "computerSessions", "recommendedBreaks",
                "completedBreaks", "breakAdherence", "longVisualSessions", "driftedBreaks", "activeHours", "meanStretchMinutes" },
  "byGrade": [{ "gradeName", "gradeLevel", "classrooms", "breakAdherence", "computerSessions", "longVisualSessions",
                "activeHours", "contributorSeats", "suppressed", "suppressionReason" }],
  "byClassroom": [{ "classroomName", "subject", "gradeName", "breakAdherence", "meanStretchMinutes",
                    "activeMinutesPerWorkstation", "visualLoadIndex", "suppressed" }],
  "visualLoad": { "byClassroom": [...top 5], "bySubject": [...] },
  "commonIssue": { "code", "label", "description", "detail", "params", "share", "affectedClassrooms", "ranking", "unit" },
  "trend": { "weekly": [...8 closed weeks], "monthly": [...6 months] }
}
```

- A cell built from fewer than `minCohortSeats` workstations comes back
  `suppressed: true` with its metrics omitted.
- `commonIssue` ranks candidates in one unit — share of recommended breaks — so the
  comparison is meaningful.
- Translatable prose ships with a machine-readable counterpart: attention flags carry
  `code` + `params` (`{ streak }`, `{ minutes, threshold }`, `{ seconds }`), issues
  carry `code` + `params`, and trend buckets carry `weekStart` (an epoch) so the
  client formats the label itself instead of stripping an English prefix. The English
  `detail`/`label` fields remain for API consumers.
- Asking for seat-level data is an explicit error, not a silent no-op:
  `GET /api/analytics/school?seatId=…` → `400 seat_level_not_available`.

### `GET /api/analytics/school/trend` · `/grades` · `/issues` · `/classrooms/:id/rollup`
Narrower views of the same aggregate data.

### `GET /api/analytics/school/export.csv`
Aggregate CSV with the suppression rule stated in the file.

---

## Device agent

### `POST /api/agent/hello` · `POST /api/agent/heartbeat` · `GET /api/agent/state`
All three return the same document. `hello` also joins the running lesson.

```json
{
  "seat": { "seatId", "label", "seatIndex" },
  "classroom": { "classroomId", "name", "subject", "gradeName" },
  "lesson": { "lessonSessionId", "subject", "startedAt", "active" },
  "config": { "breakIntervalMin", "breakDurationSec", "warnLead5Min", "warnLead1Min", "longSessionMin", "offlineAfterSec", "heartbeatSeconds", "language" },
  "session": { "state", "activeSeconds", "stretchSeconds" },
  "pendingBreak": { "breakEventId", "status", "dueAt", "secondsToDue", "durationSec" },
  "activeBreak": { "breakEventId", "durationSec", "startedAt", "elapsedSeconds", "instruction", "longStretch" },
  "attention": { "id", "message", "expiresAt" } | null,
  "focusPolicy": { "policyVersion", "active", "allowedDomains", "studentFacingSummary" },
  "serverTime": 1759161000000
}
```

`pendingBreak` lets an agent pre-warm; `activeBreak` is how a reloaded agent
**rejoins** a break already on screen instead of restarting it.

### `POST /api/agent/breaks/:breakEventId/shown`
The overlay is on screen. Records the real start time and pauses the screen-time
clock. Idempotent.

### `POST /api/agent/breaks/:breakEventId/complete`
`200` with `status: "completed"`. `409 break_not_elapsed` if the countdown has not
run — the server times the break from its own clock, so a modified client cannot
claim a 20-second break in 200 ms.

### `POST /api/agent/breaks/:breakEventId/skip`
`{ "reason": "student_dismissed" }` → recorded as `skipped`, which counts against
adherence. The next break is still scheduled a full interval later, so the rhythm
stays predictable.

`reason` is a **stable code**, not prose: `student_dismissed`, `window_hidden`,
`teacher_preview`. The agent sends a code so one school's audit log cannot end up
mixing languages, and the UI translates it for display (`errors.skipStudentDismissed`
and friends).

A seat may only resolve its own breaks: another seat's token gets `403`.

### `POST /api/agent/focus/report`
Enforcement telemetry (`applied`, `policyVersion`, `enforcer`) written to the audit
log. Returns the current policy.

### `GET /api/agent/instruction-pool`
The rotating distance-break instructions, so an agent can keep rotating from cache
if it is briefly offline.

---

## Demo tools (`MG_DEMO=1` only)

| Endpoint | Effect |
| --- | --- |
| `GET /api/demo/status` | Demo flag, timings, simulated-PC count, disclosure note |
| `POST /api/demo/classrooms/:id/break-now` | Makes the next break due now (or in N seconds) |
| `POST /api/demo/classrooms/:id/stretch` | Backdates a stretch so the amber flag is visible |
| `POST /api/demo/classrooms/:id/resolve` | Resolves open breaks as completed/skipped/missed |
| `POST /api/demo/seats/:seatId/offline` | Takes a seat offline mid-lesson, or restores it |
| `POST /api/demo/reset` | **Wipes and reseeds the database** |
| `GET /api/demo/audit` | Recent audit entries |

These edit the same rows the live scheduler uses, so the dashboard, reports and
audit trail all react for real — nothing is faked for display.

---

## WebSocket

`ws://host/live?token=<user token>` or `ws://host/live?agent=<seat token>`.

Client → server: `ping`, `agent:heartbeat`, `teacher:subscribe {classroomId}`,
`agent:focus-report`.

Server → client: `hello`, `agent:state`, `break:warning` (with the real lead in
seconds), `break:start`, `break:missed`, `attention:show`, `attention:clear`,
`focus:policy`, `classroom:changed`, `analytics:stale`, `error`.

Envelope: `{ "type": "...", "payload": {...}, "at": 1759161000000 }`. A
connection with unknown credentials is closed with code `4001`.
