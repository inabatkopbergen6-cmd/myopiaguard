import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useResource } from '../api/hooks.js';
import { useClassroom } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import { DEFAULT_LANGUAGE } from '../i18n/languages.js';
import { Badge, Callout, Card, EmptyState, ErrorNote, Spinner } from '../components/ui.jsx';
import { CheckIcon, MonitorIcon, ShieldIcon } from '../lib/icons.jsx';
import { clockTime, duration, relativeTime } from '../lib/format.js';

/**
 * Setup: room cadence, workstation enrolment and the audit trail.
 *
 * This is the page a teacher (or the IT lead sitting with them) uses once per
 * computer. The enrolment token is per workstation and is the only credential a
 * classroom PC holds — it identifies a machine, never a person.
 */
export default function SetupPage() {
  const { t, tn, languages } = useI18n();
  const { classroom } = useClassroom();
  const classroomId = classroom?.id ?? null;

  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(null);

  const config = useResource(() => api.classroomConfig(classroomId), [classroomId], { enabled: Boolean(classroomId) });
  const seats = useResource(() => api.seats(classroomId), [classroomId], { enabled: Boolean(classroomId) });
  const audit = useResource(() => api.demoAudit(25), [], { enabled: Boolean(classroomId) });

  useEffect(() => {
    if (config.data?.config) setDraft(config.data.config);
  }, [config.data]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateClassroomConfig(classroomId, {
        breakIntervalMin: draft.breakIntervalMin,
        breakDurationSec: draft.breakDurationSec,
        longSessionMin: draft.longSessionMin,
        missedBreakGraceSec: draft.missedBreakGraceSec,
        offlineAfterSec: draft.offlineAfterSec,
        warnLead5Min: draft.warnLead5Min,
        warnLead1Min: draft.warnLead1Min,
        language: draft.language,
      });
      setSaved(true);
      await config.reload({ quiet: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function addWorkstations(count) {
    setBusy(true);
    setError(null);
    try {
      await api.addSeats(classroomId, { count, prefix: 'PC' });
      await seats.reload({ quiet: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text, key) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(new Error(t('errors.clipboard')));
    }
  }

  if (!classroom) return <main className="page"><Spinner /></main>;

  return (
    <main className="page">
      <div className="page__head">
        <div className="page__title">
          <span className="page__eyebrow">{classroom.gradeName}</span>
          <h1>{t('setup.title')}</h1>
          <p className="muted small">{t('setup.subtitle', { classroom: classroom.name })}</p>
        </div>
      </div>

      {error && <ErrorNote error={error} />}

      <div className="report-grid">
        <div className="stack">
          <Card
            title={t('setup.cadenceTitle')}
            subtitle={t('setup.cadenceSubtitle')}
          >
            {config.loading && !draft && <Spinner />}
            {draft && (
              <div className="stack">
                <div className="stat-strip" style={{ marginBottom: 0 }}>
                  <label className="field">
                    <span>{t('setup.breakIntervalLabel')}</span>
                    <input
                      className="input"
                      type="number"
                      min={2}
                      max={120}
                      value={draft.breakIntervalMin}
                      onChange={(event) => setDraft({ ...draft, breakIntervalMin: Number(event.target.value) })}
                    />
                    <span className="field__hint">{t('setup.breakIntervalHint')}</span>
                  </label>
                  <label className="field">
                    <span>{t('setup.challengeLengthLabel')}</span>
                    <input
                      className="input"
                      type="number"
                      min={5}
                      max={300}
                      value={draft.breakDurationSec}
                      onChange={(event) => setDraft({ ...draft, breakDurationSec: Number(event.target.value) })}
                    />
                    <span className="field__hint">{t('setup.challengeLengthHint')}</span>
                  </label>
                  <label className="field">
                    <span>{t('setup.longSessionLabel')}</span>
                    <input
                      className="input"
                      type="number"
                      min={5}
                      max={240}
                      value={draft.longSessionMin}
                      onChange={(event) => setDraft({ ...draft, longSessionMin: Number(event.target.value) })}
                    />
                    <span className="field__hint">{t('setup.longSessionHint')}</span>
                  </label>
                </div>

                <div className="stat-strip" style={{ marginBottom: 0 }}>
                  <label className="field">
                    <span>{t('setup.missedGraceLabel')}</span>
                    <input
                      className="input"
                      type="number"
                      min={10}
                      max={900}
                      value={draft.missedBreakGraceSec}
                      onChange={(event) => setDraft({ ...draft, missedBreakGraceSec: Number(event.target.value) })}
                    />
                    <span className="field__hint">{t('setup.missedGraceHint')}</span>
                  </label>
                  <label className="field">
                    <span>Offline after (seconds)</span>
                    <input
                      className="input"
                      type="number"
                      min={5}
                      max={600}
                      value={draft.offlineAfterSec}
                      onChange={(event) => setDraft({ ...draft, offlineAfterSec: Number(event.target.value) })}
                    />
                    <span className="field__hint">Heartbeat silence before a workstation reads as offline.</span>
                  </label>
                </div>

                <div className="stat-strip" style={{ marginBottom: 0 }}>
                  <label className="field">
                    <span>{t('setup.languageLabel')}</span>
                    <select
                      className="select"
                      value={draft.language ?? DEFAULT_LANGUAGE}
                      onChange={(event) => setDraft({ ...draft, language: event.target.value })}
                    >
                      {languages.map((entry) => (
                        <option key={entry.code} value={entry.code} lang={entry.code}>
                          {entry.endonym}
                        </option>
                      ))}
                    </select>
                    <span className="field__hint">{t('setup.languageHint')}</span>
                  </label>
                </div>

                <div className="row" style={{ gap: 20 }}>
                  <label className="check" style={{ flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={draft.warnLead5Min}
                      onChange={(event) => setDraft({ ...draft, warnLead5Min: event.target.checked })}
                    />
                    <span className="check__text">
                      <span className="check__title">{t('setup.warn5Title')}</span>
                      <span className="check__meta">{t('setup.warn5Body')}</span>
                    </span>
                  </label>
                  <label className="check" style={{ flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={draft.warnLead1Min}
                      onChange={(event) => setDraft({ ...draft, warnLead1Min: event.target.checked })}
                    />
                    <span className="check__text">
                      <span className="check__title">{t('setup.warn1Title')}</span>
                      <span className="check__meta">{t('setup.warn1Body')}</span>
                    </span>
                  </label>
                </div>

                <div className="row row--end">
                  {saved && (
                    <span className="row small" style={{ color: 'var(--active-600)' }}>
                      <CheckIcon size={15} /> {t('common.saved')}
                    </span>
                  )}
                  <button type="button" className="btn btn--primary" onClick={save} disabled={busy}>
                    {busy ? t('setup.saving') : t('setup.saveCadence')}
                  </button>
                </div>
              </div>
            )}
          </Card>

          <Card
            title={t('setup.workstationsTitle')}
            subtitle={t('setup.workstationsSubtitle')}
            actions={
              <button type="button" className="btn btn--sm" onClick={() => addWorkstations(1)} disabled={busy}>
                {t('setup.addOne')}
              </button>
            }
          >
            {seats.loading && !seats.data && <Spinner label={t('setup.loadingWorkstations')} />}
            {seats.data && (
              <div className="stack stack--tight">
                {seats.data.seats.map((seat) => (
                  <div className="enrol-row" key={seat.seatId}>
                    <span className="mono" style={{ fontWeight: 700 }}>
                      {seat.label}
                    </span>
                    <code>{seat.deviceUrl}</code>
                    <span className="row">
                      <button type="button" className="btn btn--sm" onClick={() => copy(seat.deviceUrl, seat.seatId)}>
                        {copied === seat.seatId ? t('common.copied') : t('setup.copyLink')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => copy(seat.agentToken, `${seat.seatId}-token`)}
                        title={t('setup.copyTokenTitle')}
                      >
                        {copied === `${seat.seatId}-token` ? t('common.copied') : t('setup.copyToken')}
                      </button>
                    </span>
                  </div>
                ))}
                {seats.data.seats.length === 0 && (
                  <EmptyState title={t('setup.noWorkstationsTitle')}>{t('setup.noWorkstationsBody')}</EmptyState>
                )}
                <p className="small muted">{seats.data.privacy}</p>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card className="card--tinted" title={t('setup.enrolTitle')} subtitle={t('setup.enrolSubtitle')}>
            <ol className="stack small" style={{ paddingLeft: 18, margin: 0 }}>
              <li>{t('setup.enrolStep1')}</li>
              <li>{t('setup.enrolStep2')}</li>
              <li>{t('setup.enrolStep3')}</li>
            </ol>
            <Callout tone="privacy" icon={<ShieldIcon size={16} />} className="stack">
              <div>
                <strong style={{ display: 'block', fontSize: '0.83rem' }}>{t('setup.kioskTitle')}</strong>
                <span className="small">{t('setup.kioskBody')}</span>
              </div>
            </Callout>
          </Card>

          <Card title={t('setup.activityTitle')} subtitle={t('setup.activitySubtitle')}>
            {audit.loading && !audit.data && <Spinner />}
            {audit.data && (
              <div className="stack stack--tight">
                {audit.data.entries.length === 0 && <EmptyState title={t('setup.activityEmpty')} />}
                {audit.data.entries.map((entry, index) => (
                  <div className="row row--between" key={`${entry.at}-${index}`} style={{ alignItems: 'flex-start' }}>
                    <span className="stack stack--tight" style={{ gap: 2 }}>
                      <span className="small" style={{ fontWeight: 600 }}>
                        {/* Audit actions are stored as stable codes; unknown codes fall
                            back to a readable de-underscored form. */}
                        {t(`setup.actionLabels.${entry.action}`) === `setup.actionLabels.${entry.action}`
                          ? entry.action.replace(/[._]/g, ' ')
                          : t(`setup.actionLabels.${entry.action}`)}
                      </span>
                      <span className="tiny muted">
                        {entry.actor} · {clockTime(Date.parse(entry.at))} · {relativeTime(Date.parse(entry.at))}
                        {entry.seatLabel ? ` · ${entry.seatLabel}` : ''}
                      </span>
                    </span>
                    <Badge tone="neutral" dot={false}>
                      {entry.classroomName ? entry.classroomName.split('—')[0].trim() : t('common.school')}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={t('setup.agentRunsTitle')} subtitle={t('setup.agentRunsSubtitle')}>
            <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <MonitorIcon size={17} />
              <span className="small muted">{t('setup.agentRunsBody', { path: '/device' })}</span>
            </div>
            <p className="tiny muted" style={{ marginTop: 10 }}>
              {t('setup.footerBreakDuration', {
                duration: duration((draft?.breakDurationSec ?? 0) * 1000),
                seats: tn(seats.data?.seats.length ?? 0, 'board.workstations'),
              })}
            </p>
          </Card>
        </div>
      </div>
    </main>
  );
}
