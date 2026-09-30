/**
 * MyopiaGuard Focus Mode — reference enforcement hook (Manifest V3).
 *
 * WHAT THIS DOES
 *   Reads the Focus Mode policy document the classroom server publishes and turns
 *   it into declarativeNetRequest rules, so only the resources a teacher approved
 *   for the current lesson will load in the main frame.
 *
 * WHAT THIS DOES NOT DO — and cannot be made to do
 *   No keyboard or mouse lock. No screen capture. No application blocking. No page
 *   content inspection. The server has no API for those, this extension requests no
 *   permission for them, and the only rule action it ever installs is a main-frame
 *   navigation block. That boundary is the product's, not a configuration choice.
 *
 * The policy document is fetched from the documented agent endpoint using the
 * seat's enrolment token — the same credential the web agent uses, so this
 * extension is a second client of one contract rather than a parallel system.
 *
 * Deployment note: the decision behind this file, and the alternative for schools
 * that already run Chrome Enterprise or an MDM, is written up in
 * docs/FOCUS_MODE_DECISION.md.
 */

const RULE_ID_BASE = 1000; // allow rules start here; id 1 is the catch-all block
const RULE_ID_BLOCK_ALL = 1;
const POLL_ALARM = 'myopiaguard-focus-poll';
const POLL_MINUTES = 1; // chrome.alarms floor; the policy rarely changes mid-lesson

/** Reads the enrolment settings a technician entered on the options page. */
async function readSettings() {
  const { serverUrl, agentToken, enforce } = await chrome.storage.local.get([
    'serverUrl',
    'agentToken',
    'enforce',
  ]);
  return {
    serverUrl: (serverUrl ?? '').replace(/\/+$/, ''),
    agentToken: agentToken ?? '',
    // `enforce: false` is a deliberate technician override for a broken policy.
    // It does not bypass anything on the server; it just stops applying rules.
    enforce: enforce !== false,
  };
}

/** Domain patterns for the allowlist, including subdomains. */
function allowlistRules(patterns) {
  return patterns
    .filter(Boolean)
    .map((domain, index) => ({
      id: RULE_ID_BASE + index,
      priority: 2, // must outrank the block-all rule below
      action: { type: 'allow' },
      condition: {
        requestDomains: [domain],
        resourceTypes: ['main_frame'],
      },
    }));
}

function blockAllRule() {
  return {
    id: RULE_ID_BLOCK_ALL,
    priority: 1,
    action: { type: 'block' },
    condition: {
      // Only top-level navigation: embedded content, scripts and stylesheets the
      // approved pages need are untouched, so an approved resource keeps working.
      resourceTypes: ['main_frame'],
      urlFilter: '*',
    },
  };
}

/**
 * Replaces every dynamic rule with the set the policy implies.
 *
 * `allowedDomains` come straight from the server's policy document, so this
 * function has no opinion about what should be approved — it only knows how to
 * express "these, and nothing else".
 */
async function applyPolicy(policy) {
  const settings = await readSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  if (!settings.enforce || !policy?.active) {
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    }
    await chrome.storage.local.set({ appliedPolicyVersion: 0, appliedAt: Date.now() });
    return { applied: false, rules: 0 };
  }

  const domains = (policy.allowedDomains ?? []).map((entry) => entry.domain);
  const rules = [blockAllRule(), ...allowlistRules(domains)];

  // Always keep the school's own server reachable, or a blocked policy could make
  // the machine unable to fetch the policy that unblocks it.
  if (settings.serverUrl) {
    try {
      rules.push({
        id: RULE_ID_BASE + 900,
        priority: 3,
        action: { type: 'allow' },
        condition: { requestDomains: [new URL(settings.serverUrl).hostname], resourceTypes: ['main_frame'] },
      });
    } catch {
      /* an unparseable server URL simply is not allowlisted */
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  await chrome.storage.local.set({
    appliedPolicyVersion: policy.policyVersion ?? 0,
    appliedAt: Date.now(),
    appliedPolicy: policy,
  });

  return { applied: true, rules: rules.length, domains: domains.length };
}

/**
 * Fetches the policy for this seat. Failure is not fatal: the last applied rules
 * stay in force, which is the fail-closed behaviour a lesson needs — a network
 * blip must not open the whole internet to a class.
 */
async function fetchPolicy() {
  const settings = await readSettings();
  if (!settings.serverUrl || !settings.agentToken) {
    return { ok: false, reason: 'not_enrolled' };
  }

  try {
    const response = await fetch(`${settings.serverUrl}/api/agent/state`, {
      headers: { 'x-agent-token': settings.agentToken },
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }
    const state = await response.json();
    const policy = state.focusPolicy ?? { active: false, allowedDomains: [] };
    const applied = await applyPolicy(policy);
    await reportEnforcement(settings, policy, applied);
    return { ok: true, policy, applied };
  } catch (error) {
    return { ok: false, reason: 'unreachable', error: String(error?.message ?? error) };
  }
}

/** Tells the server what was actually applied, so the audit trail is truthful. */
async function reportEnforcement(settings, policy, applied) {
  try {
    await fetch(`${settings.serverUrl}/api/agent/focus/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': settings.agentToken },
      body: JSON.stringify({
        applied: applied?.applied ?? false,
        policyVersion: policy?.policyVersion ?? 0,
        enforcer: `chrome-extension/${chrome.runtime.getManifest().version}`,
      }),
    });
  } catch {
    /* telemetry only: never block on it */
  }
}

/** A blocked navigation shows the school's own explanation, not a browser error. */
async function configureBlockPage(policy) {
  const url = policy?.active ? chrome.runtime.getURL('blocked.html') : null;
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const rules = current.map((rule) =>
    rule.id === RULE_ID_BLOCK_ALL
      ? { ...rule, action: url ? { type: 'redirect', redirect: { url } } : { type: 'block' } }
      : rule,
  );
  if (rules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((rule) => rule.id),
      addRules: rules,
    });
  }
}

async function refresh() {
  const result = await fetchPolicy();
  if (result.ok) await configureBlockPage(result.policy);
  await chrome.storage.local.set({ lastPollAt: Date.now(), lastPollResult: result.ok ? 'ok' : result.reason });
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
  refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.agentToken || changes.enforce)) refresh();
});

/** The options page and the action button both trigger an immediate re-apply. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'refresh') {
    refresh().then(sendResponse);
    return true; // async response
  }
  if (message?.type === 'status') {
    chrome.storage.local
      .get(['appliedPolicy', 'appliedPolicyVersion', 'appliedAt', 'lastPollResult', 'lastPollAt'])
      .then(sendResponse);
    return true;
  }
  return false;
});

refresh();
