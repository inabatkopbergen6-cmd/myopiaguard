import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { authStore, api } from '../api/client.js';
import { useLiveSocket } from '../api/hooks.js';
import BreakChallenge, { AttentionTakeover } from '../components/Takeovers.jsx';
import { SessionWarningBanner, useSessionNotices, useWarningCopy } from '../components/SessionWarnings.jsx';
import { Badge, Callout, Card, ErrorNote, Spinner, ToastRegion } from '../components/ui.jsx';
import { useI18n } from '../i18n/index.jsx';
import { isSupportedLanguage } from '../i18n/languages.js';
import { BellIcon, CheckIcon, ClockIcon, EyeIcon, GlobeIcon, MonitorIcon, PlayIcon, ShieldIcon, StopIcon } from '../lib/icons.jsx';
import { clockTime, duration, mmss } from '../lib/format.js';

const AGENT_VERSION = 'web-agent/1.0';

/**
 * Classroom PC agent (the student-facing surface).
 *
 * The schedule is not decided here. The server owns the cadence, the instruction
 * text and the deadline; this view renders the state it is given and reports what
 * happened. That is why closing the tab, reloading mid-break, or losing the network
 * cannot change a child's break rhythm — on reconnect the agent is handed the true
 * current state, including a break already in progress.
 *
 * It runs at `/device?token=…` (or with a stored token), and is designed for a
 * kiosk window: full-screen takeover for breaks, non-blocking banners for warnings,
 * an overlay for teacher attention, and a quiet status panel for the school's IT
 * staff that a student has no reason to touch.
 *
 * **Language.** The room's language comes from the server (`config.language`),
 * because a classroom PC has no user account to store a preference against and a
 * kiosk should not offer a language control to whoever sits down. `?lang=`
 * overrides it for support and testing, for this session only.
 */
export default function DevicePage() {
  const { t, tn, setLang } = useI18n();
  const [token, setToken] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) {
      authStore.agentToken = fromUrl;
      // Keep the token out of the address bar so a screenshot or a shared link
      // cannot enrol a stranger's machine.
      window.history.replaceState({}, '', '/device');
      return fromUrl;
    }
    return authStore.agentToken ?? null;
  });
  const [tokenInput, setTokenInput] = useState('');
  const [enrolmentError, setEnrolmentError] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [breakError, setBreakError] = useState(null);
  const [attentionOverride, setAttentionOverride] = useState(null);
  const [settledBreakId, setSettledBreakId] = useState(null);
  const notices = useSessionNotices();
  const warningCopy = useWarningCopy();
  const lastWarningRef = useRef(null);

  /** Read once: a support override applies to this session and is never saved. */
  const langOverride = useRef(
    (() => {
      const requested = new URLSearchParams(window.location.search).get('lang');
      return isSupportedLanguage(requested) ? requested.toLowerCase() : null;
    })(),
  );

  useEffect(() => {
    if (langOverride.current) setLang(langOverride.current, { persist: false });
  }, [setLang]);

  // The room's language is authoritative unless an override was requested.
  const roomLanguage = state?.config?.language;
  useEffect(() => {
    if (!langOverride.current && isSupportedLanguage(roomLanguage)) {
      setLang(roomLanguage.toLowerCase(), { persist: false });
    }
  }, [roomLanguage, setLang]);

  // One-second local tick drives the visible countdown only.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Skip reasons are sent as stable codes, never as English prose: the audit log
   * is the school's record and must not contain a sentence in whichever language
   * the student's screen happened to be in.
   */
  const onEvent = useCallback(
    (message) => {
      const { type, payload } = message;
      if (type === 'agent:state' && payload) {
        setState(payload);
        setError(null);
        return;
      }
      if (type === 'break:warning') {
        const copy = warningCopy(payload.kind, payload.leadSeconds, payload.dueInSeconds);
        const key = `${payload.breakEventId}:${payload.kind}`;
        if (lastWarningRef.current !== key) {
          lastWarningRef.current = key;
          notices.notify({ ...copy, id: key, ttlMs: 45_000, icon: <BellIcon size={17} /> });
        }
        notices.setBanner({ ...copy, kind: payload.kind, dueInSeconds: payload.dueInSeconds });
        return;
      }
      if (type === 'break:start') {
        setSettledBreakId(null);
        setBreakError(null);
        notices.clearAll();
        lastWarningRef.current = null;
        const parsed = Date.parse(payload.startedAt);
        setState((prev) =>
          prev
            ? {
                ...prev,
                activeBreak: {
                  breakEventId: payload.breakEventId,
                  durationSec: payload.durationSec,
                  // `Date.parse` returns NaN on a bad value, and `??` does not catch
                  // NaN — an unguarded NaN propagates into the ring maths.
                  startedAt: Number.isFinite(parsed) ? parsed : Date.now(),
                  instruction: payload.instruction,
                  longStretch: payload.longStretch,
                },
                pendingBreak: null,
              }
            : prev,
        );
        // Tell the server the overlay is really up: it records the true start time
        // and pauses the screen-time clock from that moment.
        api.agentBreakShown(token, payload.breakEventId).catch(() => {});
        api.agentState(token).then(setState).catch(() => {});
        return;
      }
      if (type === 'break:missed') {
        notices.clearAll();
        setState((prev) => (prev ? { ...prev, activeBreak: null, pendingBreak: null } : prev));
        api.agentState(token).then(setState).catch(() => {});
        return;
      }
      if (type === 'attention:show') {
        setAttentionOverride(payload);
        return;
      }
      if (type === 'attention:clear') {
        setAttentionOverride(null);
        return;
      }
      if (type === 'focus:policy') {
        setState((prev) => (prev ? { ...prev, focusPolicy: payload } : prev));
        return;
      }
      if (type === 'session:started' || type === 'session:ended') {
        api.agentHello(token, AGENT_VERSION).then(setState).catch(() => {});
        return;
      }
      if (type === 'error') {
        setError(new Error(payload?.error ?? 'connection_error'));
      }
    },
    [notices, token, warningCopy],
  );

  const live = useLiveSocket({
    agentToken: token,
    onEvent,
    enabled: Boolean(token),
    pollMs: 5000,
    onPoll: () => {
      if (token) api.agentState(token).then(setState).catch(() => {});
    },
  });

  // Heartbeat: over the socket when it is up, over REST when it is not, so a
  // classroom PC is never marked offline just because the socket dropped.
  useEffect(() => {
    if (!token || enrolmentError) return undefined;
    const beat = () => {
      if (!live.send('agent:heartbeat', { agentVersion: AGENT_VERSION })) {
        api.agentHeartbeat(token, AGENT_VERSION).then(setState).catch(() => {});
      }
    };
    beat();
    const timer = setInterval(beat, 5000);
    return () => clearInterval(timer);
  }, [token, live, enrolmentError]);

  // Initial hello: enrols this seat into the running lesson, if there is one.
  // A rejected credential is terminal, not transient: re-enrolment is the fix, and
  // retrying forever would just fill the console (and the server log) with noise.
  useEffect(() => {
    if (!token) return;
    setError(null);
    api
      .agentHello(token, AGENT_VERSION)
      .then((next) => {
        setState(next);
        setEnrolmentError(null);
      })
      .catch((caught) => {
        if (caught?.status === 401 || caught?.status === 403) {
          authStore.agentToken = null;
          setToken(null);
          setState(null);
          setEnrolmentError('invalid_token');
          return;
        }
        setError(caught);
      });
  }, [token]);

  // A break dismissed by minimising the window is still a skipped break.
  const activeBreak = state?.activeBreak;
  useEffect(() => {
    if (!activeBreak || settledBreakId === activeBreak.breakEventId) return undefined;
    const onHidden = () => {
      if (document.hidden) {
        api.agentBreakSkip(token, activeBreak.breakEventId, 'window_hidden').catch(() => {});
        setState((prev) => (prev ? { ...prev, activeBreak: null } : prev));
        notices.notify({
          title: t('break.skippedToastTitle'),
          text: t('break.skippedToastBody'),
          tone: 'warn',
          ttlMs: 12_000,
        });
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [activeBreak, settledBreakId, token, notices, t]);

  const attention = attentionOverride ?? state?.attention ?? null;
  const attentionRemaining = attention ? Math.max(0, Math.ceil((attention.expiresAt - now) / 1000)) : 0;

  useEffect(() => {
    if (attention && attentionRemaining <= 0) setAttentionOverride(null);
  }, [attention, attentionRemaining]);

  const completeBreak = useCallback(async () => {
    const breakId = state?.activeBreak?.breakEventId;
    if (!breakId || busy || settledBreakId === breakId) return;
    setBusy(true);
    setBreakError(null);
    try {
      await api.agentBreakComplete(token, breakId);
      setSettledBreakId(breakId);
      setState((prev) => (prev ? { ...prev, activeBreak: null, pendingBreak: null } : prev));
      notices.notify({
        title: t('break.completeToastTitle'),
        text: t('break.completeToastBody'),
        tone: 'success',
        ttlMs: 8000,
        icon: <CheckIcon size={17} />,
      });
      const fresh = await api.agentState(token);
      setState(fresh);
    } catch (caught) {
      // A clock-skew rejection means the server wants a little longer; retry once.
      if (caught?.code === 'break_not_elapsed') {
        setTimeout(() => {
          setBusy(false);
          completeBreak();
        }, 1200);
        return;
      }
      setBreakError(t('break.couldNotLog'));
    } finally {
      setBusy(false);
    }
  }, [state, token, busy, settledBreakId, notices, t]);

  const skipBreak = useCallback(
    async (reasonCode) => {
      const breakId = state?.activeBreak?.breakEventId;
      if (!breakId) return;
      setBusy(true);
      try {
        await api.agentBreakSkip(token, breakId, reasonCode);
        setSettledBreakId(breakId);
        setState((prev) => (prev ? { ...prev, activeBreak: null, pendingBreak: null } : prev));
        const fresh = await api.agentState(token);
        setState(fresh);
      } catch {
        setBreakError(t('break.couldNotRecord'));
      } finally {
        setBusy(false);
      }
    },
    [state, token, t],
  );

  const nextBreakIn = useMemo(() => {
    const pending = state?.pendingBreak;
    if (!pending || pending.status !== 'pending') return null;
    const seconds = Math.max(0, Math.round((Number(pending.dueAt) - now) / 1000));
    return { seconds, dueAt: Number(pending.dueAt) };
  }, [state, now]);

  // ---- enrolment screen
  if (!token) {
    return (
      <div className="device device--enrol">
        <header className="device__bar">
          <Link to="/login" className="brand">
            <span className="brand__mark">
              <EyeIcon size={16} />
            </span>
            <span className="brand__name">MyopiaGuard</span>
          </Link>
          <span className="auth__bar-tag">{t('device.barTitle')}</span>
          <span className="device__bar-spacer">
            <Link className="btn btn--sm btn--ghost" to="/login">
              {t('device.backToSignIn')}
            </Link>
          </span>
        </header>

        <main className="device__enrol-stage">
          <div className="device__enrol-card">
            <div className="device__enrol-head">
              <div className="device__enrol-icon">
                <MonitorIcon size={24} />
              </div>
              <div className="device__enrol-titles">
                <h2>{t('device.enrolTitle')}</h2>
                <p>{t('device.enrolSubtitle')}</p>
              </div>
            </div>

            {enrolmentError && (
              <div className="callout callout--danger" style={{ marginBottom: 16 }}>
                <div>
                  <strong style={{ display: 'block', fontSize: '0.86rem' }}>{t('device.notEnrolledTitle')}</strong>
                  <span className="small">{t('device.notEnrolledInvalid')}</span>
                </div>
              </div>
            )}

            <form
              className="device__enrol-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = tokenInput.trim();
                if (!value) return;
                authStore.agentToken = value;
                setEnrolmentError(null);
                setToken(value);
              }}
            >
              <label className="field">
                <span>{t('device.seatTokenLabel')}</span>
                <input
                  className="input mono"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder={t('device.seatTokenPlaceholder')}
                  required
                  autoFocus
                />
                <span className="field__hint">{t('device.seatTokenHint')}</span>
              </label>

              <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={!tokenInput.trim()}>
                <CheckIcon size={16} />
                {t('device.enrolButton')}
              </button>
            </form>

            <div className="device__enrol-foot">
              <Link className="btn btn--block btn--ghost" to="/login">
                {t('device.backToSignIn')}
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="device">
      <header className="device__bar">
        <MonitorIcon size={16} />
        <strong>{state?.seat?.label ?? t('nav.liveConnecting')}</strong>
        <span className="muted" style={{ opacity: 0.75 }}>
          {state ? `${state.classroom.gradeName} · ${state.classroom.name}` : ''}
        </span>
        <span className="device__bar-spacer">
          {state?.focusPolicy?.active && (
            <Badge tone="brand" className="badge" dot={false}>
              <GlobeIcon size={12} /> {t('device.focusBadge')}
            </Badge>
          )}
          <Badge tone={live.connected ? 'active' : 'attention'} className="badge">
            {live.connected ? t('device.connected') : t('device.reconnecting')}
          </Badge>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            style={{ color: '#c9d8d4' }}
            onClick={() => {
              authStore.agentToken = null;
              setToken(null);
              setState(null);
            }}
          >
            {t('device.unenrol')}
          </button>
        </span>
      </header>

      <div className="device__body">
        {error && <ErrorNote error={error} />}

        {!state && !error && (
          <Card>
            <Spinner label={t('device.contacting')} />
          </Card>
        )}

        {state && (
          <>
            {!state.lesson.active ? (
              <Card title={t('device.waitingTitle')} subtitle={t('device.waitingSubtitle')}>
                <div className="row" style={{ gap: 12 }}>
                  <ClockIcon size={18} />
                  <span className="small muted">{t('device.waitingBody')}</span>
                </div>
              </Card>
            ) : (
              <>
                <SessionWarningBanner
                  warning={notices.banner}
                  nextBreakIn={nextBreakIn}
                  onDismiss={() => notices.setBanner(null)}
                />

                <Card title={t('device.routineTitle')} subtitle={t('device.routineSubtitle')}>
                  <div className="stat-strip" style={{ marginBottom: 0 }}>
                    <div className="stat">
                      <div className="stat__label">{t('device.currentStretch')}</div>
                      <div className="stat__value">{duration(state.session?.stretchSeconds ?? 0)}</div>
                      <div className="stat__foot">
                        {state.session?.state === 'on_break'
                          ? t('device.currentStretchFootPaused')
                          : t('device.currentStretchFootActive', { minutes: state.config.breakIntervalMin })}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">{t('device.nextBreak')}</div>
                      <div className="stat__value">
                        {state.activeBreak ? t('device.nextBreakNow') : nextBreakIn ? mmss(nextBreakIn.seconds) : '—'}
                      </div>
                      <div className="stat__foot">
                        {nextBreakIn
                          ? t('device.nextBreakAt', { time: clockTime(nextBreakIn.dueAt) })
                          : t('device.nextBreakAfter')}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">{t('device.breakLength')}</div>
                      <div className="stat__value">
                        {state.config.breakDurationSec}
                        <span className="stat__unit">{t('units.secondsShort')}</span>
                      </div>
                      <div className="stat__foot">{t('device.breakLengthFoot')}</div>
                    </div>
                    <div className="stat">
                      <div className="stat__label">{t('device.screenTimeLesson')}</div>
                      <div className="stat__value">
                        {duration((state.session?.activeSeconds ?? 0) + (state.session?.stretchSeconds ?? 0))}
                      </div>
                      <div className="stat__foot">
                        {t('device.screenTimeFoot', { time: clockTime(state.lesson.startedAt) })}
                      </div>
                    </div>
                  </div>
                </Card>

                <Card title={t('device.nextTitle')} subtitle={t('device.nextSubtitle')}>
                  <div className="stack stack--tight">
                    <div className="countdown-strip">
                      <BellIcon size={16} />
                      <span className="grow">{t('device.nextWarnings')}</span>
                      <strong>
                        {state.config.warnLead5Min ? t('device.nextWarningsValue') : t('device.nextWarningsOff')}
                      </strong>
                    </div>
                    <div className="countdown-strip">
                      <PlayIcon size={16} />
                      <span className="grow">
                        {t('device.nextChallenge', {
                          seconds: tn(state.config.breakDurationSec, 'device.nextChallengeSeconds'),
                        })}
                      </span>
                      <strong>{t('device.nextChallengeValue')}</strong>
                    </div>
                  </div>
                </Card>

                {state.focusPolicy?.active && (
                  <Card title={t('device.focusOnTitle')} subtitle={t('device.focusOnSubtitle')}>
                    <div className="row row--wrap">
                      {(state.focusPolicy.allowedDomains ?? []).map((domain) => (
                        <Badge key={domain.domain} tone="brand" dot={false}>
                          {domain.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="small muted" style={{ marginTop: 10 }}>
                      {/* Composed here rather than echoing the server's English summary. */}
                      {state.focusPolicy.allowedDomains?.length
                        ? t('device.focusSummaryOn', {
                            resources: state.focusPolicy.allowedDomains.map((entry) => entry.name).join(', '),
                          })
                        : t('device.focusSummaryNone')}{' '}
                      {t('device.focusAskTeacher')}
                    </p>
                    <Callout tone="privacy" icon={<ShieldIcon size={16} />}>
                      <span className="small">{t('device.focusReassurance')}</span>
                    </Callout>
                  </Card>
                )}
              </>
            )}

            <Card title={t('device.statusTitle')} subtitle={t('device.statusSubtitle')}>
              <dl className="kv">
                <dt>{t('device.statusSeat')}</dt>
                <dd className="mono">{state.seat.label}</dd>
                <dt>{t('device.statusBuild')}</dt>
                <dd className="mono">{AGENT_VERSION}</dd>
                <dt>{t('device.statusTransport')}</dt>
                <dd>{live.connected ? t('device.statusTransportLive') : t('device.statusTransportPoll')}</dd>
                <dt>{t('device.statusCadence')}</dt>
                <dd>
                  {t('device.statusCadenceValue', {
                    minutes: state.config.breakIntervalMin,
                    seconds: state.config.breakDurationSec,
                  })}
                </dd>
                <dt>{t('device.statusOfflineThreshold')}</dt>
                <dd>{t('device.statusOfflineValue', { seconds: state.config.offlineAfterSec })}</dd>
                <dt>{t('device.statusServerTime')}</dt>
                <dd className="mono">{clockTime(state.serverTime)}</dd>
              </dl>
              {state.demoMode && (
                <Callout tone="warn" icon={<StopIcon size={16} />} className="stack">
                  <div>
                    <span className="small">{t('device.demoNotice')}</span>
                  </div>
                </Callout>
              )}
            </Card>
          </>
        )}
      </div>

      {/* Full-screen surfaces last, so they always win the stacking order. */}
      {attention && attentionRemaining > 0 && (
        <AttentionTakeover
          broadcast={attention}
          secondsRemaining={attentionRemaining}
          canDismiss={false}
          onDismiss={() => setAttentionOverride(null)}
        />
      )}

      {activeBreak && settledBreakId !== activeBreak.breakEventId && (
        <BreakChallenge
          durationSec={activeBreak.durationSec}
          instruction={activeBreak.instruction}
          instructionKey={activeBreak.instruction?.key}
          startedAt={activeBreak.startedAt}
          longStretch={activeBreak.longStretch}
          seatLabel={state?.seat?.label}
          onComplete={completeBreak}
          onSkip={skipBreak}
          busy={busy}
          error={breakError}
          variant="student"
        />
      )}

      <ToastRegion toasts={notices.toasts} onDismiss={notices.dismiss} />
    </div>
  );
}
