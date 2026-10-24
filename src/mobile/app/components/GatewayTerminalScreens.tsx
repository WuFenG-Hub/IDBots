import { useEffect } from 'react';
import type { GatewayVersionMismatch } from '../../bridge/gatewayClient';
import { t } from '../../i18n';
import { getMe } from '../../login/loginApi';

/**
 * Full-screen pages for the gateway terminal states (REQ-E-2 close codes).
 * The shell renders these instead of the normal tabs whenever the real
 * gateway client enters the matching state; the mock bridge never gets here.
 */

const PAGE_CLASS =
  'flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--bg-main)] px-6 text-center';
const TITLE_CLASS = 'text-lg font-semibold text-[var(--text-primary)]';
const BODY_CLASS = 'text-sm leading-relaxed text-[var(--text-secondary)]';

/**
 * 4013 tenant-unavailable: the tenant process is gone (stopped/suspended).
 * Polls the control plane's getMe every 5 s and continues into the app as
 * soon as the tenant reports ready or degraded (C3: degraded still opens).
 */
export function TenantUnavailableScreen(): JSX.Element {
  useEffect(() => {
    let cancelled = false;
    let navigated = false;
    const tick = async () => {
      try {
        const me = await getMe();
        if (cancelled || navigated) return;
        if (me.tenant.status === 'ready' || me.tenant.status === 'degraded') {
          navigated = true;
          window.location.assign('/app/');
        }
      } catch {
        // Transient poll failure: the next 5 s tick retries.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className={PAGE_CLASS} data-testid="gateway-tenant-unavailable">
      <h1 className={TITLE_CLASS}>{t('mobile.gateway.tenantUnavailableTitle')}</h1>
      <p className={BODY_CLASS}>{t('mobile.gateway.tenantUnavailableBody')}</p>
    </div>
  );
}

/** 4009 too-many-devices: a fourth socket was rejected by the gateway. */
export function TooManyDevicesScreen(): JSX.Element {
  return (
    <div className={PAGE_CLASS} data-testid="gateway-too-many-devices">
      <h1 className={TITLE_CLASS}>{t('mobile.gateway.tooManyDevicesTitle')}</h1>
      <p className={BODY_CLASS}>{t('mobile.gateway.tooManyDevicesBody')}</p>
    </div>
  );
}

/** Welcome contract-major guard: this app build cannot talk to the server. */
export function VersionMismatchScreen(props: { mismatch: GatewayVersionMismatch | null }): JSX.Element {
  const expected = props.mismatch?.expected ?? '?';
  const actual = props.mismatch?.actual ?? '?';
  return (
    <div className={PAGE_CLASS} data-testid="gateway-version-mismatch">
      <h1 className={TITLE_CLASS}>{t('mobile.gateway.versionMismatchTitle')}</h1>
      <p className={BODY_CLASS}>
        {t('mobile.gateway.versionMismatchBody', { expected: `${expected}.x`, actual })}
      </p>
    </div>
  );
}
