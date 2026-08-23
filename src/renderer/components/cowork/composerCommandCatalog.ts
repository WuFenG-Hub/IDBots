import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkPermissionMode, CoworkSessionGoal } from '../../types/cowork';
import { parseGoalCommandArgs, type ComposerCommand } from './composerCommands';

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
  /** Pending goal attached to the next started session (from /goal). */
  pendingGoal: { text: string; status: 'active' | 'paused' } | null;
  /** Replace the pending goal (null clears). */
  setPendingGoal: (goal: { text: string; status: 'active' | 'paused' } | null) => void;
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
    {
      name: 'export',
      description: i18nService.t('composerCommandExportDesc'),
      run: () => i18nService.t('composerNoticeExportNoSession'),
    },
    {
      name: 'goal',
      description: i18nService.t('composerCommandGoalDesc'),
      hint: i18nService.t('composerCommandGoalHint'),
      run: async (args, ctx) => {
        const parsed = parseGoalCommandArgs(args);
        switch (parsed.kind) {
          case 'show':
            return options.pendingGoal
              ? `${i18nService.t('composerNoticeGoalView' + (options.pendingGoal.status === 'paused' ? 'Paused' : 'Active'))} ${options.pendingGoal.text}`
              : i18nService.t('composerNoticeGoalNone');
          case 'clear':
            options.setPendingGoal(null);
            return i18nService.t('composerNoticeGoalCleared');
          case 'edit':
            options.setPendingGoal({ text: parsed.text, status: options.pendingGoal?.status ?? 'active' });
            return i18nService.t('composerNoticeGoalSet');
          case 'pause':
          case 'resume': {
            if (!options.pendingGoal) {
              return i18nService.t('composerNoticeGoalNoActive');
            }
            const status = parsed.kind === 'pause' ? 'paused' : 'active';
            options.setPendingGoal({ text: options.pendingGoal.text, status });
            return i18nService.t(parsed.kind === 'pause' ? 'composerNoticeGoalPaused' : 'composerNoticeGoalResumed');
          }
          case 'create': {
            // DSH-faithful start: the objective becomes the task — set the
            // pending goal AND submit it as the first prompt, so the session
            // starts working toward the goal from turn one.
            options.setPendingGoal({ text: parsed.text, status: 'active' });
            const sent = await ctx.submitMessage(parsed.text);
            return sent ? i18nService.t('composerNoticeGoalPendingNewTask') : undefined;
          }
        }
      },
    },
  ];
}

export interface SessionComposerCommandOptions {
  sessionId: string;
  /** The session's current goal (from the session object; null = none). */
  goal: CoworkSessionGoal | null | undefined;
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
    {
      name: 'export',
      description: i18nService.t('composerCommandExportDesc'),
      run: async () => {
        const result = await coworkService.exportSessionTranscript(options.sessionId);
        if (result.success && result.cancelled) {
          return i18nService.t('composerNoticeExportCancelled');
        }
        if (result.success) {
          return i18nService.t('composerNoticeExportSaved');
        }
        return result.error ?? i18nService.t('composerNoticeExportFailed');
      },
    },
    {
      name: 'goal',
      description: i18nService.t('composerCommandGoalDesc'),
      hint: i18nService.t('composerCommandGoalHint'),
      run: async (args) => {
        const parsed = parseGoalCommandArgs(args);
        const current = options.goal ?? null;
        switch (parsed.kind) {
          case 'show':
            return current
              ? `${i18nService.t(current.status === 'paused' ? 'composerNoticeGoalViewPaused' : 'composerNoticeGoalViewActive')} ${current.text}`
              : i18nService.t('composerNoticeGoalNone');
          case 'clear': {
            if (!current) return i18nService.t('composerNoticeGoalNone');
            await coworkService.setSessionGoal(options.sessionId, null);
            return i18nService.t('composerNoticeGoalCleared');
          }
          case 'edit': {
            const result = await coworkService.setSessionGoal(options.sessionId, {
              text: parsed.text,
              status: current?.status ?? 'active',
            });
            return result.success ? i18nService.t('composerNoticeGoalSet') : (result.error ?? i18nService.t('composerCommandFailed'));
          }
          case 'pause':
          case 'resume': {
            if (!current) {
              return i18nService.t('composerNoticeGoalNoActive');
            }
            const status = parsed.kind === 'pause' ? 'paused' : 'active';
            const result = await coworkService.setSessionGoal(options.sessionId, {
              text: current.text,
              status,
            });
            return result.success
              ? i18nService.t(parsed.kind === 'pause' ? 'composerNoticeGoalPaused' : 'composerNoticeGoalResumed')
              : (result.error ?? i18nService.t('composerCommandFailed'));
          }
          case 'create': {
            if (current) {
              // DSH parity: an existing goal demands edit or clear first.
              return i18nService.t('composerNoticeGoalAlreadySet');
            }
            const result = await coworkService.setSessionGoal(options.sessionId, {
              text: parsed.text,
              status: 'active',
            });
            return result.success ? i18nService.t('composerNoticeGoalSet') : (result.error ?? i18nService.t('composerCommandFailed'));
          }
        }
      },
    },
  ];
}
