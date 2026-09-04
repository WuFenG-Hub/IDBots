import { resolveApiConfigForModel, resolveCurrentApiConfig } from './claudeSettings';
import { clearCoworkSessionUpstream } from './coworkOpenAICompatProxy';
import type { CoworkMemoryGuardLevel } from './coworkMemoryExtractor';
import { isQuestionLikeMemoryText } from './coworkMemoryExtractor';
import { truncateUtf16Units } from './llmSafeText';

/**
 * System-brain seam for the memory judge/extractor. These are fleet-level
 * automations, so they must ride the Twin Bot's brain pair (primary +
 * fallback) instead of the bare app default model — the default may be the
 * metaid-free onboarding model whose exhausted free quota must never disable
 * memory. main.ts sets the resolver once at startup; when no twin brain is
 * configured (new-user onboarding), the app default keeps serving.
 */
export interface MemoryJudgeBrain {
  llmId: string | null;
  llmProvider: string | null;
  fallbackLlmId: string | null;
  fallbackLlmProvider: string | null;
}

let memoryJudgeBrainResolver: (() => MemoryJudgeBrain | null) | null = null;

export function setMemoryJudgeBrainResolver(resolver: (() => MemoryJudgeBrain | null) | null): void {
  memoryJudgeBrainResolver = resolver;
}

type JudgeApiConfig = { baseURL: string; apiKey: string; model: string };

let memoryJudgePinCounter = 0;

/**
 * Config candidates in preference order: twin primary brain, then twin
 * fallback brain. The app default model is used ONLY when the twin has no
 * brain configured at all. Each brain candidate pins its proxy upstream under
 * a throwaway key (concurrent one-shot callers must never repoint it); the
 * caller releases all pins via releaseJudgeApiConfigCandidates.
 */
function resolveJudgeApiConfigCandidates(): Array<{ config: JudgeApiConfig; pinKey: string | null }> {
  const candidates: Array<{ config: JudgeApiConfig; pinKey: string | null }> = [];
  const seen = new Set<string>();
  const pushBrain = (llmId: string | null, llmProvider: string | null): void => {
    const id = llmId?.trim();
    if (!id) return;
    memoryJudgePinCounter = (memoryJudgePinCounter + 1) % Number.MAX_SAFE_INTEGER;
    const pinKey = `memory-judge-${Date.now().toString(36)}-${memoryJudgePinCounter}`;
    const { config } = resolveApiConfigForModel(id, 'local', pinKey, llmProvider ?? undefined);
    if (!config?.baseURL) {
      clearCoworkSessionUpstream(pinKey);
      return;
    }
    const dedupeKey = `${config.baseURL}|${config.model}`;
    if (seen.has(dedupeKey)) {
      clearCoworkSessionUpstream(pinKey);
      return;
    }
    seen.add(dedupeKey);
    candidates.push({ config: { baseURL: config.baseURL, apiKey: config.apiKey ?? '', model: config.model }, pinKey });
  };
  const brain = memoryJudgeBrainResolver?.() ?? null;
  if (brain) {
    pushBrain(brain.llmId, brain.llmProvider);
    pushBrain(brain.fallbackLlmId, brain.fallbackLlmProvider);
  }
  if (candidates.length === 0) {
    const { config } = resolveCurrentApiConfig();
    if (config?.baseURL) {
      candidates.push({ config: { baseURL: config.baseURL, apiKey: config.apiKey ?? '', model: config.model }, pinKey: null });
    }
  }
  return candidates;
}

function releaseJudgeApiConfigCandidates(candidates: Array<{ pinKey: string | null }>): void {
  for (const candidate of candidates) {
    if (candidate.pinKey) clearCoworkSessionUpstream(candidate.pinKey);
  }
}

const FACTUAL_PROFILE_RE = /(我叫|我是|我的名字|我名字|我来自|我住在|我的职业|我有(?!\s*(?:一个|个)?问题)|我养了|我喜欢|我偏好|我习惯|\bmy\s+name\s+is\b|\bi\s+am\b|\bi['’]?m\b|\bi\s+live\s+in\b|\bi['’]?m\s+from\b|\bi\s+work\s+as\b|\bi\s+have\b|\bi\s+prefer\b|\bi\s+like\b|\bi\s+usually\b)/i;
const TRANSIENT_RE = /(今天|昨日|昨天|刚刚|刚才|本周|本月|临时|暂时|这次|当前|today|yesterday|this\s+week|this\s+month|temporary|for\s+now)/i;
const PROCEDURAL_RE = /(执行以下命令|run\s+(?:the\s+)?following\s+command|\b(?:cd|npm|pnpm|yarn|node|python|bash|sh|git|curl|wget)\b|\$[A-Z_][A-Z0-9_]*|&&|--[a-z0-9-]+|\/tmp\/|\.sh\b|\.bat\b|\.ps1\b)/i;
const REQUEST_STYLE_RE = /^(?:请|麻烦|帮我|请你|帮忙|请帮我|use|please|can you|could you|would you)/i;
const ASSISTANT_STYLE_RE = /((请|以后|后续|默认|请始终|不要再|请不要|优先|务必).*(回复|回答|语言|中文|英文|格式|风格|语气|简洁|详细|代码|命名|markdown|respond|reply|language|format|style|tone))/i;
const LLM_BORDERLINE_MARGIN = 0.08;
const LLM_MIN_CONFIDENCE = 0.55;
const LLM_TIMEOUT_MS = 5000;
const LLM_CACHE_MAX_SIZE = 256;
const LLM_CACHE_TTL_MS = 10 * 60 * 1000;
const LLM_INPUT_MAX_CHARS = 280;

export interface MemoryJudgeInput {
  text: string;
  isExplicit: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  llmEnabled?: boolean;
}

export interface MemoryJudgeResult {
  accepted: boolean;
  score: number;
  reason: string;
  source: 'rule' | 'llm';
}

type CachedLlmJudgeResult = {
  value: MemoryJudgeResult;
  createdAt: number;
};

const llmJudgeCache = new Map<string, CachedLlmJudgeResult>();

function thresholdByGuardLevel(isExplicit: boolean, guardLevel: CoworkMemoryGuardLevel): number {
  if (isExplicit) {
    if (guardLevel === 'strict') return 0.7;
    if (guardLevel === 'relaxed') return 0.52;
    return 0.6;
  }
  if (guardLevel === 'strict') return 0.8;
  if (guardLevel === 'relaxed') return 0.62;
  return 0.72;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function shouldCallLlmForBoundaryCase(score: number, threshold: number, reason: string): boolean {
  if (reason === 'empty' || reason === 'question-like' || reason === 'procedural-like') {
    return false;
  }
  return Math.abs(score - threshold) <= LLM_BORDERLINE_MARGIN;
}

function buildLlmCacheKey(input: MemoryJudgeInput): string {
  return `${input.guardLevel}|${input.isExplicit ? 1 : 0}|${normalizeText(input.text)}`;
}

function getCachedLlmResult(key: string): MemoryJudgeResult | null {
  const cached = llmJudgeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > LLM_CACHE_TTL_MS) {
    llmJudgeCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedLlmResult(key: string, value: MemoryJudgeResult): void {
  llmJudgeCache.set(key, { value, createdAt: Date.now() });
  while (llmJudgeCache.size > LLM_CACHE_MAX_SIZE) {
    const oldestKey = llmJudgeCache.keys().next().value;
    if (!oldestKey || typeof oldestKey !== 'string') break;
    llmJudgeCache.delete(oldestKey);
  }
}

function scoreMemoryText(text: string): { score: number; reason: string } {
  const normalized = normalizeText(text);
  if (!normalized) return { score: 0, reason: 'empty' };
  if (isQuestionLikeMemoryText(normalized)) {
    return { score: 0.05, reason: 'question-like' };
  }

  let score = 0.5;
  let strongestReason = 'neutral';

  if (FACTUAL_PROFILE_RE.test(normalized)) {
    score += 0.28;
    strongestReason = 'factual-personal';
  }
  if (ASSISTANT_STYLE_RE.test(normalized)) {
    score += 0.1;
    strongestReason = strongestReason === 'neutral' ? 'assistant-preference' : strongestReason;
  }
  if (REQUEST_STYLE_RE.test(normalized)) {
    score -= 0.14;
    if (strongestReason === 'neutral') strongestReason = 'request-like';
  }
  if (TRANSIENT_RE.test(normalized)) {
    score -= 0.18;
    if (strongestReason === 'neutral') strongestReason = 'transient-like';
  }
  if (PROCEDURAL_RE.test(normalized)) {
    score -= 0.4;
    strongestReason = 'procedural-like';
  }
  if (normalized.length < 6) {
    score -= 0.2;
  } else if (normalized.length <= 120) {
    score += 0.06;
  } else if (normalized.length > 240) {
    score -= 0.08;
  }

  return { score: clamp01(score), reason: strongestReason };
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/messages';
  }
  if (normalized.endsWith('/v1/messages')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        return typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'string') return content.trim();
  if (typeof record.output_text === 'string') return record.output_text.trim();
  return '';
}

function parseLlmJudgePayload(text: string): { accepted: boolean; confidence: number; reason: string } | null {
  if (!text.trim()) return null;
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    const acceptedRaw = parsed.accepted;
    const decisionRaw = parsed.decision;
    const confidenceRaw = parsed.confidence;
    const reasonRaw = parsed.reason;

    const accepted =
      typeof acceptedRaw === 'boolean'
        ? acceptedRaw
        : typeof decisionRaw === 'string'
          ? /(accept|allow|yes|true|pass)/i.test(decisionRaw)
          : false;
    const confidence = clamp01(
      typeof confidenceRaw === 'number'
        ? confidenceRaw
        : typeof confidenceRaw === 'string'
          ? Number(confidenceRaw)
          : 0
    );
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : 'llm';
    return { accepted, confidence, reason };
  } catch {
    return null;
  }
}

async function judgeWithLlm(
  input: MemoryJudgeInput,
  ruleScore: number,
  threshold: number,
  ruleReason: string
): Promise<MemoryJudgeResult | null> {
  const candidates = resolveJudgeApiConfigCandidates();
  if (candidates.length === 0) return null;

  const normalizedText = truncateUtf16Units(normalizeText(input.text), LLM_INPUT_MAX_CHARS);
  if (!normalizedText) {
    releaseJudgeApiConfigCandidates(candidates);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  const systemPrompt = [
    'You classify whether a sentence is durable long-term user memory.',
    'Accept only stable personal facts or stable assistant preferences.',
    'Reject questions, temporary context, one-off tasks, and procedural command text.',
    'Return JSON only: {"accepted":boolean,"confidence":number,"reason":string}',
  ].join(' ');

  const userPrompt = JSON.stringify({
    text: normalizedText,
    is_explicit: input.isExplicit,
    guard_level: input.guardLevel,
    rule_score: Number(ruleScore.toFixed(3)),
    threshold: Number(threshold.toFixed(3)),
    rule_reason: ruleReason,
  });

  try {
    // Twin primary → twin fallback: one exhausted/rejected brain must not
    // disable judging while the other is healthy.
    for (const { config } of candidates) {
      const url = buildAnthropicMessagesUrl(config.baseURL);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 120,
            temperature: 0,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: controller.signal,
        });
      } catch {
        return null; // timeout/abort: the shared 5s budget is spent
      }
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      const text = extractTextFromAnthropicResponse(payload);
      const parsed = parseLlmJudgePayload(text);
      if (!parsed) {
        continue;
      }
      if (parsed.confidence < LLM_MIN_CONFIDENCE) {
        return null;
      }

      return {
        accepted: parsed.accepted,
        score: parsed.confidence,
        reason: `llm:${parsed.reason || 'boundary'}`,
        source: 'llm',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    releaseJudgeApiConfigCandidates(candidates);
  }
}

export async function judgeMemoryCandidate(input: MemoryJudgeInput): Promise<MemoryJudgeResult> {
  const { score, reason } = scoreMemoryText(input.text);
  const threshold = thresholdByGuardLevel(input.isExplicit, input.guardLevel);
  const ruleResult: MemoryJudgeResult = {
    accepted: score >= threshold,
    score,
    reason,
    source: 'rule',
  };
  if (!shouldCallLlmForBoundaryCase(score, threshold, reason)) {
    return ruleResult;
  }
  if (!input.llmEnabled) {
    return ruleResult;
  }

  const cacheKey = buildLlmCacheKey(input);
  const cached = getCachedLlmResult(cacheKey);
  if (cached) {
    return cached;
  }

  const llmResult = await judgeWithLlm(input, score, threshold, reason);
  if (!llmResult) {
    return ruleResult;
  }
  setCachedLlmResult(cacheKey, llmResult);
  return llmResult;
}

// ---------------------------------------------------------------------------
// Turn-level multilingual memory extraction (global-audit de-hardgate)
//
// The regex extractor in coworkMemoryExtractor only recognizes zh/en signal
// phrases, so for every other language neither explicit commands ("recuerda
// que me llamo Carlos") nor implicit personal facts ever reached the judge —
// memory silently did not exist for non-zh/en users. This pass extracts
// memory-worthy changes from the WHOLE turn text in any language. It runs at
// most once per turn, only when the session's LLM judge is enabled and the
// text is substantive (isSubstantiveMemoryText); regex-extracted candidates
// keep their existing judged path and are deduped against these.
// ---------------------------------------------------------------------------

export interface TurnMemoryExtractionChange {
  action: 'add' | 'delete';
  text: string;
  isExplicit: boolean;
}

export type TurnMemoryExtractionRunner = (input: {
  userText: string;
  assistantText: string;
  guardLevel: CoworkMemoryGuardLevel;
  implicitEnabled: boolean;
}) => Promise<TurnMemoryExtractionChange[] | null>;

let turnMemoryExtractionRunner: TurnMemoryExtractionRunner | null = null;

/** Test seam: inject a deterministic extraction runner (null restores the default). */
export function setTurnMemoryExtractionRunner(runner: TurnMemoryExtractionRunner | null): void {
  turnMemoryExtractionRunner = runner;
}

const TURN_EXTRACTION_MAX_USER_CHARS = 1200;
const TURN_EXTRACTION_MAX_ASSISTANT_CHARS = 400;
const TURN_EXTRACTION_MAX_TEXT_CHARS = 500;
const TURN_EXTRACTION_MAX_IMPLICIT_ADDS = 2;
const TURN_EXTRACTION_MAX_EXPLICIT_ADDS = 2;
const TURN_EXTRACTION_MAX_DELETES = 2;

type CachedExtraction = { value: TurnMemoryExtractionChange[]; createdAt: number };
const extractionCache = new Map<string, CachedExtraction>();

/** Pure payload parser, exported for unit tests. Returns null on unusable output. */
export function parseTurnMemoryExtractionPayload(raw: string): TurnMemoryExtractionChange[] | null {
  const match = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { changes?: unknown };
    if (!Array.isArray(parsed.changes)) return null;
    const changes: TurnMemoryExtractionChange[] = [];
    let implicitAdds = 0;
    let explicitAdds = 0;
    let deletes = 0;
    for (const entry of parsed.changes) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const action = row.action === 'delete' ? 'delete' : row.action === 'add' ? 'add' : null;
      const text = truncateUtf16Units(normalizeText(String(row.text ?? '')), TURN_EXTRACTION_MAX_TEXT_CHARS);
      if (!action || text.length < 2) continue;
      const isExplicit = row.is_explicit === true || row.isExplicit === true;
      if (action === 'delete') {
        if (deletes >= TURN_EXTRACTION_MAX_DELETES) continue;
        deletes += 1;
      } else if (isExplicit) {
        if (explicitAdds >= TURN_EXTRACTION_MAX_EXPLICIT_ADDS) continue;
        explicitAdds += 1;
      } else {
        if (implicitAdds >= TURN_EXTRACTION_MAX_IMPLICIT_ADDS) continue;
        implicitAdds += 1;
      }
      changes.push({ action, text, isExplicit });
    }
    return changes;
  } catch {
    return null;
  }
}

async function runTurnMemoryExtractionDefault(input: {
  userText: string;
  assistantText: string;
  guardLevel: CoworkMemoryGuardLevel;
  implicitEnabled: boolean;
}): Promise<TurnMemoryExtractionChange[] | null> {
  const candidates = resolveJudgeApiConfigCandidates();
  if (candidates.length === 0) return null;
  const userText = truncateUtf16Units(normalizeText(input.userText), TURN_EXTRACTION_MAX_USER_CHARS);
  if (!userText) {
    releaseJudgeApiConfigCandidates(candidates);
    return null;
  }
  const assistantText = truncateUtf16Units(normalizeText(input.assistantText ?? ''), TURN_EXTRACTION_MAX_ASSISTANT_CHARS);

  const guardClause = input.guardLevel === 'strict'
    ? 'strict: extract only unmistakable durable facts'
    : input.guardLevel === 'relaxed'
      ? 'relaxed: plausible durable facts are fine too'
      : 'standard: extract clear durable facts';
  const systemPrompt = [
    'You extract long-term memories worth keeping from ONE assistant-conversation turn. The user may write in ANY language — extract across languages, never assume Chinese or English.',
    'Extract durable personal facts, durable preferences, and explicit remember/forget instructions the USER gave (e.g. "remember that ...", "olvida que ...").',
    'Never extract: questions, transient context (today\'s news, one-off tasks, current debugging), procedural/command output, or anything the assistant merely said about itself unless the user confirmed it as a durable preference.',
    `Guard level — ${guardClause}.`,
    input.implicitEnabled
      ? 'Implicit-memory mode: implicit facts AND explicit instructions both count.'
      : 'Explicit-only mode: extract ONLY explicit remember/forget instructions from the user.',
    'Each "text" carries the fact itself in the user\'s own language, with the instruction verb stripped. Do not translate.',
    'Return strict JSON only: {"changes":[{"action":"add"|"delete","text":"...","is_explicit":true|false}]} — at most 2 implicit adds, 2 explicit adds, 2 deletes; return {"changes":[]} when nothing qualifies.',
  ].join('\n');
  const userPrompt = JSON.stringify({
    user_message: userText,
    assistant_message: assistantText,
    guard_level: input.guardLevel,
    implicit_enabled: input.implicitEnabled,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS * 2);
  try {
    // Twin primary → twin fallback, same failover rule as judgeWithLlm.
    for (const { config } of candidates) {
      let response: Response;
      try {
        response = await fetch(buildAnthropicMessagesUrl(config.baseURL), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 400,
            temperature: 0,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
          signal: controller.signal,
        });
      } catch {
        return null; // timeout/abort: the shared budget is spent
      }
      if (!response.ok) continue;
      const payload = await response.json();
      const text = extractTextFromAnthropicResponse(payload);
      const parsed = parseTurnMemoryExtractionPayload(text);
      if (!parsed) continue;
      return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    releaseJudgeApiConfigCandidates(candidates);
  }
}

export async function judgeTurnMemoryExtraction(input: {
  userText: string;
  assistantText: string;
  guardLevel: CoworkMemoryGuardLevel;
  implicitEnabled: boolean;
}): Promise<TurnMemoryExtractionChange[] | null> {
  if (turnMemoryExtractionRunner) {
    try {
      return await turnMemoryExtractionRunner(input);
    } catch {
      return null;
    }
  }
  const cacheKey = `turn-extract|${input.guardLevel}|${input.implicitEnabled ? 1 : 0}|${normalizeText(input.userText)}`;
  const cached = extractionCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.createdAt > LLM_CACHE_TTL_MS) {
      extractionCache.delete(cacheKey);
    } else {
      return cached.value;
    }
  }
  const result = await runTurnMemoryExtractionDefault(input);
  if (result) {
    extractionCache.set(cacheKey, { value: result, createdAt: Date.now() });
    while (extractionCache.size > LLM_CACHE_MAX_SIZE) {
      const oldestKey = extractionCache.keys().next().value;
      if (!oldestKey || typeof oldestKey !== 'string') break;
      extractionCache.delete(oldestKey);
    }
  }
  return result;
}
