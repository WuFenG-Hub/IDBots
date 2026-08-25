import type { TeamCultureStore } from '../teamCultureStore';
import { normalizeTeamCultureKind, type TeamCultureKind } from '../teamCultureStore';
import type { GroupTaskStore } from '../groupTaskStore';

/**
 * Task-close culture distillation — the write side of the shared culture
 * base. When a group task closes as done, the acceptance summary (goal,
 * per-deliverable verdicts, plan changes, conclusion, outcome) is offered to
 * an LLM which may propose a SMALL number of team-level culture entries
 * (glossary terms the team had to align on, conventions that measurably
 * helped or whose violation cost rework, cross-member lessons). Proposals
 * land through the store's normal upsert channel, so everything the
 * governance model promises holds automatically: fingerprint dedupe,
 * owner-entry protection, per-kind caps with emergent displacement, and full
 * revision history. The acceptance summary — previously stored but never fed
 * into any memory — finally becomes fleet knowledge.
 */

export interface CultureDistillationTaskInput {
  taskId: number;
  title: string;
  goal: string;
  status: string;
  summary: {
    conclusion: string | null;
    outcome: string | null;
    planChanges: string[];
    deliverables: Array<{ status: string; authorName: string | null }>;
    members: Array<{ name: string | null; role: string }>;
  } | null;
}

export interface CultureDistillationCounts {
  applied: number;
  protectedEntries: number;
  capacitySkipped: number;
}

const MAX_PROPOSALS_PER_KIND = 3;
const DISTILLATION_LLM_TIMEOUT_MS = 120_000;

export function buildCultureDistillationPrompt(input: {
  title: string;
  goal: string;
  summary: NonNullable<CultureDistillationTaskInput['summary']>;
  existingTopics: string[];
}): string {
  const deliverableLines = input.summary.deliverables.map(
    (deliverable) => `- ${deliverable.authorName ?? 'unknown'}: ${deliverable.status}`,
  );
  const memberNames = input.summary.members.map((member) => member.name).filter(Boolean).join(', ');
  const lines = [
    'You are distilling team-culture entries from a finished group task. The culture base is a tiny, shared, low-entropy layer injected into EVERY future group task of this fleet — earn your slot in it.',
    '',
    'Rules:',
    '- Propose ONLY team-level items: terms the team had to align on during this task, conventions that measurably helped (or whose violation caused rework), and lessons every member should carry into future tasks.',
    '- Do NOT restate the task narrative, do NOT praise individuals, do NOT propose single-bot knowledge (that belongs to the bot\'s private knowledge store).',
    `- At most ${MAX_PROPOSALS_PER_KIND} entries per kind. If nothing qualifies, return empty arrays — silence is a valid answer.`,
    '- Topics are short stable labels (2-6 words); text is one precise sentence.',
    '- Existing culture topics are listed below; never propose a duplicate of those.',
    '- Output ONLY a JSON object, no prose around it.',
    '',
    'Output JSON shape:',
    '{"glossary": [{"term": "...", "definition": "..."}], "conventions": [{"topic": "...", "text": "..."}], "lessons": [{"topic": "...", "text": "..."}]}',
    '',
    `Task: ${input.title}`,
    `Goal: ${input.goal}`,
    `Chair conclusion: ${input.summary.conclusion ?? '(none)'}`,
    `Plan changes: ${input.summary.planChanges.length > 0 ? input.summary.planChanges.join(' | ') : '(none)'}`,
    `Deliverable verdicts: ${deliverableLines.length > 0 ? deliverableLines.join(' ; ') : '(none)'}`,
    `Members: ${memberNames || '(unknown)'}`,
    `Existing culture topics: ${input.existingTopics.length > 0 ? input.existingTopics.join(' ; ') : '(none)'}`,
  ];
  return lines.join('\n');
}

export function parseCultureDistillationOutput(raw: string): {
  glossary: Array<{ term: string; definition: string }>;
  conventions: Array<{ topic: string; text: string }>;
  lessons: Array<{ topic: string; text: string }>;
} | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const pick = (value: unknown, keyA: string, keyB: string): string => {
        if (!value || typeof value !== 'object') return '';
        const record = value as Record<string, unknown>;
        return typeof record[keyA] === 'string' ? record[keyA] : (typeof record[keyB] === 'string' ? record[keyB] : '');
      };
      const mapList = (value: unknown, keyA: string, keyB: string) =>
        (Array.isArray(value) ? value : [])
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => ({ first: pick(entry, keyA, keyB), second: pick(entry, keyB, keyA) }))
          .filter((pair) => pair.first.trim() && pair.second.trim())
          .slice(0, MAX_PROPOSALS_PER_KIND);
      return {
        glossary: mapList(parsed.glossary, 'term', 'definition').map((pair) => ({ term: pair.first, definition: pair.second })),
        conventions: mapList(parsed.conventions, 'topic', 'text').map((pair) => ({ topic: pair.first, text: pair.second })),
        lessons: mapList(parsed.lessons, 'topic', 'text').map((pair) => ({ topic: pair.first, text: pair.second })),
      };
    } catch {
      // Try the next candidate slice.
    }
  }
  return null;
}

export type CultureDistillationPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: { signal?: AbortSignal; maxTokens?: number; thinking?: 'enabled' | 'disabled' },
) => Promise<string>;

/** Core distillation step: gather → prompt → parse → apply via the store. */
export async function runCultureDistillation(input: {
  task: CultureDistillationTaskInput;
  cultureStore: TeamCultureStore;
  performChat: CultureDistillationPerformChat;
}): Promise<CultureDistillationCounts> {
  const counts: CultureDistillationCounts = { applied: 0, protectedEntries: 0, capacitySkipped: 0 };
  if (input.task.status !== 'done' || !input.task.summary) {
    return counts;
  }
  const memberCount = input.task.summary.members.length;
  if (memberCount < 2) {
    return counts;
  }
  const existingTopics = input.cultureStore
    .listCulture({ status: 'active', limit: 200 })
    .map((entry) => entry.topic);
  const raw = await input.performChat(
    'You are a team-culture distillation assistant. Respond only with the requested JSON object.',
    buildCultureDistillationPrompt({
      title: input.task.title,
      goal: input.task.goal,
      summary: input.task.summary,
      existingTopics,
    }),
    undefined,
    { thinking: 'disabled', signal: AbortSignal.timeout(DISTILLATION_LLM_TIMEOUT_MS) },
  );
  const parsed = parseCultureDistillationOutput(raw);
  if (!parsed) {
    return counts;
  }
  const proposals: Array<{ kind: TeamCultureKind; topic: string; text: string }> = [
    ...parsed.glossary.map((item) => ({ kind: 'glossary' as const, topic: item.term, text: item.definition })),
    ...parsed.conventions.map((item) => ({ kind: 'convention' as const, topic: item.topic, text: item.text })),
    ...parsed.lessons.map((item) => ({ kind: 'team_lesson' as const, topic: item.topic, text: item.text })),
  ];
  for (const proposal of proposals) {
    const result = input.cultureStore.upsertCulture({
      kind: normalizeTeamCultureKind(proposal.kind),
      topic: proposal.topic,
      text: proposal.text,
      origin: 'distillation',
      taskId: input.task.taskId,
    });
    if (result.protected) counts.protectedEntries += 1;
    else if (result.capacitySkipped) counts.capacitySkipped += 1;
    else if (result.created || result.revised) counts.applied += 1;
  }
  return counts;
}

// --- task-close wiring -------------------------------------------------------

let cultureStoreProvider: (() => TeamCultureStore) | null = null;
let performChatProvider: CultureDistillationPerformChat | null = null;
let groupTaskStoreProvider: (() => GroupTaskStore) | null = null;

export function setTeamCultureDistillationDeps(deps: {
  getTeamCultureStore: () => TeamCultureStore;
  getGroupTaskStore: () => GroupTaskStore;
  performChat: CultureDistillationPerformChat;
}): void {
  cultureStoreProvider = deps.getTeamCultureStore;
  groupTaskStoreProvider = deps.getGroupTaskStore;
  performChatProvider = deps.performChat;
}

/**
 * Fire-and-forget hook for closeGroupTask: best-effort, never throws into
 * the close flow. Cancelled tasks are skipped — their lessons are usually
 * noise; only completed (done) tasks with a recorded acceptance summary and
 * at least two members distill.
 */
export function distillTeamCultureFromTaskClose(
  taskId: number,
  status: string,
  title: string,
  goal: string,
): void {
  void (async () => {
    try {
      if (!cultureStoreProvider || !performChatProvider || !groupTaskStoreProvider) return;
      const groupTaskStore = groupTaskStoreProvider();
      const summaryRow = groupTaskStore.getLatestAcceptanceSummary(taskId);
      if (!summaryRow) return;
      const counts = await runCultureDistillation({
        task: {
          taskId,
          title,
          goal,
          status,
          summary: {
            conclusion: summaryRow.conclusion,
            outcome: summaryRow.outcome ?? null,
            planChanges: summaryRow.planChanges ?? [],
            deliverables: (summaryRow.deliverables ?? []).map((deliverable) => ({
              status: deliverable.status,
              authorName: deliverable.authorName,
            })),
            members: (summaryRow.members ?? []).map((member) => ({
              name: member.name,
              role: member.role,
            })),
          },
        },
        cultureStore: cultureStoreProvider(),
        performChat: performChatProvider,
      });
      if (counts.applied > 0) {
        console.log(
          `[TeamCulture] Distilled ${counts.applied} culture entr(ies) from task ${taskId}` +
            ` (protected: ${counts.protectedEntries}, capacity-skipped: ${counts.capacitySkipped})`,
        );
      }
    } catch (error) {
      console.warn(
        `[TeamCulture] Distillation failed for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
}
