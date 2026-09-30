import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverRoot, '..');

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Installed defaults for a classroom's break cadence. These are the numbers an
 * admin sees in config; every classroom row stores its own copy so a school can
 * tune cadence per room without a redeploy.
 */
export const CLASSROOM_DEFAULTS = Object.freeze({
  breakIntervalMin: 20,
  breakDurationSec: 20,
  warnLead5Min: true,
  warnLead1Min: true,
  longSessionMin: 45,
  missedBreakGraceSec: 120,
  offlineAfterSec: 15,
});

/**
 * Demo speeds the whole model up so a walkthrough does not take 20 minutes.
 * Real cadence is unchanged; only the seed + defaults for the demo classroom move.
 */
export const DEMO_TIMINGS = Object.freeze({
  breakIntervalMin: 2,
  breakDurationSec: 20,
  longSessionMin: 5,
  missedBreakGraceSec: 45,
  offlineAfterSec: 15,
});

const demoMode = bool(process.env.MG_DEMO, false);

export const config = {
  serverRoot,
  repoRoot,
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),
  dbPath: process.env.MG_DB ?? path.join(repoRoot, 'data', 'myopiaguard.db'),
  webDist: path.join(repoRoot, 'web', 'dist'),
  demoMode,
  timings: demoMode ? { ...CLASSROOM_DEFAULTS, ...DEMO_TIMINGS } : { ...CLASSROOM_DEFAULTS },
  // How often the authoritative scheduler re-evaluates every live seat.
  tickMs: int(process.env.MG_TICK_MS, 1000),
  schedulerEnabled: bool(process.env.MG_SCHEDULER, true),
  tokenTtlMs: int(process.env.MG_TOKEN_TTL_HOURS, 12) * 3_600_000,
  // k-anonymity floor for school analytics: rollup cells built from fewer than
  // this many contributing seats are suppressed instead of reported.
  minCohortSeats: int(process.env.MG_MIN_COHORT, 5),
  // Realtime fan-out cadence for dashboard snapshots (ms).
  snapshotThrottleMs: int(process.env.MG_SNAPSHOT_THROTTLE_MS, 2000),
};

export default config;
