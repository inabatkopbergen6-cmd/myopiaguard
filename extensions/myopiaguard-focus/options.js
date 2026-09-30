/** Options page: enrolment details plus an honest read-out of what is applied. */

const $ = (id) => document.getElementById(id);

function renderStatus(status) {
  const policy = status.appliedPolicy;
  $('s-active').textContent = policy?.active ? 'On' : 'Off';
  $('s-version').textContent = policy?.policyVersion ? `#${policy.policyVersion}` : '—';
  $('s-count').textContent = policy?.allowedDomains?.length ?? 0;
  $('s-applied').textContent = status.appliedAt ? new Date(status.appliedAt).toLocaleTimeString() : 'never';
  $('s-poll').textContent = status.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : 'never';

  const list = $('s-domains');
  list.replaceChildren(
    ...(policy?.allowedDomains ?? []).map((entry) => {
      const item = document.createElement('li');
      item.textContent = `${entry.name} — ${entry.domain}`;
      return item;
    }),
  );

  const failure = $('failure');
  if (status.lastPollResult && status.lastPollResult !== 'ok') {
    failure.hidden = false;
    $('failure-detail').textContent = `Reason: ${status.lastPollResult}`;
  } else {
    failure.hidden = true;
  }
}

async function load() {
  const settings = await chrome.storage.local.get(['serverUrl', 'agentToken', 'enforce']);
  $('serverUrl').value = settings.serverUrl ?? '';
  $('agentToken').value = settings.agentToken ?? '';
  $('enforce').checked = settings.enforce !== false;
  renderStatus(await chrome.runtime.sendMessage({ type: 'status' }));
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    serverUrl: $('serverUrl').value.trim().replace(/\/+$/, ''),
    agentToken: $('agentToken').value.trim(),
    enforce: $('enforce').checked,
  });
  $('status').textContent = 'Saved — checking for a policy…';
  const result = await chrome.runtime.sendMessage({ type: 'refresh' });
  $('status').textContent = result?.ok
    ? `Applied: ${result.policy?.active ? `${result.policy.allowedDomains.length} approved resource(s)` : 'Focus Mode is off'}`
    : `Could not reach the server (${result?.reason ?? 'unknown'})`;
  renderStatus(await chrome.runtime.sendMessage({ type: 'status' }));
});

$('refresh').addEventListener('click', async () => {
  $('status').textContent = 'Checking…';
  const result = await chrome.runtime.sendMessage({ type: 'refresh' });
  $('status').textContent = result?.ok ? 'Up to date.' : `Could not reach the server (${result?.reason ?? 'unknown'})`;
  renderStatus(await chrome.runtime.sendMessage({ type: 'status' }));
});

load();
