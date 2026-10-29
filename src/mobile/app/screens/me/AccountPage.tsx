import { useState } from 'react';
import { t } from '../../../i18n';
import { logout, requestAccountDeletion } from '../../../login/loginApi';
import { BottomSheet } from '../../components/BottomSheet';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * account secondary page (IA-PLAN v1 §4.9): logout + account deletion only.
 * Deliberately NO mnemonic/import/chain-backup entries (IA-PLAN §3.1:
 * mobile is a thin tenant client; scope OUT for this cycle).
 */
export function AccountPage(props: { onBack: () => void }): JSX.Element {
  const [sheet, setSheet] = useState<'logout' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
      window.location.assign('/login');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await requestAccountDeletion(reason.trim() || undefined);
      setDone(true);
      setTimeout(() => window.location.assign('/login'), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SecondaryPageShell title={t('mobile.me.entry.account')} onBack={props.onBack} testId="me-page-account">
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <button
          type="button"
          data-testid="account-logout"
          onClick={() => setSheet('logout')}
          className="flex min-h-[52px] w-full items-center justify-between border-b border-[var(--border-color)] py-2 text-[15px] text-[var(--text-primary)]"
        >
          {t('mobile.me.logout')}
        </button>
        <button
          type="button"
          data-testid="account-delete"
          onClick={() => {
            setDone(false);
            setReason('');
            setSheet('delete');
          }}
          className="flex min-h-[52px] w-full items-center justify-between py-2 text-[15px] text-red-600"
        >
          {t('mobile.me.deleteAccount')}
        </button>
      </div>

      {sheet === 'logout' ? (
        <BottomSheet title={t('mobile.me.logoutTitle')} onClose={() => setSheet(null)}>
          <p className="mb-4 text-sm text-[var(--text-secondary)]">{t('mobile.me.logoutBody')}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setSheet(null)}
              className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.me.botCancel')}
            </button>
            <button
              type="button"
              onClick={() => void doLogout()}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.me.logoutConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {sheet === 'delete' ? (
        <BottomSheet title={t('mobile.me.deleteTitle')} onClose={() => setSheet(null)}>
          {done ? (
            <p className="min-h-[44px] py-3 text-center text-sm font-medium text-emerald-600">
              {t('mobile.me.deleteDone')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.deleteBody')}</p>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('mobile.me.deleteReasonPlaceholder')}
                className="min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none"
              />
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setSheet(null)}
                  className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
                >
                  {t('mobile.me.botCancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  disabled={busy}
                  className="min-h-[44px] flex-1 rounded-xl bg-red-600 py-2 font-medium text-white active:opacity-80 disabled:opacity-40"
                >
                  {t('mobile.me.deleteConfirm')}
                </button>
              </div>
            </div>
          )}
        </BottomSheet>
      ) : null}
    </SecondaryPageShell>
  );
}
