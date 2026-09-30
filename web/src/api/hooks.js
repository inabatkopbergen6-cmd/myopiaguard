import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live connection to the server's realtime hub.
 *
 * Deliberately thin: it owns the socket, reconnection and keepalive, and hands
 * every envelope to `onEvent`. It holds no application state, so a reconnect
 * cannot leave a stale snapshot on screen — the caller re-fetches on reconnect,
 * which is the same path it already uses for the first load.
 *
 * Polling is a fallback, not a second source of truth: if the socket cannot be
 * established the UI still refreshes every `pollMs`, but it shows that it is
 * degraded rather than pretending to be live.
 */

const PING_MS = 25_000;

export function useLiveSocket({ token, agentToken, onEvent, enabled = true, pollMs = 10_000, onPoll } = {}) {
  const [connected, setConnected] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const socketRef = useRef(null);
  const handlerRef = useRef(onEvent);
  const pollRef = useRef(onPoll);
  const closedByUs = useRef(false);
  const attemptRef = useRef(0);
  const pingRef = useRef(null);

  handlerRef.current = onEvent;
  pollRef.current = onPoll;

  const send = useCallback((type, payload) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type, payload }));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!enabled || (!token && !agentToken)) return undefined;
    closedByUs.current = false;
    let reconnectTimer;
    let pingTimer;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = agentToken ? `agent=${encodeURIComponent(agentToken)}` : `token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(`${protocol}//${window.location.host}/live?${query}`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
        setDegraded(false);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
        }, PING_MS);
      };

      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        handlerRef.current?.(message);
      };

      socket.onclose = (event) => {
        clearInterval(pingTimer);
        setConnected(false);
        if (closedByUs.current) return;
        if (event.code === 4001) {
          // Credentials rejected: reconnecting would loop forever.
          setDegraded(true);
          return;
        }
        setDegraded(true);
        const delay = Math.min(15_000, 800 * 2 ** attemptRef.current);
        attemptRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        /* onclose handles the retry; nothing to log that would help a teacher */
      };
    };

    connect();

    const pollTimer = setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) pollRef.current?.();
    }, pollMs);

    return () => {
      closedByUs.current = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      clearInterval(pollTimer);
      socketRef.current?.close(1000, 'component unmounted');
      socketRef.current = null;
      setConnected(false);
    };
  }, [token, agentToken, enabled, pollMs]);

  return { connected, degraded, send };
}

/**
 * A one-socket design needs a way for many components to listen. `App` owns the
 * socket and publishes every envelope here; pages subscribe with `useLiveEvent`.
 * Subscribers are kept in a module-level set because the socket outlives (and
 * should outlive) any individual page.
 */
const listeners = new Set();

export function publishLive(message) {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {
      /* one broken subscriber must not stop the others */
    }
  }
}

export function useLiveEvent(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (message) => ref.current?.(message);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
}

/**
 * Small data-fetching hook: `loading` on first load, `refreshing` afterwards, and
 * `error` surfaced as a message rather than thrown. Used for every REST read in
 * the app so loading and error states look the same everywhere.
 */
export function useResource(loader, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled, refreshing: false, loadedAt: 0 });
  const loaderRef = useRef(loader);
  const mounted = useRef(true);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async ({ quiet = false } = {}) => {
      if (!enabled) return null;
      setState((prev) => ({ ...prev, loading: !quiet && !prev.data, refreshing: quiet }));
      try {
        const data = await loaderRef.current();
        if (!mounted.current) return null;
        setState({ data, error: null, loading: false, refreshing: false, loadedAt: Date.now() });
        return data;
      } catch (error) {
        if (!mounted.current) return null;
        setState((prev) => ({ ...prev, error, loading: false, refreshing: false }));
        return null;
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { ...state, reload: run, setData: (data) => setState((prev) => ({ ...prev, data })) };
}
