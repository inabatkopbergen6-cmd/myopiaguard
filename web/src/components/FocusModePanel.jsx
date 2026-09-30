import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import { useResource } from '../api/hooks.js';
import { Badge, Callout, Card, EmptyState, ErrorNote, Spinner } from './ui.jsx';
import { GlobeIcon, ShieldIcon } from '../lib/icons.jsx';
import { useI18n } from '../i18n/index.jsx';
import { dateTime, relativeTime } from '../lib/format.js';

/**
 * Focus Mode configuration (deliverable 7).
 *
 * This panel owns *policy*: which approved resources a teacher allows for this
 * lesson. It deliberately does not contain the enforcement mechanism — that is the
 * documented decision in docs/FOCUS_MODE_DECISION.md, with a reference
 * implementation in extensions/myopiaguard-focus/. What this panel does show is
 * the exact document that gets handed to the school's chosen enforcer, so a
 * teacher (and an IT department) can see what will be applied rather than trusting
 * a toggle.
 */
export default function FocusModePanel({ classroomId, onChanged }) {
  const { t } = useI18n();
  const focus = useResource(() => api.focus(classroomId), [classroomId], { enabled: Boolean(classroomId) });
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showPolicy, setShowPolicy] = useState(false);

  const status = focus.data?.status;
  const catalog = focus.data?.catalog ?? [];

  useEffect(() => {
    if (!status) return;
    setSelected(status.selectedResourceIds ?? []);
  }, [status?.focusSessionId, status?.active, classroomId]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const resource of catalog) {
      const bucket = map.get(resource.category) ?? [];
      bucket.push(resource);
      map.set(resource.category, bucket);
    }
    return [...map.entries()];
  }, [catalog]);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await api.enableFocus(classroomId, selected);
      await focus.reload({ quiet: true });
      onChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await api.disableFocus(classroomId);
      await focus.reload({ quiet: true });
      onChanged?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  function toggle(resourceId) {
    setSelected((prev) => (prev.includes(resourceId) ? prev.filter((id) => id !== resourceId) : [...prev, resourceId]));
  }

  if (focus.loading) return <Spinner label="Loading Focus Mode" />;
  if (focus.error) return <ErrorNote error={focus.error} onRetry={() => focus.reload()} />;

  return (
    <div className="stack">
      <Card
        title={t('focus.panelTitle')}
        subtitle={t('focus.panelSubtitle')}
        actions={
          <>
            <button type="button" className="btn btn--sm" onClick={() => setShowPolicy((value) => !value)}>
              {showPolicy ? t('focus.hidePolicy') : t('focus.showPolicy')}
            </button>
            {status.active && (
              <button type="button" className="btn btn--sm btn--danger" onClick={turnOff} disabled={busy}>
                {t('focus.turnOff')}
              </button>
            )}
          </>
        }
      >
        <div className="stack">
          <div className="row row--between row--wrap">
            <div className="row">
              {status.active ? (
                <Badge tone="brand">
                  <GlobeIcon size={12} />
                  {t('focus.on')}
                </Badge>
              ) : (
                <Badge tone="neutral" dot={false}>
                  {t('focus.off')}
                </Badge>
              )}
              {status.active && (
                <span className="small muted">
                  {t('focus.sinceWhen', {
                    time: dateTime(status.since),
                    count: status.selectedResources?.length ?? 0,
                  })}
                </span>
              )}
            </div>
            {!focus.data?.lessonSession && (
              <span className="small muted">{t('focus.startLessonFirst')}</span>
            )}
          </div>

          {error && <ErrorNote error={error} />}

          {catalog.length === 0 ? (
            <EmptyState title={t('focus.noResourcesTitle')}>{t('focus.noResourcesBody')}</EmptyState>
          ) : (
            grouped.map(([category, resources]) => (
              <div key={category} className="stack stack--tight">
                <h4 style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-500)' }}>
                  {category}
                </h4>
                <div className="resource-grid">
                  {resources.map((resource) => {
                    const on = selected.includes(resource.id);
                    return (
                      <label key={resource.id} className={`check ${on ? 'check--on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggle(resource.id)} />
                        <span className="check__text">
                          <span className="check__title">{resource.name}</span>
                          <span className="check__meta mono">{resource.domain}</span>
                          {resource.description && <span className="check__meta">{resource.description}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <div className="row row--between row--wrap">
            <span className="small muted">
              {t('focus.selectedOf', { selected: selected.length, total: catalog.length })}
            </span>
            <div className="row">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setSelected(catalog.filter((resource) => resource.defaultAllowed).map((r) => r.id))}
              >
                {t('focus.useDefaults')}
              </button>
              <button type="button" className="btn btn--primary" onClick={apply} disabled={busy || !status?.lessonSession}>
                {busy ? t('focus.applying') : status.active ? t('focus.updateAllowlist') : t('focus.turnOn')}
              </button>
            </div>
          </div>
        </div>
      </Card>

      {showPolicy && (
        <Card
          title={t('focus.enforcementTitle')}
          subtitle={t('focus.enforcementSubtitle')}
        >
          {status.policy ? (
            <>
              <pre className="policy-block">{JSON.stringify(status.policy, null, 2)}</pre>
              <Callout tone="privacy" icon={<ShieldIcon size={16} />} className="stack" >
                <div>
                  <strong style={{ display: 'block', fontSize: '0.83rem' }}>{t('focus.scopeTitle')}</strong>
                  <span className="small">
                    {t('focus.scopeBody', { mode: status.policy.mode, scope: status.policy.scope })}
                  </span>
                </div>
              </Callout>
            </>
          ) : (
            <EmptyState title={t('focus.noPolicyTitle')}>{t('focus.noPolicyBody')}</EmptyState>
          )}
        </Card>
      )}

      <Card title={t('focus.historyTitle')} subtitle={t('focus.historySubtitle')}>
        {(focus.data?.history ?? []).length === 0 ? (
          <EmptyState title={t('focus.historyEmpty')} />
        ) : (
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('focus.historyEnabled')}</th>
                <th>{t('focus.historyBy')}</th>
                <th className="num">{t('focus.historyResources')}</th>
                <th>{t('focus.historyStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {focus.data.history.map((entry) => (
                <tr key={entry.id}>
                  <td className="mono">{dateTime(entry.enabledAt)}</td>
                  <td>{entry.enabledByName ?? '—'}</td>
                  <td className="num">{entry.resourceCount}</td>
                  <td>
                    {entry.status === 'active' ? (
                      <Badge tone="brand">{t('focus.historyActive')}</Badge>
                    ) : (
                      <span className="small muted">{t('focus.historyEnded', { time: relativeTime(entry.disabledAt) })}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

export { ApiError };
