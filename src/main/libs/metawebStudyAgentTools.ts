import { z } from 'zod';
import {
  DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT,
  normalizeStudyTopic,
  type MetawebStudyJobRecord,
} from '../metawebStudyJobStore';

/**
 * Control surface the host (main.ts) provides for the MetaWeb study-job
 * tools. Backed by MetawebStudyService (services/metawebStudyService.ts):
 * the M4 owner-assigned study-topic queue — enqueue a topic ("study game
 * development in your spare time") and read back study status/history so the
 * bot can truthfully answer "what have you been learning?". Both methods are
 * metabotId-first; the acting bot is resolved from the session.
 */
export type MetawebStudyControl = {
  enqueueStudyJob(
    metabotId: number,
    input: { topic: string; budgetPins?: number },
  ): { job: MetawebStudyJobRecord; created: boolean };
  enqueueQaSurfJob(
    metabotId: number,
    input?: { budgetPins?: number },
  ): { job: MetawebStudyJobRecord; created: boolean };
  disableQaSurfJob(metabotId: number): boolean;
  listStudyJobs(metabotId: number): MetawebStudyJobRecord[];
};

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

const STATUS_LABEL: Record<MetawebStudyJobRecord['status'], string> = {
  pending: 'pending (waiting for the next nightly run)',
  running: 'running right now',
  done: 'done',
  failed: 'failed',
};

/** "YYYY-MM-DD HH:MM UTC" from an ISO timestamp; 'never' when null. */
function formatRunAt(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : iso;
}

/** Numbered job list for the metaweb_study_status tool response. */
export function formatStudyJobList(jobs: MetawebStudyJobRecord[]): string {
  const lines: string[] = [`${jobs.length} study job(s) for this bot:`];
  jobs.forEach((job, index) => {
    const recurring = job.kind === 'qa-surf' ? ' [recurring Q&A surfing]' : '';
    lines.push(`${index + 1}. "${job.topic}"${recurring} — ${STATUS_LABEL[job.status] ?? job.status}`);
    lines.push(
      `   runs: ${job.runCount} | ${job.kind === 'qa-surf' ? 'pins handled' : 'pins saved'}: ${job.processedPinIds.length} | nightly budget: ${job.budgetPins} | last run: ${formatRunAt(job.lastRunAt)}`
    );
    if (job.lastRunSummary) lines.push(`   last result: ${job.lastRunSummary}`);
    if (job.lastError) lines.push(`   last error: ${job.lastError}`);
  });
  lines.push('');
  lines.push(
    'Answer the owner from this record exactly — which topics are queued, what each nightly run saved, and what is done. The learned content itself lives in your knowledge bases: query it with knowledge_base_query, and cite KB sources rather than reciting from memory.'
  );
  return lines.join('\n');
}

/**
 * Inline MCP tools for the M4 autonomous-study queue, registered for every
 * cowork surface when the host provides a MetawebStudyControl (see
 * coworkRunner). metaweb_study_enqueue is the write path (owner assigns a
 * study topic); metaweb_study_status is the read path (answer "what have you
 * been learning" truthfully from the jobs record — the project deliberately
 * has no proactive morning report). Unattributed sessions get a clear error,
 * never a guessed bot.
 */
export function buildMetawebStudyAgentTools(deps: {
  tool: SdkToolFactory;
  metawebStudy: MetawebStudyControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, metawebStudy, sessionId, resolveMetabotId } = deps;

  /** Strict per-session bot attribution; null means "do not guess". */
  const requireMetabotId = (toolName: string): number | { isError: true; text: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return {
        isError: true,
        text: `${toolName} could not resolve which MetaBot owns this session, so it has no study jobs. Study jobs are per-bot; retry from a session attributed to a MetaBot.`,
      };
    }
    return metabotId;
  };

  const studyEnqueue = tool(
    'metaweb_study_enqueue',
    'Queue an autonomous MetaWeb study job for YOURSELF — use when the owner asks you to learn, study, or research a topic in your spare time (e.g. "有空学学做游戏", "study video generation tonight"). During the nightly window a background session searches MetaWeb for the topic, reads the most relevant pins, and saves the worthwhile ones into your knowledge bases (up to the nightly pin budget per run; the job continues on following nights until the topic corpus is exhausted). Re-enqueueing a topic that is already queued or running is a no-op returning the existing job. Do NOT use this for tasks the owner wants done NOW — study jobs run at night; for immediate learning just follow the MetaWeb learning loop in this session. After enqueueing, confirm to the owner what will be studied and when.',
    {
      topic: z.string().min(1),
      budgetPins: z.number().int().min(1).max(50).optional(),
    },
    async (args: { topic: string; budgetPins?: number }) => {
      const topic = normalizeStudyTopic(args.topic);
      if (!topic) {
        return textResult('metaweb_study_enqueue requires a non-empty topic.', true);
      }
      const metabotId = requireMetabotId('metaweb_study_enqueue');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const { job, created } = metawebStudy.enqueueStudyJob(metabotId, {
          topic,
          budgetPins: args.budgetPins,
        });
        if (!created) {
          return textResult(
            `A study job for "${job.topic}" is already ${job.status} (queued earlier, ${job.processedPinIds.length} pin(s) saved so far). It continues in the next nightly window — no duplicate was created.`
          );
        }
        return textResult(
          [
            `Study job queued: "${job.topic}" (nightly budget: ${job.budgetPins} pins/run, up to ${DEFAULT_STUDY_PIN_BUDGET_PER_NIGHT} by default).`,
            'It runs in the nightly study window (local 00:00–06:00): each run searches MetaWeb for the topic, reads the most relevant pins, and saves the worthwhile ones into your knowledge bases.',
            'Tell the owner what was queued and that progress is visible anytime via metaweb_study_status or the knowledge-base panel.',
          ].join('\n')
        );
      } catch (error) {
        return textResult(`metaweb_study_enqueue failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const studyStatus = tool(
    'metaweb_study_status',
    'Read YOUR OWN MetaWeb study jobs — queued, running, and finished study topics with per-job run counts, saved-pin counts, nightly budget, last run time, and the last run\'s result summary. Use this to answer the owner truthfully when they ask what you have been studying, what you already learned, or whether a topic is still queued. Bare call, no arguments. To answer what you actually KNOW from studying (not the job bookkeeping), query your knowledge bases with knowledge_base_query instead.',
    {},
    async () => {
      const metabotId = requireMetabotId('metaweb_study_status');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const jobs = metawebStudy.listStudyJobs(metabotId);
        if (!jobs.length) {
          return textResult(
            'You have no study jobs yet. When the owner asks you to learn a topic in your spare time, queue one with metaweb_study_enqueue.'
          );
        }
        return textResult(formatStudyJobList(jobs.slice(0, 10)));
      } catch (error) {
        return textResult(`metaweb_study_status failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const qaSurfEnqueue = tool(
    'metaweb_qa_surf_enqueue',
    [
      'Enable RECURRING nightly on-chain Q&A surfing for yourself — use when the owner asks you to spend your nights on the MetaWeb Q&A (e.g. "晚上去链上问答看看，会的就答", "surf the on-chain Q&A at night and learn from it").',
      'Every night (00:00–06:00) a background session then: browses the unanswered question queue, answers the ones squarely in your role (a few per night — answers are on-chain writes that cost sats), likes genuinely good answers, and saves Q&A valuable to your role into your knowledge bases.',
      'It recurs until the owner disables it (metaweb_qa_surf_disable); it never completes on its own. Re-enabling while active is a no-op returning the existing job. nightly_budget caps the NEW pins handled per run (questions answered + pins saved), default 10, max 50.',
      'Confirm to the owner what was enabled and that progress is visible via metaweb_study_status.',
    ].join(' '),
    {
      nightly_budget: z.number().int().min(1).max(50).optional().describe('New pins handled per night (answered + saved). Default 10.'),
    },
    async (args: { nightly_budget?: number }) => {
      const metabotId = requireMetabotId('metaweb_qa_surf_enqueue');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const { job, created } = metawebStudy.enqueueQaSurfJob(metabotId, {
          budgetPins: args.nightly_budget,
        });
        if (!created) {
          return textResult(
            `Nightly Q&A surfing is already ${job.status} for this bot (${job.runCount} run(s) so far, ${job.processedPinIds.length} pin(s) handled). It continues every night — no duplicate was created.`
          );
        }
        return textResult(
          [
            `Nightly Q&A surfing enabled (nightly budget: ${job.budgetPins} pins/run).`,
            'Each night (00:00–06:00) a background session browses the unanswered on-chain questions, answers the ones squarely in your role, reacts honestly, and saves valuable Q&A into your knowledge bases.',
            'Tell the owner it recurs until disabled (metaweb_qa_surf_disable) and that progress shows in metaweb_study_status.',
          ].join('\n')
        );
      } catch (error) {
        return textResult(`metaweb_qa_surf_enqueue failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  const qaSurfDisable = tool(
    'metaweb_qa_surf_disable',
    'Stop YOUR recurring nightly on-chain Q&A surfing — use when the owner asks to stop/disable the nightly surfing ("别晚上去问答了", "stop the nightly Q&A surfing"). Answers and knowledge already saved stay; only future nightly runs stop. Re-enable anytime with metaweb_qa_surf_enqueue. Bare call, no arguments.',
    {},
    async () => {
      const metabotId = requireMetabotId('metaweb_qa_surf_disable');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      try {
        const disabled = metawebStudy.disableQaSurfJob(metabotId);
        if (!disabled) {
          return textResult('Nightly Q&A surfing is not active for this bot — nothing to disable.');
        }
        return textResult(
          'Nightly Q&A surfing disabled. Everything already answered and saved stays with you; future nightly runs are stopped. Re-enable anytime with metaweb_qa_surf_enqueue.'
        );
      } catch (error) {
        return textResult(`metaweb_qa_surf_disable failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [studyEnqueue, qaSurfEnqueue, qaSurfDisable, studyStatus];
}
