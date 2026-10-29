import { useState } from 'react';
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/24/outline';
import { t } from '../../../i18n';
import type { MobileBotInput } from '../../hooks/useMetabots';
import { useMetabots, type BotOperationResult } from '../../hooks/useMetabots';
import type { EditorBrainOption } from '../../components/BotEditorForm';
import { BotEditorForm } from '../../components/BotEditorForm';
import { BotAvatar } from '../../components/BotAvatar';
import { BottomSheet } from '../../components/BottomSheet';
import { sortBotsForList } from '../../botList';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * bots secondary page (IA-PLAN v1 §4.5): avatar + name + role rows pushing
 * the FULL editor as the third-level page (rendered by MeScreen), and the
 * A5 two-field create BottomSheet. Row scope is exactly the IA-PLAN spec —
 * the old list-level enable switch / chain actions moved out with the flat
 * section (flagged in the A6 delivery note for the owner).
 */
interface CreateFormState {
  busy: boolean;
  outcome: BotOperationResult | null;
}

export function BotsPage(props: {
  onBack: () => void;
  onOpenEdit: (botId: number) => void;
}): JSX.Element {
  const manager = useMetabots();
  const [createState, setCreateState] = useState<CreateFormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const brainOptions: EditorBrainOption[] = manager.modelGroups.flatMap((group) => group.models.map((model) => ({
    providerKey: group.id,
    modelId: model.id,
    label: `${group.name} · ${model.name}`,
  })));
  const sortedBots = sortBotsForList(manager.bots);

  const submitCreate = async (input: MobileBotInput) => {
    setCreateState((current) => (current ? { ...current, busy: true, outcome: null } : current));
    const result = await manager.createBot(input);
    if (result.state === 'synced') {
      setNotice(t('mobile.me.botCreatedSynced'));
      setCreateState(null);
      return;
    }
    setCreateState((current) => (current ? { ...current, busy: false, outcome: result } : current));
  };

  return (
    <SecondaryPageShell
      title={t('mobile.me.entry.bots')}
      onBack={props.onBack}
      testId="me-page-bots"
      action={
        <button
          type="button"
          onClick={() => setCreateState({ busy: false, outcome: null })}
          className="flex min-h-[36px] items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          data-testid="bot-create"
        >
          <PlusIcon className="h-4 w-4" aria-hidden />
          {t('mobile.me.botCreate')}
        </button>
      }
    >
      {notice ? <p className="px-1 text-sm text-emerald-600" aria-live="polite">{notice}</p> : null}
      {manager.loading ? <p className="px-1 py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {manager.error ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-red-600">{manager.error}</p>
          <button type="button" onClick={() => void manager.reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}

      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-2">
        {sortedBots.length === 0 && !manager.loading ? (
          <p className="py-4 text-center text-sm text-[var(--text-secondary)]" data-testid="bots-empty">
            {t('mobile.me.botsEmpty')}
          </p>
        ) : null}
        {sortedBots.map((bot) => (
          <button
            key={bot.id}
            type="button"
            data-testid={`bot-row-${bot.id}`}
            onClick={() => props.onOpenEdit(bot.id)}
            className="flex min-h-[52px] w-full items-center gap-3 border-b border-[var(--border-color)] px-2 py-2 text-left last:border-b-0 active:bg-[var(--bg-hover)]"
          >
            <BotAvatar name={bot.name} avatar={bot.avatar} testId={`bot-avatar-${bot.id}`} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] text-[var(--text-primary)]">{bot.name}</p>
              {bot.role ? (
                <p className="truncate text-xs text-[var(--text-secondary)]" data-testid={`bot-role-${bot.id}`}>
                  {bot.role}
                </p>
              ) : null}
            </div>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          </button>
        ))}
      </div>

      {createState ? (
        <BottomSheet title={t('mobile.me.botCreate')} onClose={createState.busy ? () => undefined : () => setCreateState(null)}>
          <BotEditorForm
            key="bots-page-create"
            state={{ bot: null, busy: createState.busy, outcome: createState.outcome }}
            brainOptions={brainOptions}
            skills={manager.skills}
            catalogError={manager.catalogError}
            getBalance={manager.getBotBalance}
            onClose={() => setCreateState(null)}
            onSave={submitCreate}
          />
        </BottomSheet>
      ) : null}
    </SecondaryPageShell>
  );
}
