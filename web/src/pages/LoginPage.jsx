import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, authStore } from '../api/client.js';
import LanguageSwitcher from '../components/LanguageSwitcher.jsx';
import { ErrorNote } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import {
  ChevronIcon,
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  MegaphoneIcon,
  MonitorIcon,
  ShieldIcon,
} from '../lib/icons.jsx';

/**
 * Sign-in and landing page.
 *
 * The layout is deliberately uneven: the hero takes the wider column and the form
 * sits lower, so the two do not share a baseline. The hero itself is a vanishing
 * point — a classroom receding toward a horizon with the sun on it — and the four
 * product principles sit *inside* that depth field at staggered depths rather than
 * being listed in an even grid beneath it.
 *
 * The far layer is genuinely out of focus and sharpens as you approach the primary
 * action: the product's own advice ("look into the distance") performed by the page,
 * where the near thing is blurry and the far thing is clear.
 */
export default function LoginPage({ onSignedIn }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [demoOpen, setDemoOpen] = useState(true);
  /**
   * Depth of field: the hero's atmospheric distance layer sharpens as attention
   * moves to the sign-in form — the product's eye-health advice performed by the interface.
   */
  const [approaching, setApproaching] = useState(false);

  useEffect(() => {
    api
      .demoAccounts()
      .then((data) => setAccounts(data.accounts ?? []))
      .catch(() => setAccounts([]));
  }, []);

  async function submit(event) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      authStore.token = result.token;
      const me = await onSignedIn();
      const role = me?.user?.role ?? result.user.role;
      navigate(role === 'admin' ? '/school' : '/teacher', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  function useAccount(account) {
    setUsername(account.username);
    setPassword('myopiaguard');
    setError(null);
  }

  const principles = [
    {
      icon: <MonitorIcon size={18} />,
      tag: 'PRIVACY-FIRST',
      title: t('auth.pointWorkstationsTitle'),
      body: t('auth.pointWorkstationsBody'),
    },
    {
      icon: <MegaphoneIcon size={18} />,
      tag: 'NO LOCKOUT',
      title: t('auth.pointAttentionTitle'),
      body: t('auth.pointAttentionBody'),
    },
    {
      icon: <GlobeIcon size={18} />,
      tag: 'SESSION-BOUND',
      title: t('auth.pointFocusTitle'),
      body: t('auth.pointFocusBody'),
    },
    {
      icon: <ClockIcon size={18} />,
      tag: 'PREDICTABLE',
      title: t('auth.pointWarningsTitle'),
      body: t('auth.pointWarningsBody'),
    },
  ];

  return (
    <div className={`auth ${approaching ? 'auth--approaching' : ''}`}>
      <header className="auth__bar">
        <span className="brand">
          <span className="brand__mark">
            <EyeIcon size={16} />
          </span>
          <span className="brand__name">MyopiaGuard</span>
        </span>
        <span className="auth__bar-tag">{t('auth.brandTag')}</span>
        <span className="auth__bar-spacer">
          <LanguageSwitcher />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigate('/device')}>
            <MonitorIcon size={15} />
            {t('auth.classroomPcView')}
          </button>
        </span>
      </header>

      <main className="auth__main">
        <section className="auth__pitch">
          <div className="auth__pitch-header">
            <span className="auth__eyebrow">
              <EyeIcon size={13} />
              {t('auth.brandTag')}
            </span>

            <h1 className="auth__headline">{t('auth.headline')}</h1>

            <p className="auth__lede">{t('auth.lede', { breakSeconds: 20 })}</p>
          </div>

          <div className="hero__stage">
            {/* The atmospheric horizon viewport: gives depth and literal distance context */}
            <div className="hero__viewport">
              <div className="hero__scene" aria-hidden="true">
                <RoomToHorizon />
              </div>
              <div className="hero__viewport-glass">
                <span className="hero__viewport-badge">
                  <span className="hero__viewport-dot" />
                  20-20-20 Eye-Rest Rhythm
                </span>
                <span className="hero__viewport-caption">
                  Simulated 20ft (6m) distance view · Rest ciliary muscles
                </span>
              </div>
            </div>

            {/* Asymmetrical Bento Grid: 4 deliberate principles, clear and legible */}
            <div className="hero__bento">
              {principles.map((principle, index) => (
                <div key={principle.title} className={`hero__bento-card hero__bento-card--${index}`}>
                  <div className="hero__bento-head">
                    <span className="hero__bento-icon">{principle.icon}</span>
                    <span className="hero__bento-tag">{principle.tag}</span>
                  </div>
                  <strong className="hero__bento-title">{principle.title}</strong>
                  <p className="hero__bento-body">{principle.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          className="auth__panel"
          onFocusCapture={() => setApproaching(true)}
          onBlurCapture={() => setApproaching(false)}
          onMouseEnter={() => setApproaching(true)}
          onMouseLeave={() => setApproaching(false)}
        >
          <form className="auth__card" onSubmit={submit}>
            <div className="auth__card-head">
              <h2>{t('auth.signInTitle')}</h2>
              <p>{t('auth.signInSubtitle')}</p>
            </div>

            {error && <ErrorNote error={error} />}

            <div className="auth__form">
              <label className="field">
                <span>{t('auth.username')}</span>
                <input
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="teacher.avery"
                  required
                />
              </label>

              <label className="field">
                <span>{t('auth.password')}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>

              <button
                type="submit"
                className="btn btn--primary btn--lg btn--block auth__submit-btn"
                disabled={busy || !username || !password}
              >
                {busy ? t('auth.signingIn') : t('auth.signIn')}
              </button>
            </div>

            <div className="auth__aside">
              <button type="button" className="btn btn--block btn--ghost auth__enrol-btn" onClick={() => navigate('/device')}>
                <MonitorIcon size={15} />
                {t('auth.enrolButton')}
              </button>
              <p className="auth__pc-hint">{t('auth.enrolHint')}</p>
            </div>
          </form>

          {accounts.length > 0 && (
            <div className="auth__demo-box">
              <button
                type="button"
                className="auth__demo-trigger"
                onClick={() => setDemoOpen((prev) => !prev)}
                aria-expanded={demoOpen}
              >
                <ShieldIcon size={15} />
                <span className="auth__demo-trigger-label">{t('auth.showDemoAccounts')}</span>
                <span className="auth__demo-pass">{t('auth.demoPasswordLabel', { password: 'myopiaguard' })}</span>
                <ChevronIcon size={14} className={`auth__demo-chevron ${demoOpen ? 'is-open' : ''}`} />
              </button>

              {demoOpen && (
                <div className="auth__accounts">
                  {accounts.map((account) => {
                    const isSelected = username === account.username;
                    return (
                      <button
                        key={account.username}
                        type="button"
                        className={`auth__account ${isSelected ? 'auth__account--active' : ''}`}
                        onClick={() => useAccount(account)}
                      >
                        <span
                          className="avatar"
                          style={
                            account.role === 'admin'
                              ? { background: 'var(--petrol-100)', color: 'var(--petrol-700)' }
                              : { background: 'var(--distance-100)', color: 'var(--distance-700)' }
                          }
                        >
                          {account.role === 'admin' ? 'SA' : 'T'}
                        </span>
                        <span className="auth__account-meta grow">
                          <span className="auth__account-name">{account.displayName}</span>
                          <span className="auth__account-login">{account.username}</span>
                        </span>
                        <span className="auth__account-badge">
                          {account.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleTeacher')}
                        </span>
                      </button>
                    );
                  })}
                  <p className="auth__pc-hint">{t('auth.demoHint')}</p>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * The far layer of the hero: a room receding to its vanishing point, with the sun
 * sitting on the horizon at the centre of that recession.
 *
 * Every ray and floor line is derived from one vanishing point, so the geometry is
 * genuine one-point perspective rather than decorative hatching — the same reason
 * the break screen anchors on a horizon. Rendered with `slice` so it fills the field
 * at any aspect ratio.
 */
function RoomToHorizon() {
  // The vanishing point: the far end of the room, and where the sun sits.
  const VP = { x: 392, y: 196 };
  const W = 640;
  const H = 300;

  // Floor courses: spacing grows away from the horizon, which is what makes a flat
  // set of lines read as a receding surface rather than as stripes.
  const floorLines = [3, 8, 16, 28, 46, 70, 100].map((offset) => VP.y + offset);
  const ceilingLines = [4, 11, 22, 40, 64].map((offset) => VP.y - offset);

  // Rays fanning from the vanishing point out past every corner of the frame.
  const floorRayTargets = [-240, 40, 200, 392, 584, 744, 1024];
  const ceilingRayTargets = [-200, 90, 240, 392, 544, 694, 984];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Looking down a classroom toward a horizon, with the sun at the vanishing point."
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#06201a" />
          <stop offset="46%" stopColor="#0d3327" />
          <stop offset="78%" stopColor="#1c4b34" />
          <stop offset="100%" stopColor="#3a5f38" />
        </linearGradient>
        <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffe6c9" stopOpacity="0.95" />
          <stop offset="34%" stopColor="#ee8558" stopOpacity="0.58" />
          <stop offset="100%" stopColor="#e0603c" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="haze" cx="50%" cy="100%" r="70%">
          <stop offset="0%" stopColor="#ffd6aa" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#ffd6aa" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="floorFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0b2b23" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#06201a" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      <rect width={W} height={H} fill="url(#sky)" />

      {/* The sun at the vanishing point, its glow spreading along the horizon */}
      <circle cx={VP.x} cy={VP.y} r="124" fill="url(#sunGlow)" />
      <circle cx={VP.x} cy={VP.y} r="19" fill="#ffe6c9" opacity="0.9" />

      {/* The horizon: the light everything recedes toward */}
      <rect x="0" y={VP.y} width={W} height="48" fill="url(#haze)" />
      <line x1="0" y1={VP.y} x2={W} y2={VP.y} stroke="#ffd6aa" strokeOpacity="0.42" strokeWidth="1.2" />

      {/* Ceiling rays */}
      {ceilingRayTargets.map((target) => (
        <line key={`c${target}`} x1={VP.x} y1={VP.y} x2={target} y2={-120} stroke="#7fe0c0" strokeOpacity="0.12" strokeWidth="1" />
      ))}

      {/* Floor rays */}
      {floorRayTargets.map((target) => (
        <line key={`f${target}`} x1={VP.x} y1={VP.y} x2={target} y2={H + 80} stroke="#7fe0c0" strokeOpacity="0.15" strokeWidth="1" />
      ))}

      {/* Floor courses, spreading as they approach the viewer */}
      {floorLines.map((y) => (
        <line key={`fl${y}`} x1="-60" y1={y} x2={W + 60} y2={y} stroke="#7fe0c0" strokeOpacity="0.09" strokeWidth="1" />
      ))}

      {/* Ceiling courses */}
      {ceilingLines.map((y) => (
        <line key={`cl${y}`} x1="-60" y1={y} x2={W + 60} y2={y} stroke="#7fe0c0" strokeOpacity="0.07" strokeWidth="1" />
      ))}

      {/* Mist settling into the room, so the far end is hazier than the near */}
      <rect y={VP.y} width={W} height={H - VP.y} fill="url(#floorFade)" />
    </svg>
  );
}
