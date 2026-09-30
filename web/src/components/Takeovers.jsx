import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { ShieldIcon } from '../lib/icons.jsx';

/**
 * Full-screen break challenge (deliverable 2) — the "window".
 *
 * The brief: it should feel like looking through a window, not like a fitness-app
 * timer. So there is no ring. There is a sky, a sun that sets across the break, a
 * horizon, and a light-line along that horizon which *is* the progress indicator.
 * The countdown is the only number, and it is set in the display serif so the
 * student screen carries the same voice as the rest of the product.
 *
 * Constraints kept from the previous build — these were correctness fixes, not
 * decoration:
 *   - It cannot be dismissed by accident. No close button; Escape asks first; the
 *     only exit is an explicit two-step skip recorded as Skipped/Incomplete.
 *   - The countdown is computed from the server's `startedAt`, so a reload or a slow
 *     tick cannot shorten the break.
 *   - One value drives every encoding. `remainingFraction` positions the sun, sets
 *     the horizon light and prints the numeral, so they cannot disagree. The horizon
 *     carries real `progressbar` values, and the numeral is announced at intervals
 *     rather than every second.
 */
export default function BreakChallenge({
  durationSec = 20,
  instruction,
  instructionKey,
  startedAt,
  longStretch = false,
  seatLabel,
  onComplete,
  onSkip,
  busy = false,
  error = null,
  /** `student` on a classroom PC; `preview` when a teacher is demonstrating it. */
  variant = 'student',
}) {
  const { t, tn } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [confirmSkip, setConfirmSkip] = useState(false);
  const completedRef = useRef(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  // Take focus when the challenge appears. Without this a keyboard user is still
  // "outside" the dialog: Escape would not reach it, and a screen reader would keep
  // reading the page underneath.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  const total = Math.max(1, Number(durationSec) || 20);
  const elapsed = Math.max(0, (now - Number(startedAt ?? now)) / 1000);
  const remaining = Math.max(0, total - elapsed);
  const secondsLeft = Math.ceil(remaining);
  /** The single value behind the sun, the horizon light and the numeral. */
  const remainingFraction = Math.min(1, remaining / total);
  const elapsedFraction = 1 - remainingFraction;

  useEffect(() => {
    if (remaining <= 0 && !completedRef.current && !busy) {
      completedRef.current = true;
      onComplete?.();
    }
  }, [remaining, busy, onComplete]);

  // Escape asks before it does anything: a break should never end by reflex.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfirmSkip(true);
      }
    };
    const node = containerRef.current;
    node?.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  /**
   * The sun's path across the sky. It begins high and slightly left of centre and
   * sets to the right, so the movement reads both as a real sunset arc and as
   * progress. The trail is the same function sampled backwards, which is why the
   * dots line up with the disc exactly rather than approximately.
   */
  const sunPath = useMemo(() => {
    const at = (fraction) => ({ x: 46 + 16 * fraction, y: 25 + 33 * fraction });
    return { at, current: at(elapsedFraction) };
  }, [elapsedFraction]);

  const trail = useMemo(
    () =>
      [1, 2, 3, 4, 5].map((step) => {
        const fraction = Math.max(0, elapsedFraction - step * 0.035);
        const point = sunPath.at(fraction);
        return { ...point, opacity: Math.max(0, 0.32 - step * 0.055), size: Math.max(3, 11 - step * 1.8) };
      }),
    [elapsedFraction, sunPath],
  );

  /**
   * The instruction is chosen server-side and arrives with a stable key plus its
   * English text. We prefer the key so a translated break screen never falls back to
   * English mid-sentence, and use the server text only for a key we do not know.
   */
  const instructionText = useMemo(() => {
    const key = instruction?.key ?? instructionKey;
    if (key) {
      const candidate = t(`instructions.${key}`);
      if (candidate !== `instructions.${key}`) return candidate;
    }
    return instruction?.text ?? t('instructions.farthest-object');
  }, [instruction, instructionKey, t]);

  const isPreview = variant === 'preview';

  return (
    <div
      className="window"
      role="dialog"
      aria-modal="true"
      aria-label={t('break.dialogLabel')}
      ref={containerRef}
      tabIndex={-1}
      style={{ '--remaining': remainingFraction }}
    >
      <div className="window__sky" />

      {/* Thin receding bands: the landscape going away from the viewer. */}
      <div className="window__bands" aria-hidden="true">
        {[38, 46, 53, 59, 63].map((top, index) => (
          <span key={top} className="window__band" style={{ top: `${top}%`, opacity: 0.45 + index * 0.13 }} />
        ))}
      </div>

      <div className="window__haze" aria-hidden="true" />
      <div className="window__land" aria-hidden="true" />

      <div className="window__trail" aria-hidden="true">
        {trail.map((dot) => (
          <span
            key={`${dot.x.toFixed(2)}-${dot.y.toFixed(2)}`}
            className="window__trail-dot"
            style={{
              left: `${dot.x}%`,
              top: `${dot.y}%`,
              width: dot.size,
              height: dot.size,
              opacity: dot.opacity,
            }}
          />
        ))}
      </div>

      <div className="window__sun" aria-hidden="true" style={{ left: `${sunPath.current.x}%`, top: `${sunPath.current.y}%` }} />

      <div className="window__inner">
        <div className="window__head">
          <span className="window__eyebrow">{tn(total, 'break.eyebrowCount')}</span>
          {seatLabel && <span className="window__eyebrow window__eyebrow--seat">{seatLabel}</span>}
        </div>

        <h1 className="window__instruction">{instructionText}</h1>

        <div className="window__count" aria-hidden="true">
          {secondsLeft > 0 ? secondsLeft : '✓'}
        </div>
        <div className="window__count-label">{t('break.secondsLabel')}</div>

        {/* Announced at intervals, not every second, so a screen reader is not
            flooded with twenty announcements during one break. */}
        <span className="sr-only" role="timer" aria-live="polite">
          {[10, 5, 4, 3, 2, 1].includes(secondsLeft) ? tn(secondsLeft, 'break.countdownAnnounce') : ''}
        </span>

        {longStretch && <p className="window__hint window__hint--warm">{t('break.longStretch')}</p>}
        {error && <p className="window__hint window__hint--error">{error}</p>}
        <p className="window__hint">{t('break.hint')}</p>
      </div>

      {/* The horizon *is* the progress indicator: the lit portion is the time left. */}
      <div className="window__horizon">
        <div
          className="window__horizon-line"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={secondsLeft}
          aria-label={t('break.remainingOf', { remaining: secondsLeft, total })}
        >
          <div className="window__horizon-fill" style={{ width: `${remainingFraction * 100}%` }} />
        </div>
        <span className="window__horizon-caption">
          {t('break.remainingOf', { remaining: secondsLeft, total })}
        </span>
      </div>

      {/*
        The exit lives at the bottom edge, muted and small, so it is never the thing
        a student's eye lands on. Previewing from the dashboard gets a plain close
        button instead: the student-facing affordance should not appear in a demo.
      */}
      <footer className="window__footer">
        {isPreview ? (
          <button type="button" className="window__footer-button" onClick={() => onSkip?.('teacher_preview')}>
            {t('break.skipPreview')}
          </button>
        ) : confirmSkip ? (
          <div className="window__confirm">
            <span className="window__confirm-text">{t('break.skipPrompt')}</span>
            <button type="button" className="window__footer-button" onClick={() => setConfirmSkip(false)}>
              {t('break.skipKeepGoing')}
            </button>
            <button
              type="button"
              className="window__footer-button window__footer-button--confirm"
              onClick={() => onSkip?.('student_dismissed')}
              disabled={busy}
            >
              {t('break.skipConfirm')}
            </button>
          </div>
        ) : (
          <div className="window__skip-group">
            <button type="button" className="window__footer-button" onClick={() => setConfirmSkip(true)}>
              {t('break.skipRequest')}
            </button>
            <span className="window__skip-note">{t('break.skipNote')}</span>
          </div>
        )}
      </footer>
    </div>
  );
}

/**
 * Attention Mode overlay (deliverable 6), as seen on a classroom PC.
 *
 * A *message*, not a takeover of the machine: dismissible, holding no input, and
 * stating the capability boundary so a student can see it too. The sky is daylight
 * rather than dusk, so this moment is visually distinct from a break.
 */
export function AttentionTakeover({ broadcast, secondsRemaining, onDismiss, canDismiss = false }) {
  const { t } = useI18n();
  return (
    <div
      className="window window--attention"
      role="alertdialog"
      aria-modal="false"
      aria-label={t('attention.takeoverLabel')}
    >
      <div className="window__inner">
        <span className="attention-badge">
          <ShieldIcon size={14} />
          {t('attention.badge')}
        </span>

        <p className="attention-message">{broadcast.message}</p>

        <div className="stack stack--tight" style={{ alignItems: 'center', gap: 7 }}>
          <span className="window__hint">
            {secondsRemaining > 0
              ? t('attention.clearsItselfIn', { seconds: secondsRemaining })
              : t('attention.clearingNow')}
          </span>
          <span className="window__hint" style={{ opacity: 0.85 }}>{t('attention.takeoverReassurance')}</span>
        </div>

        {canDismiss && (
          <button type="button" className="window__footer-button" onClick={onDismiss}>
            {t('common.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
