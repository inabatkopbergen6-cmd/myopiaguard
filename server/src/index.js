import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import cors from 'cors';
import express from 'express';
import { teacherClassroomIds, userFromToken } from './auth.js';
import config from './config.js';
import { all, closeDatabase, get, getDb } from './db.js';
import { errorHandler, notFoundHandler } from './lib/http.js';
import { now } from './lib/time.js';
import { RealtimeHub } from './realtime.js';
import { buildAgentState } from './services/agentState.js';
import { DemoAgentPool } from './services/demoAgents.js';
import { BreakScheduler } from './services/scheduler.js';
import { getLiveSeatSession, touchHeartbeat } from './services/sessionState.js';
import agentRoutes from './routes/agent.js';
import analyticsRoutes from './routes/analytics.js';
import authRoutes from './routes/auth.js';
import devRoutes from './routes/dev.js';
import reportRoutes from './routes/reports.js';
import teacherRoutes from './routes/teacher.js';

/**
 * MyopiaGuard server.
 *
 * Two transports, one authority:
 *   - REST for reads, configuration and one-shot commands (a report, a broadcast).
 *   - WebSocket for anything that must be felt live: dashboard freshness, break
 *     countdown warnings, the break overlay, Attention Mode and Focus Mode policy.
 *
 * The schedule itself is decided only by services/scheduler.js on the server. A
 * classroom PC can be reloaded, closed, or lose the network — the cadence the
 * children experience does not change, because the server already knew the answer.
 */
export function createApp({ webDist = config.webDist } = {}) {
  const app = express();
  app.locals.demoMode = config.demoMode;
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/api/health' && res.statusCode === 200) return;
      if (process.env.MG_QUIET === '1') return;
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - started}ms)`);
    });
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      demoMode: config.demoMode,
      schedulerEnabled: config.schedulerEnabled,
      timings: config.timings,
      counts: {
        schools: Number(get('SELECT COUNT(*) AS count FROM schools').count),
        classrooms: Number(get('SELECT COUNT(*) AS count FROM classrooms').count),
        seats: Number(get('SELECT COUNT(*) AS count FROM seats').count),
        liveLessons: Number(get(`SELECT COUNT(*) AS count FROM lesson_sessions WHERE status = 'live'`).count),
      },
      serverTime: now(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/teacher', teacherRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/analytics', analyticsRoutes);
  if (config.demoMode || process.env.MG_ALLOW_DEMO_TOOLS === '1') {
    app.use('/api/demo', devRoutes);
  }

  // Built web app, when it exists. In development the SPA is served by Vite and
  // only the API lives here.
  if (webDist && fs.existsSync(webDist)) {
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/live')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.type('text/plain').send(
        [
          'MyopiaGuard API is running.',
          '',
          'The web app is not built yet. Either run the dev server:',
          '  npm run dev:web        (http://localhost:5173)',
          'or build it:',
          '  npm run build          (then reload this page)',
        ].join('\n'),
      );
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Resolves a WebSocket principal from `?token=` (person) or `?agent=` (classroom PC). */
function principalFor(url) {
  const token = url.searchParams.get('token');
  const agentToken = url.searchParams.get('agent');

  if (agentToken) {
    const seat = get(
      `SELECT s.*, c.school_id, c.grade_id FROM seats s JOIN classrooms c ON c.id = s.classroom_id
        WHERE s.agent_token = ?`,
      [agentToken],
    );
    if (!seat) return { error: 'unknown_agent_token' };
    return {
      kind: 'agent',
      seatId: seat.id,
      seatLabel: seat.label,
      classroomId: seat.classroom_id,
      schoolId: seat.school_id,
    };
  }

  if (token) {
    const row = userFromToken(token);
    if (!row) return { error: 'unauthorized' };
    return {
      kind: row.role === 'admin' ? 'admin' : 'teacher',
      role: row.role,
      userId: row.id,
      schoolId: row.school_id,
      displayName: row.display_name,
    };
  }

  return { error: 'no_credentials' };
}

export function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer(app);
  const hub = new RealtimeHub({ server });
  app.locals.hub = hub;

  hub.onConnection = (conn, req) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const principal = principalFor(url);
    if (principal.error) {
      hub.send(conn, 'error', { error: principal.error });
      conn.socket.close(4001, principal.error);
      return;
    }
    conn.meta = principal;

    if (principal.kind === 'agent') {
      hub.join(conn, `seat:${principal.seatId}`);
      hub.join(conn, `classroom:${principal.classroomId}`);
      // Converge a reloaded or reconnecting device on the true current state:
      // if a break is already on screen, the agent rejoins it rather than restarting it.
      hub.send(conn, 'agent:state', buildAgentState({ seatId: principal.seatId, demoMode: config.demoMode }));
      hub.toClassroom(principal.classroomId, 'classroom:changed', { classroomId: principal.classroomId }, { kind: 'teacher' });
      return;
    }

    if (principal.kind === 'admin') {
      hub.join(conn, `school:${principal.schoolId}`);
    } else {
      for (const classroomId of teacherClassroomIds(principal.userId)) {
        hub.join(conn, `classroom:${classroomId}`);
      }
    }
    hub.join(conn, `user:${principal.userId}`);
    hub.send(conn, 'hello', { kind: principal.kind, serverTime: now(), demoMode: config.demoMode });
  };

  hub.onMessage = (conn, message) => {
    const { type, payload } = message;

    if (type === 'ping') {
      hub.send(conn, 'pong', { at: now() });
      return;
    }

    if (type === 'agent:heartbeat' && conn.meta.kind === 'agent') {
      const live = getLiveSeatSession(conn.meta.seatId);
      if (live) touchHeartbeat(live.id, now());
      const seatState = buildAgentState({ seatId: conn.meta.seatId, demoMode: config.demoMode });
      hub.send(conn, 'agent:state', seatState);
      if (seatState?.pendingBreak?.secondsToDue === 0 || seatState?.activeBreak) {
        hub.toClassroom(conn.meta.classroomId, 'classroom:changed', { classroomId: conn.meta.classroomId }, { kind: 'teacher' });
      }
      return;
    }

    if (type === 'teacher:subscribe' && ['teacher', 'admin'].includes(conn.meta.kind)) {
      const classroomId = payload?.classroomId;
      if (!classroomId) {
        hub.send(conn, 'error', { error: 'missing_classroom_id' });
        return;
      }
      const allowed =
        conn.meta.kind === 'admin' || teacherClassroomIds(conn.meta.userId).includes(classroomId);
      if (!allowed) {
        hub.send(conn, 'error', { error: 'forbidden_classroom' });
        return;
      }
      hub.join(conn, `classroom:${classroomId}`);
      hub.send(conn, 'subscribed', { classroomId, serverTime: now() });
      return;
    }

    if (type === 'agent:focus-report' && conn.meta.kind === 'agent') {
      const state = buildAgentState({ seatId: conn.meta.seatId, demoMode: config.demoMode });
      hub.send(conn, 'agent:state', state);
      return;
    }

    hub.send(conn, 'error', { error: 'unsupported_type', type });
  };

  const scheduler = new BreakScheduler({ hub });
  app.locals.scheduler = scheduler;

  // Demo only: stands in for classroom PCs that are not actually running, so the
  // dashboard in a seeded school is not a wall of grey. A real agent always takes
  // precedence for its own seat (see services/demoAgents.js).
  const demoAgents = new DemoAgentPool({ hub });
  app.locals.demoAgents = demoAgents;

  return { app, server, hub, scheduler, demoAgents };
}

export function start({ port = config.port } = {}) {
  getDb(); // opens/creates the database and applies the schema
  const { app, server, hub, scheduler, demoAgents } = createServer();
  server.listen(port, () => {
    const summary = all(
      `SELECT (SELECT COUNT(*) FROM schools) AS schools, (SELECT COUNT(*) FROM classrooms) AS classrooms,
              (SELECT COUNT(*) FROM seats) AS seats`,
      [],
    )[0];
    console.log('');
    console.log('  MyopiaGuard server');
    console.log(`  API      http://localhost:${port}/api/health`);
    console.log(`  Realtime ws://localhost:${port}/live`);
    console.log(`  Web app  ${fs.existsSync(config.webDist) ? `http://localhost:${port}/` : 'not built — run npm run dev:web (5173)'}`);
    console.log(`  Data     ${config.dbPath}`);
    console.log(`  Demo     ${config.demoMode ? 'ON (accelerated break cadence + demo tools)' : 'off'}`);
    console.log(
      `  Seed     ${summary.schools} school(s), ${summary.classrooms} classroom(s), ${summary.seats} seat(s)`,
    );
    if (config.demoMode && Number(get(`SELECT COUNT(*) AS count FROM lesson_sessions WHERE status = 'live'`).count) > 0) {
      console.log('  Demo PCs a simulated classroom-PC pool keeps the live room online (real agents take over per seat)');
    }
    if (summary.schools === 0) {
      console.log('  Hint     no data yet — run: npm run seed:demo');
    }
    console.log('');
  });

  scheduler.start();
  demoAgents.start();

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down`);
    scheduler.stop();
    demoAgents.stop();
    hub.close();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { app, server, hub, scheduler };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  start();
}

export default { createApp, createServer, start };
