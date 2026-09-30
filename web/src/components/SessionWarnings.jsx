import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { BellIcon, ClockIcon } from '../lib/icons.jsx';

/**
 * Session limit warnings (deliverable 3).
 *
 * Two layers, on purpose:
 *   - a **banner** that stays up while a warning is in force, so a student who
 *     looked away for a moment still sees that a break is coming;
 *   - a **toast** that appears once and fades, so the notice is noticed at the
 *     moment it becomes true.
 *
 * Neither interrupts anything: no modal, no focus steal, no sound. That is the
 * whole point of the pre-break warning — the interruption only happens at T-0.
 */

export function useSessionNotices() {
  const [toasts, setToasts] = useState([]);
  const [banner, setBanner] = useState(null);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback((notice) => {
    const id = notice.id ?? `notice_${Math.random().toString(36).slice(2, 9)}`;
    setToasts((prev) => [...prev.filter((toast) => toast.id !== id), { ...notice, id }]);
    if (notice.ttlMs) {
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
        timers.current.delete(id);
      }, notice.ttlMs);
      timers.current.set(id, timer);
    }
    return id;
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const clearAll = useCallback(() => {
    setToasts([]);
    setBanner(null);
  }, []);

  return { toasts, banner, setBanner, notify, dismiss, clearAll };
}

/**
 * Human wording for a countdown warning, driven by the lead the server used.
 *
 * The lead is expressed as a plural-aware phrase (1 минута / 2 минуты / 5 минут),
 * which is why the two counts are separate dictionary entries chosen by `tn`
 * rather than a suffix appended in code.
 */
export function useWarningCopy() {
  const { t, tn } = useI18n();
  return useCallback(
    (kind, leadSeconds, dueInSeconds) => {
      const minutes = Math.max(1, Math.round(leadSeconds / 60));
      const lead =
        leadSeconds >= 120
          ? tn(minutes, 'warning.minutesCount')
          : leadSeconds >= 60
            ? tn(1, 'warning.minutesCount')
            : tn(Math.max(1, leadSeconds), 'warning.secondsCount');

      if (kind === 't5') {
        return {
          title: t('warning.minutesUntilBreak', { minutes: lead }),
          text: t('warning.wrapUp'),
          tone: 'info',
        };
      }
      return {
        title: t('warning.secondsUntilBreak', { seconds: lead }),
        text: dueInSeconds <= 20 ? t('warning.aboutToTakeOver') : t('warning.saveNow'),
        tone: 'warn',
      };
    },
    [t, tn],
  );
}

/**
 * The sticky banner. Shows the *current* warning until the break starts, plus a
 * quiet always-on countdown to the next break so the rhythm is predictable rather
 * than surprising.
 */
export function SessionWarningBanner({ warning, nextBreakIn, onDismiss }) {
  const { t, tn } = useI18n();
  if (!warning && nextBreakIn === null) return null;

  if (warning) {
    return (
      <div className={`banner banner--${warning.kind === 't1' ? 'warn' : 'info'}`} role="status">
        <BellIcon size={17} />
        <div className="grow">
          <strong>{warning.title}</strong>
          <span className="small">{warning.text}</span>
        </div>
        {onDismiss && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={onDismiss}>
            {t('warning.gotIt')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="banner banner--quiet" role="status">
      <ClockIcon size={16} />
      <div className="grow">
        <span>{t('warning.nextBreakIn', { seconds: tn(nextBreakIn.seconds, 'warning.nextBreakInCount') })}</span>
        <span className="small muted">
          {t('warning.warningCadence', {
            five: tn(5, 'warning.minutesCount'),
            one: tn(1, 'warning.minutesCount'),
          })}
        </span>
      </div>
    </div>
  );
}
