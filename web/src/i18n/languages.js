/**
 * Supported languages.
 *
 * Adding a language is two edits: an entry here, and a dictionary file. Nothing
 * else in the app branches on language — every surface reads its strings through
 * `useI18n()`, so a new language needs no component changes.
 *
 * `intlLocale` drives dates and numbers through `Intl`, which is why it is kept
 * separate from the UI code: a school may want Russian labels with a regional
 * date format (ru-RU, ru-KZ, …) without translating anything again.
 */
export const LANGUAGES = Object.freeze([
  {
    code: 'en',
    /** Shown in the switcher in the language itself — never translated. */
    endonym: 'English',
    intlLocale: 'en-GB',
  },
  {
    code: 'ru',
    endonym: 'Русский',
    intlLocale: 'ru-RU',
  },
]);

export const DEFAULT_LANGUAGE = 'en';

const BY_CODE = new Map(LANGUAGES.map((entry) => [entry.code, entry]));

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((entry) => entry.code));

export function isSupportedLanguage(code) {
  return BY_CODE.has(String(code ?? '').toLowerCase());
}

export function languageEntry(code) {
  return BY_CODE.get(String(code ?? '').toLowerCase()) ?? BY_CODE.get(DEFAULT_LANGUAGE);
}

export function intlLocale(code) {
  return languageEntry(code).intlLocale;
}

/**
 * Best match for a browser preference such as `ru-RU` or `en-US,en;q=0.9`.
 * Falls back to the default rather than guessing.
 */
export function matchLanguage(candidate) {
  const raw = String(candidate ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (BY_CODE.has(raw)) return raw;
  const base = raw.split(/[-_,;]/)[0];
  return BY_CODE.has(base) ? base : null;
}
