// Shows the student which resources *were* approved, so a blocked page is never a
// dead end: the rule is visible, and the way forward (ask the teacher) is obvious.
chrome.storage.local.get(['appliedPolicy']).then(({ appliedPolicy }) => {
  const list = document.getElementById('approved-list');
  if (!list) return;
  const domains = appliedPolicy?.allowedDomains ?? [];
  if (domains.length === 0) {
    list.innerHTML = '<li>No resources have been approved yet.</li>';
    return;
  }
  list.replaceChildren(
    ...domains.map((entry) => {
      const item = document.createElement('li');
      item.textContent = `${entry.name} (${entry.domain})`;
      return item;
    }),
  );
});
