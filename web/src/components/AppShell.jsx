import { Link, useLocation } from 'react-router-dom';
import { authStore } from '../api/client.js';
import { useClassroom, useSession } from '../App.jsx';
import { useI18n } from '../i18n/index.jsx';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { ToastRegion } from './ui.jsx';
import { ChartIcon, DocIcon, EyeIcon, GlobeIcon, MonitorIcon, SlidersIcon } from '../lib/icons.jsx';
import { initials } from '../lib/format.js';

/**
 * The application frame: identity, navigation, the classroom switcher, the
 * language switcher and the live-connection indicator.
 *
 * The indicator matters — a teacher deciding whether to trust the board needs to
 * know it is live rather than five minutes stale.
 */
export default function AppShell({ children }) {
  const session = useSession();
  const { classrooms, classroom, setClassroomId } = useClassroom();
  const location = useLocation();
  const { t } = useI18n();
  const isAdmin = session.user?.role === 'admin';

  const navItems = isAdmin
    ? [{ to: '/school', label: t('nav.schoolAnalytics'), icon: <ChartIcon size={15} /> }]
    : [
        { to: '/teacher', label: t('nav.classroom'), icon: <EyeIcon size={15} />, end: true },
        { to: '/teacher/report', label: t('nav.weeklyReport'), icon: <DocIcon size={15} /> },
        { to: '/teacher/focus', label: t('nav.focusMode'), icon: <GlobeIcon size={15} /> },
        { to: '/teacher/setup', label: t('nav.setup'), icon: <SlidersIcon size={15} /> },
      ];

  return (
    <div className="shell">
      <header className="topbar">
        <Link to={isAdmin ? '/school' : '/teacher'} className="brand">
          <span className="brand__mark">
            <EyeIcon size={17} />
          </span>
          <span className="stack stack--tight" style={{ gap: 0 }}>
            <span className="brand__name">MyopiaGuard</span>
            <span className="brand__sub">{t('nav.tagline')}</span>
          </span>
        </Link>

        <nav className="nav" aria-label={t('nav.main')}>
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={
                (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)) ? 'page' : undefined
              }
            >
              <span className="row" style={{ gap: 7 }}>
                {item.icon}
                <span className="nav-label">{item.label}</span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="topbar__right">
          {!isAdmin && classrooms.length > 0 && (
            <label className="row" style={{ gap: 8 }}>
              <span className="sr-only">{t('nav.classroom')}</span>
              <select
                className="select"
                style={{ width: 'auto', minWidth: 210 }}
                value={classroom?.id ?? ''}
                onChange={(event) => setClassroomId(event.target.value)}
              >
                {classrooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.gradeName} · {room.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <span
            className={`live-pill ${session.live.connected ? 'live-pill--on' : session.live.degraded ? 'live-pill--off' : ''}`}
            title={
              session.live.connected
                ? t('nav.liveConnected')
                : session.live.degraded
                  ? t('nav.liveDegraded')
                  : t('nav.liveConnecting')
            }
          >
            <span className="live-pill__dot" />
            {session.live.connected
              ? t('nav.live')
              : session.live.degraded
                ? t('nav.livePolling')
                : t('nav.liveConnectingShort')}
          </span>

          <Link
            to="/device"
            className="btn btn--sm btn--ghost"
            title={t('nav.classroomPcTitle')}
            onClick={() => authStore.lastClassroomId === undefined && null}
          >
            <MonitorIcon size={15} />
            <span className="btn-label">{t('nav.classroomPc')}</span>
          </Link>

          <LanguageSwitcher />

          <div className="user-chip">
            <span className="avatar">{initials(session.user.displayName)}</span>
            <span className="user-chip__meta">
              <span className="user-chip__name">{session.user.displayName}</span>
              <span className="user-chip__role">{isAdmin ? t('auth.roleAdmin') : t('auth.roleTeacher')}</span>
            </span>
          </div>

          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={session.signOut}
            aria-label={t('nav.signOut')}
            title={t('nav.signOut')}
          >
            {t('nav.signOut')}
          </button>
        </div>
      </header>

      {children}

      <ToastRegion toasts={session.toasts.toasts} onDismiss={session.toasts.dismiss} />
    </div>
  );
}
