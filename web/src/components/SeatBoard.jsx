import { useI18n } from '../i18n/index.jsx';
import { Meter, SeatStatusBadge } from './ui.jsx';
import { attentionFlagDetail, attentionFlagLabel, attentionHeadline } from '../lib/attentionText.js';
import { countdown, duration, pct, relativeTime } from '../lib/format.js';

/**
 * A seat on the board.
 *
 * Identity: the label is a machine ("PC-01"). There is no room in this component
 * for a person's name, by design — see docs/PRIVACY.md.
 *
 * The tile answers three questions in one glance: is this PC working, is its break
 * routine holding, and does it need me? Everything else is in the detail drawer.
 */
export function SeatTile({ seat, now, selected, onSelect }) {
  const { t, tn } = useI18n();
  const status = seat.status;
  const stretch = seat.session?.stretchSeconds ?? 0;
  const flags = seat.flags ?? [];
  const critical = flags.some((flag) => flag.severity === 'high') || seat.longStretch;
  const missedToday = seat.counters.today.missed + seat.counters.today.skipped;

  const classes = ['seat', `seat--${status}`, selected ? 'seat--selected' : '', critical ? 'seat--flagged' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(seat.seatId)}
      aria-pressed={selected}
      aria-label={t('seat.tileAria', {
        seat: seat.label,
        status: t(`status.${status}`),
        adherence: pct(seat.adherencePct),
      })}
    >
      {/* Keyed on status: React remounts this element only when the status actually
          changes, so the ripple marks a real transition rather than every render. */}
      <span key={status} className="seat__ripple" aria-hidden="true" />

      <div className="seat__head">
        <span className="seat__label">{seat.label}</span>
        <SeatStatusBadge status={status} />
      </div>

      <div className="stack stack--tight" style={{ gap: 5 }}>
        <div className="row row--between" style={{ fontSize: '0.78rem' }}>
          <span className="muted">{t('seat.adherenceLabel')}</span>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{pct(seat.adherencePct)}</strong>
        </div>
        <Meter value={seat.adherencePct} />
      </div>

      <div className="seat__stretch">
        <span>
          {status === 'on_break' ? (
            <span style={{ color: 'var(--break-600)', fontWeight: 600 }}>{t('seat.onDistanceBreak')}</span>
          ) : status === 'offline' ? (
            t('seat.lastSeen', { time: relativeTime(seat.lastSeenAt, now) })
          ) : (
            <>
              {stretch > 0 ? t('seat.workingFor', { duration: duration(stretch) }) : t('seat.idle')}
              {seat.longStretch && <span className="seat__stretch-warn">{t('seat.longStretchSuffix')}</span>}
            </>
          )}
        </span>
      </div>

      <div className="seat__foot">
        <span>
          {seat.nextBreakAt !== null ? (
            <>
              {t('seat.nextBreakIn', { when: countdown(seat.secondsToNextBreak) })}
            </>
          ) : seat.currentBreak?.status === 'in_progress' ? (
            t('seat.breakInProgress')
          ) : (
            t('seat.noBreakScheduled')
          )}
        </span>
        <span title={t('seat.missedTooltip')}>
          {missedToday > 0 ? tn(missedToday, 'seat.missedCount') : t('seat.onTrack')}
        </span>
      </div>

      {flags.length > 0 && (
        <div className="seat__flags">
          {flags.slice(0, 2).map((flag) => (
            <span key={flag.code} className={`flag-chip ${flag.severity === 'high' ? '' : 'flag-chip--danger'}`}>
              {attentionFlagLabel(t, flag)}
            </span>
          ))}
          {flags.length > 2 && <span className="flag-chip">+{flags.length - 2}</span>}
        </div>
      )}
    </button>
  );
}

/** The same seat as a table row, for teachers who prefer a list. */
export function SeatRow({ seat, now, selected, onSelect }) {
  const { t, tn } = useI18n();
  const stretch = seat.session?.stretchSeconds ?? 0;
  const missedToday = seat.counters.today.missed + seat.counters.today.skipped;

  return (
    <button
      type="button"
      className={`seat-row ${selected ? 'seat-row--selected' : ''}`}
      onClick={() => onSelect(seat.seatId)}
      aria-pressed={selected}
    >
      <span className="seat-row__label">{seat.label}</span>
      <SeatStatusBadge status={seat.status} />
      <span className="row" style={{ gap: 12, minWidth: 0 }}>
        <span style={{ width: 120 }}>
          <Meter value={seat.adherencePct} />
        </span>
        <span className="mono small">{pct(seat.adherencePct)}</span>
        <span className="small muted nowrap">
          {seat.status === 'on_break'
            ? t('status.on_break')
            : seat.status === 'offline'
              ? t('seat.lastSeen', { time: relativeTime(seat.lastSeenAt, now) })
              : stretch > 0
                ? t('seat.workingFor', { duration: duration(stretch) })
                : t('seat.idle')}
        </span>
      </span>
      <span className="small muted nowrap">
        {seat.nextBreakAt !== null ? countdown(seat.secondsToNextBreak) : '—'}
      </span>
      <span className="small nowrap">{tn(missedToday, 'seat.missedCount')}</span>
      <span className="seat-row__flags">
        {(seat.flags ?? []).slice(0, 2).map((flag) => (
          <span key={flag.code} className="flag-chip">
            {attentionFlagLabel(t, flag)}
          </span>
        ))}
      </span>
    </button>
  );
}

/**
 * Attention Needed panel (deliverable 1).
 *
 * Lists only seats that have earned a place: two breaks missed in a row, an
 * unusually long uninterrupted session, or a PC that dropped off. Sorted by
 * severity, so the top of the list is always the most useful thing to do next.
 */
export function AttentionPanel({ attention, now, onSelect, activeBroadcast }) {
  const { t, tn } = useI18n();
  const high = attention.filter((item) => item.severity === 'high');

  return (
    <div className="attention-panel" aria-live="polite">
      {activeBroadcast && (
        <div className="callout callout--warn">
          <div className="grow">
            <strong style={{ display: 'block', fontSize: '0.85rem' }}>{t('seat.attentionLive')}</strong>
            <span className="small">
              {t('seat.attentionLiveMeta', {
                message: activeBroadcast.message,
                screens: tn(activeBroadcast.deliveredCount, 'seat.screens'),
                seconds: activeBroadcast.secondsRemaining,
              })}
            </span>
          </div>
        </div>
      )}

      {attention.length === 0 ? (
        <div className="attention-empty">
          <div className="stack stack--tight">
            <strong style={{ color: 'var(--ink-700)' }}>{t('seat.nothingNeeded')}</strong>
            <span>{t('seat.nothingNeededBody')}</span>
          </div>
        </div>
      ) : (
        <>
          <p className="small muted">
            {tn(attention.length, 'seat.flaggedSummary')}
            {high.length > 0 ? t('seat.flaggedHigh', { count: high.length }) : ''}
          </p>
          {attention.map((item) => (
            <button
              key={item.seatId}
              type="button"
              className={`attention-item attention-item--${item.severity}`}
              onClick={() => onSelect(item.seatId)}
            >
              <span className="attention-item__head">
                <span className="attention-item__seat">{item.label}</span>
                <SeatStatusBadge status={item.status} />
              </span>
              <span className="attention-item__headline">{attentionHeadline(t, item)}</span>
              <span className="attention-item__detail grow">
                {/* Composed from the flag's own params, not the server's English sentence. */}
                {attentionFlagDetail(t, tn, item.flags?.[0]) || t('attentionFlag.needsCheckIn')}
              </span>
              <span className="row row--between tiny muted">
                <span>
                  {t('seat.todayCounters', {
                    completed: item.counters.completed,
                    missed: item.counters.missed,
                    skipped: item.counters.skipped,
                  })}
                </span>
                <span className="mono">{pct(item.adherencePct)}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
