import { z } from 'zod';
import type { MetawebSurfRunRecord } from '../metawebSurfStore';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

/**
 * Tool-facing surface of SurfService. startSurf is async by design: the run
 * proceeds unattended in the background; metaweb_surf_status is how the bot
 * answers "what did you learn on your last surf?" truthfully from the run
 * records — the deliberate substitute for proactive reporting. The
 * before-dream setting accessors additionally serve the legacy
 * metaweb_qa_surf_* tool aliases (see metawebStudyAgentTools).
 */
export type MetawebSurfControl = {
  startSurfForMetabot(metabotId: number): { runId: string };
  isSurfRunning(metabotId: number): boolean;
  listSurfRuns(metabotId: number, limit?: number): MetawebSurfRunRecord[];
  setSurfBeforeDreamEnabled(metabotId: number, enabled: boolean): void;
  isSurfBeforeDreamEnabled(metabotId: number): boolean;
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Human-readable surf run list. Exposed for tests. */
export function formatSurfRunList(runs: MetawebSurfRunRecord[]): string {
  if (runs.length === 0) {
    return 'No surf runs yet. Start one with metaweb_surf_start, or enable surf-before-dream for a nightly surf.';
  }
  const lines = runs.slice(0, 10).map((run) => {
    const stats = run.stats;
    const acted = [
      stats.savedToKb ? `${stats.savedToKb} saved` : null,
      stats.liked ? `${stats.liked} liked` : null,
      stats.commented ? `${stats.commented} commented` : null,
      stats.answered ? `${stats.answered} answered` : null,
    ].filter(Boolean).join(', ');
    const headline = run.reportMarkdown?.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim();
    return [
      `- [${run.status}] ${run.startedAt.slice(0, 16).replace('T', ' ')} (${run.trigger})`,
      `  fetched ${stats.fetched} new · deep-read ${stats.deepRead}${acted ? ` · ${acted}` : ''}`,
      run.error ? `  error: ${run.error}` : null,
      headline ? `  ${headline.slice(0, 140)}` : null,
    ].filter(Boolean).join('\n');
  });
  return [`Recent surf runs (newest first, ${runs.length} total):`, ...lines].join('\n');
}

/**
 * Inline MCP tools for MetaWeb surf ("AI 冲浪"), registered for every cowork
 * surface when the host provides a MetawebSurfControl. metaweb_surf_start is
 * the chat trigger ("去冲浪 / 上网逛逛"); metaweb_surf_status is the read
 * path. Same strict per-session bot attribution as the study tools.
 */
export function buildSurfAgentTools(deps: {
  tool: SdkToolFactory;
  metawebSurf: MetawebSurfControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, metawebSurf, sessionId, resolveMetabotId } = deps;

  const requireMetabotId = (toolName: string): number | { isError: true; text: string } => {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return {
        isError: true,
        text: `${toolName} could not resolve which MetaBot owns this session, so it cannot surf. Surfing is per-bot; retry from a session attributed to a MetaBot.`,
      };
    }
    return metabotId;
  };

  const surfStart = tool(
    'metaweb_surf_start',
    [
      'Start one autonomous MetaWeb surf run ("AI 冲浪"), as the MetaBot that owns this session.',
      'Use when the user asks you to go surf / browse the AI internet (去冲浪、上网逛逛), or when you decide a surf would help: you will catch up on new chain content since your last surf, search & learn old content relevant to your role, engage (like/comment/answer) as your persona sees fit, and handle chain notifications addressed to you.',
      'The run is unattended and asynchronous: this call only starts it. While it runs you cannot start a second one; the structured surf report lands in your surf records (metaweb_surf_status) and, for nightly runs, feeds tonight\'s dream.',
      'Interactions cost on-chain fees and are capped by the bot\'s per-run interaction budget. Do not start a surf when one is already running — check metaweb_surf_status first if unsure.',
    ].join(' '),
    {},
    async () => {
      const metabotId = requireMetabotId('metaweb_surf_start');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      if (metawebSurf.isSurfRunning(metabotId)) {
        return textResult(
          'A surf run is already in progress for you right now. Let it finish — check metaweb_surf_status for the outcome.',
          true,
        );
      }
      try {
        const { runId } = metawebSurf.startSurfForMetabot(metabotId);
        return textResult(
          [
            'Surf started — you are now browsing MetaWeb in the background (fresh digest → search & learn → persona-driven engagement → your inbox).',
            `- run id: ${runId}`,
            'The structured surf report will appear in your surf records when the run finishes; the user can also read it in the bot editor\'s advanced tab.',
          ].join('\n'),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Could not start the surf run: ${msg}`, true);
      }
    }
  );

  const surfStatus = tool(
    'metaweb_surf_status',
    [
      'List your recent MetaWeb surf runs (newest first): status, what was fetched/learned/saved, and how you engaged.',
      'Use to answer "what did you learn on your last surf / 你上次冲浪学到了什么", or to check whether a surf is currently running before starting one.',
    ].join(' '),
    {
      limit: z.number().int().min(1).max(50).optional().describe('How many recent runs to list (default 5, max 50).'),
    },
    async (args: { limit?: number }) => {
      const metabotId = requireMetabotId('metaweb_surf_status');
      if (typeof metabotId !== 'number') {
        return textResult(metabotId.text, true);
      }
      const running = metawebSurf.isSurfRunning(metabotId);
      const runs = metawebSurf.listSurfRuns(metabotId, args.limit ?? 5);
      const header = running ? 'A surf run is IN PROGRESS right now.\n' : '';
      return textResult(`${header}${formatSurfRunList(runs)}`);
    }
  );

  return [surfStart, surfStatus];
}
