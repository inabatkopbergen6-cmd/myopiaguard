import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useLiveEvent, useResource } from '../api/hooks.js';
import { useClassroom } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { AttentionPanel, SeatRow, SeatTile } from '../components/SeatBoard.jsx';
import SeatDetailDrawer from '../components/SeatDetailDrawer.jsx';
import AttentionModeDialog from '../components/AttentionModeDialog.jsx';
import BreakChallenge from '../components/Takeovers.jsx';
import { Badge, Callout, Card, EmptyState, ErrorNote, Segmented, Spinner, Stat } from '../components/ui.jsx';
import {
  ChartIcon,
  CheckIcon,
  ClockIcon,
  GlobeIcon,
  GridIcon,
  ListIcon,
  MegaphoneIcon,
  MonitorIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  StopIcon,
} from '../lib/icons.jsx';
import { clockTime, duration, pct } from '../lib/format.js';

/**
 * Teacher dashboard (deliverable 1).
 *
 * One screen, refreshed live over the WebSocket, that answers: is the room
 * working, is the break routine holding, and does anything need me? Seats are
 * workstations; the only label anywhere is PC-nn.
 *
 * Refresh strategy: the socket pushes `classroom:changed` when something real
 * happens (a break starts, a seat drops out), and the page re-fetches the
 * snapshot. A one-second local timer drives only the countdown text, so the UI
 * feels live without hammering the API.
 */
export default function TeacherDashboard() {
  const { t, tn } = useI18n();
  const { classroom, classrooms } = useClassroom();
  const classroomId = classroom?.id ?? null;

  const [view, setView] = useState('grid');
  const [selectedSeatId, setSelectedSeatId] = useState(null);
  const [showAttention, setShowAttention] = useState(false);
  const [previewBreak, setPreviewBreak] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [now, setNow] = useState(Date.now());

  const snapshot = useResource(() => api.snapshot(classroomId), [classroomId], { enabled: Boolean(classroomId) });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Live updates: anything that touches this classroom refreshes the snapshot.
  // The one-second local timer above only drives countdown text, so the board
  // feels live without turning every tick into an API call.
  const reloadQuietly = snapshot.reload;
  useLiveEvent((message) => {
    if (message.type === 'classroom:changed') {
      if (!message.payload?.classroomId || message.payload.classroomId === classroomId) reloadQuietly({ quiet: true });
      return;
    }
    if (message.type === 'attention:broadcast' || message.type === 'attention:clear' || message.type === 'focus:changed') {
      reloadQuietly({ quiet: true });
    }
  });

  const data = snapshot.data;

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      adherence: data.classAdherence.adherencePct,
      active: data.counts.active,
      onBreak: data.counts.onBreak,
      offline: data.counts.offline,
      flagged: data.counts.flagged,
      sessions: data.classAdherence,
    };
  }, [data]);

  async function startSession() {
    setBusy(true);
    setActionError(null);
    try {
      await api.startSession(classroomId, classroom.subject);
      await snapshot.reload({ quiet: true });
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function endSession() {
    setBusy(true);
    setActionError(null);
    try {
      await api.endSession(classroomId);
      await snapshot.reload({ quiet: true });
    } catch (caught) {
      setActionError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (classrooms.length === 0) {
    return (
      <main className="page">
        <EmptyState title={t('board.noClassroomsTitle')}>{t('board.noClassroomsBody')}</EmptyState>
      </main>
    );
  }

  const selectedSeat = selectedSeatId ? data?.seats.find((seat) => seat.seatId === selectedSeatId) : null;

  return (
    <main className="page">
      <div className="page__head">
        <div className="page__title">
          <span className="page__eyebrow">{classroom.gradeName}</span>
          <h1>{classroom.name}</h1>
          <p className="muted small">
            {t('board.headerMeta', {
              subject: classroom.subject,
              interval: data?.classroom.breakIntervalMin ?? classroom.breakIntervalMin,
              seats: tn(data?.counts.seats ?? classroom.seatCount, 'board.workstations'),
            })}
          </p>
        </div>

        <div className="row row--wrap">
          {data?.lessonSession ? (
            <>
              <Badge tone="active">
                <PlayIcon size={12} />
                {t('board.lessonLiveSince', { time: clockTime(data.lessonSession.startedAt) })}
              </Badge>
              <Link className="btn btn--sm" to="/teacher/focus">
                <GlobeIcon size={15} />
                {t('nav.focusMode')}
              </Link>
              <button type="button" className="btn btn--sm btn--danger" onClick={endSession} disabled={busy}>
                <StopIcon size={14} />
                {t('board.endLesson')}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={startSession} disabled={busy}>
              <PlayIcon size={15} />
              {t('board.startLesson')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--attention"
            onClick={() => setShowAttention(true)}
            disabled={!data?.lessonSession}
            title={data?.lessonSession ? t('board.getAttentionTitle') : t('board.getAttentionDisabled')}
          >
            <MegaphoneIcon size={15} />
            {t('board.getAttention')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => snapshot.reload({ quiet: true })}
            disabled={snapshot.refreshing}
          >
            <RefreshIcon size={15} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {actionError && <ErrorNote error={actionError} />}

      {snapshot.loading && !data && (
        <Card>
          <Spinner label={t('board.loadingClassroom')} />
        </Card>
      )}

      {snapshot.error && !data && <ErrorNote error={snapshot.error} onRetry={() => snapshot.reload()} />}

      {data && stats && (
        <>
          <div className="adherence-hero">
            <div className="adherence-hero__figure">
              <span
                className="adherence-hero__value"
                style={{ color: stats.adherence === null ? 'var(--ink-400)' : stats.adherence >= 85 ? 'var(--active-600)' : stats.adherence >= 70 ? 'var(--ink-900)' : 'var(--attention-600)' }}
              >
                {pct(stats.adherence)}
              </span>
              <span className="muted">{t('board.classAdherence')}</span>
            </div>
            <div className="adherence-hero__meta">
              <span className="small muted">
                {t('board.todaySummary', {
                  completed: data.classAdherence.completed,
                  skipped: data.classAdherence.skipped,
                  missed: data.classAdherence.missed,
                })}
              </span>
              <span className="small muted">
                {data.lessonSession
                  ? t('board.lessonRunningSince', { time: clockTime(data.lessonSession.startedAt) })
                  : t('board.noLessonRunning')}
              </span>
            </div>
            <div className="adherence-hero__split">
              <div className="stack stack--tight">
                <span className="stat__label">{t('board.working')}</span>
                <strong style={{ fontSize: '1.3rem' }}>{stats.active}</strong>
              </div>
              <div className="stack stack--tight">
                <span className="stat__label">{t('board.onBreak')}</span>
                <strong style={{ fontSize: '1.3rem', color: 'var(--break-600)' }}>{stats.onBreak}</strong>
              </div>
              <div className="stack stack--tight">
                <span className="stat__label">{t('board.offline')}</span>
                <strong style={{ fontSize: '1.3rem', color: stats.offline > 0 ? 'var(--attention-600)' : 'var(--ink-400)' }}>
                  {stats.offline}
                </strong>
              </div>
              <div className="stack stack--tight">
                <span className="stat__label">{t('board.needsAttention')}</span>
                <strong style={{ fontSize: '1.3rem', color: stats.flagged > 0 ? 'var(--attention-600)' : 'var(--ink-400)' }}>
                  {stats.flagged}
                </strong>
              </div>
            </div>
          </div>

          <div className="dash">
            <div className="stack">
              <Card
                flush
                title={t('board.cardTitle')}
                subtitle={t('board.cardSubtitle', { seats: tn(data.counts.seats, 'board.workstations') })}
                actions={
                  <>
                    <Segmented
                      ariaLabel={t('board.boardLayout')}
                      value={view}
                      onChange={setView}
                      options={[
                        { value: 'grid', label: <GridIcon size={15} /> },
                        { value: 'list', label: <ListIcon size={15} /> },
                      ]}
                    />
                  </>
                }
              >
                <div style={{ padding: 14 }}>
                  {view === 'grid' ? (
                    <div className="seat-grid">
                      {data.seats.map((seat) => (
                        <SeatTile
                          key={seat.seatId}
                          seat={seat}
                          now={now}
                          selected={seat.seatId === selectedSeatId}
                          onSelect={setSelectedSeatId}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="seat-list">
                      {data.seats.map((seat) => (
                        <SeatRow
                          key={seat.seatId}
                          seat={seat}
                          now={now}
                          selected={seat.seatId === selectedSeatId}
                          onSelect={setSelectedSeatId}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              <Card
                className="card--tinted"
                title={t('board.roomSettings')}
                subtitle={t('board.roomSettingsSubtitle')}
                actions={
                  <Link className="btn btn--sm" to="/teacher/setup">
                    {t('board.openSetup')}
                  </Link>
                }
              >
                <div className="stat-strip" style={{ marginBottom: 0 }}>
                  <Stat
                    label={t('board.breakInterval')}
                    value={data.classroom.breakIntervalMin}
                    unit={t('units.minutesShort')}
                    foot={t('board.breakIntervalFoot')}
                  />
                  <Stat
                    label={t('board.challengeLength')}
                    value={data.classroom.breakDurationSec}
                    unit={t('units.secondsShort')}
                    foot={t('board.challengeLengthFoot')}
                  />
                  <Stat
                    label={t('board.longSessionFlag')}
                    value={data.classroom.longSessionMin}
                    unit={t('units.minutesShort')}
                    foot={t('board.longSessionFlagFoot')}
                  />
                  <Stat
                    label={t('board.warnings')}
                    value={t('board.warningsValue', {
                      five: data.classroom.warnLead5Min ? `5${t('units.minutesShort')}` : '—',
                      one: data.classroom.warnLead1Min ? `1${t('units.minutesShort')}` : '—',
                    })}
                    foot={t('board.warningsFoot')}
                  />
                </div>
              </Card>

              {snapshot.data?.focus?.active && (
                <Card title={t('board.focusOnTitle')} subtitle={t('board.focusOnSubtitle')}>
                  <div className="row row--wrap">
                    {(snapshot.data.focus.selectedResources ?? []).map((resource) => (
                      <Badge key={resource.id} tone="brand" dot={false}>
                        {resource.name}
                      </Badge>
                    ))}
                    <Link className="btn btn--sm" to="/teacher/focus" style={{ marginLeft: 'auto' }}>
                      {t('board.manage')}
                    </Link>
                  </div>
                </Card>
              )}
            </div>

            <div className="stack">
              <Card
                title={t('board.attentionCard')}
                subtitle={t('board.attentionCardSubtitle')}
              >
                <AttentionPanel
                  attention={data.attention}
                  now={now}
                  onSelect={setSelectedSeatId}
                  activeBroadcast={data.attentionBroadcast}
                />
              </Card>

              <Card title={t('board.previewCard')} subtitle={t('board.previewCardSubtitle')}>
                <div className="stack stack--tight">
                  <button
                    type="button"
                    className="btn btn--block"
                    onClick={() =>
                      setPreviewBreak({
                        durationSec: data.classroom.breakDurationSec,
                        instruction: { key: 'farthest-object' },
                        startedAt: Date.now(),
                        longStretch: false,
                      })
                    }
                  >
                    <MonitorIcon size={15} />
                    {t('board.previewButton')}
                  </button>
                  <p className="preview-note">{t('board.previewNote')}</p>
                </div>
              </Card>

              <Card title={t('board.thisClassroom')} subtitle={t('board.reference')}>
                <dl className="kv">
                  <dt>{t('board.grade')}</dt>
                  <dd>{classroom.gradeName}</dd>
                  <dt>{t('board.subject')}</dt>
                  <dd>{classroom.subject}</dd>
                  <dt>{t('board.workstationsLabel')}</dt>
                  <dd>{data.counts.seats}</dd>
                  <dt>{t('board.breakEvery')}</dt>
                  <dd>{t('board.minutesValue', { value: data.classroom.breakIntervalMin })}</dd>
                  <dt>{t('board.missedBreakGrace')}</dt>
                  <dd>{data.classroom.missedBreakGraceSec}{t('units.secondsShort')}</dd>
                  <dt>{t('board.offlineAfter')}</dt>
                  <dd>{data.classroom.offlineAfterSec}{t('units.secondsShort')}</dd>
                </dl>
                <Callout tone="privacy" icon={<ShieldIcon size={16} />} className="stack" >
                  <div>
                    <strong style={{ display: 'block', fontSize: '0.82rem' }}>{t('board.privacyTitle')}</strong>
                    <span className="small">{t('board.privacyBody', { example: data.seats[0]?.label ?? '' })}</span>
                  </div>
                </Callout>
              </Card>

              <Link className="btn btn--block" to="/teacher/report">
                <ChartIcon size={15} />
                {t('board.weeklyReportLink')}
              </Link>
            </div>
          </div>
        </>
      )}

      {selectedSeatId && (
        <SeatDetailDrawer
          seatId={selectedSeatId}
          liveSeat={selectedSeat}
          now={now}
          onClose={() => setSelectedSeatId(null)}
        />
      )}

      {showAttention && (
        <AttentionModeDialog
          classroomId={classroomId}
          activeBroadcast={data?.attentionBroadcast}
          onClose={() => setShowAttention(false)}
          onSent={() => snapshot.reload({ quiet: true })}
          onCleared={() => snapshot.reload({ quiet: true })}
        />
      )}

      {previewBreak && (
        <BreakChallenge
          {...previewBreak}
          seatLabel={t('board.previewSeatLabel')}
          variant="preview"
          onComplete={() => setPreviewBreak(null)}
          onSkip={() => setPreviewBreak(null)}
        />
      )}
    </main>
  );
}
