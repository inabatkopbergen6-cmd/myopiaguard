# MyopiaGuard Focus Mode — browser extension (reference enforcement hook)

A Manifest V3 Chrome/Chromium extension that turns a teacher's Focus Mode policy
into enforced browsing rules on a classroom PC.

This is the **reference implementation** of the enforcement hook. The product
decision behind it — and the alternatives for schools that already manage devices
with Chrome Enterprise, Google Workspace for Education, or an MDM — is written up
in [`docs/FOCUS_MODE_DECISION.md`](../../docs/FOCUS_MODE_DECISION.md). The server
side of this contract is `buildPolicyDocument()` in
`server/src/services/focus.js`.

## What it does

1. Polls the classroom server once a minute for this seat's policy.
2. If the policy is active, installs two kinds of `declarativeNetRequest` rule:
   - one catch-all **block** for top-level navigation (`main_frame`), priority 1;
   - one **allow** per approved domain (including subdomains), priority 2.
3. Leaves the school's own server domain allowlisted, so a policy can never make
   the machine unable to fetch the policy that replaces it.
4. Redirects a blocked navigation to `blocked.html`, which lists the resources
   that *are* approved and tells the student to ask their teacher.
5. Reports what it applied back to the server (`/api/agent/focus/report`) so the
   audit trail records enforcement, not just intent.

## What it deliberately cannot do

No keyboard or mouse lock. No screen capture. No application blocking. No page
content inspection. The extension requests no permission for any of those, and the
only rule action it ever installs is a main-frame navigation block. The server has
no API for them either — the boundary exists in both halves.

## Install and enrol (once per classroom PC)

1. Open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select this folder.
   *(For a fleet, publish it privately through the Google Workspace admin console
   or force-install it with the `ExtensionInstallForcelist` Chrome policy.)*
2. Open the extension's **Options**.
3. Paste the **classroom server URL** (the address the teacher dashboard uses) and
   the **seat enrolment token** shown on the teacher dashboard under
   *Setup → Workstations* for this machine — for example `PC-04`.
4. Click **Save and apply now**. The status panel shows the policy version, how
   many resources are approved, and when it was last applied.

**Pin the token to the machine, not to a person.** The token identifies a
workstation. There is no student field anywhere in MyopiaGuard for an extension —
or a technician — to enter.

## Failure behaviour

| Situation | What happens |
| --- | --- |
| Server unreachable on a poll | The last applied rules stay in force. A network blip must not open every site mid-lesson. |
| Focus Mode switched off by the teacher | The teacher's next action or the next poll removes every rule, and browsing is unrestricted. |
| Lesson ends | Focus Mode is session-scoped on the server, so the policy comes back inactive and rules are removed. |
| Technician untickes **Enforce** | No rules are applied; the extension keeps reporting the policy it received. Use for maintenance, not during a lesson. |
| Policy has zero approved resources | The server refuses to enable it (`empty_allowlist`), so this cannot produce a machine with nothing available. |

## Testing status — read this before relying on it

- The policy contract, the enable/disable lifecycle, the session-scoping and the
  audit trail are covered by the server test suite
  (`server/test/api.test.js`, "Focus Mode produces an enforceable policy…"),
  including the refusal to enable an empty allowlist and the policy versioning an
  enforcer depends on.
- The extension code in this folder is **not executed by that suite**: extension
  service workers need a real browser profile with the extension loaded, which the
  server tests do not provision. Treat it as a reviewed reference implementation
  and put it through your own device-management pilot before a whole-school
  rollout — in particular the rule update path on your Chrome version.
- The API surface it relies on is stable and broadly available
  (`declarativeNetRequest` dynamic rules and `requestDomains` conditions, Chrome
  116+). No MV2 fallback is provided, because MV2 is withdrawn.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest — `declarativeNetRequest`, `storage`, `alarms` |
| `background.js` | Policy fetch, rule construction, enforcement reporting |
| `blocked.html` / `blocked.js` | The page a student sees for a blocked site |
| `options.html` / `options.js` | Enrolment and a plain-speaking status read-out |
