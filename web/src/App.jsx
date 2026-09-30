import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api, authStore } from './api/client.js';
import { publishLive, useLiveSocket } from './api/hooks.js';
import AppShell from './components/AppShell.jsx';
import { I18nProvider, useI18n } from './i18n/index.jsx';
import LoginPage from './pages/LoginPage.jsx';
import TeacherDashboard from './pages/TeacherDashboard.jsx';
import WeeklyReportPage from './pages/WeeklyReportPage.jsx';
import FocusModePage from './pages/FocusModePage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import SchoolAnalyticsPage from './pages/SchoolAnalyticsPage.jsx';
import DevicePage from './pages/DevicePage.jsx';

/**
 * Session context. One place that knows who is signed in, which classrooms they
 * may see, and whether the live socket is up — every page reads from here rather
 * than fetching `/me` again.
 */
const SessionContext = createContext(null);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function useClassroom() {
  const session = useSession();
  const [classroomId, setClassroomIdState] = useState(() => authStore.lastClassroomId);

  const classrooms = session.classrooms;
  const resolved = useMemo(() => {
    if (classrooms.length === 0) return null;
    const fromStore = classrooms.find((room) => room.id === classroomId);
    return fromStore ?? classrooms[0];
  }, [classrooms, classroomId]);

  const setClassroomId = useCallback((id) => {
    authStore.lastClassroomId = id;
    setClassroomIdState(id);
  }, []);

  return { classrooms, classroom: resolved, classroomId: resolved?.id ?? null, setClassroomId };
}

export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((toast) => {
    const id = toast.id ?? `toast_${Math.random().toString(36).slice(2, 9)}`;
    const entry = { tone: 'info', ...toast, id, createdAt: Date.now() };
    setToasts((prev) => [...prev.filter((item) => item.id !== id), entry]);
    if (entry.ttlMs) {
      setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), entry.ttlMs);
    }
    return id;
  }, []);

  const dismiss = useCallback((id) => setToasts((prev) => prev.filter((item) => item.id !== id)), []);
  const clear = useCallback(() => setToasts([]), []);

  return { toasts, push, dismiss, clear };
}

/**
 * Writes the chosen language to the signed-in account so it follows the person to
 * another computer. Fire-and-forget: the choice has already been applied locally,
 * and a failed save must not interrupt a lesson.
 */
function persistLanguage(code) {
  if (!authStore.token) return;
  api.updatePreferences({ language: code }).catch(() => {});
}

/**
 * The provider sits above everything, including the classroom-PC view, because a
 * student's break screen must be translated too — and that screen is served by the
 * device route, which has no session at all.
 */
export default function App() {
  return (
    <I18nProvider onPersist={persistLanguage}>
      <AppRoutes />
    </I18nProvider>
  );
}

function AppRoutes() {
  const [session, setSession] = useState({ status: 'loading', user: null, classrooms: [], error: null });
  const location = useLocation();
  const navigate = useNavigate();
  const toasts = useToasts();
  const { applyAccountLanguage } = useI18n();

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the token is being discarded regardless */
    }
    authStore.clear();
    setSession({ status: 'anonymous', user: null, classrooms: [], error: null });
    navigate('/login', { replace: true });
  }, [navigate]);

  const refreshSession = useCallback(async () => {
    if (!authStore.token) {
      setSession({ status: 'anonymous', user: null, classrooms: [], error: null });
      return null;
    }
    try {
      const me = await api.me();
      setSession({ status: 'signed-in', user: me.user, classrooms: me.classrooms ?? [], error: null });
      // The account's saved language wins over the local guess, once per account.
      applyAccountLanguage(me.user.id, me.user.preferences?.language);
      return me;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) authStore.clear();
      setSession({ status: 'anonymous', user: null, classrooms: [], error });
      return null;
    }
  }, [applyAccountLanguage]);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  const onLiveEvent = useCallback(
    (message) => {
      if (message.type === 'error' && message.payload?.error === 'unauthorized') {
        signOut();
        return;
      }
      // Fan out to whichever page is mounted. Pages never open their own socket.
      publishLive(message);
    },
    [signOut],
  );

  const live = useLiveSocket({
    token: session.status === 'signed-in' ? authStore.token : null,
    onEvent: onLiveEvent,
    enabled: session.status === 'signed-in',
    onPoll: refreshSession,
  });

  const value = useMemo(
    () => ({ ...session, signOut, refreshSession, live, toasts }),
    [session, signOut, refreshSession, live, toasts],
  );

  if (location.pathname === '/device' || location.pathname.startsWith('/device/')) {
    return <DevicePage />;
  }

  if (session.status === 'loading') {
    return <SessionLoading />;
  }

  return (
    <SessionContext.Provider value={value}>
      <Routes>
        <Route path="/login" element={<LoginPage onSignedIn={refreshSession} />} />
        <Route
          path="/teacher/*"
          element={
            <RequireRole role="teacher">
              <AppShell>
                <Routes>
                  <Route path="/" element={<TeacherDashboard />} />
                  <Route path="report" element={<WeeklyReportPage />} />
                  <Route path="focus" element={<FocusModePage />} />
                  <Route path="setup" element={<SetupPage />} />
                  <Route path="*" element={<Navigate to="/teacher" replace />} />
                </Routes>
              </AppShell>
            </RequireRole>
          }
        />
        <Route
          path="/school"
          element={
            <RequireRole role="admin">
              <AppShell>
                <SchoolAnalyticsPage />
              </AppShell>
            </RequireRole>
          }
        />
        <Route path="*" element={<Landing />} />
      </Routes>
    </SessionContext.Provider>
  );
}

/** Shown while the session is restored; also the first paint of a translated app. */
function SessionLoading() {
  const { t } = useI18n();
  return (
    <div className="auth">
      <header className="auth__bar">
        <span className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </span>
          <span className="brand__name">MyopiaGuard</span>
        </span>
        <span className="auth__bar-tag">{t('auth.brandTag')}</span>
      </header>
      <main className="auth__main" style={{ display: 'block' }}>
        <div className="stack" style={{ alignItems: 'center', paddingTop: 60 }}>
          <div className="spinner" />
          <p className="muted small">{t('nav.restoringSession')}</p>
        </div>
      </main>
    </div>
  );
}

function RequireRole({ role, children }) {
  const session = useSession();
  if (session.status !== 'signed-in') return <Navigate to="/login" replace />;
  if (session.user.role !== role) {
    // A signed-in admin has no teacher dashboard and vice versa: send them to the
    // surface their role actually owns rather than showing a broken page.
    return <Navigate to={session.user.role === 'admin' ? '/school' : '/teacher'} replace />;
  }
  return children;
}

/** `/` sends each role to the surface it owns, and anonymous visitors to sign-in. */
function Landing() {
  const session = useContext(SessionContext);
  if (!session || session.status !== 'signed-in') return <Navigate to="/login" replace />;
  return <Navigate to={session.user.role === 'admin' ? '/school' : '/teacher'} replace />;
}
