import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv } from '../api/client.js';
import { useLiveEvent, useResource } from '../api/hooks.js';
import { useClassroom } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Callout, Card, ErrorNote, Segmented, Spinner } from '../components/ui.jsx';
import { CheckIcon, ClockIcon, DownloadIcon, PrintIcon, ShieldIcon } from '../lib/icons.jsx';
import { adherenceTone, dateTime, duration, pct, shortDate, weekdayShort } from '../lib/format.js';

/**
 * Weekly classroom report (deliverable 4).
 *
 * The five headline metrics are defined server-side (services/reports.js) and
 * rendered here verbatim, so the table, the CSV and the printed page can never
 * disagree. The Mon–Fri chart shows both adherence and session volume, because
 * adherence alone hides whether a room was actually used.
 *
 * Export: CSV from the API; PDF via the browser's own print-to-PDF, using the
 * print stylesheet. That keeps the deployment dependency-free — no headless
 * Chromium on a school server.
 */
/** Maps a server metric `unit` value onto a dictionary key. */
function metricUnitKey(unit) {
  if (unit === 'sessions') return 'sessions';
  if (unit === 'breaks') return 'breaks';
  if (unit === 'stretches') return 'stretches';
  return 'minutesShort';
}

export default function WeeklyReportPage() {
  const { t, tn } = useI18n();
  const { classroom } = useClassroom();
  const classroomId = classroom?.id ?? null;
  const [weeksAgo, setWeeksAgo] = useState(0);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const report = useResource(
    () => api.weeklyReport(classroomId, { weeksAgo, live }),
    [classroomId, weeksAgo, live],
    { enabled: Boolean(classroomId) },
  );

  // A stored snapshot appears on Monday mornings; refresh if the server says so.
  useLiveEvent((message) => {
    if (message.type === 'classroom:changed' && live) report.reload({ quiet: true });
  });

  const data = report.data?.report;
  const stored = report.data?.stored ?? [];

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await api.generateWeeklyReport(classroomId);
      await report.reload({ quiet: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setError(null);
    try {
      await downloadCsv(api.weeklyReportCsvUrl(classroomId, weeksAgo));
    } catch (caught) {
      setError(caught);
    }
  }

  if (!classroom) return <main className="page"><Spinner /></main>;

  return (
    <main className="page">
      <div className="page__head no-print">
        <div className="page__title">
          <span className="page__eyebrow">{classroom.gradeName}</span>
          <h1>{t('report.title')}</h1>
          <p className="muted small">
            {data
              ? t('report.subtitleRange', { classroom: data.classroom.name, range: data.range.label })
              : t('report.subtitleAuto')}
          </p>
        </div>
        <div className="row row--wrap">
          <Segmented
            ariaLabel={t('report.weekLabel')}
            value={weeksAgo}
            onChange={setWeeksAgo}
            options={[
              { value: 0, label: t('report.lastWeek') },
              { value: 1, label: t('report.weekBefore') },
              { value: 2, label: t('report.weeksAgoThree') },
            ]}
          />
          <button type="button" className="btn btn--sm" onClick={generate} disabled={busy}>
            {busy ? t('report.generating') : t('report.generate')}
          </button>
          <button type="button" className="btn btn--sm" onClick={exportCsv}>
            <DownloadIcon size={15} />
            {t('report.csv')}
          </button>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => window.print()}>
            <PrintIcon size={15} />
            {t('report.print')}
          </button>
          <Link className="btn btn--sm" to="/teacher">
            {t('report.backToClassroom')}
          </Link>
        </div>
      </div>

      {error && <ErrorNote error={error} />}
      {report.loading && !data && <Card><Spinner label={t('report.building')} /></Card>}
      {report.error && !data && <ErrorNote error={report.error} onRetry={() => report.reload()} />}

      {data && (
        <div className="stack" style={{ gap: 18 }}>
          <div className="print-only">
            <h2>{t('report.printTitle', { classroom: data.classroom.name })}</h2>
            <p className="small muted">
              {t('report.printSubtitle', {
                grade: data.classroom.gradeName,
                subject: data.classroom.subject,
                range: data.range.label,
                generated: dateTime(data.generatedAt),
              })}
            </p>
          </div>

          <Callout tone="privacy" icon={<ShieldIcon size={16} />} className="no-print">
            <strong style={{ display: 'block', fontSize: '0.85rem' }}>
              {report.data.source === 'stored weekly job' ? t('report.sourceStored') : t('report.sourceLive')}
            </strong>
            <span className="small">
              {report.data.source === 'stored weekly job'
                ? t('report.sourceStoredBody', { range: data.range.label })
                : t('report.sourceLiveBody')}{' '}
              {t('report.sourcePrivacy')}
            </span>
          </Callout>

          <section className="report-metrics">
            {data.metrics.map((metric) => {
              const value = data.totals[metric.key];
              const delta =
                metric.key === 'breakAdherence'
                  ? data.deltas.adherencePct
                  : metric.key === 'computerSessions'
                    ? data.deltas.sessions
                    : metric.key === 'recommendedBreaks'
                      ? data.deltas.recommendedBreaks
                      : null;
              return (
                <div className="metric-card" key={metric.key}>
                  <div className="metric-card__label">{t(`metrics.${metric.key}.label`)}</div>
                  <div className="metric-card__value">
                    {metric.key === 'breakAdherence' ? pct(value) : (value ?? '—')}
                    {metric.unit === '%' ? null : (
                      <span className="metric-card__unit">{t(`units.${metricUnitKey(metric.unit)}`)}</span>
                    )}
                  </div>
                  {delta !== null && delta !== undefined && (
                    <span className={`delta delta--${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
                      {delta > 0 ? '▲' : delta < 0 ? '▼' : '■'}{' '}
                      {t('report.deltaVs', {
                        delta: `${Math.abs(delta)}${metric.unit === '%' ? ` ${t('units.points')}` : ''}`,
                      })}
                    </span>
                  )}
                  <div className="metric-card__hint">{t(`metrics.${metric.key}.description`)}</div>
                </div>
              );
            })}
          </section>

          <div className="report-grid">
            <Card
              title={t('report.chartTitle')}
              subtitle={t('report.chartSubtitle')}
            >
              <WeekTrendChart perDay={data.perDay} />
              <div className="legend" style={{ marginTop: 12 }}>
                <span className="legend__item">
                  <span className="legend__swatch" style={{ background: 'var(--brand-500)' }} />
                  {t('report.legendAdherence')}
                </span>
                <span className="legend__item">
                  <span className="legend__swatch" style={{ background: '#93a29d' }} />
                  {t('report.legendSessions')}
                </span>
              </div>
            </Card>

            <div className="stack">
              <Card title={t('report.dayByDay')}>
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>{t('common.day')}</th>
                      <th className="num">{t('common.sessions')}</th>
                      <th className="num">{t('common.breaks')}</th>
                      <th className="num">{t('common.adherence')}</th>
                      <th className="num">{t('common.long')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perDay.map((day) => (
                      <tr key={day.dayKey}>
                        <td>
                          <strong>{weekdayShort(day.start)}</strong>
                          <span className="tiny muted"> {shortDate(day.start)}</span>
                        </td>
                        <td className="num">{day.computerSessions}</td>
                        <td className="num">
                          {day.completedBreaks}/{day.recommendedBreaks}
                        </td>
                        <td className="num">{pct(day.breakAdherence)}</td>
                        <td className="num">{day.longVisualSessions}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>
                        <strong>{t('common.week')}</strong>
                      </td>
                      <td className="num">
                        <strong>{data.totals.computerSessions}</strong>
                      </td>
                      <td className="num">
                        <strong>
                          {data.totals.completedBreaks}/{data.totals.recommendedBreaks}
                        </strong>
                      </td>
                      <td className="num">
                        <strong>{pct(data.totals.breakAdherence)}</strong>
                      </td>
                      <td className="num">
                        <strong>{data.totals.longVisualSessions}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <p className="tiny muted" style={{ marginTop: 10 }}>
                  {t('report.weekSummary', {
                    seats: tn(data.totals.seatsReporting, 'board.workstations'),
                    duration: duration(data.totals.activeMinutes * 60),
                    skipped: data.totals.skippedBreaks,
                    missed: data.totals.missedBreaks,
                  })}
                </p>
              </Card>

              <Card title={t('report.perWorkstation')} subtitle={t('report.perWorkstationSubtitle')}>
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>{t('common.seat')}</th>
                      <th className="num">{t('common.breaks')}</th>
                      <th className="num">{t('common.adherence')}</th>
                      <th className="num">{t('common.long')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perSeat.map((seat) => (
                      <tr key={seat.seatId}>
                        <td className="mono">{seat.seatLabel}</td>
                        <td className="num">
                          {seat.completedBreaks}/{seat.recommendedBreaks}
                        </td>
                        <td className="num">
                          <span
                            style={{
                              color:
                                adherenceTone(seat.breakAdherence) === 'good'
                                  ? 'var(--active-600)'
                                  : adherenceTone(seat.breakAdherence) === 'bad'
                                    ? 'var(--danger-600)'
                                    : undefined,
                              fontWeight: 600,
                            }}
                          >
                            {pct(seat.breakAdherence)}
                          </span>
                        </td>
                        <td className="num">{seat.longVisualSessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          </div>

          <Card className="card--tinted" title={t('report.definitionsTitle')} subtitle={t('report.definitionsSubtitle')}>
            <div className="stack stack--tight">
              {data.metrics.map((metric) => (
                <div key={metric.key} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <CheckIcon size={15} />
                  <span className="small">
                    <strong>{t(`metrics.${metric.key}.label`)}</strong> — {t(`metrics.${metric.key}.description`)}
                  </span>
                </div>
              ))}
              <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                <ClockIcon size={15} />
                <span className="small">
                  <strong>{t('report.weekWindow')}</strong> — {t('report.weekWindowBody')}
                </span>
              </div>
            </div>
          </Card>

          {stored.length > 0 && (
            <Card title={t('report.storedTitle')} subtitle={t('report.storedSubtitle')}>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>{t('common.week')}</th>
                    <th>{t('report.storedGenerated')}</th>
                    <th>{t('report.storedSource')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stored.map((entry) => (
                    <tr key={entry.id}>
                      <td className="mono">{entry.weekLabel}</td>
                      <td>{dateTime(Date.parse(entry.generatedAt))}</td>
                      <td>{entry.automatic ? t('report.storedWeeklyJob') : t('report.storedOnDemand')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <p className="tiny muted">
            {t('report.footer', {
              generated: dateTime(data.generatedAt),
              interval: data.classroom.breakIntervalMin,
              seconds: data.classroom.breakDurationSec,
            })}
          </p>
        </div>
      )}
    </main>
  );
}

/**
 * Hand-drawn SVG chart rather than a charting dependency: five bars and a line
 * need no library, the markup stays inspectable, it prints cleanly, and it renders
 * identically with JavaScript disabled in the print path.
 */
function WeekTrendChart({ perDay }) {
  const { t, tn } = useI18n();
  const width = 640;
  const height = 240;
  const padding = { top: 18, right: 44, bottom: 34, left: 44 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxSessions = Math.max(1, ...perDay.map((day) => day.computerSessions));

  const barWidth = plotWidth / perDay.length;

  const linePoints = perDay
    .map((day, index) => {
      const x = padding.left + barWidth * index + barWidth / 2;
      const y = padding.top + plotHeight - (day.computerSessions / maxSessions) * plotHeight * 0.9;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('report.chartAlt')} style={{ width: '100%', height: 'auto' }}>
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = padding.top + plotHeight - (tick / 100) * plotHeight;
          return (
            <g key={tick}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--ink-150)" strokeWidth="1" />
              <text x={padding.left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="var(--ink-400)">
                {tick}%
              </text>
            </g>
          );
        })}

        {perDay.map((day, index) => {
          const x = padding.left + barWidth * index + barWidth * 0.22;
          const barW = barWidth * 0.56;
          const value = day.breakAdherence;
          const barHeight = value === null ? 0 : (value / 100) * plotHeight;
          const y = padding.top + plotHeight - barHeight;
          const fill =
            value === null
              ? 'var(--ink-150)'
              : value >= 85
                ? 'var(--brand-500)'
                : value >= 70
                  ? 'var(--brand-100)'
                  : 'var(--attention-400)';
          return (
            <g key={day.dayKey}>
              {value === null ? (
                <rect x={x} y={padding.top + plotHeight - 3} width={barW} height={3} fill="var(--ink-200)" />
              ) : (
                <rect x={x} y={y} width={barW} height={barHeight} rx="4" fill={fill} />
              )}
              {value !== null && (
                <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize="10.5" fontWeight="650" fill="var(--ink-700)">
                  {Math.round(value)}%
                </text>
              )}
              <text
                x={padding.left + barWidth * index + barWidth / 2}
                y={height - padding.bottom + 18}
                textAnchor="middle"
                fontSize="11"
                fill="var(--ink-600)"
                fontWeight="600"
              >
                {weekdayShort(day.start)}
              </text>
              <text
                x={padding.left + barWidth * index + barWidth / 2}
                y={height - padding.bottom + 31}
                textAnchor="middle"
                fontSize="9.5"
                fill="var(--ink-400)"
              >
                {tn(day.computerSessions, 'report.sessionsCount')}
              </text>
            </g>
          );
        })}

        <polyline points={linePoints} fill="none" stroke="#93a29d" strokeWidth="1.6" strokeDasharray="4 3" />
        {perDay.map((day, index) => {
          const x = padding.left + barWidth * index + barWidth / 2;
          const y = padding.top + plotHeight - (day.computerSessions / maxSessions) * plotHeight * 0.9;
          return <circle key={day.dayKey} cx={x} cy={y} r="3" fill="#93a29d" />;
        })}

        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={padding.top + plotHeight}
          y2={padding.top + plotHeight}
          stroke="var(--ink-300)"
        />
        <text x={width - padding.right + 6} y={padding.top + 6} fontSize="9.5" fill="var(--ink-400)">
          {maxSessions}
        </text>
        <text x={width - padding.right + 6} y={padding.top + plotHeight} fontSize="9.5" fill="var(--ink-400)">
          0
        </text>
      </svg>
    </div>
  );
}
