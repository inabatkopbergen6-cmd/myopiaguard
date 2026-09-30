import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { setFormatLocale } from '../lib/format.js';
import en from './en.js';
import ru from './ru.js';
import { DEFAULT_LANGUAGE, LANGUAGES, intlLocale, isSupportedLanguage, languageEntry, matchLanguage } from './languages.js';

/**
 * Translation for the whole app.
 *
 * Shape:
 *   t('board.adherence')                  → a string
 *   t('board.nextBreakIn', { seconds: 12 }) → "Next break in 12s"
 *   tn(count, 'board.workstations')       → picks the right plural category
 *
 * Two things this does that a naive `key → string` lookup does not:
 *
 *   1. **Plural categories, not a two-form suffix.** English has one/other;
 *      Russian has one/few/many/other, and 1, 2 and 5 all take different forms. A
 *      dictionary entry can therefore be an object of `Intl.PluralRules`
 *      categories, and `tn` selects between them for the *current* language. The
 *      old `plural()` helper this replaces could only append an "s", which is
 *      wrong for Russian the moment a count is 2.
 *
 *   2. **Locale-aware number and date output.** Interpolated numbers and every
 *      `toLocale*` call in `lib/format.js` follow the selected language, so
 *      "1,234" becomes "1 234". The locale is pushed into `format.js` rather than
 *      threaded through ~20 call sites.
 *
 * Persistence is deliberate and layered: `localStorage` applies instantly and
 * works signed-out, while the signed-in account stores the choice server-side so
 * it follows the teacher to another computer. The provider does not talk to the
 * API itself — `onPersist` is supplied by the app shell, which keeps this module
 * free of a dependency on the API client (and avoids an import cycle).
 */

const DICTIONARIES = { en, ru };

const I18nContext = createContext(null);

export const STORAGE_KEY = 'myopiaguard.lang';

function readStoredLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    // Private mode / storage disabled: fall through to detection.
    return null;
  }
}

function writeStoredLanguage(code) {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* the choice still applies for this session */
  }
}

/** Resolves the initial language: stored choice → browser preference → default. */
export function resolveInitialLanguage(explicit) {
  if (isSupportedLanguage(explicit)) return explicit.toLowerCase();
  const stored = readStoredLanguage();
  if (stored) return stored;
  const fromBrowser = matchLanguage(navigator.languages?.[0] ?? navigator.language);
  return fromBrowser ?? DEFAULT_LANGUAGE;
}

/** Walks a dot path through the dictionary. Returns undefined when absent. */
function lookup(dictionary, path) {
  let node = dictionary;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

export function I18nProvider({ children, initialLanguage, onPersist }) {
  const [lang, setLangState] = useState(() => resolveInitialLanguage(initialLanguage));
  const [ready, setReady] = useState(false);
  // Guards the "server value wins on sign-in" rule so it applies once per account,
  // not on every render.
  const appliedAccountRef = useRef(null);
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;

  const locale = intlLocale(lang);

  // Number/date formatting follows the language. Done here once so every
  // formatter call site inherits it.
  useEffect(() => {
    setFormatLocale(locale);
    document.documentElement.lang = lang;
    setReady(true);
  }, [lang, locale]);

  const dictionary = DICTIONARIES[lang] ?? DICTIONARIES[DEFAULT_LANGUAGE];
  const fallback = DICTIONARIES[DEFAULT_LANGUAGE];

  const formatParams = useCallback(
    (params) => {
      if (!params) return params;
      const out = {};
      for (const [key, value] of Object.entries(params)) {
        out[key] = typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
      }
      return out;
    },
    [locale],
  );

  /**
   * Translate. Falls back `selected language → English → the key itself`, so a
   * missing Russian string shows English rather than a raw key, and a genuinely
   * absent key is visible during development instead of rendering as blank.
   */
  const t = useCallback(
    (key, params) => {
      const value = lookup(dictionary, key) ?? lookup(fallback, key);
      if (typeof value !== 'string') {
        if (value !== undefined) return key; // caller used t() on a plural entry
        return key;
      }
      if (!params) return value;
      return value.replace(/\{(\w+)\}/g, (match, name) => {
        if (!(name in params)) return match;
        const formatted = formatParams({ [name]: params[name] });
        return String(formatted[name]);
      });
    },
    [dictionary, fallback, formatParams],
  );

  /**
   * Translate with a count, choosing the plural category the language actually
   * uses. `key` must resolve to an object of categories.
   */
  const tn = useCallback(
    (count, key, params) => {
      const entry = lookup(dictionary, key) ?? lookup(fallback, key);
      const merged = { count, ...formatParams(params) };
      if (typeof entry === 'string') {
        // A language that does not distinguish this plural form: interpolate directly.
        return entry.replace(/\{(\w+)\}/g, (match, name) => (name in merged ? String(merged[name]) : match));
      }
      if (!entry || typeof entry !== 'object') return key;
      const category = new Intl.PluralRules(locale).select(Number(count) || 0);
      const template = entry[category] ?? entry.other ?? lookup(fallback, key)?.[category] ?? lookup(fallback, key)?.other;
      if (typeof template !== 'string') return key;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in merged ? String(merged[name]) : match));
    },
    [dictionary, fallback, locale, formatParams],
  );

  const setLang = useCallback(
    (code, { persist = true } = {}) => {
      if (!isSupportedLanguage(code)) return;
      const next = code.toLowerCase();
      setLangState(next);
      writeStoredLanguage(next);
      if (persist) persistRef.current?.(next);
    },
    [],
  );

  /**
   * Adopt the language stored on the signed-in account. Called by the app shell
   * once `/me` resolves. The account wins over the local guess (a teacher who set
   * Russian on their laptop expects it on the classroom desktop too), but only the
   * first time per account, so a local change made in this session is not undone.
   */
  const applyAccountLanguage = useCallback(
    (userId, accountLanguage) => {
      const key = userId ?? 'anonymous';
      if (appliedAccountRef.current === key) return;
      appliedAccountRef.current = key;
      if (isSupportedLanguage(accountLanguage)) {
        const next = accountLanguage.toLowerCase();
        setLangState(next);
        writeStoredLanguage(next);
      }
    },
    [],
  );

  const value = useMemo(
    () => ({
      lang,
      locale,
      ready,
      languages: LANGUAGES,
      language: languageEntry(lang),
      isRtl: false,
      t,
      tn,
      setLang,
      applyAccountLanguage,
    }),
    [lang, locale, ready, t, tn, setLang, applyAccountLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

/** Convenience for components that only translate. */
export function useT() {
  return useI18n().t;
}
