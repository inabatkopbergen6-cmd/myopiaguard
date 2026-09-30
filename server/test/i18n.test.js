import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Translation integrity.
 *
 * The dictionaries are the one part of this product where a mistake is invisible:
 * a missing Russian head simply falls back to English, and nothing throws. These
 * tests are what make a gap *loud* — a missing key, a Russian plural entry that
 * forgot a category, or a key referenced from code but absent from both files.
 *
 * The files are read and evaluated with `new Function` rather than imported, so
 * this stays runnable from the server workspace without a bundler.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dictionaryPath = (lang) => path.join(repoRoot, 'web', 'src', 'i18n', `${lang}.js`);

function loadDictionary(lang) {
  const source = readFileSync(dictionaryPath(lang), 'utf8');
  // The files are `export default { … }`, so strip the one export keyword.
  const body = source.replace(/^\s*import[\s\S]*?;\s*$/gm, '').replace(/export default/, 'return');
  // eslint-disable-next-line no-new-func
  return new Function(body)();
}

const en = loadDictionary('en');
const ru = loadDictionary('ru');

/** Every leaf path in a dictionary, including plural-category leaves. */
function leafPaths(node, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafPaths(value, current));
    } else {
      out.push(current);
    }
  }
  return out;
}

const PLURAL_CATEGORIES = new Set(['one', 'few', 'many', 'other']);

/** Paths that represent a plural entry, e.g. `board.workstations.one`. */
function pluralEntries(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.some((k) => PLURAL_CATEGORIES.has(k))) out.push({ path: current, categories: keys });
      else pluralEntries(value, current, out);
    }
  }
  return out;
}

test('every English key exists in Russian', () => {
  const enPaths = new Set(leafPaths(en));
  const ruPaths = new Set(leafPaths(ru));
  const missing = [...enPaths].filter((keyPath) => !ruPaths.has(keyPath));
  assert.deepEqual(missing, [], `Russian is missing: ${missing.join(', ')}`);
});

test('Russian adds no key that English lacks, apart from plural categories', () => {
  const enPaths = new Set(leafPaths(en));
  const extra = [...new Set(leafPaths(ru))]
    .filter((keyPath) => !enPaths.has(keyPath))
    .filter((keyPath) => !PLURAL_CATEGORIES.has(keyPath.split('.').pop()));
  assert.deepEqual(extra, [], `Russian has unexpected keys: ${extra.join(', ')}`);
});

test('Russian plural entries carry all four categories', () => {
  // Russian needs one / few / many / other: 1 перерыв, 2 перерыва, 5 перерывов.
  // A missing category silently falls back to `other`, which reads as a grammar
  // error rather than as a bug.
  const problems = [];
  for (const entry of pluralEntries(ru)) {
    if (entry.categories.includes('one') || entry.categories.includes('few')) {
      for (const category of ['one', 'few', 'many', 'other']) {
        if (!entry.categories.includes(category)) problems.push(`${entry.path} is missing "${category}"`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

test('no dictionary value is empty or left as a placeholder', () => {
  const problems = [];
  for (const [name, dictionary] of Object.entries({ en, ru })) {
    for (const keyPath of leafPaths(dictionary)) {
      const value = keyPath.split('.').reduce((node, segment) => node?.[segment], dictionary);
      if (typeof value === 'string' && value.trim() === '') problems.push(`${name}.${keyPath} is empty`);
      if (typeof value === 'string' && /^(TODO|TBD|XXX)/i.test(value)) problems.push(`${name}.${keyPath} is a placeholder`);
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

test('interpolation placeholders match between English and Russian', () => {
  // A Russian string that drops `{count}` renders a sentence with no number, and a
  // typo'd placeholder renders the literal braces to a child.
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const problems = [];

  const compare = (enValue, ruValue, keyPath) => {
    if (typeof enValue === 'string' && typeof ruValue === 'string') {
      const a = placeholders(enValue).join(',');
      const b = placeholders(ruValue).join(',');
      if (a !== b) problems.push(`${keyPath}: en{${a}} vs ru{${b}}`);
      return;
    }
    if (enValue && ruValue && typeof enValue === 'object' && typeof ruValue === 'object') {
      for (const [key, child] of Object.entries(enValue)) compare(child, ruValue[key], `${keyPath}.${key}`);
    }
  };

  for (const [key, value] of Object.entries(en)) compare(value, ru[key], key);
  assert.deepEqual(problems, [], problems.join('; '));
});

test('t() is never called on a plural entry, and tn() never on a plain string', () => {
  // This is the bug class that shipped once: `t('analytics.daysCount')` on a plural
  // object returns the key itself, so the UI rendered the literal text
  // "analytics.daysCount" in the window selector. Neither failure throws.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(jsx|js)$/.test(entry)) files.push(full);
    }
  };
  walk(path.join(repoRoot, 'web', 'src'));

  const lookup = (node, keyPath) =>
    keyPath.split('.').reduce((current, segment) => (current == null ? undefined : current[segment]), node);

  const isPlural = (value) =>
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).some((k) => PLURAL_CATEGORIES.has(k));

  const problems = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const match of source.matchAll(/(?<![$\w])t\(\s*'([a-zA-Z][\w.]*)'/g)) {
      const value = lookup(en, match[1]);
      if (isPlural(value)) {
        problems.push(`${path.relative(repoRoot, file)}: t('${match[1]}') is a plural entry — use tn(count, …)`);
      }
    }
    for (const match of source.matchAll(/tn\([^,]+,\s*'([a-zA-Z][\w.]*)'/g)) {
      const value = lookup(en, match[1]);
      if (typeof value === 'string') {
        problems.push(`${path.relative(repoRoot, file)}: tn(count, '${match[1]}') is a plain string — use t(…)`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('; '));
});

test('the break instruction pool is translated for every server instruction key', () => {
  // The server picks an instruction by key; the client translates it by key. A key
  // the dictionary does not know means an English sentence on a Russian break
  // screen — the one screen students actually read.
  const serverSource = readFileSync(
    path.join(repoRoot, 'server', 'src', 'services', 'breaks.js'),
    'utf8',
  );
  const keys = [...serverSource.matchAll(/key:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 4, 'the instruction pool should have several entries');
  for (const key of keys) {
    for (const [name, dictionary] of Object.entries({ en, ru })) {
      assert.ok(
        dictionary.instructions?.[key],
        `${name}.instructions is missing the server's "${key}" instruction`,
      );
    }
  }
});

test('the weekly report metric labels are translated for every metric the server defines', () => {
  const serverSource = readFileSync(
    path.join(repoRoot, 'server', 'src', 'services', 'reports.js'),
    'utf8',
  );
  const block = /METRIC_DEFINITIONS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/.exec(serverSource);
  assert.ok(block, 'METRIC_DEFINITIONS not found');
  const keys = [...block[1].matchAll(/key:\s*'(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'expected the five headline metrics');
  for (const key of keys) {
    for (const [name, dictionary] of Object.entries({ en, ru })) {
      assert.ok(dictionary.metrics?.[key]?.label, `${name}.metrics.${key}.label is missing`);
      assert.ok(dictionary.metrics?.[key]?.description, `${name}.metrics.${key}.description is missing`);
    }
  }
});

test('the attention flag labels are translated for every server code', () => {
  const serverSource = readFileSync(
    path.join(repoRoot, 'server', 'src', 'services', 'dashboard.js'),
    'utf8',
  );
  const codes = [...serverSource.matchAll(/(REPEAT_MISSES|LONG_SESSION|OFFLINE_MID_SESSION|OFFLINE_MID_BREAK):\s*'([a-z_]+)'/g)]
    .map((m) => m[2]);
  assert.ok(codes.length === 4, `expected four attention codes, found ${codes.length}`);
  for (const code of codes) {
    for (const [name, dictionary] of Object.entries({ en, ru })) {
      assert.ok(dictionary.attentionFlag?.[code], `${name}.attentionFlag.${code} is missing`);
    }
  }
});

test('the audit action labels cover every action the server writes', () => {
  const files = [
    'server/src/routes/teacher.js',
    'server/src/services/attention.js',
    'server/src/services/focus.js',
    'server/src/routes/dev.js',
  ];
  const actions = new Set();
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    for (const match of source.matchAll(/action:\s*'([a-z]+\.[a-z_]+)'/g)) actions.add(match[1]);
  }
  assert.ok(actions.size >= 8, `expected several audited actions, found ${actions.size}`);
  for (const action of actions) {
    for (const [name, dictionary] of Object.entries({ en, ru })) {
      assert.ok(
        dictionary.setup?.actionLabels?.[action],
        `${name}.setup.actionLabels is missing "${action}"`,
      );
    }
  }
});

test('every t() and tn() key used in the app resolves in both dictionaries', () => {
  // Catches a typo in a component: without this, a mistyped key renders as the raw
  // key text in the UI rather than as a translated string.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(jsx|js)$/.test(entry)) files.push(full);
    }
  };
  walk(path.join(repoRoot, 'web', 'src'));

  /**
   * Every path a lookup can resolve: the leaves, plus each intermediate object.
   * The intermediates matter because a plural key used with `tn(count, key)`
   * correctly names the *parent* object, not a category leaf.
   */
  const resolvable = (node, prefix = '', out = new Set()) => {
    for (const [key, value] of Object.entries(node)) {
      const current = prefix ? `${prefix}.${key}` : key;
      out.add(current);
      if (value && typeof value === 'object' && !Array.isArray(value)) resolvable(value, current, out);
    }
    return out;
  };
  const enResolvable = resolvable(en);
  const ruResolvable = resolvable(ru);

  // Keys built dynamically (`metrics.${metric.key}.label`) cannot be checked
  // statically; those are covered by the server-driven tests above.
  const staticKey = /(?<![$\w])t\(\s*'([a-zA-Z][\w.]*)'/g;
  const staticPluralKey = /tn\([^,]+,\s*'([a-zA-Z][\w.]*)'/g;
  const missing = new Set();
  const untranslated = new Set();

  for (const file of files) {
    // Strip comments first: several doc comments contain example t('…') calls,
    // which would otherwise be reported as missing keys.
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const regex of [staticKey, staticPluralKey]) {
      for (const match of source.matchAll(regex)) {
        const key = match[1];
        if (!enResolvable.has(key)) missing.add(`${path.relative(repoRoot, file)} → ${key}`);
        else if (!ruResolvable.has(key)) untranslated.add(`${path.relative(repoRoot, file)} → ${key}`);
      }
    }
  }

  assert.deepEqual([...missing], [], `keys used but not defined: ${[...missing].join(', ')}`);
  assert.deepEqual([...untranslated], [], `keys defined but not translated: ${[...untranslated].join(', ')}`);
});
