# MyopiaGuard

**A classroom eye-health platform.** It manages screen-break routines across school
computers, gives teachers a live view of whether the routine is holding, and rolls
the result up into privacy-preserving school analytics.

The product's promise in one line: **it watches screens, not children.** A seat is
a workstation labelled `PC-01`; there is no student field in the data model to
fill in, and school-level reporting is aggregate by construction — enforced in the
schema, the validators, the queries and the response guard, not just the UI.

---

## Try it in two minutes

```bash
npm install
npm run build
npm run seed:demo -- --force    # 8 classrooms, 92 workstations, 4 weeks of history
MG_DEMO=1 npm start             # http://localhost:4000
```

Sign in as `teacher.avery` / `myopiaguard` (the sign-in page lists the other
seeded accounts). The dashboard opens on **Room 208 — Computer Science**, already
live, with seats working, one on a break, one PC switched off, and one seat
flagged for missing two breaks in a row.

`MG_DEMO=1` shortens the walkthrough room's cadence to a break every 2 minutes so
a full cycle is observable in under a minute, and enables the demo controls listed
in [`docs/API.md`](docs/API.md#demo-tools-mg_demo1-only). Without it, the cadence
is the real 20 minutes and none of the demo surface exists.

**To see the student side**, open the classroom-PC view in a second tab: sign in,
go to *Setup*, copy an enrolment link (for example `PC-04`), and open it. That tab
is now a classroom PC — it heartbeats, receives warnings, and takes over
full-screen for a distance break. Real agents take precedence over the demo's
simulated PCs per seat, so the dashboard hands that seat over to your tab.

## The seven deliverables

| # | Deliverable | Where it lives |
| --- | --- | --- |
| 1 | Live teacher dashboard — grid/list, per-seat and class adherence, long-session flag, missed counters, Attention Needed panel, seat detail card | `web/src/pages/TeacherDashboard.jsx`, `web/src/components/SeatBoard.jsx`, `SeatDetailDrawer.jsx` |
| 2 | Full-screen break challenge — rotating instruction, 20·19·18…1 countdown, auto-logged completion, early dismissal logged as skipped | `web/src/components/Takeovers.jsx` |
| 3 | Session limit warnings — T-5 and T-1 notices as banner + toast, configurable per classroom | `web/src/components/SessionWarnings.jsx`, `server/src/services/scheduler.js` |
| 4 | Weekly report — the five metrics, Monday→Friday trend chart, CSV and print-to-PDF export | `web/src/pages/WeeklyReportPage.jsx`, `server/src/services/reports.js` |
| 5 | School analytics — adherence by grade, highest visual load classrooms/subjects, most common issue, weekly/monthly trend, aggregate-only | `web/src/pages/SchoolAnalyticsPage.jsx`, `server/src/services/analytics.js` |
| 6 | Attention Mode — broadcast to every screen, custom or default message, teacher-set duration, clearable | `web/src/components/AttentionModeDialog.jsx`, `server/src/services/attention.js` |
| 7 | Focus Mode — resource checklist, session-scoped allowlist, versioned policy document, pluggable enforcement | `web/src/components/FocusModePanel.jsx`, `server/src/services/focus.js`, `extensions/myopiaguard-focus/`, [`docs/FOCUS_MODE_DECISION.md`](docs/FOCUS_MODE_DECISION.md) |
| + | **Language switcher** — English and Russian across every surface, including the student break screen | `web/src/i18n/`, `web/src/components/LanguageSwitcher.jsx` |

## How it works

```
classroom PC (/device)  ──REST + WebSocket──►  Node server  ◄──REST + WebSocket──  teacher (/teacher)
                                               BreakScheduler                        admin (/school)
                                               SQLite
```

The server owns the schedule. Agents render it and report what happened. That is
why closing a tab, reloading mid-break, or switching a PC off cannot change a
child's break rhythm — and why a modified client cannot claim a 20-second break in
200 ms.

- **Teachers** see their own rooms: who is working, who is on a break, which seats
  need a check-in.
- **Admins** see grade, classroom and subject rollups — and cannot reach seat-level
  data even by asking for it.
- **Students** see a warning, then a quiet 20-second look into the distance — in
  their classroom's language.

### Languages

English and Russian ship today; adding another is an entry in
`web/src/i18n/languages.js` plus a dictionary file, with no component changes. Two
details make it correct rather than approximate:

- **Real plural rules.** Russian needs one/few/many/other, selected through
  `Intl.PluralRules` — so 1 рабочее место, 2 рабочих места and 5 рабочих мест are
  each right. English's two forms are the same mechanism.
- **Numbers and dates follow the language.** "1,625" and "89.6%" become "1 625" and
  "89,6%".

Teachers pick a language in the top bar; the choice is stored on the account, so it
follows them to another computer. A classroom PC has no account, so its language is
set per room in Setup — the screens a child reads are configured by the school, not
flippable by whoever sits down. `server/test/i18n.test.js` fails the build on a
missing key, an incomplete Russian plural, or a `t()`/`tn()` mix-up.

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The principles, and where they are enforced

| Principle | Enforced by |
| --- | --- |
| Never show a student identity | A `CHECK` constraint plus `assertSeatLabel()`; one API test asserts `400 pii_rejected` and the schema test asserts the device never emits a person-shaped field |
| School analytics are aggregate-only | Four independent controls: role gate, identifier-parameter refusal, a response-body guard, and k-anonymity suppression. The API test scans the real admin payload for seat labels |
| Attention Mode is not remote control | The capability set (`inputLock: false`, …) is in every payload, the overlay says it on screen, and those capabilities do not exist in the codebase |
| Interruptions are predictable | The warning rows are created before a break is due and the timing contract is covered by `server/test/scheduler.test.js` |

Read [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full statement, including what is
deliberately *not* collected.

## Commands

```bash
npm install               # root + both workspaces (3 runtime deps: express, ws, cors)
npm run build             # build the web app into web/dist
npm run test:contrast     # contrast audit for the student-facing screens
npm run fonts             # re-download the self-hosted typefaces (rarely needed)
npm start                 # serve API + built web app on :4000
npm run dev               # server (watch) + Vite dev server together
npm run dev:server        # just the API
npm run dev:web           # just the SPA on :5173 (proxies /api and /live)
npm test                  # 95 server tests, node:test, no network needed
npm run seed              # seed an empty database
npm run seed:demo -- --force   # reseed the demo school
```

## Design

The interface is built on one metaphor: **the horizon**. The product asks children to
look into the distance, so the visual language is made of distance — atmospheric
depth, a horizon line, and a single warm sun as the only warm colour in a deep-green
world. The full-screen break challenge is the clearest expression of it and is the
reference the rest of the product borrows from.

- **Type**: Bitter (slab serif) for headings, Manrope (grotesk) for interface text.
  Both self-hosted so a classroom PC renders correctly with no internet, and both
  chosen partly *because* they ship Cyrillic — most fashionable display serifs do not.
- **Surfaces**: flat by default. A box gets a hairline border, a tint, or a deep fill
  — never all three, and never a shadow unless it genuinely floats above the page.
- **Colour**: deep green is the brand, pulled from the break screen into every page.
  The one warm colour is a sunset persimmon and it only ever means "needs attention".
- **The break screen is a window**, not a timer: a sun sets across the break, the
  horizon's lit line is the progress indicator, and the sun breathes rather than ticks.
- **Seat status changes ripple** out of the status dot instead of snapping colour.

`npm run test:contrast` composites the real gradients and reports the contrast ratio
of every element on the student screens — it caught a rail that dropped to 1.0:1 as
the sun set.

## Project layout

```
myopiaguard/
├── server/            Node API, scheduler, realtime hub, SQLite
│   ├── src/
│   │   ├── routes/    auth · teacher · agent · reports · analytics · dev
│   │   ├── services/  scheduler · sessionState · breaks · dashboard · reports
│   │   │              analytics · attention · focus · agentState · demoAgents
│   │   └── lib/       validation (privacy gates) · http (aggregate guard) · time
│   └── test/          95 tests: domain, scheduler, privacy, end-to-end API, i18n
├── web/               React SPA — teacher dashboard, reports, analytics, device agent
│   └── src/
│       ├── pages/     TeacherDashboard · WeeklyReportPage · SchoolAnalyticsPage
│       │              FocusModePage · SetupPage · DevicePage · LoginPage
│       ├── components/ SeatBoard · Takeovers · SessionWarnings · AttentionModeDialog
│       │              FocusModePanel · SeatDetailDrawer · AppShell · LanguageSwitcher · ui
│       ├── i18n/       languages · en · ru · provider (t / tn via Intl.PluralRules)
│       └── styles/    fonts.css (generated) · base.css (tokens) · app.css
│                     auth.css (sign-in) · window.css (the break screen)
├── extensions/
│   └── myopiaguard-focus/   MV3 reference enforcement hook for Focus Mode
└── docs/              ARCHITECTURE · API · PRIVACY · DEPLOYMENT · FOCUS_MODE_DECISION
```

## Documentation

| Document | Read it for |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System shape, module map, data model, realtime protocol, failure behaviour, tests |
| [`docs/API.md`](docs/API.md) | Every endpoint with request/response shapes and status codes |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | The privacy commitment and the exact mechanism enforcing each part |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Install, configuration, first-week checklist, backups, retention, TLS, capacity |
| [`docs/FOCUS_MODE_DECISION.md`](docs/FOCUS_MODE_DECISION.md) | The Focus Mode enforcement decision point, alternatives considered, and the open IT decision |
| [`extensions/myopiaguard-focus/README.md`](extensions/myopiaguard-focus/README.md) | Enrolling a classroom PC with the Focus Mode extension |

## Notes on the build

- **No charting library.** The Mon–Fri and trend charts are ~60 lines of SVG each:
  they print correctly through a dedicated print stylesheet, need no runtime, and
  keep the dependency list at three packages.
- **SQLite via `node:sqlite`.** No native module to compile, so a school can deploy
  with nothing but Node installed. The schema is portable to Postgres if a district
  outgrows one process.
- **The classroom PC is the same web app** on the `/device` route — nothing to
  package per platform, nothing to keep patched on ninety machines.
- **`npm test` is honest about coverage.** The extension in `extensions/` is a
  reviewed reference implementation that the suite does not execute (extension
  service workers need a real browser profile); its README says so explicitly.

## Licence

MIT — see [`LICENSE`](LICENSE).
