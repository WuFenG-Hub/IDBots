import React, { useCallback, useEffect, useState } from 'react';
import { ScaleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { preferenceService } from '../../services/preference';
import type { PreferenceUserRoundSummary } from '../../types/preference';
import PreferenceComparePanel from './PreferenceComparePanel';

const t = (key: string): string => i18nService.t(key);

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const canJudge = (round: PreferenceUserRoundSummary, nowSec: number): boolean =>
  round.myKind !== null && round.status === 'collecting' && nowSec < round.commitCutoffAt;

const useRounds = (filter: { mine?: boolean; taskid?: string }) => {
  const [rounds, setRounds] = useState<PreferenceUserRoundSummary[]>([]);
  const { mine, taskid } = filter;
  const load = useCallback(async () => {
    try {
      setRounds((await preferenceService.listRounds({ mine, taskid })).rounds);
    } catch (error) {
      console.warn('[preference] listRounds failed', error);
      setRounds([]);
    }
  }, [mine, taskid]);
  useEffect(() => {
    // Cache-first render; the refresh broadcasts preference:update, which the
    // subscription turns into a re-list, so the board picks up new chain events.
    preferenceService.refresh().catch(() => undefined);
    void load();
    return preferenceService.subscribe(() => void load());
  }, [load]);
  return rounds;
};

/** "Preference rounds" on the MetaTask board: rounds that list the user as a judge. */
const PreferenceRoundsSection: React.FC = () => {
  const rounds = useRounds({ mine: true });
  const [openRound, setOpenRound] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <>
      {rounds.length > 0 && (
        <section className="mb-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
            <ScaleIcon className="h-4 w-4 text-[var(--color-accent)]" />
            {t('preference.rounds.title')}
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{t('preference.rounds.subtitle')}</p>
          <ul className="mt-2 space-y-1.5">
            {rounds.map((round) => (
              <li key={round.pinId} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--text-primary)]">{round.title}</div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    {t(`preference.status.${round.status}`)}
                    {round.status === 'collecting' &&
                      ` · ${t('preference.rounds.closesAt').replace('{time}', formatAt(round.commitCutoffAt))}`}
                    {round.myBallotStatus &&
                      ` · ${t('preference.rounds.myBallot').replace('{status}', t(`preference.ballotStatus.${round.myBallotStatus}`))}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenRound(round.pinId)}
                  className={
                    canJudge(round, nowSec)
                      ? 'btn-idchat-primary-filled shrink-0 rounded-lg px-3 py-1 text-xs font-medium'
                      : 'shrink-0 rounded-lg border border-[var(--border-color)] px-3 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }
                >
                  {canJudge(round, nowSec) ? t('preference.rounds.judge') : t('preference.rounds.view')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {openRound && <PreferenceComparePanel roundPinId={openRound} onClose={() => setOpenRound(null)} />}
    </>
  );
};

/** Round buttons on a MetaTask detail page (rounds whose subject is this task). */
export const PreferenceTaskRoundButtons: React.FC<{ rootPinId: string }> = ({ rootPinId }) => {
  const rounds = useRounds({ taskid: rootPinId });
  const [openRound, setOpenRound] = useState<string | null>(null);
  const nowSec = Math.floor(Date.now() / 1000);
  if (rounds.length === 0) return null;
  return (
    <>
      {rounds.slice(0, 2).map((round) => (
        <button
          key={round.pinId}
          type="button"
          onClick={() => setOpenRound(round.pinId)}
          className={
            canJudge(round, nowSec)
              ? 'btn-idchat-primary-filled inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium'
              : 'inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }
        >
          <ScaleIcon className="h-4 w-4" />
          {canJudge(round, nowSec)
            ? t('preference.detail.judgeRound')
            : t('preference.detail.viewRound').replace('{status}', t(`preference.status.${round.status}`))}
        </button>
      ))}
      {openRound && <PreferenceComparePanel roundPinId={openRound} onClose={() => setOpenRound(null)} />}
    </>
  );
};

export default PreferenceRoundsSection;
