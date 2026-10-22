import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/index.css';
import { mobileI18n } from '../i18n';
import MobileApp from './MobileApp';

/** Applies the OS theme before first paint (no dark: utilities on mobile). */
function applySystemTheme(): void {
  if (typeof window.matchMedia !== 'function') return;
  const apply = () => {
    document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches);
  };
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}

export function mountMobileApp(): void {
  mobileI18n.initFromDeviceLocale();
  applySystemTheme();
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Failed to find the root element');
  }
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <MobileApp />
    </React.StrictMode>,
  );
}
