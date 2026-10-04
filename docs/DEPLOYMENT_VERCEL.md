# Deploying on Vercel (services mode)

`vercel.json` at the repository root declares two services — `web` (the Vite SPA)
and `server` (the Express API) — behind one ordered public routing table.

```
/api/(.*)  →  server     REST API
/live      →  server     WebSocket hub (teacher board, break overlays)
/(.*)      →  web        everything else; deep links resolve via the SPA rewrite
```

Verified behaviour this config depends on:

- **Vercel preserves the original request path** when a service-targeted rewrite
  selects a service. `GET /api/teacher/classrooms` reaches `server` as
  `/api/teacher/classrooms`, which is exactly the prefix `server/src/index.js`
  mounts. **No path stripping is needed or wanted** — `server/src/routes/teacher.js`
  and friends are already written against `/api/…`.
- **Routing into a service is final.** If the selected service 404s, Vercel does
  not fall through to the next rewrite. This is why `/api/(.*)` and `/live` must be
  listed before the `/(.*)` catch-all.
- **A service-scoped catch-all is required for the Vite SPA.** Without the
  `services.web.rewrites` entry, a browser refresh on `/teacher`, `/school` or
  `/device` asks the web service for a file that does not exist and gets a 404.
  Top-level routing selects the service; the service-scoped rewrite is what serves
  `index.html` for client-side routes.
- **Vercel Functions support WebSockets natively** (public beta on all plans,
  Fluid Compute). `/live` is not blocked by the platform.

## No service bindings are declared, on purpose

The task template asked for a binding from `web` to `server`. **This repository
does not need one, and adding it would be cargo-culting a variable that nothing
reads.** A binding injects a target's internal URL into the *calling service's*
runtime so one service can make server-to-server requests. Here:

- Every API call originates in the **browser**, not in the web service. The client
  in `web/src/api/client.js` uses relative same-origin paths (`fetch('/api/auth/login')`)
  and the document itself says so: *"Same-origin everywhere… there is no base URL
  to configure."*
- The WebSocket URL is derived from the browser's own location
  (`web/src/api/hooks.js`): `` `${protocol}//${window.location.host}/live` ``.
- `web` is a static Vite build. It runs no server code, so it cannot consume a
  binding at all.

So `web` never calls `server` server-to-server, there is no hardcoded hostname or
port to replace, and **no application code needed changing for the routing to be
correct.** If a binding were declared anyway, the injected variable would simply go
unread. Bindings would become necessary only if the SPA gained a server runtime
(for example SSR) that had to reach the API.

## Blockers: this service will not run correctly on Vercel as written

This is the important part, and it is not a configuration problem that
`vercel.json` can fix. The API is a **stateful, single-process, long-lived** Node
service. Vercel runs stateless functions on ephemeral instances. The three
conflicts, each grounded in the current code:

### 1. The scheduler cannot run (breaks the core product promise)

`server/src/services/scheduler.js` is a 1 Hz in-process timer:
`setInterval(() => this.tick(), this.tickMs)` with `tickMs = 1000`
(`server/src/config.js`). It is the *sole authority* for when a break happens — the
documented product promise is "the server decides when a break happens".

A Vercel Function instance is created on demand, may be reused, and is frozen when
idle. An interval started during one invocation does not keep running between
requests. **The schedule stops.** No warnings, no triggers, no misses — the
dashboard would silently show a classroom frozen at whatever state the last
request left behind.

### 2. SQLite on an ephemeral filesystem

`server/src/config.js` defaults `dbPath` to `<repo>/data/myopiaguard.db`, and
`server/src/db.js` opens it with `node:sqlite` and WAL mode. On Vercel the
filesystem is read-only except `/tmp`, which is per-instance and discarded. Every
write (heartbeats, break events, seats, tokens) lives on a filesystem that does not
persist and is not shared between concurrent instances. **Seeded data disappears
and the application cannot function.**

### 3. In-memory realtime fan-out does not span instances

`server/src/realtime.js` keeps `this.connections = new Set()` in process memory and
fans out by iterating it. With one instance this is correct; with several, a teacher
connected to instance A never receives events published from instance B. Two
teachers looking at the same room could see different boards.

### What a real deployment needs

| Concern | Required change |
| --- | --- |
| Scheduler | Move the tick out of the request lifecycle: a Vercel **Cron Job** hitting an internal endpoint, or a dedicated always-on process. Note the current work is O(live seats) per tick with several indexed reads each — fine at 1 Hz in-process, an awkward fit for a function invocation. |
| Database | A networked database (Vercel Postgres / Neon, Turso, Supabase). `db.js` is deliberately portable in shape — TEXT ids, epoch-ms INTEGER timestamps — but `node:sqlite` calls must be replaced with a Postgres/Turso client, and `tx()` reworked (it currently relies on a single connection). |
| Realtime | A broker that spans instances (Vercel's own realtime guidance, Ably, Pusher, or a Redis pub/sub). The hub's interface (`toSeat`, `toClassroom`, `toSchool`) is small enough that only `realtime.js` needs replacing. |
| Demo mode | **Never set `MG_DEMO=1` in production.** It exposes `/api/demo/*`, including `/api/demo/reset` (wipes and reseeds the database) and `/api/auth/demo-accounts`, which returns the shared demo password. |

Until those are addressed, this repository is best deployed as a **long-lived
container** (Fly.io, Railway, Render, a school VM, or Vercel container services with
a persistent volume and a single always-on instance) — which is what the
architecture was designed for. See `docs/DEPLOYMENT.md`.

## Environment variables to set in the Vercel project

| Variable | Value | Notes |
| --- | --- | --- |
| `MG_DB` | path or connection string | **Required.** Defaults to a file inside the repo, which is ephemeral on Vercel. |
| `MG_PUBLIC_URL` | `https://<your-domain>` | Used to build classroom-PC enrolment links (`server/src/routes/teacher.js`). Without it the link is derived from the request host. |
| `MG_TOKEN_TTL_HOURS` | e.g. `12` | Login token lifetime. |
| `MG_MIN_COHORT` | e.g. `5` | k-anonymity floor for school analytics. |
| `MG_SCHEDULER` | `1` | Leave enabled in a long-lived deployment; see blocker 1. |
| `PORT` | — | Do **not** set on Vercel; the platform assigns it. |
| `MG_DEMO` | — | Leave unset. Demo mode is for local walkthroughs only. |

## Local verification

```bash
vercel dev          # builds and runs both services with binding vars injected
```

`vercel dev` is the supported way to exercise the routing table locally. I could
not run it here: the `dsh-vercel-mcp` plugin is installed but **not OAuth-connected**
(`vercel_mcp_status` reports "未授权"), so the project could not be linked and no
`vercel` CLI session exists in this environment. The JSON above is schema-valid and
its routing semantics were checked against Vercel's services documentation, but it
has **not** been through a real Vercel build.
