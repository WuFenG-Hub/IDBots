import type { MetaBotForSelector } from '../cowork/MetaBotSelector';

/**
 * Owner-Agent roster for the long-term task surfaces (detail page binding
 * selector + board creation flow). Same eligibility rule as the cowork New
 * Task composer: local bots that are enabled AND have a configured LLM — a bot
 * without a brain cannot host a session, so listing it would only produce a
 * dead route.
 */
export async function loadOwnerAgentBots(): Promise<{ bots: MetaBotForSelector[]; twinId: number | null }> {
  const [selectorResult, fullListResult] = await Promise.all([
    window.electron?.idbots?.getMetaBots?.(),
    window.electron?.metabot?.list?.(),
  ]);
  if (!selectorResult?.success || !selectorResult.list) return { bots: [], twinId: null };
  const localList = fullListResult?.success && fullListResult.list ? fullListResult.list : [];
  const llmConfiguredIds = new Set(
    localList
      .filter((metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim())
      .map((metabot) => metabot.id),
  );
  const bots = selectorResult.list.filter((metabot) => llmConfiguredIds.has(metabot.id));
  const twin = bots.find((metabot) => metabot.metabot_type === 'twin');
  return { bots, twinId: twin ? twin.id : null };
}
