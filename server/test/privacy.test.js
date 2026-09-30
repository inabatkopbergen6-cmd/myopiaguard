import assert from 'node:assert/strict';
import test from 'node:test';
import { findAggregateLeaks, isForbiddenKey } from '../src/lib/http.js';
import { assertDomain, assertSeatLabel, normalizeSeatLabel, sanitizeMessage } from '../src/lib/validation.js';

/**
 * These are the tests that defend the product's central promise: a classroom PC
 * identifies a machine, never a child, and the school analytics layer cannot
 * report on an individual even by accident.
 */

test('seat labels normalise to the machine-label form', () => {
  assert.equal(normalizeSeatLabel('PC-1'), 'PC-01');
  assert.equal(normalizeSeatLabel('pc 7'), 'PC-07');
  assert.equal(normalizeSeatLabel('Seat 12'), 'Seat 12');
  assert.equal(normalizeSeatLabel('seat-3'), 'Seat 03');
  assert.equal(normalizeSeatLabel('PC-104'), 'PC-104');
});

test('a seat cannot be labelled with a student name', () => {
  for (const attempt of ['Anna Kowalski', 'Jamie', 'PC-Anna', 'Student: Maria', '123', 'desk-four', '']) {
    assert.throws(
      () => assertSeatLabel(attempt),
      (error) => error.status === 400 && ['invalid_seat_label', 'pii_rejected'].includes(error.code),
      `"${attempt}" must be rejected as a seat label`,
    );
  }
});

test('the same rule applies to bulk seat creation, so a whole room cannot be named at once', () => {
  assert.throws(() => assertSeatLabel('PC-Olivia'), (error) => error.code === 'invalid_seat_label');
});

test('seat labels are stable through a round trip, so the grid cannot drift', () => {
  for (let index = 1; index <= 40; index += 1) {
    const label = assertSeatLabel(`PC-${index}`);
    assert.equal(normalizeSeatLabel(label), label);
  }
});

test('broadcast messages are length-capped and stripped of control characters and markup', () => {
  assert.equal(sanitizeMessage('  Please look  at the board.  '), 'Please look at the board.');
  assert.equal(sanitizeMessage('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(sanitizeMessage('line\u0000one'), 'line one');
  assert.equal(sanitizeMessage(''), '');
  assert.equal(sanitizeMessage('', { fallback: 'Default' }), 'Default');
  assert.equal(sanitizeMessage('x'.repeat(400), { maxLength: 20 }).length, 20);
});

test('focus resource domains are validated, not trusted', () => {
  assert.equal(assertDomain('https://Docs.Google.com/some/path'), 'docs.google.com');
  assert.equal(assertDomain('khanacademy.org'), 'khanacademy.org');
  for (const bad of ['not a domain', 'javascript:alert(1)', 'http://', 'localhost', '']) {
    assert.throws(() => assertDomain(bad), (error) => error.status === 400);
  }
});

test('the aggregate guard passes genuine rollup payloads', () => {
  const clean = {
    school: { id: 'sch_1', name: 'Riverside Secondary School' },
    headline: { classrooms: 8, computersReporting: 92, computerSessions: 725, breakAdherence: 74.6 },
    byGrade: [
      { gradeName: 'Grade 7', classrooms: 2, contributorSeats: 24, breakAdherence: 89.6, suppressed: false },
      { gradeName: 'Grade 11', classrooms: 1, suppressed: true, suppressionReason: 'Fewer than 5 workstations contributed.' },
    ],
    visualLoad: { bySubject: [{ subject: 'Computer Science', visualLoadIndex: 30.5, classrooms: 3 }] },
  };
  assert.deepEqual(findAggregateLeaks(clean), []);
});

test('the aggregate guard blocks per-seat rows however they are labelled', () => {
  const cases = [
    { byClassroom: [{ classroomName: 'Room 208', seatId: 'seat_abc' }] },
    { detail: { seat_label: 'PC-04' } },
    { rows: [{ seatSessionId: 'ses_1' }] },
    { agents: [{ agentToken: 'tok_123' }] },
    { students: [{ name: 'Anna' }] },
    { devices: [{ hostname: 'LAB-PC-04' }] },
  ];
  for (const payload of cases) {
    assert.ok(findAggregateLeaks(payload).length > 0, `${JSON.stringify(payload)} should be blocked`);
  }
});

test('the aggregate guard blocks a seat label hiding as an ordinary value', () => {
  // The failure mode being defended against: someone adds a helpful "example seat"
  // or a drill-down URL to an admin payload. The key is innocuous; the value is not.
  const payload = { note: 'Highest load workstation', example: 'PC-04', link: '/rooms/208' };
  const leaks = findAggregateLeaks(payload);
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /seat-label-shaped value/);
});

test('the aggregate guard reports the path of every leak it finds', () => {
  const leaks = findAggregateLeaks({ a: { b: [{ seatLabel: 'PC-01' }] } });
  // Two independent signals: the identifier key, and the seat-shaped value.
  assert.equal(leaks.length, 2);
  assert.ok(leaks.some((leak) => /^\$\.a\.b\[0\]\.seatLabel \(forbidden key\)$/.test(leak)), leaks.join(' | '));
  assert.ok(leaks.some((leak) => /seat-label-shaped value/.test(leak)), leaks.join(' | '));
});

test('plural and snake_case spellings of identifier keys are all caught', () => {
  for (const key of ['seats', 'seat_ids', 'SEAT-LABEL', 'seatSessions', 'students', 'devices', 'agentToken', 'hostnames']) {
    assert.ok(isForbiddenKey(key), `${key} should be treated as an identifier`);
  }
});

test('aggregate counts are not mistaken for identifiers', () => {
  const payload = {
    seatsReporting: 12,
    seatCount: 92,
    classroomName: 'Room 305',
    subject: 'Computer Science',
    gradeName: 'Grade 9',
  };
  assert.deepEqual(findAggregateLeaks(payload), []);
});
