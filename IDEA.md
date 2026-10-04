# MyopiaGuard — project idea and engineering reference

> **One line:** MyopiaGuard watches **screens, not children** — it runs a
> screen-break routine across a school's computers, shows teachers whether that
> routine is holding, and rolls the result into aggregate-only school analytics.

This document is the complete engineering picture of the product: the idea, the
architecture, the data model, the API, the design system, the Russian-first
internationalisation, the privacy guarantees *and* where each one is enforced,
and — because a reference that only lists strengths is marketing — the known
defects and open risks at the end.

- For a short orientation, read [`README.md`](README.md).
- For the privacy statement on its own, read [`docs/PRIVACY.md`](docs/PRIVACY.md).
- For deployment and operation, read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## 1. The idea

### 1.1 The problem

Sustained near-work on a screen is a driver of juvenile myopia progression. The
standard clinical advice is unglamorous and well established: every ~20 minutes,
look at something far away for ~20 seconds. Schools own the screens and the
timetable, so schools are the only actor who can make that advice actually happen
— but the advice is easy to give and hard to enforce, because a teacher managing
thirty children cannot also be a stopwatch.

Every naive solution fails in the same way: **it asks the child to be
responsible, or it asks the teacher to police.** Neither survives a Tuesday
afternoon.

### 1.2 The insight

The eye-break routine is a *scheduling* problem, not a *compliance* problem.

If the schedule is authoritative, server-owned, and impossible for the client to
influence, then the routine happens regardless of whether anyone remembers it,
regardless of whether the classroom PC was reloaded, and regardless of whether a
student closes the tab. Nobody has to be trusted or monitored. That single move
resolves the compliance problem and, as a side effect, removes almost every
reason the product would ever have needed to identify a child.

This is why the architecture has one unusual property for a classroom tool: **the
client is not trusted to know when a break is.** It is told.

### 1.3 The product decision that follows

Because the server owns the schedule, the data the product *needs* is about
machines and timings — never people. A seat is a workstation called `PC-04`.
There is no student field in the schema, not as a disabled feature and not as a
future-proofing column. The privacy promise is therefore structural rather than
policy: there is no student record to leak, subpoena, or accidentally display.

That is the whole product thesis, and everything below is the consequence of it.

### 1.4 Who it is for

| Role | Surface | What they get | What they deliberately cannot get |
| --- | --- | --- | --- |
| **Teacher** | `/teacher` | Live board for *their* rooms: who is working, who is on a break, which seats need a check-in. Weekly report. Attention Mode. Focus Mode. | Any other teacher's classroom. Any student identity (none exists). |
| **School admin** | `/school` | Grade / classroom / subject rollups, trends, highest visual load, most common issue. | Seat-level drill-down, at any layer — refused by role, by parameter, by response guard, and by k-anonymity. |
| **Student** | `/device` | A warning, then a quiet 20-second look into the distance — in the room's language. | Any control over the cadence. Nothing to dismiss permanently. |
| **IT / technician** | `/teacher/setup` | Room cadence, workstation enrolment links, audit trail. | Anything that identifies a child, because nothing collects one. |

---

## 2. System architecture

```
   classroom PC                     school server                       teacher / admin
 ┌───────────────┐            ┌──────────────────────────┐          ┌──────────────────┐
 │ web agent     │  REST      │ Express API              │   REST   │ React SPA        │
 │ /device       │ ─────────► │  /api/agent/*            │ ◄─────── │  /teacher        │
 │               │            │  /api/teacher/*          │          │  /school         │
 │ heartbeats    │  WS        │  /api/reports/*          │   WS     │                  │
 │ countdown     │ ◄────────► │  /api/analytics/*        │ ◄──────► │  live board      │
 │ overlays      │            │  /live                   │          │                  │
 └───────────────┘            │                          │          └──────────────────┘
                              │ BreakScheduler (1 Hz)    │
                              │ DemoAgentPool (demo only)│
                              │ SQLite via node:sqlite   │
                              └──────────────────────────┘
```

One Node process, one SQLite file, one web build. Three runtime dependencies
total (`express`, `ws`, `cors`); the web app adds React and React Router.

### 2.1 Where authority lives

**The server decides when a break happens.** `server/src/services/scheduler.js`
walks every live seat on a 1 Hz tick and drives the entire lifecycle:
`pending → warning → in_progress → resolved(completed | skipped | missed)`.

Consequences that fall out of that choice, and are the product's actual
guarantees:

- Closing the tab, reloading mid-break, or powering the PC off **cannot change the
  cadence**. On reconnect the agent is handed the true state, including a break
  already on screen (`buildAgentState` returns `activeBreak` with its elapsed
  time, so the overlay *rejoins* rather than restarts).
- A cheap client cannot claim a 20-second break in 200 ms — the server re-derives
  elapsed time from its own `started_at`. *(See §10.1: there is a real hole in
  this control as shipped.)*
- An offline PC is **frozen, not penalised**: no warnings, no trigger, no miss
  while it is away, and its clock is re-anchored on return.

### 2.2 Module map — server (`server/src`)

| Module | Responsibility |
| --- | --- |
| `index.js` | Express app, WebSocket hub wiring, static SPA, graceful shutdown |
| `config.js` | Port, DB path, demo mode, tick rate, k-anonymity floor, token TTL |
| `db.js` | Schema, idempotent column migrations, query helpers, transactions, audit |
| `auth.js` | scrypt hashing, bearer + agent tokens, role guards, classroom scoping |
| `realtime.js` | Room-based fan-out (`classroom:*`, `seat:*`, `school:*`), keepalive |
| `lib/validation.js` | Seat-label privacy gate, message sanitising, domain validation |
| `lib/http.js` | Typed API errors, async wrapper, **aggregate-only response guard** |
| `lib/time.js` | Epoch-ms conventions, school-local day/week/month windows |
| `lib/ids.js` | `makeId` (short ids), `makeToken` (CSPRNG credentials), seeded PRNG |
| `services/scheduler.js` | The 1 Hz tick: warnings, triggers, misses, snapshots, weekly job |
| `services/sessionState.js` | The only writer of schedule columns |
| `services/breaks.js` | Pure timing and outcome maths (no DB, no sockets) |
| `services/dashboard.js` | Live classroom snapshot, seat detail, attention rules |
| `services/reports.js` | Weekly metrics, per-day/per-seat series, CSV, stored snapshots |
| `services/analytics.js` | Grade/classroom/subject rollups, k-anonymity, trend, issues |
| `services/attention.js` | Attention Mode broadcast, auto-expiry, audit |
| `services/focus.js` | Focus Mode policy document and lifecycle |
| `services/agentState.js` | The single document a classroom PC renders itself from |
| `services/demoAgents.js` | Demo-only stand-in PCs; a real agent always wins |
| `seed.js` | Generates a reproducible 4-week demo school |

### 2.3 Module map — web (`web/src`)

| Area | Files |
| --- | --- |
| Shell | `App.jsx` (roles, routes, session), `components/AppShell.jsx` |
| Translation | `i18n/` — provider, `languages.js`, `en.js`, `ru.js`; `components/LanguageSwitcher.jsx` |
| Live data | `api/hooks.js` — one socket in `App`, a `useLiveEvent` bus, `useResource` loader |
| Teacher board | `pages/TeacherDashboard.jsx`, `components/SeatBoard.jsx`, `SeatDetailDrawer.jsx` |
| Break + attention surfaces | `components/Takeovers.jsx`, `components/SessionWarnings.jsx`, `AttentionModeDialog.jsx` |
| Reports | `pages/WeeklyReportPage.jsx` (hand-drawn SVG chart + print stylesheet) |
| Admin | `pages/SchoolAnalyticsPage.jsx` |
| Focus Mode | `pages/FocusModePage.jsx`, `components/FocusModePanel.jsx` |
| Device agent | `pages/DevicePage.jsx` |
| Design system | `styles/fonts.css`, `styles/base.css` (tokens), `app.css`, `auth.css`, `window.css` |

---

## 3. Data model

```
schools ─┬─ grades ── classrooms ─┬─ seats ─────────┐
         │                        │                 │
         │                        ├─ lesson_sessions│
         │                        │        │        │
         │                        │        └─ seat_sessions ── break_events
         │                        │                            (the event log)
         │                        ├─ focus_sessions ── focus_session_resources
         │                        └─ attention_broadcasts
         └─ users (teacher/admin) ── teacher_classrooms
         focus_resources (school-curated catalogue)   weekly_reports   audit_log
```

Design rules that hold everywhere:

- Every timestamp is **epoch milliseconds** (`INTEGER`).
- Ids are application-generated `TEXT` with a type prefix (`seat_9f3k2m4p`), so
  the schema is portable to Postgres without a sequence rewrite.
- `break_events` and `seat_sessions` are the **append-mostly event log everything
  else is derived from.** No cached counters exist to drift — which is why the
  live dashboard can never disagree with the weekly report.
- Statuses are constrained in the schema, not only in code:
  `break_events.status ∈ (pending, in_progress, completed, skipped, missed)`.

### 3.1 The privacy-critical detail

`seats` has **no student column**, and the label carries a `CHECK`:

```sql
CHECK (label GLOB 'PC-[0-9]*' OR label GLOB 'Seat [0-9]*')
```

That constraint is looser than it looks — `PC-1 Anna` satisfies
`PC-[0-9]*` (see §10.3). The real gate is `assertSeatLabel()` in
`lib/validation.js`, and the database constraint is the second line of defence
rather than the first.

### 3.2 Migrations

`CREATE TABLE IF NOT EXISTS` is a no-op against an existing database, so a column
added to the schema would never reach a deployment that already had data.
`applyMigrations()` runs on every open and is idempotent, driven by an explicit
`ensureColumn()` helper. Two columns have been added this way so far
(`users.preferences`, `classrooms.language`). It is deliberately **not** a general
migration framework: if the schema needs to change *shape* rather than grow, write
a real versioned step.

---

## 4. The break lifecycle

The heart of the product. `services/breaks.js` holds the pure maths;
`services/sessionState.js` is the only writer of schedule columns;
`services/scheduler.js` is the only thing that *decides*.

```
seat joins lesson
      │  startSeatSession()
      ▼
  ┌─────────┐   warningOffsets()   ┌────────────────┐
  │ pending │ ───────────────────► │ break:warning  │  T-5 and T-1
  └────┬────┘                      └────────────────┘
       │ due_at reached (scheduler tick)
       ▼
 ┌─────────────┐  markBreakShown()   ┌──────────────┐
 │ in_progress │ ◄────────────────── │ break:start  │  overlay up
 └──────┬──────┘                     └──────────────┘
        │  completed / skipped  (agent)
        │  missed               (deadline = started_at + duration + grace)
        ▼
   resolved ──► resolveBreak() restarts the cadence
```

Key mechanics:

- **The break row is created before the break is due.** That is what lets the
  5-minute and 1-minute warnings attach to a real recommendation, and what lets
  the dashboard count down to a break it already knows about.
- **`active_seconds` + `resumed_at` accumulator.** Completed stretches are banked
  into `active_seconds`; the stretch in progress is anchored by `resumed_at`.
  Pausing (a break going up, or the seat going away) banks the stretch and clears
  the anchor, so no figure depends on a ticking counter and nothing drifts over a
  lesson.
- **`skipped` and `missed` both restart the clock.** Stacking another break
  immediately on top of a refused one would contradict the "predictable, never
  abrupt" principle.
- **Adherence** = `completed / (completed + skipped + missed)`. Breaks still
  `pending` are excluded from both sides, because a break that has not come due
  yet is neither a success nor a failure.
- **Warning leads scale with the cadence** (`warningOffsets`): at the 20-minute
  default the scale is exactly 1:1 (true T-5 and T-1); at the demo's 2-minute
  cadence the leads shrink so they remain meaningful.
- **"Long visual session"** has two definitions on purpose: the room's own
  `long_session_min` drives the *live* amber flag, while reports and school
  rollups use a fixed product-wide 45 minutes so grades compare like with like.

### 4.1 Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Agent socket drops | REST heartbeat every 5 s in parallel, so the seat stays online; WS reconnects with backoff |
| Browser reloaded mid-break | Agent rejoins the break in progress with the server's elapsed time |
| Seat offline mid-lesson | Frozen: no breaks, no penalties, cadence re-anchored on return; flagged for the teacher |
| Seat offline mid-break | That break is recorded as **missed** — it was on screen and unfinished |
| Server restarts | Schedules live in the database; the 1 Hz tick resumes and produces the same answers |
| Policy fetch fails (Focus Mode) | Last applied rules stay in force — **fail closed** |
| Admin analytics guard trips | `500 aggregate_guard_violation` plus a server log naming the leaked path |
| Scheduler tick throws | Caught and logged per tick; the interval is never cancelled by one bad pass |

---

## 5. API surface

Full request/response shapes are in [`docs/API.md`](docs/API.md). Summary:

### REST

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | — | Bearer token + user + accessible classrooms |
| `GET` | `/api/auth/me` | user | Identity, preferences, classrooms, server time |
| `PATCH` | `/api/auth/me/preferences` | user | Interface language (validated) |
| `POST` | `/api/auth/logout` | user | Deletes the token |
| `GET` | `/api/teacher/classrooms` | teacher | Assigned rooms only |
| `GET` | `/api/teacher/classrooms/:id/snapshot` | teacher | **The live dashboard document** |
| `GET`/`PATCH` | `/api/teacher/classrooms/:id/config` | teacher | Cadence, thresholds, room language |
| `GET`/`POST` | `/api/teacher/classrooms/:id/seats` | teacher | Enrolment material (`agentToken`, `deviceUrl`) |
| `GET`/`DELETE` | `/api/teacher/seats/:id` | teacher | Seat detail card / remove workstation |
| `POST` | `/api/teacher/classrooms/:id/session`, `/session/end` | teacher | Lesson lifecycle |
| `GET`/`POST` | `/api/teacher/classrooms/:id/attention`, `/attention/clear` | teacher | Attention Mode |
| `GET`/`POST`/`DELETE` | `/api/teacher/classrooms/:id/focus` | teacher | Focus Mode lifecycle |
| `POST`/`PATCH` | `/api/teacher/focus/catalog` | **admin** | School-curated resource catalogue |
| `GET` | `/api/reports/classrooms/:id/weekly`, `.csv`, `/print`, `/history` | teacher | Weekly report |
| `GET` | `/api/analytics/school`, `/trend`, `/grades`, `/issues`, `/classrooms/:id/rollup`, `/school/export.csv` | **admin** | Aggregate-only rollups |
| `POST` | `/api/agent/hello`, `/heartbeat` | agent | Join + heartbeat, returns full device state |
| `GET` | `/api/agent/state`, `/instruction-pool` | agent | Converge on true state |
| `POST` | `/api/agent/breaks/:id/shown`, `/complete`, `/skip` | agent | Break lifecycle reporting |
| `POST` | `/api/agent/focus/report` | agent | Enforcement acknowledgement |
| `GET` | `/api/health` | — | Counts, timings, demo flag |
| *demo only* (`MG_DEMO=1`) | `/api/demo/status`, `break-now`, `stretch`, `resolve`, `seats/:id/offline`, `reset`, `audit` | teacher | Walkthrough controls that edit real rows |

### WebSocket (`/live`)

Authenticated by `?token=` (person) or `?agent=` (classroom PC) at upgrade.

Client → server: `ping`, `agent:heartbeat`, `teacher:subscribe`,
`agent:focus-report`.

| Event | To | Meaning |
| --- | --- | --- |
| `hello` | teacher/admin | Socket authenticated |
| `agent:state` | seat | Full device state (config, next/active break, overlays, policy) |
| `break:warning` | seat | T-minus notice with the real lead in seconds |
| `break:start` | seat | T-0: overlay up, instruction, duration |
| `break:missed` | seat | The window closed without a completion |
| `attention:show` / `attention:clear` | seat | Teacher message on/off |
| `attention:broadcast` | teacher | Dashboard shows the Clear control + countdown |
| `focus:policy` / `focus:changed` | seat / teacher | Allowlist policy document |
| `classroom:changed`, `classroom:config` | classroom | Something real changed — dashboards refetch |
| `session:started` / `session:ended` | classroom | Lesson lifecycle nudge |
| `analytics:stale` | school | Aggregate figures moved |

**The hub is deliberately dumb.** `realtime.js` moves envelopes; it never decides
policy. That is what keeps "a dropped socket cannot change a child's break
rhythm" true by construction rather than by discipline.

---

## 6. Privacy and security model

Four independent controls protect the aggregate layer, because "aggregate only"
has to survive a future maintainer adding a convenient endpoint:

| # | Control | Stops | Where |
| --- | --- | --- | --- |
| 1 | `requireUser('admin')` | The wrong **person** | `routes/analytics.js` |
| 2 | `rejectIdentifierParams()` | The wrong **question** — `?seatId=…` is refused by name (`400 seat_level_not_available`), not silently ignored | `routes/analytics.js` |
| 3 | `aggregateOnlyGuard()` | The wrong **answer** — scans the outgoing payload for seat/student identifiers and `PC-nn`-shaped values | `lib/http.js` |
| 4 | k-anonymity suppression | Re-identification by elimination — cells built from fewer than `MG_MIN_COHORT` (default 5) workstations are withheld | `services/analytics.js` |

Plus three gates on the write path:

1. **Seat identity** — `assertSeatLabel()` is the single choke point for every
   label that enters the system; the DB `CHECK` is the backstop.
2. **Free-text broadcast** — `sanitizeMessage()` length-caps, strips angle
   brackets and removes control characters from Attention Mode text.
3. **Domain** — `assertDomain()` normalises and validates Focus Mode resources.

### 6.1 Attention Mode is not remote control

Enforced by the payload, not by a policy page. Every broadcast carries:

```json
"capabilities": { "inputLock": false, "screenCapture": false,
                  "appBlocking": false, "windowControl": false,
                  "scope": "lesson-management" }
```

Those capabilities do not exist in the codebase — not as a setting, not as an
API, not as a disabled branch. The overlay says so on screen, so a child is not
left guessing whether the machine is watching them. Every broadcast is written to
`audit_log` **with its message text**.

### 6.2 What is deliberately not collected

Keystrokes, screenshots, page content, browsing history, audio, camera, file
contents, application usage, and **any identifier for the person at the
keyboard**. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

### 6.3 Credentials

- Passwords: `scryptSync`, 64-byte key, per-user random salt, compared with
  `timingSafeEqual`.
- User tokens: `randomBytes(24).toString('base64url')` → 192 bits, 12 h TTL,
  expiry enforced and expired rows deleted on presentation.
- Agent tokens: `randomBytes(18)` → 144 bits, `UNIQUE`, **no expiry** (a
  workstation's identity is provisioned once). They appear only in the enrolment
  response behind classroom ownership, and never in `/api/health`, the access log
  or an error body.

---

## 7. Design system

**Direction: "Horizon."** The product asks children to look into the distance, so
the interface is built out of distance — atmospheric depth, a horizon line, mist,
and a single warm sun as the only warm colour in a deep-green world. The
full-screen break challenge is the purest expression of it and the reference
everything else borrows from.

### 7.1 Tokens (`styles/base.css`)

| Family | Role |
| --- | --- |
| `--distance-50 … 950` | The deep-green brand ramp, taken from the break screen sky |
| `--mint-*` | The break ring's light; affirmation and live state |
| `--sun-*` | **The one warm colour.** Sunset persimmon, not default amber. Means exactly "needs attention" |
| `--petrol-*` | The "resting / on break" state — cool enough to separate from green |
| `--ink-*` | Green-tinted neutrals, so they sit inside the atmospheric palette |
| `--on-dark*` | Text tokens for the full-screen student screens |
| `--r-xs … --r-full` | Radii, 4–24px |
| `--shadow-xs … --shadow-float` | Depth, reserved for things that genuinely float |
| `--ease-*`, `--dur-*` | Motion |
| `--track-eyebrow`, `--track-label`, `--track-wide` | **Language-aware letterspacing** (see §8.3) |

### 7.2 Type

| Role | Face | Why |
| --- | --- | --- |
| Display / headings | **Bitter** (variable slab serif) | Editorial confidence at display sizes; holds up at interface sizes, unlike fashionable high-contrast serifs |
| Interface | **Manrope** (variable grotesk) | Neutral, wide weight range (400–800 — every weight the CSS asks for), excellent numerals |
| Code / ids | System mono | Seat labels and tokens only; never prose |

Both are **self-hosted** and both ship **Cyrillic** — which is a hard requirement,
not a bonus: Fraunces, Instrument Serif and Newsreader all failed on it. A
classroom PC with no internet still renders the intended typography rather than
silently falling back to `system-ui`.

Section labels, table headers and counters step *out* of the serif and into the
grotesk at uppercase — a slab serif at 11px uppercase is a texture, not a label.

### 7.3 Surfaces

Flat by default. A box gets a hairline border **or** a tint **or** a deep fill —
never all three, and never a shadow unless it genuinely floats (modal, drawer,
toast). Radii stay tight (4–8px for controls). The signature interactions are the
sun *breathing* on the break screen and a seat's status change emitting a single
soft ripple from its status dot rather than snapping colour.

---

## 8. Internationalisation — Russian-first

The deployment this ships to is a Russian school, so **Russian is the default**:
the sign-in page, every dashboard surface and every student-facing screen are
Russian without anybody having to find a switcher first.

| Decision | Where | Why |
| --- | --- | --- |
| `DEFAULT_LANGUAGE = 'ru'` | `i18n/languages.js` | The out-of-the-box experience. It is also the `t()` fallback dictionary, so an untranslated key resolves to Russian rather than English. |
| `<html lang="ru">` | `web/index.html` | No language flash, and pre-React paint is already Russian. The provider keeps `document.documentElement.lang` in sync afterwards. |
| Cyrillic faces preloaded | `web/index.html` | The Cyrillic subsets are on the critical path; without preload the browser discovers them only after layout, causing a flash and a shift. |
| English still first-class | `i18n/en.js` | Selecting English, or having `en` in `Accept-Language`, overrides the default in every case. |

### 8.1 Mechanism

One provider wraps the whole app — including the classroom-PC view, because the
break screen is the surface a student actually reads.

| Call | Use |
| --- | --- |
| `t('board.workstations')` | A plain string, with `{name}` interpolation |
| `tn(count, 'board.workstations')` | A count, selecting the plural category the language uses |

**Plural categories come from `Intl.PluralRules`, not a suffix.** English needs
one/other; Russian needs one/few/many/other, so 1 рабочее место, 2 рабочих места
and 5 рабочих мест are three different words. A dictionary entry may therefore be
an *object* of categories, and `server/test/i18n.test.js` fails the build if a
Russian plural entry is missing one.

**Numbers and dates follow the language.** `lib/format.js` is not a React module,
so the provider pushes the locale in via `setFormatLocale()` and the language's
unit strings via `setFormatStrings()`. Every existing `toLocale*` call becomes
locale-correct without threading a locale through ~20 call sites: "1,625" and
"89.6%" become "1 625" and "89,6%".

**Server-authored prose is keyed, not translated twice.** Payloads carry stable
identifiers (`instruction.key`, `metric.key`, `flag.code`, `issue.code`,
`entry.action`) plus structured `params`, so the client composes the sentence in
the reader's language. The server's English `detail`/`label` fields remain for API
consumers and as a last-resort fallback.

**Persistence is layered.** `localStorage` applies instantly and works signed out;
the signed-in account stores the choice server-side (`users.preferences`) so it
follows a teacher to another computer. A classroom PC has no account, so its
language comes from its room (`classrooms.language`) — configuration, not a
control a student can flip.

### 8.2 The i18n test suite is the quality gate

`server/test/i18n.test.js` (11 tests) is the model the rest of the repo should
follow. It asserts, against the real files:

- every English key exists in Russian, and Russian adds no key English lacks
  (plural categories excepted);
- every Russian plural entry carries all four categories;
- interpolation placeholders match between the two dictionaries;
- `t()` is never called on a plural entry and `tn()` never on a plain string;
- every server-defined instruction key, metric, attention flag and audit action
  has a translation;
- every `t()`/`tn()` key used anywhere in `web/src` resolves in both dictionaries.

That last test is why making Russian the default is safe: the dictionary cannot
be incomplete without failing the build.

### 8.3 Cyrillic typography corrections

Three things in the original stylesheet were tuned on Latin and degrade in
Russian. All three are fixed:

1. **Letterspacing.** Positive tracking that clarifies `WORKSTATIONS` leaves
   `РАБОЧИЕ МЕСТА` swimming, because Cyrillic lowercase forms are wider and its
   uppercase forms more uniform. Uppercase tracking now reads
   `--track-eyebrow` / `--track-label` / `--track-wide`, which a `:lang(ru)` block
   reduces (0.13em → 0.085em, 0.09em → 0.06em, 0.24em → 0.17em).
2. **Synthetic oblique.** Cyrillic has no true italic in these faces, so a browser
   asked for one synthesises a smear. `font-synthesis: none` refuses it, and
   `:lang(ru) em/i/cite` fall back to the roman.
3. **Measure (`ch`) caps.** The `ch` unit is the width of a "0" — the wrong ruler
   for Cyrillic running text. The break-screen instruction rises 21ch → 25ch, the
   attention message 24ch → 28ch, and the sign-in headline is retuned, so Russian
   copy keeps the intended number of lines instead of gaining an orphaned word.

---

## 9. Testing and quality

```bash
npm test            # 94 tests, node:test, no network needed
npm run test:contrast   # contrast audit of the student-facing screens
```

| File | Tests | Covers |
| --- | --- | --- |
| `breaks.test.js` | 16 | Adherence maths, streaks, schedule clamping, warning leads, week windows |
| `scheduler.test.js` | 21 | The whole timing lifecycle on a **fake clock**, plus dashboard/attention derivation |
| `privacy.test.js` | 12 | Seat-label gate, message sanitising, aggregate guard (positive and negative) |
| `api.test.js` | 34 | End-to-end HTTP over a real socket: auth, roles, agent anti-cheat, reports, analytics, attention, focus, audit, per-account and per-room language |
| `i18n.test.js` | 11 | Translation integrity (see §8.2) |

**94, not 95** — the README and `docs/ARCHITECTURE.md` both say 95, which is a
documentation error (§10.6).

The scheduler suite is the strongest part: `setClock` drives a fake clock, so a
20-minute cadence is verified in microseconds, and a seat that stops heartbeating
is genuinely treated as offline. Each file runs in its own process via
`node --test`, which is what isolates the shared module-level clock and the
`setDb()` fixture.

`npm run test:contrast` (`scripts/check-contrast.mjs`) computes text contrast on
the dark break screen by **compositing the real gradients** — sky, two off-centre
radial washes, the haze band at full strength, the land band — parsing the values
out of the CSS so the audit follows the source rather than a transcription. It
earned its place: the first version put the progress rail exactly on the sky/land
boundary, where the background swings from dark to bright as the sun sets, and the
rail fell to **1.0:1** at the end of a break. The rail now sits on the ground
(measured 14.6:1).

---

## 10. Known defects and open risks

This section is the reason to trust the rest of the document. Everything below
was verified by reading the code, and the two highest-severity items were
reproduced against a running server.

### 10.1 A break can be completed without ever being shown (high)

`POST /api/agent/breaks/:id/complete` re-derives elapsed time only when
`started_at` is non-null:

```js
// server/src/routes/agent.js
const elapsedMs = breakEvent.started_at ? atMs - Number(breakEvent.started_at) : null;
if (elapsedMs !== null && elapsedMs < requiredMs * 0.9) {
  throw new ApiError(409, 'break_not_elapsed', { ... });
}
```

A client that never calls `/shown` leaves `started_at` null, so the guard is
skipped and the break is recorded `completed` with **zero seconds elapsed**.

Reproduced:

```
before : { status: 'pending', started_at: null, duration_sec: 20 }
POST   /api/agent/breaks/brk_kxbgxrl9/complete   → 200
body   : { status: 'completed', elapsedSeconds: null }
after  : { status: 'completed', started_at: null }
```

This defeats the anti-cheat property quoted in `docs/ARCHITECTURE.md` and
`README.md`. The existing test (`api.test.js`) calls `/shown` first, so it only
exercises the protected path. **Fix:** reject `complete` unless
`started_at !== null` (and status is `in_progress`), returning `409`.

### 10.2 `/shown` accepts a break that is not due yet (medium)

`markBreakShown()` sets `in_progress` for any non-resolved break, and the route
never compares `due_at` to now. Reproduced: a break **1200 seconds in the future**
was put on screen and marked `in_progress` on request. A client can therefore pull
the overlay forward at will, which inflates `completed` counts relative to the
real cadence. **Fix:** require `due_at <= now`.

### 10.3 `assertSeatLabel()` rejects its own canonical output (medium)

```js
const SEAT_LABEL_RE = /^(PC|Seat)[\s-]?(\d{1,3})$/i;
const HUMAN_NAME_RE = /\b[A-Z][a-z]{2,}\b/;
...
if (HUMAN_NAME_RE.test(raw)) { throw new ApiError(400, 'pii_rejected', ...); }
```

`HUMAN_NAME_RE` matches the word **`Seat`** (`[A-Z][a-z]{2,}` = "Sea", with the
word boundary before the "t"). Measured behaviour:

| Input | Result |
| --- | --- |
| `"Seat 12"` | **throws `pii_rejected`** |
| `"Seat-12"` | **throws `pii_rejected`** |
| `"Seat12"` | accepted → normalises to `"Seat 12"` |
| `"seat 12"` | accepted → normalises to `"Seat 12"` |
| `"PC-01"` | accepted |

So the validator rejects exactly the form it produces, for the `Seat` prefix
only, and the outcome depends on whether the caller happened to include a
separator. The canonical documented example `"Seat 12"` in
`docs/PRIVACY.md` does not work. The integration test masks it by accepting
either error code:

```js
assert.ok(['invalid_seat_label', 'pii_rejected'].includes(body.error));
```

**Fix:** check `HUMAN_NAME_RE` against the *normalised* label, or drop the second
gate entirely (the first already constrains the shape to `PC`/`Seat` + digits) —
and assert one specific error code in the test.

### 10.4 The schema `CHECK` is looser than "machine shape" (medium)

`CHECK (label GLOB 'PC-[0-9]*' ...)` accepts `PC-1 Anna`, `PC-12ABC`,
`PC-999XYZ`. Combined with `seed.js` writing labels by direct interpolation
(bypassing the validator), the "there is no override" claim in `docs/PRIVACY.md`
holds for the HTTP API but not for the schema. **Fix:** make the glob exact, or
enforce the label through the validator in the seeder.

### 10.5 `aggregateOnlyGuard` does not cover the CSV route (medium)

`aggregateOnlyGuard()` wraps **`res.json` only** (`lib/http.js`). The analytics CSV
exits via `res.send(...)` (`routes/analytics.js`), so it is unguarded even though
the router-level `router.use(...)` looks like it covers every route. Today's CSV
is clean, but it is the one egress where a future per-workstation column would ship
silently. The guard also has naming holes: `workstationId`, `machineName`,
`computerId`, `pcLabel` are not in `FORBIDDEN_STEMS` — and "workstation" is the
product's own vocabulary, so a maintainer following the codebase's naming would be
the one to trip over it. **Fix:** wrap `res.send` too, and add the workstation
family to the stem list.

### 10.6 Documentation drift

- `README.md` and `docs/ARCHITECTURE.md` say **95 tests**; there are **94**.
- `README.md` claims "an API test asserts `400 pii_rejected`" — no test asserts
  that code specifically (§10.3).
- `README.md` claims "the schema test asserts the device never emits a
  person-shaped field" — no such test exists; the person-shaped-field scan covers
  the *teacher* payloads only.
- `docs/PRIVACY.md` describes the guard as scanning the "serialised payload"; it
  runs on the pre-serialisation object inside `res.json`.
- `docs/PRIVACY.md` gives `"Seat 12"` as the canonical valid label, which the
  current validator rejects (§10.3).

### 10.7 Fixed in this revision

Recorded with the same rigour as the open items, because a defects list that only
ever grows stops being read.

**The weekly report was empty by construction (high — fixed).**
`seed.js` anchored the generated history at `startOfLocalWeek(now() - 7 * DAY)` —
the previous week, *unconditionally*. But the report it is meant to populate is
`weekRange(mode: 'last-complete')`, which means "the most recent Mon–Fri that has
finished":

| Today | Most recent finished Mon–Fri | `now() − 7d` | Agree? |
| --- | --- | --- | --- |
| Sat / Sun | this week's | this week's | yes |
| Mon – Fri | **last** week's | the week before that | **no — off by one week** |

So seeding on a weekday produced four weeks of history ending a week *earlier*
than every `last-complete` window the application asks for. Because the report
endpoint prefers the stored snapshot, a teacher opening the weekly report saw
**zeros across all five metrics** — an empty report rather than an error, which is
the worst kind of wrong.

Found because `api.test.js` test 18 asserts `computerSessions > 0` against a live
snapshot and failed reproducibly. Confirmed pre-existing by stashing every change
in this revision and re-running: it failed identically on pristine code.

Verified after the fix (today = Sunday, so the window is Mon 28 Sep – Fri 2 Oct):

```
before:  computerSessions 0   | recommended 0   | completed 0   | perSeat 0
after:   computerSessions 119 | recommended 238 | completed 199 | perSeat 12 | 5 days
```

The fix derives one shared anchor (`lastCompleteMonday`) using the same rule as
`weekRange`, so the seeder and the report can no longer disagree. The API suite
went from 33/34 to **34/34 passing**.

**Russian is now the default interface language (fixed).**
`DEFAULT_LANGUAGE` was `'en'` while `web/index.html` hard-coded `lang="en"`, so a
Russian-language deployment opened in English. Both are now Russian, the Cyrillic
faces are preloaded, and the Cyrillic typography corrections in §8.3 are in place.

**CSS and UI defects (fixed).** The full analysis, with the reasoning behind each
change, is in §14.

### 10.8 Lower-severity and structural notes

| Area | Note |
| --- | --- |
| No WebSocket tests | The entire realtime path — `/live` upgrade auth, `teacher:subscribe` authorization, agent identity — is untested, yet it is the delivery channel the privacy doc leans on. |
| No cross-school tests | The seed creates exactly one school, so tenant isolation on analytics/reports/demo routes is unverified by test. |
| `/api/demo/audit` is unscoped | Demo-gated, but it joins `seats` and returns seat labels with no classroom or school filter, unlike every other demo route. |
| `assertClassroomAccess` admin branch untested | This single `if` is the only thing stopping an admin from drilling into seat data via the teacher router. |
| `tx()` uses a module-global depth counter | `txDepth` is not per-database, so nested transactions across two open databases would join the wrong one. Latent, not currently reachable. |
| `buildSeatDetail` rebuilds the whole classroom | Opening one seat's drawer re-runs the full snapshot query set. Fine at 12 seats; O(seats) per click at scale. |
| `schoolAnalytics` is O(classrooms × windows) | A 7-day window with 8 classrooms runs ~34 rollup scans, each reading and sorting raw break rows. No caching layer. |
| DST-sensitive day maths | `dashboard.js` and `reports.js` step days by fixed 86 400 000 ms, which drifts across a DST boundary in a non-UTC zone. |
| `math-intrinsics` modulo bias | `makeId` maps bytes to a 36-char alphabet with `% 36`, a slight bias. Not security-relevant (ids are not credentials). |

---

## 11. Operations

| Concern | Position |
| --- | --- |
| **Configuration** | `PORT`, `MG_DB`, `MG_DEMO`, `MG_TICK_MS`, `MG_SCHEDULER`, `MG_TOKEN_TTL_HOURS`, `MG_MIN_COHORT`, `MG_SNAPSHOT_THROTTLE_MS`, `MG_PUBLIC_URL`, `MG_QUIET`, `MG_ALLOW_DEMO_TOOLS`. See `docs/DEPLOYMENT.md`. |
| **Backups** | The database is one file in WAL mode: `sqlite3 data/myopiaguard.db ".backup 'backup.db'"`. |
| **Retention** | Deliberately unopinionated — events are the school's records. `docs/DEPLOYMENT.md` ships the exact `DELETE` statements for a chosen window. Nothing in the product needs history older than the current academic year. |
| **TLS / proxy** | Terminate at the school's existing proxy. Note that tokens travel in a query parameter for the WebSocket upgrade, so a proxy that logs full URLs needs that path excluded or the token redacted. |
| **Capacity** | Tens of rooms and hundreds of seats. SQLite plus a 1 Hz in-process tick is the right size; the schema is portable to Postgres if a district outgrows one process. |
| **CORS** | Currently `cors({ origin: true })` — reflects any origin. Low impact while auth is bearer-only (no cookie to ride), but it should be an explicit allowlist in production. |
| **Logging** | One line per request: method, URL, status, ms. Never headers, never bodies — so no token or message text lands in the log. `MG_QUIET=1` silences it. |

---

## 12. Deliberate non-goals

- **No student accounts, anywhere.** Not stubbed, not planned — see §6.
- **No device control.** No input lock, no capture, no app blocking: not
  implemented, not permissioned, not an API.
- **No charting library.** The two charts are ~60 lines of SVG each; they print
  correctly, render without JavaScript in the print path, and keep the runtime
  dependency list at three packages.
- **No message queue or worker fleet.** A school is tens of rooms and hundreds of
  seats; an in-process tick over SQLite is the right size.
- **No shared UI kit.** The design system is ~2 000 lines of hand-authored CSS
  with tokens, not a component library — which is what makes the horizon motif
  consistent instead of approximate.

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Seat** | A workstation. `PC-04`, never a person. The only identity the system stores. |
| **Break event** | One recommended eye break and its outcome: `pending`, `in_progress`, `completed`, `skipped`, `missed`. |
| **Stretch** | Uninterrupted screen time before a break. "Long" = past the room threshold (live) or 45 min (reports). |
| **Adherence** | `completed / (completed + skipped + missed)`. Pending breaks are excluded. |
| **Attention Mode** | A teacher's classroom-management broadcast to every screen. Explicitly not remote control. |
| **Focus Mode** | A session-scoped browsing allowlist derived from a school-curated catalogue, expiring with the lesson. |
| **In-progress rejoin** | A reloaded or reconnected agent being handed the true remaining time of a break already on screen. |
| **k-anonymity floor** | Minimum contributing workstations before a rollup cell is reported at all (`MG_MIN_COHORT`, default 5). |

---

## 14. CSS and UI analysis — what was wrong and what changed

The stylesheets were read end to end (`fonts.css`, `base.css`, `app.css`,
`auth.css`, `window.css` — ~3 300 lines) and every finding below was confirmed
against the file before being changed. Each entry is: **what was wrong → why it
mattered → the fix.**

### 14.1 Structural duplication

**`.panel` and `.card` were two complete, divergent definitions of the same
surface.** `base.css` defined both with the same white background, radius and
shadow, but the border colour had already drifted (`rgba(17,29,26,0.07)` against
`0.08`). `.panel` had **no consumer**: the only surface component is `Card` in
`components/ui.jsx`, which emits `.card`.

*Fix:* deleted the `.panel` family (including the unused `.panel--bare`), kept
`.card` as the single definition, and reconciled the tints. ~30 lines of
maintenance debt removed. `card--tinted` is used on three pages, so the variant
system stays.

### 14.2 Typography and font loading

| Problem | Why it mattered | Fix |
| --- | --- | --- |
| No font preload | The Cyrillic subsets are on the critical path for a Russian UI, but the browser only discovered them after layout — a flash of the fallback face followed by a visible reflow | `<link rel="preload" as="font" crossorigin>` for `manrope-cyrillic.woff2` and `bitter-cyrillic.woff2` |
| Bare fallback stacks | The pre-swap render used the platform generic, whose metrics differ enough from Manrope/Bitter that headings changed height and centred layouts shifted sideways | Added local-only `Manrope Fallback` / `Bitter Fallback` faces with `size-adjust` and ascent/descent/line-gap overrides |
| No synthetic-style control | A browser asked for an oblique on Cyrillic synthesises a visibly smeared fake | `font-synthesis: none` on `body`, plus `:lang(ru)` roman fallback for `em`/`i`/`cite` |
| Letterspacing tuned on Latin | Uppercase tracking that clarifies `WORKSTATIONS` leaves `РАБОЧИЕ МЕСТА` swimming | Introduced `--track-eyebrow` / `--track-label` / `--track-wide`; a `:lang(ru)` block reduces them; every uppercase rule now reads the tokens instead of a literal |
| Inconsistent tracking values | Uppercase labels used five different hard-coded values (0.08, 0.09, 0.1, 0.13, 0.19em) with no system | Unified through the three tokens |

### 14.3 Layout defects

**The topbar overflowed above ~1300px with Russian labels.** The rules hid nav
labels only below **1420px**, but Russian labels make the row wider, so between
roughly 1300px and 1440px — the commonest laptop width there is — the header
overflowed. With `flex-wrap: nowrap` plus `overflow-x: auto` and a *hidden*
scrollbar, the account chip and the sign-out button sat off-screen with no
affordance indicating it.

*Fix:* `flex-wrap: wrap` with `row-gap` (safer than clipping — an extra header row
beats a hidden control), the label-collapse breakpoint moved to 1500px, and a real
thin scrollbar on the nav instead of `scrollbar-width: none`.

**The classroom selector could not shrink.** `AppShell.jsx` set
`style={{ width: 'auto', minWidth: 210 }}` inline, which overrode the stylesheet
and truncated long Russian room names at every width. *Fix:* removed the inline
style; the width now flexes between a floor and a 240px ceiling in CSS.

**`.seat-row` used hard-coded columns.** `grid-template-columns: 92px 128px 1fr …`
held *translated* text — `2 ч 14 мин` is wider in Russian at the same font size
than its English equivalent. *Fix:* `minmax()` for the first two columns, so they
take the space they need and give it back when the row is narrow.

**Fixed stat-strip dividers broke on wrap.** `.stat` carries a left border with
`:first-child` clearing it, so when `auto-fit` wrapped the strip to two rows, the
item starting each new row kept a stray vertical rule. *Fix:* explicit
breakpoints at 900px and 560px with `nth-child(odd)` clearing the divider.

**`* { scrollbar-width: thin }` applied to everything.** It halved the scrollbar on
the classroom-PC view — where a student must discover that more content exists.
*Fix:* scoped thin scrollbars to genuinely receding surfaces (`.drawer__body`,
`.modal`, `.policy-block`); the document keeps the platform default, and the
WebKit thumb became a properly inset pill.

**iOS zooms the page when a form field is under 16px.** Every text control here is
14–15px, so every form on an iPad — including the enrolment form a technician
fills in on the classroom PC — zoomed in and stayed zoomed. *Fix:* 16px on
touch-sized viewports only.

**Device and break screens ignored mobile viewport and safe areas.** `100vh` on a
phone includes the retractable toolbar, so content at the bottom was unreachable;
on a landscape tablet the device bar sat under the notch. *Fix:* `100dvh` with a
`vh` fallback, and `env(safe-area-inset-*)` padding on `.device` and the break
screen footer.

### 14.4 Accessibility and robustness

- **`forced-colors` support on the break screen.** The scene is painted entirely
  in gradients, so a forced-colours user lost the sun *and* the progress
  indicator. Added a `@media (forced-colors: active)` block that keeps the text on
  `Canvas` and gives the progress rail a real border and `Highlight` fill.
- **Print.** The print sheet now also drops the metric strip's rules to a printable
  border colour, so a report printed from a browser with background graphics off
  still shows its structure.
- **Russian string growth.** Cyrillic labels run 20–35% longer than their English
  equivalents, so `white-space: nowrap` on badges and stat labels clipped them.
  Added a `:lang(ru)` block allowing those specific labels to wrap.

### 14.5 Verification

| Check | Result |
| --- | --- |
| CSS brace balance, all five files | balanced (250/250, 76/76, 140/140, 10/10, 53/53) |
| `npm run test:contrast` | **all checks pass** — tightest is the eyebrow token at 8.7:1 against 4.5:1 required |
| `npm run build` | succeeds; `dist/index.html` byte-verified UTF-8 with `<html lang="ru">` and the Russian title |
| `--track-*`, `:lang(ru)`, fallback faces, `forced-colors` in the built CSS | all present after minification; `.panel` correctly absent |
| Server serving the built app | `200 text/html; charset=UTF-8`, both preloaded fonts `200 font/woff2` |
| Authenticated end-to-end | login → `/me` → classroom snapshot (2 rooms, 12 seats, 3 flagged) |
| `server/test/i18n.test.js` | **11/11 pass** — confirms the Russian dictionary is complete, so defaulting to it cannot surface a raw key |
| Full server suite | **94/94 pass** (was 93/94 before the seed fix in §10.7) |
