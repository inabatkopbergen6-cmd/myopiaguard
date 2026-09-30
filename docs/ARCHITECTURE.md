# Architecture

## Shape of the system

```
   classroom PC                     school server                       teacher / admin
 ┌───────────────┐            ┌──────────────────────────┐          ┌──────────────────┐
 │ web agent     │  REST      │ Express API              │   REST   │ React SPA        │
 │ /device       │ ─────────► │  /api/agent/*            │ ◄─────── │  /teacher        │
 │               │            │  /api/teacher/*          │          │  /school         │
 │ heartbeats    │  WS        │  /api/analytics/*        │   WS     │                  │
 │ countdown     │ ◄────────► │  /live                   │ ◄──────► │  live board      │
 │ overlays      │            │                          │          │                  │
 └───────────────┘            │ BreakScheduler (1 Hz)    │          └──────────────────┘
                              │ DemoAgentPool (demo only) │
                              │ SQLite (node:sqlite)      │
                              └──────────────────────────┘
```

One Node process, one SQLite file, one web build. The classroom PC is the *same*
web app on a different route, which is why there is nothing to package per
platform and nothing to keep patched on ninety machines.

## Where authority lives

**The server decides when a break happens.** Not the classroom PC, not the
browser tab, not a timer in the student's session. `services/scheduler.js` walks
every live seat once a second and drives the whole lifecycle: warning → T-0 →
resolve (completed / skipped / missed).

Consequences that fall out of that choice:

- Closing the tab, reloading mid-break, or switching the PC off cannot change the
  cadence. On reconnect the agent is handed the true state, including a break
  already on screen (`buildAgentState` returns `activeBreak` with its elapsed
  time, so the overlay *rejoins* rather than restarts).
- A modified client cannot claim a 20-second break in 200 ms: the server
  re-derives elapsed time from its own `started_at` and rejects the completion
  (`409 break_not_elapsed`).
- An offline PC is frozen rather than penalised: no warnings, no trigger, no miss
  while it is away, and its clock is re-anchored on return.

## Module map

### Server (`server/src`)

| Module | Responsibility |
| --- | --- |
| `index.js` | Express app, WebSocket hub wiring, static web app, graceful shutdown |
| `config.js` | Port, DB path, demo mode and timings, k-anonymity floor, tick rate |
| `db.js` | Schema, migrations-by-`CREATE TABLE IF NOT EXISTS`, query helpers, transactions |
| `auth.js` | scrypt password hashing, bearer tokens, agent tokens, role guards |
| `realtime.js` | Room-based fan-out (`classroom:*`, `seat:*`, `school:*`), keepalive |
| `lib/validation.js` | Seat-label privacy gate, message sanitising, domain validation |
| `lib/http.js` | Typed API errors, async wrapper, **aggregate-only response guard** |
| `lib/time.js` | Epoch-ms conventions, school-local day/week/month windows |
| `services/scheduler.js` | The 1 Hz tick: warnings, triggers, misses, snapshot pushes, weekly job |
| `services/sessionState.js` | The only writer of schedule columns (heartbeat, break shown, resolve, end) |
| `services/breaks.js` | Pure timing + outcome maths (adherence, streaks, rotation) |
| `services/dashboard.js` | Live classroom snapshot, seat detail, attention rules |
| `services/reports.js` | Weekly metrics, per-day/per-seat series, CSV, stored snapshots |
| `services/analytics.js` | Grade/classroom/subject rollups, k-anonymity, trend, issue ranking |
| `services/attention.js` | Attention Mode broadcast, auto-expiry, audit |
| `services/focus.js` | Focus Mode policy document and lifecycle |
| `services/agentState.js` | The single document a classroom PC renders itself from |
| `services/demoAgents.js` | Demo-only stand-in PCs; a real agent always takes precedence |

### Web (`web/src`)

| Area | Files |
| --- | --- |
| Shell | `App.jsx` (roles, routes, session), `components/AppShell.jsx` |
| Translation | `i18n/` — provider, `languages.js`, `en.js`, `ru.js`; `components/LanguageSwitcher.jsx` |
| Live data | `api/hooks.js` — one socket in `App`, `useLiveEvent` bus, `useResource` loader |
| Teacher board | `pages/TeacherDashboard.jsx`, `components/SeatBoard.jsx`, `components/SeatDetailDrawer.jsx` |
| Break + attention surfaces | `components/Takeovers.jsx`, `components/SessionWarnings.jsx` |
| Reports | `pages/WeeklyReportPage.jsx` (hand-drawn SVG chart, print stylesheet) |
| Admin | `pages/SchoolAnalyticsPage.jsx` |
| Focus Mode | `pages/FocusModePage.jsx`, `components/FocusModePanel.jsx` |
| Device agent | `pages/DevicePage.jsx` |
| Design system | `styles/fonts.css` (generated), `styles/base.css` (tokens, primitives), `styles/app.css`, `styles/auth.css`, `styles/window.css` |

### Translation (`web/src/i18n`)

One provider wraps the whole app — including the classroom-PC view, because the
break screen is the surface a student actually reads. Components call:

| Call | Use |
| --- | --- |
| `t('board.workstations')` | A plain string, with `{name}` interpolation |
| `tn(count, 'board.workstations')` | A count, selecting the plural category the language uses |

Two design points worth knowing, because they are what make the Russian build
correct rather than approximately correct:

- **Plural categories come from `Intl.PluralRules`, not a suffix.** English needs
  one/other; Russian needs one/few/many/other, so 1 рабочее место, 2 рабочих места
  and 5 рабочих мест are three different words. A dictionary entry may therefore be
  an object of categories. `server/test/i18n.test.js` asserts every Russian plural
  entry carries all four.
- **Formatting follows the language too.** `lib/format.js` is not a React module, so
  the provider pushes the locale in via `setFormatLocale()` and the language's unit
  strings via `setFormatStrings()`. Every existing `toLocale*` and duration call
  becomes locale-correct without threading a locale through ~20 call sites, and
  numbers render as "1 625" and "89,6%" in Russian.

Server-authored prose is **keyed, not translated twice**: the payloads already
carry stable identifiers (`instruction.key`, `metric.key`, `flag.code`,
`issue.code`, `entry.action`), and where the server composed a sentence it now also
sends structured `params` so the client builds the sentence in the reader's
language. The server's English `detail`/`label` fields remain for API consumers and
as a last-resort fallback.

Persistence is layered: `localStorage` applies instantly and works signed out, and
the signed-in account stores the choice server-side (`users.preferences`) so it
follows a teacher to another computer. A classroom PC has no account, so its
language comes from its room (`classrooms.language`) — configuration, not a control
a student can flip.

### Schema migrations

`db.js` has an explicit `ensureColumn()` helper. `CREATE TABLE IF NOT EXISTS` is a
no-op against an existing database, so a column added to the schema would otherwise
never reach a deployment that already had data. `applyMigrations()` runs on every
open and is idempotent; the two columns added so far are `users.preferences` and
`classrooms.language`. It is deliberately not a general migration framework — if
the schema needs to change shape rather than grow, write a real versioned step.

## Visual language

**Direction: "Horizon".** The product asks children to look into the distance, so the
interface is built out of distance itself — atmospheric depth, a horizon line, mist,
and a single warm sun as the only warm colour in a deep-green world. The full-screen
break challenge is the purest expression of it and is the reference everything else
borrows from.

| Decision | Why |
| --- | --- |
| **Bitter** (variable slab serif) for headings, **Manrope** (variable grotesk) for UI | A slab gives editorial confidence at display sizes and holds up at interface sizes, unlike the fashionable high-contrast display serifs. Both needed Cyrillic: Fraunces, Instrument Serif and Newsreader do not ship it, which ruled them out for a product with a Russian interface. Both are self-hosted — `scripts/fetch-fonts.mjs` — because a classroom PC must render correctly with no internet. |
| **Surfaces are flat by default** | `border + radius + shadow + white` on every element is the signature of template output. A surface gets a hairline border *or* a tint *or* a deep fill; shadow is reserved for things that genuinely float (modal, drawer, toast). |
| **Tight radii** (3–8px, not 16–22px) | Soft corners paired with soft shadows is what makes a UI read as an off-the-shelf kit. |
| **One warm colour** — sunset persimmon, not default amber | It exists in the palette as the horizon motif and means exactly one thing: needs attention. |
| **The break screen has no ring** | A ring is an Apple-Watch idiom. The countdown is a sky: a sun that sets across the break, a horizon whose lit line *is* the progress indicator, and an instruction to look into the distance. |

**Two signature interactions.** The sun *breathes* (a slow 5s scale pulse) so a
twenty-second break does not read as a static counter; and a seat's status change
emits a single soft ripple from its status dot instead of the colour snapping. The
ripple element is keyed on `status` in React, so it replays exactly when the status
changes and never on an unrelated re-render.

**Depth of field is real.** On the sign-in page the far layer is blurred and comes
into focus as attention moves to the form — the product's advice performed by the
page. It is driven by an explicit React class rather than `:has()`: `:has()` reported
support without matching during testing, and a school may be on an older engine.

## Contrast

`npm run test:contrast` (`scripts/check-contrast.mjs`) computes text contrast on the
dark break screen by compositing the real gradients — sky, two off-centre radial
washes, the haze band at full strength, and the land band — and evaluating each
element at its own position. Values are parsed from the CSS, so the audit follows the
source rather than a transcription.

It earned its place: the first version of the scene put the progress rail exactly on
the sky/land boundary, where the background swings from dark to bright as the sun
sets and the rail fell to **1.0:1** at the end of a break. The rail now sits on the
ground, where the backdrop is stable (measured 14.6:1).

## Data model

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

Every timestamp is epoch milliseconds (`INTEGER`). `break_events` and
`seat_sessions` are the append-mostly event log everything else is derived from —
no cached counters exist to drift, which is why the dashboard can never disagree
with the weekly report.

Statuses are constrained in the schema, not only in code:
`break_events.status ∈ (pending, in_progress, completed, skipped, missed)`.

## Realtime protocol

Client → server: `ping`, `agent:heartbeat`, `teacher:subscribe`, `agent:focus-report`.
Server → client:

| Event | To | Meaning |
| --- | --- | --- |
| `hello` | teacher/admin | Socket authenticated |
| `agent:state` | seat | Full device state (config, next/active break, overlays, policy) |
| `break:warning` | seat | T-minus notice with the real lead in seconds |
| `break:start` | seat | T-0: overlay up, instruction, duration |
| `break:missed` | seat | The window closed without a completion |
| `attention:show` / `attention:clear` | seat | Teacher message on/off |
| `focus:policy` | seat | New allowlist policy document |
| `classroom:changed` | classroom | Something real changed — dashboards refetch |
| `analytics:stale` | school | Aggregate figures moved |

The hub is deliberately dumb: it moves envelopes, it never decides policy. That
keeps "a dropped socket cannot change a child's break rhythm" true by
construction.

## Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Agent socket drops | REST heartbeat every 5 s in parallel, so the seat stays online; WS reconnects with exponential backoff |
| Browser reloaded mid-break | Agent rejoins the break in progress with the server's elapsed time |
| Seat offline mid-lesson | Frozen: no breaks, no penalties, re-anchored cadence on return. Flagged for the teacher |
| Seat offline mid-break | That break is recorded as missed — it was on screen and unfinished |
| Server restarts | Schedules live in the database; the 1 Hz tick resumes and produces the same answers |
| Policy fetch fails (Focus Mode) | Last applied rules stay in force — fail closed (see `docs/FOCUS_MODE_DECISION.md`) |
| Admin analytics guard trips | `500 aggregate_guard_violation` plus a server log line naming the leaked path |

## Testing

```bash
npm test          # 95 tests, node:test, no network, ~2.5 s
```

| File | Covers |
| --- | --- |
| `server/test/breaks.test.js` | Adherence maths, streaks, schedule clamping, warning leads, week windows |
| `server/test/scheduler.test.js` | The whole timing lifecycle on a fake clock, plus dashboard/attention derivation |
| `server/test/privacy.test.js` | Seat-label gate, message sanitising, aggregate guard (positive and negative cases) |
| `server/test/api.test.js` | End-to-end HTTP: auth, roles, agent anti-cheat, reports, analytics, attention, focus, audit, per-account and per-room language, structured translatable params |
| `server/test/i18n.test.js` | Translation integrity: key parity, Russian plural completeness, matching interpolation placeholders, server keys covered, and `t()`/`tn()` misuse |

The scheduler tests drive a fake clock and send the heartbeat a real agent sends,
so a 20-minute cadence is verified in microseconds — and a seat that stops
heartbeating is genuinely treated as offline.

## Deliberate non-goals

- **No student accounts, anywhere.** See `docs/PRIVACY.md`.
- **No device control.** No input lock, capture or app blocking: not implemented,
  not permissioned, not an API.
- **No charting library.** The two charts are ~60 lines of SVG each; they print
  correctly, render without JavaScript in the print path, and keep the install at
  three runtime dependencies (express, ws, cors).
- **No message queue or worker fleet.** A school is tens of rooms and hundreds of
  seats; SQLite plus a 1 Hz in-process tick is the right size. The schema is
  portable to Postgres if a district ever outgrows it.
