# Focus Mode enforcement — technical decision

**Status:** decided, reference implementation shipped, one open item for the school's IT team (below).

## The question

Deliverable 7 asks for Focus Mode: a teacher toggles a session, picks approved
resources from a checklist, and student devices restrict browsing to that list.
The spec explicitly flags the enforcement mechanism as a decision point —
"browser extension policy, DNS filtering, or MDM integration" — and asks for the
most practical approach for a typical school.

## Decision

**Publish a policy document from the server; let enforcement be pluggable.**

The server owns *what* is allowed. It never assumes *how* the device applies it.
`buildPolicyDocument()` in `server/src/services/focus.js` emits one versioned
document — allowed domains, wildcard patterns, a student-facing summary, an
explicit expiry rule — and three delivery paths consume the identical shape:

| Path | Fits | Applied with |
| --- | --- | --- |
| **Chrome extension** (shipped, `extensions/myopiaguard-focus/`) | Schools managing Chromebooks or Chrome browsers without a Google Workspace admin | `declarativeNetRequest` dynamic rules |
| **Chrome Enterprise / Google Workspace for Education** | Schools already in Workspace (the common case) | `URLBlocklist` / `URLAllowlist` user policies, pushed per OU |
| **MDM profile** (Jamf, Intune, Mosyle) | Mixed Windows/macOS fleets | A managed browser profile, or a filtering agent's allowlist feed |

The bundled extension is the **reference implementation**: a working, inspectable
consumer of the contract that a school can ship on day one, and that any
device-management integration can replace without touching the server.

## Why this shape

1. **The school already has a device-management story; MyopiaGuard should not
   duplicate it.** A school that runs Workspace can enforce Focus Mode with an OU
   policy the IT team already understands, and the extension is then redundant.
   Forcing one mechanism would either exclude those schools or duplicate policy
   they already maintain.
2. **Session scoping is a server concern, not a device concern.** Focus Mode must
   be on for one lesson and off afterwards. Chrome policies and MDM profiles are
   slow, coarse, org-unit-shaped things that do not naturally expire in 45
   minutes. A server that pushes a *versioned document* with an
   `expiresWithLesson: true` flag solves that regardless of the enforcer.
3. **One anti-bypass property matters more than breadth.** Every path re-asserts
   policy on a heartbeat (the extension polls each minute; the agent re-asserts
   every five seconds), so reloading a browser or restarting a PC cannot escape an
   active lesson's allowlist.
4. **Honesty about failure.** Enforcement fails *closed* on a network blip — the
   last applied rules stay in force — because a lesson's allowlist silently
   evaporating is worse than a legitimate site staying blocked for a minute.

## What was rejected, and why

| Option | Why not |
| --- | --- |
| **DNS filtering only** | Cannot distinguish a lesson from break; cannot express "for the next 45 minutes"; widely bypassed with DoH and hard-coded DNS; blocks sub-resources rather than navigation, which breaks approved sites that embed external content. |
| **System-wide kiosk / input lock** | Out of scope on purpose. The product principle is classroom management, not device control. A locked keyboard is a classroom-management failure mode (a stuck device mid-exam), and it is the capability most likely to be misused. |
| **Per-app blocking agent on every PC** | Highest deployment cost (install, update and support per machine), highest privacy surface (a background process with system privileges), and the slowest to pilot. The web agent already proves the schedule can live on the server with nothing installed. |
| **A bespoke full-screen kiosk browser** | Impossible on school-managed Chromebooks without repackaging the browser, and it would break SSO flows the school depends on. |

## Open item for the school's IT team

**Which enforcement path applies to the fleet, and does the extension need to be
force-installed?** This is a procurement and management decision, not a
technical unknown:

- If devices are in Google Workspace: prefer an OU policy, and treat the
  extension as a redundant belt-and-braces layer or omit it.
- If devices are not centrally managed: force-install the extension
  (`ExtensionInstallForcelist`) and pin the enrolment token per machine.
- Either way, confirm the **seat token is applied at provisioning time**, not by
  the student who happens to sit down.

## Privacy boundary, restated for this feature

Focus Mode restricts *browsing*. In the shipped implementation:

- No browsing history is collected, transmitted or stored. The extension never
  reads page content, never inspects URLs beyond the declarative rule match, and
  reports only "policy N applied: yes/no" back to the server.
- Blocked navigations are not logged against a seat. The server records
  enforcement *state*, not what a student tried to visit. That is a deliberate
  omission: a per-seat blocked-site log would be a browsing history by another
  name, and it is not needed to run a lesson.
- The policy itself is auditable: `focus_sessions` records who enabled it, when,
  and which resources were approved, and the message the teacher chose is in
  `audit_log`.

## Verification

- `server/test/api.test.js` — "Focus Mode produces an enforceable policy and
  refuses an empty allowlist": asserts the policy shape, the wildcard patterns an
  enforcer needs, that the version changes so a stale policy is detectable, that
  the device sees the same version, and that an empty allowlist is refused.
- "ending the lesson clears seat sessions and turns Focus Mode off": asserts the
  session-scoping that every enforcement path relies on.
- The extension code itself is reviewed but **not** exercised by the test suite —
  see the testing-status section of
  `extensions/myopiaguard-focus/README.md`. Pilot it on one device per fleet type
  before a whole-school rollout.
