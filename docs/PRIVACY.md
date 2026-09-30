# Privacy and safety by design

MyopiaGuard watches **screens**, not children. This document states the commitment,
then shows the mechanism — because a privacy promise without an enforcement point
is marketing.

## The commitments

1. **A seat is a workstation, never a person.** The only identity a classroom PC
   carries is a machine label: `PC-01`, `Seat 12`.
2. **School-level reporting is aggregate by construction.** Grade, classroom and
   subject rollups. No seat-level figure exists at the admin layer to withhold.
3. **Attention Mode is classroom management, not remote control.** No input lock,
   no screen capture, no application blocking.
4. **Focus Mode restricts browsing, not the machine.** No keystroke logging, no
   page-content inspection, no per-seat blocked-site history.
5. **Interruptions are predictable.** A break is announced five minutes and one
   minute before it happens. Nothing takes over a student's screen unannounced.

## Where each one is enforced

A promise is only as good as its choke point. Every commitment above has at least
one place in the code where it is mechanically impossible to break silently.

### 1. No student identity — four layers

| Layer | Mechanism | File |
| --- | --- | --- |
| Schema | `seats` has no student column, and a `CHECK` constrains the label to the machine shape | `server/src/db.js` |
| Validation | `assertSeatLabel()` rejects anything that is not `PC-nn`/`Seat nn`, and names outright | `server/src/lib/validation.js` |
| API | Every seat read/write path goes through that validator; the API test asserts `400 pii_rejected` | `server/src/routes/teacher.js`, `server/test/api.test.js` |
| UI | The board renders `seats.label` and has no field for a name to occupy | `web/src/components/SeatBoard.jsx` |

The practical consequence: a school *cannot* store a student name against a
machine without changing the schema. There is no import path, no free-text field
and no override.

### 2. Aggregate-only analytics — four independent controls

| Control | What it stops |
| --- | --- |
| `requireUser('admin')` | The wrong person: a teacher or a device cannot reach the layer at all |
| `rejectIdentifierParams()` | The wrong *question*: `?seatId=…` is refused by name (`400 seat_level_not_available`) rather than quietly ignored |
| `aggregateOnlyGuard()` | The wrong *answer*: the finished response body is scanned for seat/student identifiers and seat-shaped values, and is not sent if any appear |
| k-anonymity suppression | Re-identification by elimination: a cell built from fewer than `MG_MIN_COHORT` (default 5) workstations is withheld, not reported |

The guard is a deep scan of the serialised payload, so a future maintainer adding
a convenient endpoint cannot leak by accident — the request fails loudly with a
`500 aggregate_guard_violation` and logs what it blocked. Tests assert it fires
(`server/test/privacy.test.js`) and assert the real admin payload is clean and
contains no seeded seat label (`server/test/api.test.js`).

### 3. Attention Mode — declared in the payload

Broadcasts carry an explicit capability statement:

```json
"capabilities": {
  "inputLock": false, "screenCapture": false, "appBlocking": false,
  "windowControl": false, "scope": "lesson-management"
}
```

Those capabilities do not exist in the codebase, not as a setting and not as an
API. The overlay a student sees says so on screen, so they are not left guessing
whether the machine is watching them. The audit log records the message text of
every broadcast.

### 4. Focus Mode — the enforcement boundary

Enforcement happens in a declarative rule set that can only allow or block a
top-level navigation, and the extension requests no permission beyond that. No
browsing history is collected; blocked navigations are not logged per seat.
Reasoning and alternatives: `docs/FOCUS_MODE_DECISION.md`.

### 5. Predictability — asserted by tests

`server/test/scheduler.test.js` covers the timing contract: warnings fire once
each at scaled leads, the same break is never triggered twice, a seat that was
away gets a re-anchored cadence rather than an instant overlay, and an offline PC
is frozen rather than penalised. A break can never arrive unannounced, because the
row exists before it is due and the warning timestamps live on it.

## What MyopiaGuard does collect

Deliberately, and nothing more:

- **Break events** — recommended/scheduled time, whether it was shown, completed,
  skipped or missed, its duration, the stretch of screen time that preceded it.
- **Session events** — when a workstation joined a lesson, when it ended, how much
  active screen time accrued.
- **Heartbeats** — "this seat was alive at time T", used only for the offline badge.
- **Administrative audit** — who broadcast what message, who enabled Focus Mode
  with which resources, who changed a room's cadence.

Not collected: keystrokes, screenshots, page content, browsing history, audio,
camera, file contents, application usage, or any identifier for the person at the
keyboard.

## Data retention

The seeded deployment keeps everything indefinitely, because a school needs a term
of trend data. `docs/DEPLOYMENT.md` states the retention position plainly: break
and session events are the school's records and should follow the school's own
retention policy — one line of SQL prunes anything older than a chosen window, and
nothing in the product needs history older than the current academic year.

## What a school should still think about

Technology cannot decide policy. These remain school decisions, and MyopiaGuard
does not make them for you:

- **Whether to tell students and families** that screen-rest routines are running.
  The product is designed so that this conversation is easy — there is nothing to
  disclose about individuals.
- **Where the break rhythm comes from.** If a specialist advises a different
  cadence for a specific age group, set it per classroom; the defaults are a
  starting point, not a clinical recommendation.
- **Whether a seat's adherence should ever be used in a report about a class.**
  The product supports it; the school should decide whether it is fair, and it is
  visible to the teacher rather than hidden in an admin report.
