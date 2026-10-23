/**
 * Mobile login entry (T1: UI shell + loginApi seam; the full REQ-E-10 flow
 * ships in T2). The page calls `loginApi.sendCode` / `loginApi.verifyCode`
 * for every action — no fetch, no hard-coded outcomes — so wiring the real
 * control plane later only changes loginApi.ts.
 *
 * The import graph stays tiny (react + mobile i18n + loginApi): the control
 * plane serves this bundle before any session exists and it must fit the
 * 80 KB gzip budget (REQ-E-19). No desktop i18n, no redux, no Tailwind, no
 * window.electron: styling is inline.
 */

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { mobileI18n, t } from '../i18n';
import { sendCode, verifyCode } from './loginApi';

mobileI18n.initFromDeviceLocale();

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
  note: { fontSize: 13, color: '#64748B', textAlign: 'center', margin: 0 },
  error: { fontSize: 13, color: '#B42318', textAlign: 'center', margin: 0 },
};

function normalizePhone(input: string): string {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{11}$/.test(digits) ? `+86${digits}` : digits;
}

function LoginPage(): JSX.Element {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tenantStatus, setTenantStatus] = useState('');

  const onSendCode = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await sendCode(normalizePhone(phone));
      setCodeSent(true);
      console.info('[login] resendAfterSec', result.resendAfterSec);
    } catch {
      setError(t('mobile.login.invalidPhone'));
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await verifyCode(normalizePhone(phone), code);
      setTenantStatus(result.tenant.status);
    } catch {
      setError(t('mobile.login.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

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
      <button type="button" onClick={onSendCode} disabled={busy || !phone} style={styles.button}>
        {t('mobile.login.sendCode')}
      </button>
      {codeSent && (
        <>
          <p style={styles.note}>{t('mobile.login.codeSent', { sec: 60 })}</p>
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t('mobile.login.codePlaceholder')}
            style={styles.input}
          />
          <button type="button" onClick={onVerify} disabled={busy || !code} style={styles.button}>
            {t('mobile.login.verify')}
          </button>
        </>
      )}
      {tenantStatus && <p style={styles.note}>{t('mobile.login.verified', { status: tenantStatus })}</p>}
      {error && <p style={styles.error}>{error}</p>}
      <p style={styles.note}>{t('mobile.login.demoNote')}</p>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LoginPage />
  </React.StrictMode>,
);
