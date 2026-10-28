/**
 * Mobile login entry (REQ-E-10): full SMS sign-in / invite-only sign-up flow
 * on top of the loginApi C3 seam — every action goes through loginApi, no
 * fetch and no hard-coded outcomes, so wiring the real control plane later
 * only changes loginApi.ts.
 *
 * Also renders the WeChat/QQ in-app browser guide (those webviews cannot
 * finish sign-in) and the iPhone Safari "Add to Home Screen" hint.
 *
 * The import graph stays tiny (react + mobile i18n + loginApi +
 * inAppBrowser): the control plane serves this bundle before any session
 * exists and it must fit the 80 KB gzip budget (REQ-E-19). No desktop i18n,
 * no redux, no Tailwind, no window.electron: styling is inline.
 */

import '../native/installNativeBootstrapFirst';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { mobileI18n, t } from '../i18n';
import {
  copyTextToClipboard,
  isInAppBrowser,
  isIosSafari,
  isStandaloneDisplay,
} from './inAppBrowser';
import { getMe, logout, sendCode, verifyCode } from './loginApi';
import type { LoginTenant } from './loginApi';

mobileI18n.initFromDeviceLocale();

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 24;
const PREPARE_POLL_MS = 3000;

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 'max(env(safe-area-inset-top), 24px) 24px max(env(safe-area-inset-bottom), 24px)',
    backgroundColor: '#F5F7F9',
    color: '#303133',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  guidePage: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  guideSheet: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#fff',
    color: '#303133',
    borderRadius: '20px 20px 0 0',
    padding: '24px 24px max(env(safe-area-inset-bottom), 24px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    boxShadow: '0 -8px 30px rgba(15, 23, 42, 0.18)',
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: '#ffdc51',
    color: '#111',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 24,
    fontWeight: 700,
  },
  title: { fontSize: 20, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 14, color: '#64748B', textAlign: 'center', margin: 0 },
  subtitleLeft: { fontSize: 14, color: '#64748B', textAlign: 'left', margin: 0, lineHeight: 1.6 },
  input: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 12,
    border: '1px solid #BFC2CC',
    backgroundColor: '#fff',
    padding: '12px 16px',
    fontSize: 14,
    color: '#303133',
  },
  button: {
    width: '100%',
    maxWidth: 320,
    minHeight: 44,
    borderRadius: 12,
    border: 'none',
    backgroundColor: '#ffdc51',
    color: '#111',
    fontSize: 15,
    fontWeight: 600,
  },
  textButton: {
    border: 'none',
    backgroundColor: 'transparent',
    color: '#64748B',
    fontSize: 13,
    padding: 8,
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    width: '100%',
    maxWidth: 320,
    fontSize: 13,
    lineHeight: 1.5,
    color: '#475569',
  },
  link: { color: '#1D4ED8', textDecoration: 'none' },
  note: { fontSize: 13, color: '#64748B', textAlign: 'center', margin: 0 },
  noteSmall: { fontSize: 12, color: '#94A3B8', textAlign: 'center', margin: 0 },
  error: { fontSize: 13, color: '#B42318', textAlign: 'center', margin: 0 },
  statusWord: { fontSize: 16, fontWeight: 600, margin: 0 },
  a2hsCard: {
    position: 'fixed',
    left: 12,
    right: 12,
    bottom: 'max(env(safe-area-inset-bottom), 12px)',
    maxWidth: 456,
    margin: '0 auto',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: '14px 16px',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    boxShadow: '0 8px 30px rgba(15, 23, 42, 0.14)',
    zIndex: 10,
  },
  a2hsTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 4px', color: '#303133' },
  a2hsDismiss: {
    border: 'none',
    backgroundColor: '#ffdc51',
    borderRadius: 10,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    color: '#111',
    flexShrink: 0,
  },
};

function normalizePhone(input: string): string {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{11}$/.test(digits) ? `+86${digits}` : digits;
}

function isValidDisplayName(name: string): boolean {
  const length = name.trim().length;
  return length >= DISPLAY_NAME_MIN && length <= DISPLAY_NAME_MAX;
}

function readErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Localized copy for every loginApi error code the sign-in path can hit. */
function verifyErrorText(code: string | undefined): string {
  switch (code) {
    case 'INVITE_REQUIRED':
      return t('mobile.login.inviteRequired');
    case 'INVITE_INVALID':
      return t('mobile.login.inviteInvalid');
    case 'INVITE_EXHAUSTED':
      return t('mobile.login.inviteExhausted');
    case 'CODE_EXPIRED':
      return t('mobile.login.codeExpired');
    case 'CODE_INVALID':
      return t('mobile.login.invalidCode');
    default:
      return t('mobile.login.genericError');
  }
}

/** Polls `getMe` after a successful verify until the tenant opens the app. */
function PreparingScreen(props: { onSignOut: () => void }): JSX.Element {
  const [tenant, setTenant] = useState<LoginTenant | null>(null);

  useEffect(() => {
    let cancelled = false;
    let navigated = false;
    const tick = async () => {
      try {
        const me = await getMe();
        if (cancelled || navigated) {
          return;
        }
        setTenant(me.tenant);
        // `degraded` still opens the app (C3): the tenant serves with
        // reduced functionality instead of blocking the user.
        if (me.tenant.status === 'ready' || me.tenant.status === 'degraded') {
          navigated = true;
          window.location.assign('/app/');
        }
      } catch {
        // Transient poll failure: the next 3 s tick retries.
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, PREPARE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const failed = tenant?.status === 'failed';

  return (
    <div style={styles.page}>
      <div style={styles.logo}>ID</div>
      <h1 style={styles.title}>{t('mobile.login.preparingTitle')}</h1>
      <p style={styles.statusWord}>
        {t(`mobile.login.preparingStatus.${tenant?.status ?? 'provisioning'}`)}
      </p>
      {tenant?.phase && <p style={styles.note}>{tenant.phase}</p>}
      {!failed && <p style={styles.note}>{t('mobile.login.preparingNote')}</p>}
      {failed && (
        <>
          <p style={styles.error}>
            {t('mobile.login.preparingFailed', {
              message: tenant?.error ?? t('mobile.common.error'),
            })}
          </p>
          {/* Placeholder until the owner provides the real support channel. */}
          <p style={styles.note}>{t('mobile.login.supportContact')}</p>
        </>
      )}
      <button type="button" style={styles.textButton} onClick={props.onSignOut}>
        {t('mobile.login.signOut')}
      </button>
    </div>
  );
}

function LoginPage(): JSX.Element {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inviteVisible, setInviteVisible] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [displayNameVisible, setDisplayNameVisible] = useState(false);
  const [displayName, setDisplayName] = useState(() => t('mobile.login.displayNameDefault'));
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [hkConsent, setHkConsent] = useState(false);
  const [preparing, setPreparing] = useState(false);

  // 1 s ticks for the resend countdown started by sendCode's resendAfterSec.
  useEffect(() => {
    if (countdown <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const normalizedPhone = normalizePhone(phone);
  const displayNameReady = !displayNameVisible || isValidDisplayName(displayName);
  const canSignIn = !busy && code.length > 0 && agreeTerms && hkConsent && displayNameReady;

  const onSendCode = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await sendCode(normalizedPhone);
      setCodeSent(true);
      setCountdown(result.resendAfterSec);
    } catch (sendError) {
      setError(
        readErrorCode(sendError) === 'INVALID_PHONE'
          ? t('mobile.login.invalidPhone')
          : t('mobile.login.genericError'),
      );
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    if (!canSignIn) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await verifyCode(normalizedPhone, code, {
        inviteCode: inviteVisible && inviteCode.trim() ? inviteCode.trim() : undefined,
        displayName: displayNameVisible ? displayName.trim() : undefined,
      });
      setPreparing(true);
    } catch (verifyError) {
      const errorCode = readErrorCode(verifyError);
      // Sign-up path: a new account needs an invite and picks the on-chain
      // display name before the next verify attempt.
      if (errorCode === 'INVITE_REQUIRED') {
        setInviteVisible(true);
        setDisplayNameVisible(true);
      }
      setError(verifyErrorText(errorCode));
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    try {
      await logout();
    } finally {
      setPreparing(false);
    }
  };

  if (preparing) {
    return (
      <PreparingScreen
        onSignOut={() => {
          void onSignOut();
        }}
      />
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.logo}>ID</div>
      <h1 style={styles.title}>{t('mobile.login.title')}</h1>
      <p style={styles.subtitle}>{t('mobile.login.subtitle')}</p>
      <input
        type="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        placeholder={t('mobile.login.phonePlaceholder')}
        style={styles.input}
      />
      <button
        type="button"
        onClick={onSendCode}
        disabled={busy || !phone || countdown > 0}
        style={styles.button}
      >
        {countdown > 0 ? t('mobile.login.resendIn', { sec: countdown }) : t('mobile.login.sendCode')}
      </button>
      {codeSent && (
        <>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t('mobile.login.codePlaceholder')}
            style={styles.input}
          />
          {inviteVisible && (
            <input
              type="text"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              placeholder={t('mobile.login.invitePlaceholder')}
              style={styles.input}
            />
          )}
          {displayNameVisible && (
            <>
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('mobile.login.displayNamePlaceholder')}
                style={styles.input}
              />
              <p style={styles.note}>{t('mobile.login.displayNameNote')}</p>
              {!displayNameReady && <p style={styles.error}>{t('mobile.login.displayNameInvalid')}</p>}
            </>
          )}
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={agreeTerms}
              onChange={(event) => setAgreeTerms(event.target.checked)}
            />
            <span>
              {t('mobile.login.termsPrefix')}{' '}
              {/* Placeholder URLs — the owner provides the final Terms/Privacy links before launch. */}
              <a
                href="https://staging.idbots.world/terms"
                target="_blank"
                rel="noreferrer"
                style={styles.link}
              >
                {t('mobile.login.termsLink')}
              </a>{' '}
              {t('mobile.login.conjunction')}{' '}
              <a
                href="https://staging.idbots.world/privacy"
                target="_blank"
                rel="noreferrer"
                style={styles.link}
              >
                {t('mobile.login.privacyLink')}
              </a>
            </span>
          </label>
          {/* Data-residency consent wording is pending legal review before launch. */}
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={hkConsent}
              onChange={(event) => setHkConsent(event.target.checked)}
            />
            <span>{t('mobile.login.hkDataConsent')}</span>
          </label>
          <button type="button" onClick={onVerify} disabled={!canSignIn} style={styles.button}>
            {t('mobile.login.verify')}
          </button>
        </>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <p style={styles.noteSmall}>{t('mobile.login.demoNote')}</p>
    </div>
  );
}

/** Half-screen guide shown INSTEAD of the login form inside WeChat/QQ webviews. */
function InAppBrowserGuide(): JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopyLink = async () => {
    const copied = await copyTextToClipboard(window.location.href);
    setCopyState(copied ? 'copied' : 'failed');
  };

  return (
    <div style={styles.guidePage}>
      <div style={styles.guideSheet}>
        <h1 style={styles.title}>{t('mobile.login.inAppTitle')}</h1>
        <p style={styles.subtitleLeft}>{t('mobile.login.inAppBody')}</p>
        <button
          type="button"
          style={styles.button}
          onClick={() => {
            void onCopyLink();
          }}
        >
          {t('mobile.login.copyLink')}
        </button>
        {copyState === 'copied' && <p style={styles.note}>{t('mobile.login.linkCopied')}</p>}
        {copyState === 'failed' && <p style={styles.error}>{t('mobile.login.copyFailed')}</p>}
      </div>
    </div>
  );
}

/** Dismissible iPhone Safari hint about Share -> Add to Home Screen. */
function A2hsHint(): JSX.Element | null {
  const [visible, setVisible] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      isIosSafari(navigator.userAgent) &&
      !isStandaloneDisplay(),
  );
  if (!visible) {
    return null;
  }
  return (
    <div style={styles.a2hsCard}>
      <div style={{ flex: 1 }}>
        <p style={styles.a2hsTitle}>{t('mobile.login.a2hsTitle')}</p>
        <p style={styles.noteSmall}>{t('mobile.login.a2hsBody')}</p>
      </div>
      <button type="button" style={styles.a2hsDismiss} onClick={() => setVisible(false)}>
        {t('mobile.login.a2hsDismiss')}
      </button>
    </div>
  );
}

function MobileLoginRoot(): JSX.Element {
  if (typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)) {
    return <InAppBrowserGuide />;
  }
  return (
    <>
      <LoginPage />
      <A2hsHint />
    </>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <MobileLoginRoot />
  </React.StrictMode>,
);
