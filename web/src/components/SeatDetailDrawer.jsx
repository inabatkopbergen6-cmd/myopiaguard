import { api } from '../api/client.js';
import { useResource } from '../api/hooks.js';
import { Badge, Callout, DefinitionList, Drawer, ErrorNote, Meter, Spinner } from './ui.jsx';
import { SeatStatusBadge } from './ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { attentionFlagDetail, attentionFlagLabel } from '../lib/attentionText.js';
import { BREAK_STATUS, clockTime, dateTime, duration, pct, relativeTime, weekdayShort } from '../lib/format.js';
import { AlertIcon, ShieldIcon } from '../lib/icons.jsx';

/**
 * Seat detail card (deliverable 1: "clicking a seat expands a small detail card
 * (session length, last break time, adherence trend) — still no PII").
 *
 * Everything here is derived from break events and heartbeats for one machine. The
 * panel says so out loud at the bottom, because the reassurance is part of the
 * product: a teacher should never wonder whether the tool is watching a child.
 */
export default function SeatDetailDrawer({ seatId, liveSeat, onClose, now }) {
  const { t, tn } = useI18n();
  const detail = useResource(() => api.seatDetail(seatId), [seatId], { enabled: Boolean(seatId) });

  const seat = detail.data;
  const view = liveSeat ?? null;

  return (
    <Drawer
      title={seat?.seat?.label ?? view?.label ?? t('drawer.fallbackTitle')}
      subtitle={seat ? `${seat.seat.gradeName} · ${seat.seat.classroomName}` : t('drawer.loadingSeat')}
      onClose={onClose}
    >
      {detail.loading && <Spinner label={t('drawer.loadingHistory')} />}
      {detail.error && <ErrorNote error={detail.error} onRetry={() => detail.reload()} />}

      {seat && (
        <>
          <section className="drawer__section">
            <div className="row row--between">
              <SeatStatusBadge status={view?.status ?? seat.status} />
              <span className="small muted">
                {view?.online
                  ? t('drawer.lastHeartbeat', { time: relativeTime(view.lastSeenAt, now) })
                  : t('drawer.noRecentHeartbeat')}
              </span>
            </div>
            <DefinitionList
              items={[
                { label: t('drawer.screenTimeSession'), value: duration(seat.session?.totalActiveSeconds ?? 0) },
                {
                  label: t('drawer.currentStretch'),
                  value: seat.session?.stretchSeconds ? duration(seat.session.stretchSeconds) : '—',
                },
                { label: t('drawer.sessionStarted'), value: clockTime(seat.session?.startedAt) },
                {
                  label: t('drawer.lastBreak'),
                  value: seat.session?.lastBreakAt ? clockTime(seat.session.lastBreakAt) : t('drawer.noneYet'),
                },
                {
                  label: t('drawer.nextBreak'),
                  value:
                    view?.nextBreakAt !== null && view?.nextBreakAt !== undefined
                      ? t('drawer.nextBreakValue', {
                          time: clockTime(view.nextBreakAt),
                          seconds: view.secondsToNextBreak,
                        })
                      : view?.currentBreak?.status === 'in_progress'
                        ? t('drawer.onScreenNow')
                        : t('drawer.notScheduled'),
                },
                { label: t('drawer.agentBuild'), value: seat.session?.agentVersion ?? t('drawer.unknown') },
              ]}
            />
          </section>

          {seat.flags?.length > 0 && (
            <section className="drawer__section">
              <h4>{t('drawer.needsAttention')}</h4>
              {seat.flags.map((flag) => (
                <Callout
                  key={flag.code}
                  tone={flag.severity === 'high' ? 'warn' : 'default'}
                  icon={<AlertIcon size={16} />}
                >
                  <strong style={{ display: 'block', fontSize: '0.85rem' }}>{attentionFlagLabel(t, flag)}</strong>
                  <span className="small">{attentionFlagDetail(t, tn, flag)}</span>
                </Callout>
              ))}
            </section>
          )}

          <section className="drawer__section">
            <h4>{t('drawer.adherenceSection')}</h4>
            <div className="row row--between">
              <span className="small muted">{t('drawer.today')}</span>
              <span className="row" style={{ gap: 10 }}>
                <span style={{ width: 130 }}>
                  <Meter value={seat.counters.today.adherencePct} />
                </span>
                <strong className="mono">{pct(seat.counters.today.adherencePct)}</strong>
              </span>
            </div>
            <div className="row row--between">
              <span className="small muted">{t('drawer.thisLesson')}</span>
              <span className="row" style={{ gap: 10 }}>
                <span style={{ width: 130 }}>
                  <Meter value={seat.counters.session.adherencePct} />
                </span>
                <strong className="mono">{pct(seat.counters.session.adherencePct)}</strong>
              </span>
            </div>
            <p className="tiny muted">
              {t('drawer.adherenceGlossary', {
                completed: seat.counters.today.completed,
                skipped: seat.counters.today.skipped,
                missed: seat.counters.today.missed,
              })}
            </p>
          </section>

          <section className="drawer__section">
            <h4>{t('drawer.trendTitle')}</h4>
            <div className="trend">
              {seat.trend.map((day) => {
                const height = day.adherencePct === null ? 3 : Math.max(6, Math.round((day.adherencePct / 100) * 56));
                const tone =
                  day.adherencePct === null
                    ? 'none'
                    : day.adherencePct >= 85
                      ? 'ok'
                      : day.adherencePct >= 70
                        ? 'warn'
                        : 'bad';
                return (
                  <div key={day.dayKey} className="trend__col">
                    <div
                      className={`trend__bar ${tone === 'none' ? 'trend__bar--none' : tone === 'ok' ? '' : `trend__bar--${tone}`}`}
                      style={{ height }}
                      title={t('drawer.trendBarTitle', {
                        day: day.dayKey,
                        adherence: pct(day.adherencePct),
                        count: day.resolved,
                      })}
                    />
                    {/* Weekday from the language's own list, not a 3-character slice
                        of an English abbreviation. */}
                    <span className="trend__label">{weekdayShort(day.start)}</span>
                  </div>
                );
              })}
            </div>
            <p className="tiny muted">
              {seat.trend[seat.trend.length - 1]?.resolved
                ? tn(seat.trend[seat.trend.length - 1].resolved, 'drawer.breaksResolvedToday')
                : t('drawer.noBreaksResolvedToday')}
            </p>
          </section>

          <section className="drawer__section">
            <h4>{t('drawer.recentBreaks')}</h4>
            {seat.recentBreaks.length === 0 ? (
              <p className="small muted">{t('drawer.noBreaksRecorded')}</p>
            ) : (
              <div className="break-log">
                {seat.recentBreaks.map((entry) => {
                  const meta = BREAK_STATUS[entry.status] ?? BREAK_STATUS.pending;
                  return (
                    <div key={entry.id} className={`break-log__row break-log__row--${entry.status}`}>
                      <span className="mono tiny">{clockTime(entry.dueAt)}</span>
                      <span className="stack stack--tight" style={{ gap: 2 }}>
                        <span className="status-word small">{t(meta.key)}</span>
                        <span className="tiny muted">
                          {entry.stretchSeconds
                            ? t('drawer.screenTimeBefore', { duration: duration(entry.stretchSeconds) })
                            : t('drawer.stretchNotRecorded')}
                          {entry.warned ? t('drawer.warned') : ''}
                        </span>
                      </span>
                      <span className="tiny muted nowrap">
                        {entry.completedAt
                          ? `${entry.durationSec}${t('units.secondsShort')}`
                          : entry.resolvedAt
                            ? relativeTime(entry.resolvedAt, now)
                            : t('drawer.waiting')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="drawer__section">
            <h4>{t('drawer.todaySessions')}</h4>
            {seat.todaySessions.length === 0 ? (
              <p className="small muted">{t('drawer.noSessionsToday')}</p>
            ) : (
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>{t('drawer.started')}</th>
                    <th>{t('drawer.ended')}</th>
                    <th className="num">{t('drawer.screenTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {seat.todaySessions.map((session) => (
                    <tr key={session.id}>
                      <td className="mono">{clockTime(session.startedAt)}</td>
                      <td className="mono">{session.endedAt ? clockTime(session.endedAt) : t('drawer.inProgress')}</td>
                      <td className="num">{duration(session.activeSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <Callout tone="privacy" icon={<ShieldIcon size={16} />}>
            <strong style={{ display: 'block', fontSize: '0.82rem' }}>{t('drawer.privacyTitle')}</strong>
            <span className="small">
              {t('drawer.privacyBody', {
                seat: seat.seat.label,
                updated: dateTime(detail.loadedAt),
              })}
            </span>
          </Callout>
        </>
      )}
    </Drawer>
  );
}

export { Badge };
