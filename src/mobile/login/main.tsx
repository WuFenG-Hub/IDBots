/**
 * Mobile login placeholder entry (T1).
 *
 * The real phone-number + SMS-code login ships in T2 (REQ-E-10). This page
 * deliberately keeps its import graph tiny — mobile i18n plus react only —
 * because the control plane serves it at `/` before any session exists and
 * it must stay inside the 80 KB gzip budget (REQ-E-19). No desktop i18n, no
 * redux, no Tailwind import, no window.electron: the bridge is not installed
 * on this bundle, so styling is inline and static.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { mobileI18n, t } from '../i18n';

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
  badge: {
    borderRadius: 999,
    border: '1px solid #BFC2CC',
    padding: '4px 16px',
    fontSize: 12,
    color: '#64748B',
  },
};

function LoginPage(): JSX.Element {
  return (
    <div style={styles.page}>
      <div style={styles.logo}>ID</div>
      <h1 style={styles.title}>{t('mobile.login.title')}</h1>
      <p style={styles.subtitle}>{t('mobile.login.subtitle')}</p>
      <input type="tel" disabled placeholder={t('mobile.login.phonePlaceholder')} style={styles.input} />
      <span style={styles.badge}>{t('mobile.login.comingSoon')}</span>
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
