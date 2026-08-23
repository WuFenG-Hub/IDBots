import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkPermissionMode } from '../../types/cowork';
import type { ComposerCommand } from './composerCommands';

/**
 * Host-side slash-command catalogs for the cowork composer. The composer owns
 * the '/' picker and claim-token rendering (see composerCommands.ts); these
 * builders map each ported DSH command onto IDBots machinery:
 *
 * - /plan   → the cowork permission-mode system ('plan' blocks writes)
 * - /compact → manual compaction (cowork:session:compact)
 * - /export → session transcript export (Markdown file, save dialog)
 * - /goal   → session goal storage + per-turn prompt injection
 */

export interface NewTaskComposerCommandOptions {
  /** Sets the new-task composer's permission mode (drives the pill + next session). */
  setPermissionMode: (mode: CoworkPermissionMode) => void;
}

/** Commands for the new-task (home) composer: no session exists yet. */
export function buildNewTaskComposerCommands(
  options: NewTaskComposerCommandOptions,
): ComposerCommand[] {
  return [
    {
      name: 'plan',
      description: i18nService.t('composerCommandPlanDesc'),
      hint: i18nService.t('composerCommandPlanHint'),
      run: async (args, ctx) => {
        const text = args.trim();
        if (text.toLowerCase() === 'off') {
          options.setPermissionMode('default');
          return i18nService.t('composerNoticePlanOff');
        }
        if (text) {
          options.setPermissionMode('plan');
          const sent = await ctx.submitMessage(text);
          return sent ? i18nService.t('composerNoticePlanTaskSent') : undefined;
        }
        options.setPermissionMode('plan');
        return i18nService.t('composerNoticePlanOn');
      },
    },
    {
      name: 'compact',
      description: i18nService.t('composerCommandCompactDesc'),
      run: () => i18nService.t('composerNoticeCompactNoHistory'),
    },
  ];
}

export interface SessionComposerCommandOptions {
  sessionId: string;
}

/** Commands for a live session's composer (steer input + idle input). */
export function buildSessionComposerCommands(
  options: SessionComposerCommandOptions,
): ComposerCommand[] {
  return [
    {
      name: 'plan',
      description: i18nService.t('composerCommandPlanDesc'),
      hint: i18nService.t('composerCommandPlanHint'),
      run: async (args, ctx) => {
        const text = args.trim();
        if (text.toLowerCase() === 'off') {
          await coworkService.setPermissionMode(options.sessionId, 'default');
          return i18nService.t('composerNoticePlanOff');
        }
        if (text) {
          await coworkService.setPermissionMode(options.sessionId, 'plan');
          const sent = await ctx.submitMessage(text);
          return sent ? i18nService.t('composerNoticePlanTaskSent') : undefined;
        }
        await coworkService.setPermissionMode(options.sessionId, 'plan');
        return i18nService.t('composerNoticePlanOn');
      },
    },
    {
      name: 'compact',
      description: i18nService.t('composerCommandCompactDesc'),
      run: async () => {
        const result = await coworkService.requestManualCompaction(options.sessionId);
        if (result.success) {
          return i18nService.t('composerNoticeCompactRequested');
        }
        if (result.error?.includes('No messages')) {
          return i18nService.t('composerNoticeCompactNoHistory');
        }
        return result.error ?? i18nService.t('composerCommandFailed');
      },
    },
  ];
}
