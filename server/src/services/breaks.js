/**
 * Break domain logic: the instruction pool shown by the full-screen challenge,
 * the arithmetic that decides *when* a break is due, and the outcome
 * classification that every adherence number in the product is derived from.
 *
 * This module is intentionally pure — no database, no sockets — so the timing
 * rules can be unit-tested by advancing a fake clock.
 */

/** Rotating pool for the 20-second distance break (deliverable 2). */
export const BREAK_INSTRUCTIONS = Object.freeze([
  { key: 'farthest-object', text: 'Look at the farthest object you can see.' },
  { key: 'window-distance', text: 'Look out the window and focus on something in the distance.' },
  { key: 'far-wall', text: 'Look at the far wall of the room.' },
  { key: 'farthest-point', text: 'Find the farthest point in the room and hold your gaze there.' },
  { key: 'opposite-corner', text: 'Find the opposite corner of the room and let your eyes rest there.' },
  { key: 'ceiling-distance', text: 'Look up and focus on the furthest point above you.' },
]);

export function instructionFor(key) {
  return BREAK_INSTRUCTIONS.find((entry) => entry.key === key) ?? BREAK_INSTRUCTIONS[0];
}

/**
 * Picks the next instruction, avoiding an immediate repeat so a student who
 * takes six breaks in a morning does not see the same line twice in a row.
 */
export function pickInstruction(random = Math.random, avoidKey = null) {
  const pool = BREAK_INSTRUCTIONS.filter((entry) => entry.key !== avoidKey);
  const candidates = pool.length > 0 ? pool : BREAK_INSTRUCTIONS;
  return candidates[Math.floor(random() * candidates.length) % candidates.length];
}

/** Statuses that represent a break the student has already been shown. */
export const RESOLVED_STATUSES = Object.freeze(['completed', 'skipped', 'missed']);
export const OPEN_STATUSES = Object.freeze(['pending', 'in_progress']);

/** Any break that is not `completed` counts against adherence. */
export function countsAgainstAdherence(status) {
  return status === 'skipped' || status === 'missed';
}

/**
 * Seconds of continuous screen time in the current stretch. While a break is on
 * screen the stretch is paused, which is what makes "long uninterrupted session"
 * an honest measure of visual load.
 */
export function activeStretchSeconds(seatSession, atMs) {
  const anchor = seatSession.resumed_at ?? seatSession.started_at;
  if (seatSession.state === 'on_break' || seatSession.state === 'ended' || !anchor) return 0;
  return Math.max(0, Math.round((atMs - Number(anchor)) / 1000));
}

/** Total active seconds in the session, including the stretch in progress. */
export function totalActiveSeconds(seatSession, atMs) {
  return Number(seatSession.active_seconds ?? 0) + activeStretchSeconds(seatSession, atMs);
}

export function isLongStretch(stretchSec, longSessionMin) {
  return stretchSec >= longSessionMin * 60;
}

/**
 * When the next break is due.
 *
 * The break clock restarts from the moment the *last* break resolved, so a
 * classroom that takes its breaks on time stays on a predictable rhythm. For a
 * seat that has been offline the computed time may already be in the past; in
 * that case we re-anchor to `minLeadMs` from now rather than firing instantly,
 * so a returning student is never ambushed by an overlay the moment they sit
 * down.
 */
export function computeNextBreakDue({ baseAt, intervalMin, atMs, minLeadMs = 30_000 }) {
  const computed = Number(baseAt) + intervalMin * 60_000;
  if (computed >= atMs) return { dueAt: computed, lateAdjusted: false };
  return { dueAt: atMs + minLeadMs, lateAdjusted: true };
}

/**
 * Rolls a seat's break history into the counters the UI shows.
 *
 * Adherence = completed / (completed + skipped + missed) over the same window.
 * Breaks still `pending` are excluded from both sides — a break that has not come
 * due yet is neither a success nor a failure.
 *
 * `consecutiveMisses` is the trailing run of resolved breaks that were not
 * completed; two or more is what puts a seat in the Attention Needed panel.
 */
export function summarizeOutcomes(rows) {
  let completed = 0;
  let skipped = 0;
  let missed = 0;
  let pending = 0;

  for (const row of rows) {
    const status = typeof row === 'string' ? row : row.status;
    if (status === 'completed') completed += 1;
    else if (status === 'skipped') skipped += 1;
    else if (status === 'missed') missed += 1;
    else if (OPEN_STATUSES.includes(status)) pending += 1;
  }

  const resolved = completed + skipped + missed;
  const resolvedRows = [...rows]
    .filter((row) => RESOLVED_STATUSES.includes(typeof row === 'string' ? row : row.status))
    .sort((a, b) => (typeof a === 'string' ? 0 : Number(a.due_at) - Number(b.due_at)));

  // Walk the resolved breaks newest-first and stop at the first completion. Every
  // non-completed break in that trailing run counts towards the streak, whatever
  // its flavour: the attention rule is "two breaks in a row not taken", and a
  // skipped-then-missed pair is exactly that. `consecutiveMisses` and
  // `consecutiveSkipped` additionally report the run of one specific flavour at
  // the very end, which is what tells a teacher whether a seat is refusing breaks
  // or sleeping through them.
  const trailing = [];
  for (let i = resolvedRows.length - 1; i >= 0; i -= 1) {
    const status = typeof resolvedRows[i] === 'string' ? resolvedRows[i] : resolvedRows[i].status;
    if (status === 'completed') break;
    trailing.push(status);
  }
  const leadingOf = (flavour) => {
    let count = 0;
    for (const status of trailing) {
      if (status !== flavour) break;
      count += 1;
    }
    return count;
  };

  return {
    completed,
    skipped,
    missed,
    pending,
    resolved,
    /** Consecutive non-completed breaks, whatever their flavour. */
    consecutiveNonCompleted: trailing.length,
    consecutiveMisses: leadingOf('missed'),
    consecutiveSkipped: leadingOf('skipped'),
    adherencePct: resolved === 0 ? null : Math.round((completed / resolved) * 1000) / 10,
  };
}

/** Aggregate adherence across many seats, weighted by resolved breaks. */
export function aggregateAdherence(summaries) {
  const totals = summaries.reduce(
    (acc, summary) => {
      acc.completed += summary.completed;
      acc.skipped += summary.skipped;
      acc.missed += summary.missed;
      acc.resolved += summary.resolved;
      acc.pending += summary.pending;
      return acc;
    },
    { completed: 0, skipped: 0, missed: 0, resolved: 0, pending: 0 },
  );
  const seatValues = summaries.map((summary) => summary.adherencePct).filter((value) => value !== null);
  return {
    ...totals,
    adherencePct: totals.resolved === 0 ? null : Math.round((totals.completed / totals.resolved) * 1000) / 10,
    /** Mean of each seat's own %, i.e. "how does a typical seat behave". */
    meanSeatAdherencePct:
      seatValues.length === 0 ? null : Math.round((seatValues.reduce((a, b) => a + b, 0) / seatValues.length) * 10) / 10,
  };
}
