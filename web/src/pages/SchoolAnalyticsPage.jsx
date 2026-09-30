import { useState } from 'react';
import { api, downloadCsv } from '../api/client.js';
import { useLiveEvent, useResource } from '../api/hooks.js';
import { useSession } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Badge, Callout, Card, ErrorNote, Segmented, Spinner, Stat } from '../components/ui.jsx';
import { AlertIcon, DownloadIcon, GlobeIcon, ShieldIcon } from '../lib/icons.jsx';
import { dateTime, duration, pct, weekdayShort } from '../lib/format.js';

/**
 * School analytics (deliverable 5) — the admin surface, aggregate only.
 *
 * Hierarchy: Computer → Classroom → Grade → School. This page reads the top three
 * levels and never a computer: there is no seat column, no seat label and no
 * drill-down control here, and the API it talks to enforces that independently
 * (role gate + identifier-parameter rejection + response guard + k-anonymity).
 *
 * Rollup cells built from fewer than five workstations are shown as withheld, so a
 * two-machine club cannot be read off a small school's dashboard.
 */
/** Maps an issue `code` onto its dictionary key prefix. */
const ISSUE_KEYS = {
  long_sessions: 'issueLongSessions',
  missed_breaks: 'issueMissedBreaks',
  break_drift: 'issueBreakDrift',
};

/** Composes an issue's detail sentence from the numbers the server sent. */
function issueDetail(t, issue) {
  const params = issue?.params ?? {};
  switch (issue?.code) {
    case 'missed_breaks':
      return t('analytics.issueDetailMissed', {
        missed: params.missed ?? 0,
        recommended: params.recommended ?? 0,
      });
    case 'break_drift':
      return t('analytics.issueDetailDrift', { drifted: params.drifted ?? 0 });
    case 'long_sessions':
      return t('analytics.issueDetailLong', { long: params.long ?? 0 });
    default:
      return issue?.detail ?? '';
  }
}

/** Short axis label for a trend bucket, from its epoch rather than its English label. */
function trendLabel(point, mode) {
  if (!point?.weekStart) return point?.label ?? '';
  return mode === 'monthly'
    ? new Date(point.weekStart).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
    : weekdayShort(point.weekStart);
}

export default function SchoolAnalyticsPage() {
  const { t, tn } = useI18n();
  const session = useSession();
  const [windowDays, setWindowDays] = useState(7);
  const [trendMode, setTrendMode] = useState('weekly');
  const analytics = useResource(() => api.schoolAnalytics(windowDays), [windowDays]);

  // Aggregate numbers only move slowly; refresh on the server's own "stale" ping.
  useLiveEvent((message) => {
    if (message.type === 'analytics:stale') analytics.reload({ quiet: true });
  });

  const data = analytics.data;

  async function exportCsv() {
    await downloadCsv(api.analyticsCsvUrl(windowDays));
  }

  return (
    <main className="page">
      <div className="page__head">
        <div className="page__title">
          <span className="page__eyebrow">{t('analytics.eyebrow')}</span>
          <h1>{data?.school.name ?? t('common.school')}</h1>
          <p className="muted small">
            {data
              ? t('analytics.windowSummary', {
                  window: tn(data.window.days, 'analytics.daysCount'),
                  classrooms: tn(data.headline.classrooms, 'analytics.classroomsCount'),
                  grades: tn(data.headline.grades, 'analytics.gradesCount'),
                })
              : t('analytics.subtitleWholeSchool')}
          </p>
        </div>
        <div className="row row--wrap">
          <Segmented
            ariaLabel={t('analytics.windowLabel')}
            value={windowDays}
            onChange={setWindowDays}
            options={[
              { value: 7, label: tn(7, 'analytics.daysCount') },
              { value: 14, label: tn(14, 'analytics.daysCount') },
              { value: 30, label: tn(30, 'analytics.daysCount') },
              { value: 90, label: tn(90, 'analytics.daysCount') },
            ]}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={exportCsv}>
            <DownloadIcon size={15} />
            {t('analytics.exportCsv')}
          </button>
        </div>
      </div>

      {analytics.loading && !data && <Card><Spinner label={t('analytics.aggregating')} /></Card>}
      {analytics.error && !data && <ErrorNote error={analytics.error} onRetry={() => analytics.reload()} />}

      {data && (
        <div className="stack" style={{ gap: 18 }}>
          <Callout tone="deep" icon={<ShieldIcon size={16} />}>
            <strong style={{ display: 'block', fontSize: '0.86rem' }}>{t('analytics.privacyTitle')}</strong>
            <span className="small">
              {data.privacy.suppressedClassrooms > 0
                ? t('analytics.privacySuppressed', {
                    count: tn(data.privacy.suppressedClassrooms, 'analytics.suppressedCount'),
                    minCohort: data.privacy.minCohortSeats,
                  })
                : t('analytics.privacyRule', { minCohort: data.privacy.minCohortSeats })}{' '}
              {t('analytics.privacyNoDrilldown')}
            </span>
          </Callout>

          <div className="stat-strip">
            <Stat
              label={t('analytics.schoolAdherence')}
              value={pct(data.headline.breakAdherence)}
              foot={t('analytics.schoolAdherenceFoot', {
                completed: data.headline.completedBreaks,
                resolved:
                  data.headline.completedBreaks + data.headline.missedBreaks + data.headline.skippedBreaks,
              })}
            />
            <Stat
              label={t('analytics.recommendedBreaks')}
              value={data.headline.recommendedBreaks}
              foot={t('analytics.recommendedBreaksFoot')}
            />
            <Stat
              label={t('analytics.longSessions')}
              value={data.headline.longVisualSessions}
              foot={t('analytics.longSessionsFoot')}
              tone={data.headline.longVisualSessions > 0 ? 'attention' : 'default'}
            />
            <Stat
              label={t('analytics.activeTime')}
              value={data.headline.activeHours}
              unit={t('units.hoursShort')}
              foot={t('analytics.activeTimeFoot')}
            />
            <Stat
              label={t('analytics.meanStretch')}
              value={data.headline.meanStretchMinutes ?? '—'}
              unit={t('units.minutesShort')}
              foot={t('analytics.meanStretchFoot')}
            />
            <Stat
              label={t('analytics.workstationsReporting')}
              value={data.headline.computersReporting}
              foot={tn(data.headline.computerSessions, 'analytics.workstationsReportingFoot')}
            />
          </div>

          <div className="report-grid">
            <Card
              title={t('analytics.byGrade')}
              subtitle={t('analytics.byGradeSubtitle')}
            >
              <div className="grade-bars">
                {data.byGrade.map((grade) => (
                  <div className="grade-bar" key={grade.gradeLevel}>
                    <span className="grade-bar__name">{grade.gradeName}</span>
                    <span className="grade-bar__track">
                      {grade.suppressed ? (
                        <span className="small muted">
                          {t('analytics.withheldReason', { reason: grade.suppressionReason })}
                        </span>
                      ) : (
                        <>
                          <span className="meter">
                            <span
                              className={`meter__fill ${
                                grade.breakAdherence >= 85
                                  ? ''
                                  : grade.breakAdherence >= 70
                                    ? 'meter__fill--warn'
                                    : 'meter__fill--bad'
                              }`}
                              style={{ width: `${Math.max(3, grade.breakAdherence ?? 0)}%` }}
                            />
                          </span>
                          <span className="grade-bar__meta">
                            {t('analytics.gradeMeta', {
                              classrooms: tn(grade.classrooms, 'analytics.classroomsCount'),
                              workstations: tn(grade.contributorSeats, 'analytics.gradeMetaWorkstations'),
                              sessions: tn(grade.computerSessions, 'analytics.gradeMetaSessions'),
                              long: tn(grade.longVisualSessions, 'analytics.gradeMetaLong'),
                            })}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="right mono" style={{ fontWeight: 700 }}>
                      {grade.suppressed ? '—' : pct(grade.breakAdherence)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title={t('analytics.commonIssue')} subtitle={t('analytics.commonIssueSubtitle')}>
              <div className="stack">
                <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ color: 'var(--attention-600)', marginTop: 2 }}>
                    <AlertIcon size={18} />
                  </span>
                  <div>
                    <h3>
                      {t(`analytics.${ISSUE_KEYS[data.commonIssue.code] ?? 'issueMissedBreaks'}`)}
                    </h3>
                    <p className="small muted">
                      {t(`analytics.${ISSUE_KEYS[data.commonIssue.code] ?? 'issueMissedBreaks'}Desc`)}
                    </p>
                    <p className="small">{issueDetail(t, data.commonIssue)}</p>
                  </div>
                </div>

                <div className="stack stack--tight">
                  {data.commonIssue.ranking.map((entry) => (
                    <div key={entry.code} className="stack stack--tight" style={{ gap: 4 }}>
                      <div className="row row--between small">
                        <span>{t(`analytics.${ISSUE_KEYS[entry.code] ?? 'issueMissedBreaks'}`)}</span>
                        <span className="mono">{entry.share}%</span>
                      </div>
                      <span className="meter">
                        <span
                          className={`meter__fill ${entry.code === data.commonIssue.code ? '' : 'meter__fill--warn'}`}
                          style={{ width: `${Math.max(2, Math.min(100, entry.share * 2))}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>

                <p className="tiny muted">
                  {tn(data.commonIssue.affectedClassrooms, 'analytics.affectsClassrooms')}{' '}
                  {t('analytics.affectsNote')}
                </p>
              </div>
            </Card>
          </div>

          <div className="report-grid">
            <Card title={t('analytics.visualLoad')} subtitle={t('analytics.visualLoadSubtitle')}>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>{t('common.classroom')}</th>
                    <th>{t('common.subject')}</th>
                    <th className="num">{t('analytics.meanStretchHeader')}</th>
                    <th className="num">{t('analytics.screenTimePerWorkstation')}</th>
                    <th className="num">{t('common.adherence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.visualLoad.byClassroom.map((room) => (
                    <tr key={room.classroomName}>
                      <td>
                        {room.classroomName}
                        <span className="tiny muted"> {room.gradeName}</span>
                      </td>
                      <td className="small">{room.subject}</td>
                      <td className="num">{t('analytics.minuteValue', { value: room.meanStretchMinutes ?? '—' })}</td>
                      <td className="num">
                        {room.activeMinutesPerWorkstation ? duration(room.activeMinutesPerWorkstation * 60) : '—'}
                      </td>
                      <td className="num">{pct(room.breakAdherence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <hr className="divider" />

              <h4 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-500)' }}>
                {t('analytics.bySubject')}
              </h4>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>{t('common.subject')}</th>
                    <th className="num">{t('common.classroom')}</th>
                    <th className="num">{t('analytics.meanStretchHeader')}</th>
                    <th className="num">{t('common.adherence')}</th>
                    <th className="num">{t('analytics.activeHours')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.visualLoad.bySubject.map((subject) => (
                    <tr key={subject.subject}>
                      <td>
                        <span className="row" style={{ gap: 7 }}>
                          <GlobeIcon size={14} />
                          {subject.subject}
                        </span>
                      </td>
                      <td className="num">{subject.classrooms}</td>
                      <td className="num">{t('analytics.minuteValue', { value: subject.visualLoadIndex ?? '—' })}</td>
                      <td className="num">{pct(subject.breakAdherence)}</td>
                      <td className="num">{subject.activeHours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card
              title={t('analytics.trend')}
              subtitle={t('analytics.trendSubtitle')}
              actions={
                <Segmented
                  ariaLabel={t('analytics.trendPeriod')}
                  value={trendMode}
                  onChange={setTrendMode}
                  options={[
                    { value: 'weekly', label: t('analytics.weekly') },
                    { value: 'monthly', label: t('analytics.monthly') },
                  ]}
                />
              }
            >
              <TrendChart points={data.trend[trendMode]} />
              <table className="table table--compact" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>{trendMode === 'weekly' ? t('common.week') : t('common.month')}</th>
                    <th className="num">{t('common.adherence')}</th>
                    <th className="num">{t('common.sessions')}</th>
                    <th className="num">{t('common.long')}</th>
                    <th className="num">{t('common.classroom')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trend[trendMode].map((point) => (
                    <tr key={point.label}>
                      <td className="mono small">{trendLabel(point, trendMode)}</td>
                      <td className="num">{pct(point.breakAdherence)}</td>
                      <td className="num">{point.computerSessions}</td>
                      <td className="num">{point.longVisualSessions}</td>
                      <td className="num">{point.classroomsReporting}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <Card
            title={t('analytics.rollups')}
            subtitle={t('analytics.rollupsSubtitle')}
          >
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.classroom')}</th>
                  <th>{t('common.subject')}</th>
                  <th>{t('common.grade')}</th>
                  <th className="num">{t('board.workstationsLabel')}</th>
                  <th className="num">{t('common.sessions')}</th>
                  <th className="num">{t('common.adherence')}</th>
                  <th className="num">{t('analytics.longSessions')}</th>
                  <th className="num">{t('analytics.meanStretchHeader')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byClassroom.map((room) => (
                  <tr key={room.classroomId}>
                    <td>
                      {room.suppressed ? (
                        <span className="row" style={{ gap: 7 }}>
                          <span className="muted">{room.classroomName}</span>
                          <Badge tone="neutral" dot={false}>
                            {t('analytics.rollupsWithheld')}
                          </Badge>
                        </span>
                      ) : (
                        room.classroomName
                      )}
                    </td>
                    <td className="small">{room.subject}</td>
                    <td className="small">{room.gradeName}</td>
                    <td className="num">{room.suppressed ? '—' : room.computersReporting}</td>
                    <td className="num">{room.suppressed ? '—' : room.computerSessions}</td>
                    <td className="num">{room.suppressed ? '—' : pct(room.breakAdherence)}</td>
                    <td className="num">{room.suppressed ? '—' : room.longVisualSessions}</td>
                    <td className="num">
                      {room.suppressed ? '—' : t('analytics.minuteValue', { value: room.meanStretchMinutes ?? '—' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="tiny muted" style={{ marginTop: 10 }}>
              {t('analytics.rollupsFooter', {
                generated: dateTime(data.generatedAt),
                name: session.user.displayName,
                role: session.user.role === 'admin' ? t('analytics.roleAdmin') : t('analytics.roleTeacher'),
              })}
            </p>
          </Card>
        </div>
      )}
    </main>
  );
}

/** Adherence line with session volume behind it, drawn as plain SVG. */
function TrendChart({ points = [] }) {
  const { t } = useI18n();
  if (points.length === 0) {
    return <p className="small muted">{t('analytics.trendEmpty')}</p>;
  }

  const width = 560;
  const height = 200;
  const padding = { top: 16, right: 16, bottom: 30, left: 40 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxSessions = Math.max(1, ...points.map((point) => point.computerSessions));
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  const coords = points.map((point, index) => ({
    ...point,
    x: padding.left + step * index,
    y: padding.top + plotHeight - ((point.breakAdherence ?? 0) / 100) * plotHeight,
    barHeight: (point.computerSessions / maxSessions) * plotHeight * 0.55,
  }));

  const line = coords.map((point) => `${point.x},${point.y}`).join(' ');

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('analytics.trendAlt')} style={{ width: '100%', height: 'auto' }}>
        {[0, 50, 100].map((tick) => {
          const y = padding.top + plotHeight - (tick / 100) * plotHeight;
          return (
            <g key={tick}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--ink-150)" />
              <text x={padding.left - 6} y={y + 4} textAnchor="end" fontSize="9.5" fill="var(--ink-400)">
                {tick}%
              </text>
            </g>
          );
        })}

        {coords.map((point) => (
          <rect
            key={`bar-${point.label}`}
            x={point.x - 12}
            y={padding.top + plotHeight - point.barHeight}
            width={24}
            height={point.barHeight}
            rx="3"
            fill="var(--ink-150)"
          />
        ))}

        <polyline points={line} fill="none" stroke="var(--brand-600)" strokeWidth="2.2" strokeLinejoin="round" />

        {coords.map((point) => (
          <g key={point.label}>
            <circle cx={point.x} cy={point.y} r="3.6" fill="var(--white)" stroke="var(--brand-600)" strokeWidth="2.2" />
            <text x={point.x} y={point.y - 11} textAnchor="middle" fontSize="10" fontWeight="650" fill="var(--ink-700)">
              {point.breakAdherence === null ? '—' : `${Math.round(point.breakAdherence)}%`}
            </text>
            <text x={point.x} y={height - padding.bottom + 16} textAnchor="middle" fontSize="9.5" fill="var(--ink-500)">
              {trendLabel(point, 'weekly')}
            </text>
            <text x={point.x} y={height - padding.bottom + 27} textAnchor="middle" fontSize="9" fill="var(--ink-400)">
              {point.computerSessions}
            </text>
          </g>
        ))}
      </svg>
      <div className="legend" style={{ marginTop: 10 }}>
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: 'var(--brand-600)' }} />
          {t('analytics.legendAdherence')}
        </span>
        <span className="legend__item">
          <span className="legend__swatch" style={{ background: 'var(--ink-150)' }} />
          {t('analytics.legendSessions')}
        </span>
      </div>
    </div>
  );
}
