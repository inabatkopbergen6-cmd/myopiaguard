import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { XIcon } from '../lib/icons.jsx';
import { SEAT_STATUS, adherenceClass, pct } from '../lib/format.js';

/** Shared presentational pieces. Small, purposeful, and used by every page. */

export function Badge({ tone = 'neutral', children, dot = true, className = '' }) {
  return (
    <span className={`badge badge--${tone} ${className}`.trim()}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

export function SeatStatusBadge({ status }) {
  const { t } = useI18n();
  const meta = SEAT_STATUS[status] ?? SEAT_STATUS.offline;
  return (
    <Badge tone={meta.tone} title={t(meta.descKey)}>
      {t(meta.key)}
    </Badge>
  );
}

export function Card({ title, subtitle, actions, children, flush = false, className = '', id }) {
  return (
    <section className={`card ${flush ? 'card--flush' : ''} ${className}`.trim()} id={id}>
      {(title || actions) && (
        <header className="card__header">
          <div className="stack stack--tight">
            {title && <h3>{title}</h3>}
            {subtitle && <p className="small muted">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'card__body'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, unit, foot, tone = 'default', children }) {
  return (
    <div className={`stat ${tone === 'attention' ? 'stat--attention' : ''}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {foot && <div className="stat__foot">{foot}</div>}
      {children}
    </div>
  );
}

export function Meter({ value, tone }) {
  const { t } = useI18n();
  const width = value === null || value === undefined ? 0 : Math.max(2, Math.min(100, Number(value)));
  const cls = tone ?? adherenceClass(value);
  return (
    <div className="meter" role="img" aria-label={t('board.adherenceAria', { value: pct(value) })}>
      <div className={`meter__fill ${cls}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="attention-empty">
      <div className="stack stack--tight">
        <strong style={{ fontSize: '0.9rem', color: 'var(--ink-700)' }}>{title}</strong>
        {children && <span>{children}</span>}
        {action}
      </div>
    </div>
  );
}

export function Spinner({ label }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 10, color: 'var(--ink-500)', fontSize: '0.85rem' }}>
      <span className="spinner" aria-hidden />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function Callout({ tone = 'default', icon = null, children, className = '' }) {
  return (
    <div className={`callout ${tone !== 'default' ? `callout--${tone}` : ''} ${className}`.trim()}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

/** Accessible modal: focus goes in, Escape closes, the backdrop is clickable. */
export function Modal({ title, subtitle, onClose, children, footer, wide = false, labelledBy }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const headingId = useId();

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const timer = setTimeout(() => ref.current?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? headingId}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal__head">
          <div className="stack stack--tight">
            <h2 id={headingId}>{title}</h2>
            {subtitle && <p className="small muted">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label={t('common.close')}>
            <XIcon />
          </button>
        </div>
        {children}
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children }) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer__head">
          <div className="stack stack--tight">
            <h2>{title}</h2>
            {subtitle && <p className="small muted">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label={t('common.close')}>
            <XIcon />
          </button>
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </div>
  );
}

export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Inline error banner used by every form and mutation.
 *
 * The message comes from the error's dictionary key, so an error raised while the
 * interface is in Russian is shown in Russian. The server's own English `reason`
 * is only used when there is no key for the code.
 */
export function ErrorNote({ error, onRetry }) {
  const { t } = useI18n();
  if (!error) return null;
  const key = error.messageKey;
  const message = key
    ? t(key)
    : (error.detail?.reason ?? error.message ?? String(error));
  return (
    <div className="callout callout--danger">
      <div className="grow">
        <strong style={{ display: 'block', fontSize: '0.85rem' }}>{t('errors.title')}</strong>
        <span className="small">{message}</span>
      </div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** Toast stack for the session-warning system (deliverable 3). */
export function ToastRegion({ toasts, onDismiss }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toast-region" role="region" aria-live="polite" aria-label={t('warning.regionLabel')}>
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone ?? 'info'}`}>
          {toast.icon && <span className="toast__icon">{toast.icon}</span>}
          <div className="toast__body grow">
            <span className="toast__title">{toast.title}</span>
            {toast.text && <span className="toast__text">{toast.text}</span>}
            {toast.expiresAt && (
              <span className="tiny muted">
                {t('warning.dismissesIn', { seconds: Math.max(0, Math.ceil((toast.expiresAt - now) / 1000)) })}
              </span>
            )}
          </div>
          <button type="button" className="toast__dismiss" onClick={() => onDismiss(toast.id)} aria-label={t('common.dismiss')}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function DefinitionList({ items }) {
  return (
    <dl className="kv">
      {items.filter(Boolean).map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
