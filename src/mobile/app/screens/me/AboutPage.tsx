import { useEffect, useState } from 'react';
import { t } from '../../../i18n';
import { CONTRACT_VERSION } from '../../../bridge/types';
import { getMobileElectron } from '../../appBridge';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * about secondary page (IA-PLAN v1 §4.10): version info + the three legal
 * pages already live behind #8, opened in the system browser. Link URLs
 * follow the login page's placeholder pattern — the owner swaps in the
 * final domains before launch.
 */
const LEGAL_LINKS: ReadonlyArray<{ key: string; href: string; testId: string }> = [
  { key: 'mobile.me.about.terms', href: 'https://staging.idbots.world/terms', testId: 'about-link-terms' },
  { key: 'mobile.me.about.privacy', href: 'https://staging.idbots.world/privacy', testId: 'about-link-privacy' },
  { key: 'mobile.me.about.custody', href: 'https://staging.idbots.world/custody', testId: 'about-link-custody' },
];

export function AboutPage(props: { onBack: () => void }): JSX.Element {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getMobileElectron()
      .appInfo.getVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(null));
  }, []);
  return (
    <SecondaryPageShell title={t('mobile.me.entry.about')} onBack={props.onBack} testId="me-page-about">
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        {/* App glyph: initial disc, same visual family as bot avatars. */}
        <span
          aria-hidden
          className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[var(--border-color)] bg-[var(--bg-main)] text-xl font-semibold text-[var(--text-secondary)]"
        >
          ID
        </span>
        <p className="text-sm text-[var(--text-secondary)]" data-testid="about-app-version">
          {t('mobile.me.appVersion', { version: appVersion ?? '—' })}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {t('mobile.me.contractVersion', { version: CONTRACT_VERSION })}
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        {LEGAL_LINKS.map((link) => (
          <a
            key={link.testId}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            data-testid={link.testId}
            className="flex min-h-[52px] items-center justify-between border-b border-[var(--border-color)] py-2 text-[15px] text-[var(--text-primary)] last:border-b-0"
          >
            {t(link.key)}
            <span aria-hidden className="text-[var(--text-secondary)]">›</span>
          </a>
        ))}
      </div>

      <p className="px-1 text-center text-xs text-[var(--text-secondary)]">{t('mobile.me.about.copyright')}</p>
    </SecondaryPageShell>
  );
}
