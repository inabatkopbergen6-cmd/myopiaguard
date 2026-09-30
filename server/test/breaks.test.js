import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeStretchSeconds,
  aggregateAdherence,
  computeNextBreakDue,
  isLongStretch,
  pickInstruction,
  summarizeOutcomes,
  BREAK_INSTRUCTIONS,
} from '../src/services/breaks.js';
import { warningOffsets } from '../src/services/scheduler.js';
import { formatDuration, weekRange, localDayKey, startOfLocalWeek, DAY } from '../src/lib/time.js';

test('summarizeOutcomes counts each outcome and excludes breaks that are not due yet', () => {
  const summary = summarizeOutcomes([
    { status: 'completed', due_at: 1 },
    { status: 'completed', due_at: 2 },
    { status: 'completed', due_at: 3 },
    { status: 'skipped', due_at: 4 },
    { status: 'missed', due_at: 5 },
    { status: 'completed', due_at: 6 },
    { status: 'pending', due_at: 7 },
    { status: 'in_progress', due_at: 8 },
  ]);

  assert.equal(summary.completed, 4);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.missed, 1);
  assert.equal(summary.pending, 2);
  // Adherence = completed / (completed + skipped + missed) — a break that has not
  // come due yet is neither a success nor a failure.
  assert.equal(summary.resolved, 6);
  assert.equal(summary.adherencePct, 66.7);
});

test('summarizeOutcomes reports adherence as null rather than 0 when nothing has resolved', () => {
  const summary = summarizeOutcomes([{ status: 'pending', due_at: 1 }]);
  assert.equal(summary.adherencePct, null);
  assert.equal(summary.resolved, 0);
});

test('consecutive misses are counted from the most recent break backwards', () => {
  const summary = summarizeOutcomes([
    { status: 'completed', due_at: 1 },
    { status: 'missed', due_at: 2 },
    { status: 'missed', due_at: 3 },
  ]);
  assert.equal(summary.consecutiveMisses, 2);
  assert.equal(summary.consecutiveNonCompleted, 2);

  const reset = summarizeOutcomes([
    { status: 'missed', due_at: 1 },
    { status: 'missed', due_at: 2 },
    { status: 'completed', due_at: 3 },
  ]);
  assert.equal(reset.consecutiveMisses, 0, 'a completed break clears the streak');
});

test('skipped and missed breaks both count towards the same streak', () => {
  const summary = summarizeOutcomes([
    { status: 'completed', due_at: 1 },
    { status: 'skipped', due_at: 2 },
    { status: 'missed', due_at: 3 },
  ]);
  // Two breaks in a row not taken, one of each flavour.
  assert.equal(summary.consecutiveNonCompleted, 2);
  assert.equal(summary.consecutiveMisses, 1, 'only the most recent break was a miss');
  assert.equal(summary.consecutiveSkipped, 0, 'the skip was broken by the miss that followed');
});

test('a purely missed run reports as misses, a purely skipped run as skips', () => {
  const missed = summarizeOutcomes([
    { status: 'completed', due_at: 1 },
    { status: 'missed', due_at: 2 },
    { status: 'missed', due_at: 3 },
  ]);
  assert.equal(missed.consecutiveMisses, 2);
  assert.equal(missed.consecutiveSkipped, 0);

  const skipped = summarizeOutcomes([
    { status: 'skipped', due_at: 1 },
    { status: 'skipped', due_at: 2 },
  ]);
  assert.equal(skipped.consecutiveSkipped, 2);
  assert.equal(skipped.consecutiveMisses, 0);
});

test('computeNextBreakDue never hands a returning seat an instantly-overdue break', () => {
  const intervalMin = 20;
  const baseAt = 1_000_000;

  const onTime = computeNextBreakDue({ baseAt, intervalMin, atMs: baseAt + 60_000 });
  assert.equal(onTime.dueAt, baseAt + intervalMin * 60_000);
  assert.equal(onTime.lateAdjusted, false);

  // The seat was away long past its next break: re-anchor with a lead instead of
  // firing the overlay the second it reconnects.
  const late = computeNextBreakDue({ baseAt, intervalMin, atMs: baseAt + 90 * 60_000, minLeadMs: 30_000 });
  assert.equal(late.dueAt, baseAt + 90 * 60_000 + 30_000);
  assert.equal(late.lateAdjusted, true);
});

test('a break is paused while it is on screen, so the stretch is honest', () => {
  const seatSession = { state: 'active', started_at: 0, resumed_at: 600_000, active_seconds: 300 };
  assert.equal(activeStretchSeconds(seatSession, 900_000), 300);
  assert.equal(activeStretchSeconds({ ...seatSession, state: 'on_break' }, 900_000), 0);
  assert.equal(activeStretchSeconds({ ...seatSession, state: 'ended' }, 900_000), 0);
});

test('isLongStretch uses the room threshold in minutes', () => {
  assert.equal(isLongStretch(45 * 60, 45), true);
  assert.equal(isLongStretch(44 * 60 + 59, 45), false);
});

test('instruction rotation never repeats the previous instruction back to back', () => {
  const previous = BREAK_INSTRUCTIONS[0].key;
  for (let i = 0; i < 200; i += 1) {
    const next = pickInstruction(Math.random, previous);
    assert.notEqual(next.key, previous);
  }
  assert.ok(BREAK_INSTRUCTIONS.length >= 4, 'the pool must have room to rotate');
});

test('warning leads are exactly T-5 and T-1 minutes at the default cadence', () => {
  const dueAt = 10_000_000;
  const offsets = warningOffsets(dueAt, { intervalMin: 20 });
  assert.equal(offsets.t5, dueAt - 5 * 60_000);
  assert.equal(offsets.t1, dueAt - 60_000);
  assert.equal(offsets.scale, 1);
  assert.equal(offsets.lead5Sec, 300);
});

test('warning leads scale down for accelerated cadences instead of going negative', () => {
  const dueAt = 10_000_000;
  const offsets = warningOffsets(dueAt, { intervalMin: 2 });
  assert.ok(offsets.t5 < dueAt && offsets.t5 > dueAt - 2 * 60_000, 'T-5 must fall inside a 2-minute cycle');
  // T-1 is nearer to the due moment than T-5, so it is the *later* timestamp.
  assert.ok(offsets.t1 > offsets.t5 && offsets.t1 < dueAt);
  assert.equal(offsets.lead5Sec, 30);
  assert.equal(offsets.lead1Sec, 6);
  assert.equal(offsets.scale, 0.1);
});

test('warning leads can be switched off per classroom', () => {
  const offsets = warningOffsets(10_000_000, { intervalMin: 20, warnLead5Min: 0, warnLead1Min: 0 });
  assert.equal(offsets.t5, null);
  assert.equal(offsets.t1, null);
});

test('aggregateAdherence weights by resolved breaks and also reports the mean seat rate', () => {
  const totals = aggregateAdherence([
    { completed: 9, skipped: 1, missed: 0, resolved: 10, pending: 0, adherencePct: 90 },
    { completed: 1, skipped: 1, missed: 8, resolved: 10, pending: 0, adherencePct: 10 },
  ]);
  assert.equal(totals.completed, 10);
  assert.equal(totals.adherencePct, 50);
  // The two seats scored 90% and 10%, so the typical seat sits at 50% here — but
  // the two figures differ as soon as seats take different numbers of breaks.
  assert.equal(totals.meanSeatAdherencePct, 50);
});

test('formatDuration reads the way a teacher would say it', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(12 * 60_000 + 30_000), '12m 30s');
  assert.equal(formatDuration(64 * 60_000), '1h 04m');
});

test('the weekly window is Monday to Friday and is always already closed', () => {
  // Wednesday 2026-09-30 → the report covers the week that finished on Friday 25th.
  const wednesday = Date.parse('2026-09-30T09:00:00Z');
  const range = weekRange(wednesday, { offsetMinutes: 0 });
  assert.equal(localDayKey(range.start, 0), '2026-09-21');
  assert.equal(localDayKey(range.end - 1, 0), '2026-09-25');
  assert.equal(range.days.length, 5);
  assert.deepEqual(
    range.days.map((day) => day.short),
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  );

  // Asked on Monday, the same rule returns the week that ended three days earlier,
  // never a partial week.
  const monday = Date.parse('2026-09-28T07:00:00Z');
  const mondayRange = weekRange(monday, { offsetMinutes: 0 });
  assert.equal(localDayKey(mondayRange.start, 0), '2026-09-21');
  assert.ok(mondayRange.end <= monday, 'the window must not run into the future');
});

test('weekRange weeksAgo walks back distinct closed weeks', () => {
  const at = Date.parse('2026-09-30T09:00:00Z');
  const labels = [0, 1, 2].map((weeksAgo) => localDayKey(weekRange(at, { offsetMinutes: 0, weeksAgo }).start, 0));
  assert.deepEqual(labels, ['2026-09-21', '2026-09-14', '2026-09-07']);
  // The analytics trend uses weeksAgo = n + 1 for exactly this reason: weeksAgo 0 is
  // already the most recent finished week, so 0…7 would repeat it.
  assert.equal(startOfLocalWeek(at - 7 * DAY, 0), startOfLocalWeek(Date.parse('2026-09-21T00:00:00Z'), 0));
});
