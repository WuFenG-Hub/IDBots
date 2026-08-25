/**
 * Session substantive-activity detection for the orchestration
 * WORKER_EMPTY_HANDOFF judgment (使用改进清单 #10 P-A).
 *
 * Background: a worker session that actually did real work — edited files,
 * committed, ran tests — but ended with an empty / non-answer final reply
 * was judged a bare `WORKER_EMPTY_HANDOFF`. The chair had no evidence to
 * tell a false failure (work done, handoff text lost) from a truly idle
 * session. These helpers summarize the session's message-level activity so
 * the error can carry commit/tests/files/toolCalls/errors/lastError evidence
 * (format: WORKER_EMPTY_HANDOFF_WITH_ACTIVITY: commit=[...] tests=[...]
 * files=[...] toolCalls=N errors=N lastError=...).
 *
 * Message shapes as persisted by CoworkRunner.handleClaudeEvent:
 * - tool_use:    content `Using tool: <name>`,
 *                metadata { toolName, toolInput, toolUseId }
 * - tool_result: content <formatted result>,
 *                metadata { toolResult, toolUseId, error?, isError }
 * - assistant:   content text, metadata { isThinking? }
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

export interface CoworkSessionActivityMessage {
  type: string;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export interface CoworkSessionActivitySummary {
  /** tool_use message count */
  toolCalls: number;
  /** tool_result messages marked isError */
  errors: number;
  /** unique file targets of Edit/Write/MultiEdit/NotebookEdit tool calls (capped) */
  files: string[];
  /** test / tsc pass-evidence lines pulled from tool results and Bash commands (capped) */
  tests: string[];
  /** last non-empty assistant texts (capped) */
  tailText: string[];
  /** content of the last error tool_result, if any */
  lastError: string | null;
  /** commit-ish short hashes mentioned in tool results (message-level evidence) */
  commits: string[];
}

export const WORKER_EMPTY_HANDOFF = 'WORKER_EMPTY_HANDOFF';
export const WORKER_EMPTY_HANDOFF_WITH_ACTIVITY = 'WORKER_EMPTY_HANDOFF_WITH_ACTIVITY';

const MAX_FILES = 12;
const MAX_TESTS = 5;
const MAX_TAIL = 3;
const MAX_COMMITS = 5;
const MAX_LINE_LEN = 120;
const MAX_ERROR_LEN = 200;
const MAX_TOTAL_LEN = 1600;

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_RUN_COMMAND_RE = /\b(npm test|node --test|vitest|jest|tsc|ts-node|compile|electron-tsconfig|run tests)\b/i;
/** Lines that look like test/tsc outcome evidence inside a tool result. */
const TEST_EVIDENCE_LINE_RE =
  /\b(\d+\s*\/\s*\d+|\d+\s+(?:tests?|checks?|specs?|assertions?)\s+(?:passed|ok|green|failed|failing)|all\s+(?:tests?\s+)?(?:passed|green|ok)|--noEmit|exited\s+0|\bPASS\b|\bOK\b|\bFAIL\b)\b/i;
/** commit-like tokens in free text: `commit abc1234`, full 40-hex SHA, `git log --oneline` lines. */
const COMMIT_PATTERNS: RegExp[] = [
  /\bcommit\s+([0-9a-f]{7,40})\b/i,
  /\b([0-9a-f]{40})\b/,
  /^([0-9a-f]{7,12})\s+\S.*$/m,
];

const execFileAsync = promisify(execFile);

function truncate(text: string, max: number): string {
  const trimmed = stripLoneSurrogates(String(text ?? '').trim());
  if (trimmed.length <= max) return trimmed;
  return `${truncateUtf16Units(trimmed, max - 1)}…`;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFiles(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return [];
  const toolInput = metadata.toolInput;
  if (!toolInput || typeof toolInput !== 'object') return [];
  const input = toolInput as Record<string, unknown>;
  const candidate = input.file_path ?? input.notebook_path ?? input.path;
  return typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : [];
}

function extractTestsFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!TEST_EVIDENCE_LINE_RE.test(trimmed)) return null;
  return truncate(trimmed, MAX_LINE_LEN);
}

/** All commit-like tokens in a tool result (multi-line git log output yields several). */
function extractCommitsFromContent(content: string, budget: number): string[] {
  const found: string[] = [];
  for (const pattern of COMMIT_PATTERNS) {
    const regex = new RegExp(pattern.source, `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while (found.length < budget && (match = regex.exec(content)) !== null) {
      if (match[1]) found.push(match[1]);
      if (match[0].length === 0) regex.lastIndex += 1; // zero-width safety
    }
    if (found.length >= budget) break;
  }
  return found;
}

/**
 * Summarize the session's message-level activity. Pure and synchronous so the
 * EMPTY_HANDOFF judgment can enrich its error without touching the store.
 */
export function summarizeSessionActivity(
  messages: CoworkSessionActivityMessage[],
): CoworkSessionActivitySummary {
  const files: string[] = [];
  const tests: string[] = [];
  const commits: string[] = [];
  const tailText: string[] = [];
  let toolCalls = 0;
  let errors = 0;
  let lastError: string | null = null;

  for (const message of messages) {
    const type = String(message.type ?? '');
    const content = String(message.content ?? '');
    const metadata = message.metadata ?? null;

    if (type === 'tool_use') {
      toolCalls += 1;
      const toolName = typeof metadata?.toolName === 'string' ? metadata.toolName : '';
      if (FILE_TOOLS.has(toolName)) {
        const extracted = extractFiles(metadata);
        if (extracted.length > 0 && files.length < MAX_FILES) files.push(...extracted);
      }
      if (toolName === 'Bash') {
        const command = typeof metadata?.toolInput === 'object' && metadata.toolInput
          ? String((metadata.toolInput as Record<string, unknown>).command ?? '')
          : '';
        if (command && TEST_RUN_COMMAND_RE.test(command) && tests.length < MAX_TESTS) {
          tests.push(truncate(command, MAX_LINE_LEN));
        }
      }
      continue;
    }

    if (type === 'tool_result') {
      const isError = Boolean(metadata?.isError) || Boolean(metadata?.error);
      if (isError) {
        errors += 1;
        lastError = truncate(content || String(metadata?.error ?? ''), MAX_ERROR_LEN);
      }
      for (const line of content.split('\n')) {
        const evidence = extractTestsFromLine(line);
        if (evidence && tests.length < MAX_TESTS) tests.push(evidence);
      }
      const extractedCommits = extractCommitsFromContent(content, MAX_COMMITS - commits.length);
      if (extractedCommits.length > 0) commits.push(...extractedCommits);
      continue;
    }

    if (type === 'assistant') {
      if (metadata?.isThinking === true) continue;
      const trimmed = content.trim();
      if (!trimmed) continue;
      if (trimmed === '[reasoning unavailable]') continue;
      if (tailText.length < MAX_TAIL) tailText.push(truncate(trimmed, MAX_LINE_LEN));
    }
  }

  return {
    toolCalls,
    errors,
    files: unique(files).slice(0, MAX_FILES),
    tests: unique(tests).slice(0, MAX_TESTS),
    tailText: tailText.slice(-MAX_TAIL),
    lastError,
    commits: unique(commits).slice(0, MAX_COMMITS),
  };
}

/**
 * A session counts as substantively active when it shows real work evidence:
 * commits, file edits/writes, test/tsc outcome lines, a meaningful number of
 * tool calls, or narrated progress text. Purely observational sessions (a few
 * reads, nothing else) stay below the bar and keep the bare EMPTY_HANDOFF.
 */
export function hasSubstantiveActivity(summary: CoworkSessionActivitySummary): boolean {
  return (
    summary.commits.length > 0
    || summary.files.length > 0
    || summary.tests.length > 0
    || summary.toolCalls >= 4
    || summary.tailText.length >= 2
  );
}

/**
 * Build the enriched failure error: `WORKER_EMPTY_HANDOFF_WITH_ACTIVITY:
 * commit=[...] tests=[...] files=[...] toolCalls=N errors=N lastError=...`
 * so the chair can immediately recognize a false failure and reuse the work.
 * `extraCommits` may carry workspace-level git evidence (collectWorkspaceCommits).
 */
export function formatWorkerEmptyHandoffError(
  summary: CoworkSessionActivitySummary,
  extraCommits: string[] = [],
): string {
  const commits = unique([...summary.commits, ...extraCommits]).slice(0, MAX_COMMITS);
  const parts = [
    `commit=[${commits.join(',')}]`,
    `tests=[${summary.tests.join(' | ')}]`,
    `files=[${summary.files.join(',')}]`,
    `toolCalls=${summary.toolCalls}`,
    `errors=${summary.errors}`,
    summary.lastError ? `lastError=${summary.lastError}` : null,
  ].filter((part): part is string => part != null);
  let message = `${WORKER_EMPTY_HANDOFF_WITH_ACTIVITY}: ${parts.join(' ')}`;
  if (message.length > MAX_TOTAL_LEN) {
    message = `${message.slice(0, MAX_TOTAL_LEN - 1)}…(truncated)`;
  }
  return message;
}

/**
 * Best-effort git evidence from the worker workspace: the short hashes of the
 * most recent commits (optionally filtered to commits after `since`, e.g. the
 * attempt's startedAt). Never throws — any failure yields [].
 */
export async function collectWorkspaceCommits(
  cwd: string | null | undefined,
  since?: string | null,
): Promise<string[]> {
  if (!cwd) return [];
  try {
    const args = ['log', '--oneline', '-n', '5'];
    if (since) args.push('--since', since);
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 5000 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0] ?? '')
      .filter((hash) => /^[0-9a-f]{7,40}$/.test(hash))
      .slice(0, MAX_COMMITS);
  } catch {
    return [];
  }
}
