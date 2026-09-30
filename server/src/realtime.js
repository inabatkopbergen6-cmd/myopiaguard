import { WebSocketServer } from 'ws';
import { now } from './lib/time.js';

/**
 * Realtime fan-out.
 *
 * Rooms are the only addressing model:
 *   classroom:<id> — every teacher dashboard and every device agent in a room
 *   seat:<id>      — a single classroom computer
 *   school:<id>    — the aggregate analytics surface
 *
 * The hub is deliberately dumb: it moves envelopes, it does not decide policy.
 * All schedule decisions live in services/scheduler.js so that a dropped socket
 * can never change how often a child is asked to rest their eyes.
 */

const HEARTBEAT_MS = 30_000;

export class RealtimeHub {
  constructor({ server, path = '/live', logger = console } = {}) {
    this.logger = logger;
    this.connections = new Set();
    this.seq = 0;
    this.wss = new WebSocketServer({ server, path, maxPayload: 64 * 1024 });

    this.wss.on('connection', (socket, req) => {
      const conn = {
        id: `conn_${++this.seq}`,
        socket,
        rooms: new Set(),
        meta: { kind: 'unknown' },
        alive: true,
        connectedAt: now(),
      };
      this.connections.add(conn);

      socket.on('pong', () => {
        conn.alive = true;
      });
      socket.on('message', (raw) => this._handleMessage(conn, raw));
      socket.on('close', () => this.connections.delete(conn));
      socket.on('error', () => this.connections.delete(conn));

      this.onConnection?.(conn, req);
    });

    this.heartbeat = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.alive) {
          conn.socket.terminate();
          this.connections.delete(conn);
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          /* socket already gone */
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  _handleMessage(conn, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return this.send(conn, 'error', { error: 'malformed_json' });
    }
    if (!message || typeof message.type !== 'string') {
      return this.send(conn, 'error', { error: 'missing_type' });
    }
    try {
      return this.onMessage?.(conn, message);
    } catch (error) {
      this.logger.error?.('[realtime] handler failed', error);
      return this.send(conn, 'error', { error: 'handler_failed', type: message.type });
    }
  }

  join(conn, room) {
    conn.rooms.add(room);
    return conn;
  }

  leave(conn, room) {
    conn.rooms.delete(room);
  }

  send(conn, type, payload = {}) {
    if (conn.socket.readyState !== 1) return false; // OPEN
    try {
      conn.socket.send(JSON.stringify({ type, payload, at: now() }));
      return true;
    } catch {
      return false;
    }
  }

  /** Broadcast to every connection in a room. Returns how many sockets accepted it. */
  broadcast(room, type, payload = {}, { kind = null } = {}) {
    let delivered = 0;
    for (const conn of this.connections) {
      if (kind && conn.meta.kind !== kind) continue;
      if (!conn.rooms.has(room)) continue;
      if (this.send(conn, type, payload)) delivered += 1;
    }
    return delivered;
  }

  toClassroom(classroomId, type, payload, options) {
    return this.broadcast(`classroom:${classroomId}`, type, payload, options);
  }

  toSchool(schoolId, type, payload, options) {
    return this.broadcast(`school:${schoolId}`, type, payload, options);
  }

  toSeat(seatId, type, payload, options) {
    return this.broadcast(`seat:${seatId}`, type, payload, options);
  }

  connectionsIn(room, kind = null) {
    return [...this.connections].filter(
      (conn) => conn.rooms.has(room) && (!kind || conn.meta.kind === kind),
    );
  }

  close() {
    clearInterval(this.heartbeat);
    for (const conn of this.connections) {
      try {
        conn.socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.wss.close();
  }
}

export default RealtimeHub;
