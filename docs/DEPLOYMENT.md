# Deployment and operations

## Requirements

- **Node.js 22.5 or newer** (the database uses the built-in `node:sqlite`, so
  there is no native module to compile). Node 24 LTS is what this build is
  developed and tested against.
- About 100 MB of disk, growing by roughly 1 MB per classroom per school year of
  break events.
- No database server, no message queue, no container runtime required.

## Install

```bash
npm install                 # root, server and web workspaces
npm run build               # builds web/dist; the server then serves the SPA too
npm run seed:demo -- --force   # a full demo school: 8 rooms, 92 workstations, 4 weeks of history
npm start                   # http://localhost:4000
```

For a real school, seed nothing and create the school structure deliberately:

```bash
npm start                   # starts with an empty database
# then sign in as the admin created by your own provisioning step
```

## Configuration

All configuration is environment variables; there is no config file to drift.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP + WebSocket port |
| `MG_DB` | `<repo>/data/myopiaguard.db` | SQLite file path |
| `MG_DEMO` | `off` | Accelerated cadence, demo tools under `/api/demo`, the PC simulator, and a public demo-account list |
| `MG_TICK_MS` | `1000` | Scheduler tick. Lower only for testing |
| `MG_SCHEDULER` | `on` | Set `0` to disable the scheduler entirely (tests do this) |
| `MG_TOKEN_TTL_HOURS` | `12` | Session token lifetime |
| `MG_MIN_COHORT` | `5` | k-anonymity floor for analytics rollups |
| `MG_PUBLIC_URL` | request origin | Base URL used to build seat enrolment links |
| `MG_QUIET` | `off` | Suppress request logging |
| `MG_ALLOW_DEMO_TOOLS` | `off` | Expose `/api/demo` without full demo mode (do not use in production) |

Supported interface languages are `en` and `ru`, chosen per teacher account and per
classroom. Adding one is a code change (an entry in `web/src/i18n/languages.js` plus a
dictionary), not configuration.

### Demo mode is not production mode

`MG_DEMO=1` does four things you must not ship:

1. Accelerates the walkthrough room's cadence to a 2-minute interval.
2. Mounts `/api/demo/*` — routes that move break rows, take seats offline and
   **wipe the database** (`POST /api/demo/reset`).
3. Starts the classroom-PC simulator, which heartbeats seats that have no real
   agent.
4. Makes `/api/auth/demo-accounts` list usernames publicly.

With `MG_DEMO` unset, none of those exist.

## First-week checklist for a school

1. **Set the cadence per room.** Default is a break every 20 minutes of screen
   time, 20-second distance break, warnings at five and one minute. Rooms differ,
   so tune them under *Setup*.
2. **Create the workstations** in each room and print or copy the enrolment links.
   Labels are machine-only (`PC-01`) — the validator will reject a student name.
3. **Enrol each classroom PC**: open its link, put the tab in kiosk mode via the
   school's existing device management (Chrome kiosk app, Managed Guest Session,
   MDM profile). The token is pinned at provisioning time, not by whoever sits down.
4. **Decide the Focus Mode enforcement path** — see `docs/FOCUS_MODE_DECISION.md`.
   One open item needs an IT decision, not code.
5. **Set each room's language** under *Setup → Break cadence*. This is what the
   classroom PCs in that room display, including the full-screen break challenge.
   Teachers can also set their own interface language in the top bar; that choice is
   stored on their account and follows them between computers.
6. **Tell staff what Attention Mode is**: a message on every screen, no control of
   the device. The first use in a room should be a deliberate, explained one.
7. **Check the weekly report on the first Monday** and adjust the cadence for any
   room whose long-session count is high.

## Accounts and credentials

- Seeded demo accounts share one password (`myopiaguard`) and **must not survive
  the first day of a real deployment** — remove them or set real passwords.
- Passwords are stored as scrypt hashes with per-user salts
  (`server/src/auth.js`); nothing reversible is written to the database.
- Teacher sessions are bearer tokens with a 12-hour TTL, revoked on sign-out.
- A seat holds one agent token. Treat it as a machine credential: revoke by
  deleting and re-creating the seat.

## Static assets

The web build ships two self-hosted typefaces (`web/public/fonts/`, ~165 KB of woff2
covering Latin and Cyrillic). They are committed, so a normal `npm run build` needs no
network. `npm run fonts` re-downloads them from Google Fonts if you ever need to
update them.

Serving them from the same origin as the app is deliberate: a CDN-hosted font would
fail silently to a system fallback exactly when a school's network is down, which is
also when a lesson most needs the break timer to look like itself.

## Upgrades

Schema changes are applied automatically: `openDatabase()` runs an idempotent
`applyMigrations()` that adds any column introduced since a database was created
(currently `users.preferences` and `classrooms.language`). Existing rows are
untouched and pick up the column default, so an upgrade in place is safe — but take
the backup below first anyway, as with any schema change.

## Backups

Everything that matters is in one SQLite file (`data/myopiaguard.db`, plus its
`-wal` sidecar). Back up by copying the pair, or:

```bash
sqlite3 data/myopiaguard.db ".backup 'backup-$(date +%F).db'"
```

The seeded school can be regenerated at any time with `npm run seed:demo -- --force`;
a real school's data cannot, so schedule the copy.

## Data retention

Break and session events are the school's records; retention is the school's
policy, not the software's. To prune anything older than a point in time:

```sql
DELETE FROM break_events     WHERE due_at     < <epoch_ms>;
DELETE FROM seat_sessions    WHERE started_at < <epoch_ms>;
DELETE FROM lesson_sessions  WHERE started_at < <epoch_ms>;
DELETE FROM attention_broadcasts WHERE created_at < <epoch_ms>;
DELETE FROM audit_log        WHERE at         < <epoch_ms>;
```

Nothing in the product needs history older than the current academic year: the
longest window is the 90-day analytics selector. Run `VACUUM` afterwards to
reclaim the space.

## Reverse proxy and TLS

Put the server behind the school's existing TLS termination (nginx, Caddy,
IIS ARR). Two details:

- The WebSocket upgrade must be proxied: `proxy_set_header Upgrade $http_upgrade;`
  and `proxy_http_version 1.1;` for `/live`.
- Set `MG_PUBLIC_URL=https://myopiaguard.school.example` so generated enrolment
  links point at the public hostname rather than the internal one.

## Monitoring

`GET /api/health` returns the demo flag, scheduler state, cadence and row counts —
enough for an uptime check. Two log lines are worth alerting on:

- `[privacy] aggregate-only guard blocked a response:` — the analytics layer
  caught an attempt to emit seat-level data. This should never appear; treat it as
  a bug report.
- `[scheduler] tick failed` — the break engine could not complete a pass.

## Capacity

One process handles a school comfortably: the scheduler reads a few hundred
indexed rows per second at 100 workstations, and the WebSocket hub fans out to
tens of connections per room. Beyond roughly 5,000 concurrently live seats, split
per-school (one database each) before considering a rewrite — the API is
stateless per school, and teachers authenticate per school, so that split is
configuration rather than surgery.
