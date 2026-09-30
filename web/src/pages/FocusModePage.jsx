import { Link } from 'react-router-dom';
import { useClassroom } from '../App.jsx';
import FocusModePanel from '../components/FocusModePanel.jsx';
import { useI18n } from '../i18n/index.jsx';
import { Callout, Card, EmptyState, Spinner } from '../components/ui.jsx';
import { GlobeIcon, ShieldIcon } from '../lib/icons.jsx';

/**
 * Focus Mode page (deliverable 7).
 *
 * The wording here is deliberate: this is an allowlist for browsing during a
 * lesson, not a device lockdown. The page says what it does, what it does not do,
 * and where the enforcement actually happens, because a teacher should never be
 * surprised by what their school's devices do to a child's screen.
 */
export default function FocusModePage() {
  const { t } = useI18n();
  const { classroom } = useClassroom();

  if (!classroom) return <main className="page"><Spinner /></main>;

  return (
    <main className="page">
      <div className="page__head">
        <div className="page__title">
          <span className="page__eyebrow">{classroom.gradeName}</span>
          <h1>{t('focus.pageTitle')}</h1>
          <p className="muted small">{t('focus.pageSubtitle', { classroom: classroom.name })}</p>
        </div>
        <div className="row">
          <Link className="btn btn--sm" to="/teacher">
            {t('focus.backToClassroom')}
          </Link>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Callout tone="privacy" icon={<ShieldIcon size={16} />}>
          <strong style={{ display: 'block', fontSize: '0.86rem' }}>{t('focus.whatTitle')}</strong>
          <span className="small">
            <strong>{t('focus.whatIsLabel')}</strong> {t('focus.whatIsBody')}
          </span>
          <span className="small" style={{ display: 'block', marginTop: 4 }}>
            <strong>{t('focus.whatIsNotLabel')}</strong> {t('focus.whatIsNotBody')}
          </span>
        </Callout>

        <FocusModePanel classroomId={classroom.id} />

        <Card className="card--tinted" title={t('focus.howTitle')} subtitle={t('focus.howSubtitle')}>
          <div className="stack">
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <span className="brand__mark" style={{ width: 26, height: 26 }}>
                <GlobeIcon size={14} />
              </span>
              <div>
                <h4>{t('focus.step1Title')}</h4>
                <p className="small muted">{t('focus.step1Body')}</p>
              </div>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <span className="brand__mark" style={{ width: 26, height: 26 }}>
                <GlobeIcon size={14} />
              </span>
              <div>
                <h4>{t('focus.step2Title')}</h4>
                <p className="small muted">{t('focus.step2Body')}</p>
              </div>
            </div>
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <span className="brand__mark" style={{ width: 26, height: 26 }}>
                <GlobeIcon size={14} />
              </span>
              <div>
                <h4>{t('focus.step3Title')}</h4>
                <p className="small muted">
                  {t('focus.step3Body', {
                    extensionPath: 'extensions/myopiaguard-focus/',
                    decisionDoc: 'docs/FOCUS_MODE_DECISION.md',
                  })}
                </p>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
