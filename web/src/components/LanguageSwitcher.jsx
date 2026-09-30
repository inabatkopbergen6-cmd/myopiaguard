import { useI18n } from '../i18n/index.jsx';
import { GlobeIcon } from '../lib/icons.jsx';

/**
 * Language switcher.
 *
 * A native `<select>` rather than a custom dropdown: it is keyboard-accessible,
 * screen-reader-announced and mobile-friendly with no work, and a language picker
 * is exactly the kind of low-frequency control that does not deserve bespoke
 * interaction. The globe icon marks it without needing a text label.
 *
 * Language names appear in their own language ("English", "Русский") and are never
 * translated — a reader looking for their language needs to recognise it, and
 * "Немецкий" does not help someone looking for "Deutsch".
 */
export default function LanguageSwitcher({ compact = false, className = '' }) {
  const { lang, languages, setLang, t } = useI18n();

  return (
    <label className={`lang-switch ${compact ? 'lang-switch--compact' : ''} ${className}`.trim()}>
      <span className="lang-switch__icon" aria-hidden="true">
        <GlobeIcon size={15} />
      </span>
      <span className="sr-only">{t('nav.language')}</span>
      <select
        className="lang-switch__select"
        value={lang}
        onChange={(event) => setLang(event.target.value)}
        title={t('nav.languageTitle')}
      >
        {languages.map((entry) => (
          <option key={entry.code} value={entry.code} lang={entry.code}>
            {entry.endonym}
          </option>
        ))}
      </select>
    </label>
  );
}
