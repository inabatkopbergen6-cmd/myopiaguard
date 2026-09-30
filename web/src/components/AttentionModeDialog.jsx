import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Badge, Callout, ErrorNote, Modal } from './ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { MegaphoneIcon, ShieldIcon } from '../lib/icons.jsx';
import { dateTime } from '../lib/format.js';

/**
 * Attention Mode composer (deliverable 6).
 *
 * The teacher writes a short instruction, picks how long it stays up, and sends it
 * to every screen in the room. The dialog keeps the boundary visible in three
 * places: the capability line, the overlay preview (which is the same component
 * the classroom PC renders), and the plain sentence that this cannot lock a
 * keyboard, capture a screen or block an application.
 *
 * Default message: "Teacher Attention — Please look at the board."
 */

const QUICK_MESSAGE_KEYS = [
  'attention.defaultMessage',
  'attention.quick1',
  'attention.quick2',
  'attention.quick3',
  'attention.quick4',
];

export default function AttentionModeDialog({ classroomId, activeBroadcast, onClose, onSent, onCleared }) {
  const { t, tn } = useI18n();
  const defaultMessage = t('attention.defaultMessage');
  const [message, setMessage] = useState(defaultMessage);
  const [durationSec, setDurationSec] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [lastSent, setLastSent] = useState(null);
  const [durations, setDurations] = useState([10, 20, 30, 45, 60, 120]);

  useEffect(() => {
    api
      .attention(classroomId)
      .then((data) => {
        setDurations(data.durations ?? [10, 20, 30, 45, 60, 120]);
      })
      .catch(() => {
        /* the dialog still works with the built-in defaults */
      });
  }, [classroomId]);

  // If the interface language changes while the dialog is open and the message is
  // still the untouched default, follow the language rather than leaving a stale
  // English sentence in the box.
  useEffect(() => {
    setMessage((current) =>
      QUICK_MESSAGE_KEYS.some((key) => t(key) === current) ? defaultMessage : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultMessage]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.broadcast(classroomId, { message, durationSec });
      setLastSent(result.broadcast);
      onSent?.(result.broadcast);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await api.clearAttention(classroomId);
      setLastSent(null);
      onCleared?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const live = lastSent ?? activeBroadcast;

  return (
    <Modal
      title={t('attention.dialogTitle')}
      subtitle={t('attention.dialogSubtitle')}
      onClose={onClose}
      footer={
        <>
          {live && (
            <button type="button" className="btn btn--danger" onClick={clear} disabled={busy}>
              {t('attention.clearAll')}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn--attention" onClick={send} disabled={busy || !message.trim()}>
            <MegaphoneIcon size={15} />
            {busy ? t('attention.sending') : live ? t('attention.sendAgain') : t('attention.send')}
          </button>
        </>
      }
    >
      {error && <ErrorNote error={error} />}

      {live && (
        <Callout tone="warn" icon={<MegaphoneIcon size={16} />}>
          <strong style={{ display: 'block', fontSize: '0.85rem' }}>{t('attention.onScreenNow')}</strong>
          <span className="small">
            {t('attention.onScreenMeta', {
              message: live.message,
              screens: tn(live.deliveredCount, 'attention.screens'),
              seconds: live.secondsRemaining,
            })}
          </span>
        </Callout>
      )}

      <div className="attention-composer">
        <div className="field">
          <label htmlFor="attention-message">{t('attention.messageLabel')}</label>
          <textarea
            id="attention-message"
            className="textarea"
            value={message}
            maxLength={160}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={defaultMessage}
          />
          <span className="field__hint">{t('attention.messageHint', { used: message.length, max: 160 })}</span>
        </div>

        <div className="chip-row">
          {QUICK_MESSAGE_KEYS.map((key) => t(key))
            .filter((quick) => quick !== message)
            .map((quick) => (
              <button key={quick} type="button" className="chip" onClick={() => setMessage(quick)}>
                {/* Truncation by character count is fine for Latin scripts and cuts
                    Russian mid-word, so the chip keeps the full sentence and the
                    container wraps instead. */}
                {quick}
              </button>
            ))}
        </div>

        <div className="field">
          <label>{t('attention.clearsAfter')}</label>
          <div className="chip-row">
            {durations.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className="chip"
                aria-pressed={durationSec === seconds}
                onClick={() => setDurationSec(seconds)}
              >
                {seconds < 60
                  ? t('attention.durationSeconds', { seconds })
                  : t('attention.durationMinutes', { minutes: seconds / 60 })}
              </button>
            ))}
          </div>
          <span className="field__hint">{t('attention.clearsAfterHint')}</span>
        </div>

        <div className="field">
          <label>{t('attention.previewLabel')}</label>
          <div
            className="takeover takeover--attention"
            style={{ position: 'static', borderRadius: 'var(--r-lg)', minHeight: 190, padding: 22 }}
          >
            <div className="takeover__inner" style={{ gap: 14 }}>
              <span className="attention-badge">
                <ShieldIcon size={13} />
                {t('attention.badge')}
              </span>
              <p className="attention-message" style={{ fontSize: '1.5rem' }}>
                {message || defaultMessage}
              </p>
              <span className="takeover__hint">{t('attention.previewClearsIn', { seconds: durationSec })}</span>
            </div>
          </div>
        </div>

        <Callout tone="privacy" icon={<ShieldIcon size={16} />}>
          <strong style={{ display: 'block', fontSize: '0.83rem' }}>{t('attention.scopeTitle')}</strong>
          <span className="small">{t('attention.scopeBody')}</span>
        </Callout>

        {lastSent && (
          <p className="small muted">{t('attention.sentAt', { time: dateTime(lastSent.createdAt) })}</p>
        )}

        <div className="row">
          <Badge tone="neutral" dot={false}>
            {t('attention.capabilityInputLock')}
          </Badge>
          <Badge tone="neutral" dot={false}>
            {t('attention.capabilityScreenCapture')}
          </Badge>
          <Badge tone="neutral" dot={false}>
            {t('attention.capabilityAppBlocking')}
          </Badge>
        </div>
      </div>
    </Modal>
  );
}
