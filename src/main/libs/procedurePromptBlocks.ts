/**
 * Procedure prompt blocks — the hot layer for procedure memory ("经验").
 *
 * A procedure is a proven way to GET A TASK DONE: heavier than a knowledge
 * point (ordered steps + pitfalls + provenance pins), lighter than a skill
 * (no script dependency). Pure builders mirroring knowledgePromptBlocks.ts —
 * callers pass already-loaded entry views, so the runner stays the only place
 * that touches the store.
 */

import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

export const PROCEDURE_PROMPT_MAX_ITEMS = 5;
export const PROCEDURE_PROMPT_MAX_CHARS = 1800;
const PROCEDURE_TITLE_MAX_CHARS = 120;
const PROCEDURE_TRIGGER_MAX_CHARS = 200;
const PROCEDURE_STEP_MAX_CHARS = 160;
const PROCEDURE_MAX_STEPS_SHOWN = 6;
const PROCEDURE_PITFALL_MAX_CHARS = 120;
const RECALL_STEP_MAX_CHARS = 200;

export interface ProcedurePromptEntry {
  title: string;
  triggerText: string;
  steps: string[];
  pitfalls: string[];
  sourcePinIds: string[];
  version?: number;
  useCount?: number;
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function truncate(value: unknown, maxLength: number): string {
  const text = stripLoneSurrogates(typeof value === 'string' ? value.trim() : '');
  return text.length > maxLength ? `${truncateUtf16Units(text, maxLength).trim()}…` : text;
}

/**
 * Hot layer: a bounded slice of the bot's most relevant procedures, injected
 * so a matching past workflow proactively guides the current task instead of
 * the bot re-searching MetaWeb for something it already learned.
 */
export function buildProcedureBlock(
  entries: ProcedurePromptEntry[],
  maxItems: number = PROCEDURE_PROMPT_MAX_ITEMS,
  maxChars: number = PROCEDURE_PROMPT_MAX_CHARS,
): string {
  const items = (entries ?? [])
    .slice(0, Math.max(1, maxItems))
    .map((entry) => ({
      title: truncate(entry.title, PROCEDURE_TITLE_MAX_CHARS),
      trigger: truncate(entry.triggerText, PROCEDURE_TRIGGER_MAX_CHARS),
      steps: (entry.steps ?? []).slice(0, PROCEDURE_MAX_STEPS_SHOWN).map((step) => truncate(step, PROCEDURE_STEP_MAX_CHARS)),
      pitfalls: (entry.pitfalls ?? []).slice(0, 3).map((pitfall) => truncate(pitfall, PROCEDURE_PITFALL_MAX_CHARS)),
    }))
    .filter((entry) => entry.title && entry.trigger && entry.steps.length > 0);
  if (items.length === 0) return '';

  const lines: string[] = ['<procedures>'];
  let used = lines.join('\n').length;
  let included = 0;
  for (const entry of items) {
    const block = [
      `  <procedure title="${escapeXml(entry.title)}">`,
      `    <when>${escapeXml(entry.trigger)}</when>`,
      `    <steps>${escapeXml(entry.steps.join(' → '))}</steps>`,
      ...(entry.pitfalls.length ? [`    <avoid>${escapeXml(entry.pitfalls.join('；'))}</avoid>`] : []),
      `  </procedure>`,
    ].join('\n');
    if (included > 0 && used + 1 + block.length > maxChars) break;
    lines.push(block);
    used += 1 + block.length;
    included += 1;
  }
  if (included === 0) return '';
  lines.push('</procedures>');
  lines.push(
    '<instruction>',
    'The &lt;procedures&gt; block lists task workflows that already worked for you — when to use them, the',
    'steps, and what to avoid. When the current task matches a procedure\'s &lt;when&gt;, follow its steps',
    'directly instead of re-searching MetaWeb or re-deriving the workflow. Refresh a procedure with',
    'procedure_save when you find a better way; save a new one after completing a task that is likely to recur.',
    '</instruction>',
  );
  const rendered = lines.join('\n');
  return rendered.length <= maxChars
    ? rendered
    : `${truncateUtf16Units(rendered, Math.max(0, maxChars - 1)).trim()}…`;
}

/** Plain-text rendering of recall results for the procedure_recall tool response. */
export function formatProcedureRecallResults(entries: ProcedurePromptEntry[]): string {
  if (!entries || entries.length === 0) {
    return 'No procedures found for the given query. You have not saved a workflow for this kind of task yet — complete the task first, then save what worked with procedure_save.';
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const versionSuffix = typeof entry.version === 'number' && entry.version > 1 ? ` (v${entry.version})` : '';
    const useSuffix = typeof entry.useCount === 'number' && entry.useCount > 0 ? ` · used ${entry.useCount}×` : '';
    lines.push(`- 【经验】${truncate(entry.title, PROCEDURE_TITLE_MAX_CHARS)}${versionSuffix}${useSuffix}`);
    lines.push(`  when: ${truncate(entry.triggerText, PROCEDURE_TRIGGER_MAX_CHARS)}`);
    const steps = (entry.steps ?? []).map((step, index) => `${index + 1}. ${truncate(step, RECALL_STEP_MAX_CHARS)}`);
    if (steps.length) lines.push(`  steps: ${steps.join(' | ')}`);
    if (entry.pitfalls?.length) lines.push(`  avoid: ${entry.pitfalls.map((p) => truncate(p, PROCEDURE_PITFALL_MAX_CHARS)).join('；')}`);
    if (entry.sourcePinIds?.length) lines.push(`  source pins: ${entry.sourcePinIds.join(', ')}`);
  }
  lines.push('');
  lines.push('These are workflows that already worked for you. Follow the steps directly; revise with procedure_save when you find a better way.');
  return lines.join('\n');
}

/** Human-readable confirmation for the procedure_save tool response. */
export function formatProcedureSaveResult(input: {
  title: string;
  created: boolean;
  revised: boolean;
  version: number;
}): string {
  const verb = input.created ? 'Saved new procedure' : input.revised ? 'Updated procedure' : 'Procedure already up to date';
  return `${verb}: 「${truncate(input.title, PROCEDURE_TITLE_MAX_CHARS)}」 (version=${input.version}).`;
}
