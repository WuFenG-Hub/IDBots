/**
 * One-shot chat completion for Cognitive Orchestrator (Task 12.2).
 * Task 12.4: Native tools (function calling) support; returns content and/or tool_calls.
 * When llmId is provided (MetaBot's configured LLM), resolves that model's provider and config;
 * otherwise uses app default. Supports both OpenAI-compat (/v1/chat/completions) and
 * Anthropic (/v1/messages) APIs so that e.g. DeepSeek (anthropic format) works correctly.
 */

import { resolveApiConfigForModel } from '../libs/claudeSettings';
import { runWithLlmFallback } from './llmFallback';

/** OpenAI-style tool definition for function calling. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Single tool call from LLM response. */
export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

/** Chat completion result: content and/or tool_calls. */
export interface ChatCompletionResult {
  content?: string;
  tool_calls?: ToolCallResult[];
  /** Provider response metadata used to explain empty completions without logging prompt/output data. */
  responseMetadata?: ChatCompletionResponseMetadata;
}

export interface ChatCompletionResponseMetadata {
  apiType: 'openai' | 'anthropic';
  stopReason?: string | null;
  contentBlockTypes?: string[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cache-read tokens (hit) reported by the provider, if available. */
  cacheReadTokens?: number;
  /** Cache-creation tokens (miss) reported by the provider, if available. */
  cacheCreationTokens?: number;
}

/** Message for chat completion (OpenAI-style). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Mask baseURL for logs (keep scheme + host, hide path/auth). */
function maskBaseURL(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid URL)';
  }
}

function resolveThinkingForModel(
  model: string,
  thinking: 'enabled' | 'disabled' | undefined,
): 'enabled' | 'disabled' | undefined {
  if (!thinking) return undefined;
  const normalized = model.trim().toLowerCase();
  const isDeepSeekThinkingModel = normalized.includes('deepseek')
    || /(?:^|[-_/])(?:v4-(?:pro|flash)|reasoner|r1)(?:$|[-_/])/.test(normalized);
  return isDeepSeekThinkingModel ? thinking : undefined;
}

/**
 * Whether the cognitive layer should call the DeepSeek Responses API for this
 * model. The Responses API currently serves flash models only; pro and other
 * variants fall back to chat/completions. See
 * https://api-docs.deepseek.com/zh-cn/guides/responses_api
 */
function shouldUseDeepSeekResponses(provider: string | undefined, model: string): boolean {
  if (provider?.toLowerCase() !== 'deepseek') {
    return false;
  }
  return model.toLowerCase().includes('flash');
}

/** Build the DeepSeek Responses endpoint URL (host root, no /v1 prefix). */
function buildDeepSeekResponsesURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '');
  // Strip a trailing /anthropic or /v1 segment — the Responses endpoint lives
  // at the host root regardless of which compatibility path the user configured.
  const stripped = normalized.replace(/\/anthropic$/, '').replace(/\/v1$/, '');
  return `${stripped}/responses`;
}

/** Map an effort string to the DeepSeek Responses reasoning.effort value. */
function normalizeDeepSeekResponsesEffort(effort: string | undefined): 'low' | 'high' | 'max' {
  const normalized = (effort ?? '').trim().toLowerCase();
  if (normalized === 'max' || normalized === 'low') {
    return normalized;
  }
  // 'high' is the safe default; 'medium' maps to 'high'.
  return 'high';
}

/**
 * Reasoning object for the DeepSeek Responses API. The API defaults to
 * thinking ON (effort 'high') when `reasoning` is omitted, so 'disabled' must
 * be sent explicitly as { effort: 'none' } — omitting the field does NOT
 * disable thinking and lets the chain-of-thought consume the whole
 * max_output_tokens budget (status=incomplete with empty output).
 * Enabled/undefined stays at 'max' to match the project's DeepSeek-first
 * thinking-on policy. See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
function resolveDeepSeekResponsesReasoning(
  thinking: 'enabled' | 'disabled' | undefined,
): { effort: 'none' | 'max' } {
  return thinking === 'disabled' ? { effort: 'none' } : { effort: 'max' };
}

/**
 * Default max output tokens for one-shot cognitive calls that do not pass
 * maxTokens. Thinking-mode reasoning shares the output budget, so a
 * thinking-enabled call needs far more headroom than a disabled one — a 2-4K
 * ceiling lets max-effort reasoning consume the whole budget and return
 * truncated or empty text (the 2026-08-08 dream-diary failure mode, elsewhere).
 * Ceilings only: billing is by actual tokens used, so short replies cost the
 * same as before.
 */
function resolveDefaultMaxOutputTokens(thinking: 'enabled' | 'disabled' | undefined): number {
  return thinking === 'disabled' ? 4_096 : 16_384;
}

function extractAnthropicThinkingText(block: { type?: string; text?: string; thinking?: string }): string {
  if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return '';
  return block.thinking || block.text || '';
}

/** Options for one chat completion request (with optional fallback LLM retry). */
export interface ChatCompletionOptions {
  llmId?: string | null;
  /** Optional fallback provider key: retried once when the primary resolution or call fails. */
  fallbackLlmId?: string | null;
  tools?: OpenAITool[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /**
   * Thinking-mode toggle. DeepSeek v4-pro enables thinking by default with
   * effort=high, which makes lightweight llm.complete calls (e.g. chess moves)
   * take minutes and hit timeouts. Client may opt out with 'disabled'.
   */
  thinking?: 'enabled' | 'disabled';
  /**
   * When true, a response with neither text content nor tool_calls throws
   * inside the fallback-wrapped attempt, so a configured fallback LLM gets
   * a chance instead of the empty result passing through as success.
   */
  throwOnEmptyContent?: boolean;
}

/**
 * Chat completion with optional tools. Returns content and/or tool_calls.
 * Used by Cognitive Orchestrator for multi-turn tool loop (Task 12.4).
 * When options.fallbackLlmId is set (and differs from llmId), a failed primary
 * attempt (config resolution or API call) is retried once with the fallback.
 */
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionResult> {
  return runWithLlmFallback(options, (attemptOptions) => chatCompletionSingleAttempt(messages, attemptOptions));
}

/** Single chat completion attempt against the resolved config for options.llmId. */
async function chatCompletionSingleAttempt(
  messages: ChatMessage[],
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const { config, error } = resolveApiConfigForModel(options.llmId ?? undefined);
  if (error || !config) {
    throw new Error(error ?? 'LLM config not available');
  }

  const baseURL = config.baseURL?.trim();
  if (!baseURL) {
    throw new Error('LLM base URL not available');
  }

  const model = config.model || 'gpt-4o';
  const apiType = config.apiType ?? 'openai';
  const thinking = resolveThinkingForModel(model, options.thinking);
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
  // DeepSeek flash models support the Responses API (with built-in web_search).
  // Route them there when we have the real upstream base URL; fall back to the
  // chat/completions or Anthropic path otherwise. Pro and non-flash stay on
  // chat/completions until DeepSeek enables Responses for them.
  const useDeepSeekResponses = shouldUseDeepSeekResponses(config.provider, model);
  if (process.env.NODE_ENV === 'development' || hasTools) {
    console.log(
      `[Orchestrator] LLM call: apiType=${apiType} baseURL=${maskBaseURL(baseURL)} model=${model} tools=${hasTools ? options.tools!.length : 0} responses=${useDeepSeekResponses}`
    );
  }

  try {
    let result: ChatCompletionResult;
    if (useDeepSeekResponses && config.upstreamBaseURL) {
      result = await callDeepSeekResponsesStyle(
        config.upstreamBaseURL,
        model,
        config.apiKey ?? '',
        messages,
        options.tools,
        options.signal,
        options.maxTokens,
        options.temperature,
        thinking
      );
    } else if (apiType === 'anthropic') {
      result = await callAnthropicStyleWithTools(
        baseURL,
        model,
        config.apiKey ?? '',
        messages,
        options.tools,
        options.signal,
        options.maxTokens,
        options.temperature,
        thinking
      );
    } else {
      result = await callOpenAIStyleWithTools(
        baseURL,
        model,
        config.apiKey ?? '',
        messages,
        options.tools,
        options.signal,
        options.maxTokens,
        options.temperature,
        thinking
      );
    }
    if (options.throwOnEmptyContent && !result.content?.trim() && !result.tool_calls?.length) {
      const emptyError = new Error(formatEmptyCompletionError(result.responseMetadata));
      // 让上层（botBrowserBridgeService.completeLlm）能把「空回复」从 llm_unavailable 里区分出来。
      emptyError.name = 'EmptyCompletion';
      throw emptyError;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] chatCompletionWithTools failed:', msg);
    throw err;
  }
}

/**
 * One-shot completion for backward compatibility. When tools are not used,
 * returns only the reply text. For tool loop use chatCompletionWithTools.
 */
export async function performChatCompletionForOrchestrator(
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
  } = {}
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const result = await chatCompletionWithTools(messages, {
    llmId,
    fallbackLlmId: options.fallbackLlmId,
    signal: options.signal,
    maxTokens: options.maxTokens,
    throwOnEmptyContent: options.throwOnEmptyContent,
    thinking: options.thinking,
  });
  const content = result.content?.trim() ?? '';
  if (result.tool_calls?.length) {
    console.warn('[Orchestrator] performChatCompletionForOrchestrator: LLM returned tool_calls but no tools were requested; ignoring tool_calls');
  }
  return content;
}

/**
 * Build OpenAI request body messages from ChatMessage[] (strip tool_call_id/name for initial send).
 */
function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role };
    if (m.role === 'tool') {
      msg.content = m.content ?? '';
      msg.tool_call_id = m.tool_call_id ?? '';
    } else if (m.content !== undefined) {
      msg.content = m.content;
    }
    if (m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
    }
    return msg;
  });
}

/**
 * Anthropic-style API with optional tools. Returns content and tool_use blocks as tool_calls.
 */
async function callAnthropicStyleWithTools(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled'
): Promise<ChatCompletionResult> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`;
  const systemParts: string[] = [];
  const anthropicMessages: Array<{ role: string; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === 'system' && m.content) {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      anthropicMessages.push({ role: 'user', content: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      const content: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments,
          });
        }
      }
      if (content.length) anthropicMessages.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }],
      });
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens ?? resolveDefaultMaxOutputTokens(thinking),
    messages: anthropicMessages,
    system: systemParts.join('\n\n'),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (thinking !== undefined) {
    // DeepSeek Anthropic 格式支持 thinking toggle（默认 enabled，effort=high）。
    // 轻量 llm.complete 调用（如下棋走子）显式 disabled 可避免长思考与超时。
    body.thinking = { type: thinking };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim();
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM Anthropic error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  let data: {
    content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM Anthropic invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const contentBlocks = data.content ?? [];
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'anthropic',
      stopReason: data.stop_reason ?? null,
      contentBlockTypes: contentBlocks.map((block) => block.type ?? 'unknown'),
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    },
  };
  const toolCalls: ToolCallResult[] = [];
  let thinkingText = '';
  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text) {
      out.content = (out.content ?? '') + block.text;
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // DeepSeek thinking 等模型把推理放 thinking 块、text 可能为空；先收着做回退。
      thinkingText += extractAnthropicThinkingText(block);
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      const args =
        typeof (block as { input?: unknown }).input === 'string'
          ? (block as { input: string }).input
          : JSON.stringify((block as { input?: unknown }).input ?? {});
      toolCalls.push({ id: block.id, name: block.name, arguments: args });
    }
  }
  if (out.content) out.content = out.content.trim();
  if (!out.content && thinkingText.trim()) {
    // 没有 text 块时回退到 thinking 文本，避免上层把「空 content」误判为 llm_unavailable。
    // （browser.llm.complete / 象棋走子：LLM 答案可能只在推理里，解析层能从中提取合法着法。）
    out.content = thinkingText.trim();
    out.responseMetadata.contentBlockTypes = [
      ...(out.responseMetadata.contentBlockTypes ?? []),
      'reasoning-fallback',
    ];
  }
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

export const __cognitiveChatCompletionTestUtils = {
  resolveThinkingForModel,
  extractAnthropicThinkingText,
  shouldUseDeepSeekResponses,
  buildDeepSeekResponsesURL,
  normalizeDeepSeekResponsesEffort,
  resolveDeepSeekResponsesReasoning,
  resolveDefaultMaxOutputTokens,
};

/**
 * OpenAI-style API with tools. Returns content and/or tool_calls from response.
 */
async function callOpenAIStyleWithTools(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled'
): Promise<ChatCompletionResult> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(messages),
    max_tokens: maxTokens ?? resolveDefaultMaxOutputTokens(thinking),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (thinking !== undefined) {
    // DeepSeek OpenAI 兼容格式同样支持 thinking toggle。
    body.thinking = { type: thinking };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM OpenAI-compat error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  type ChoiceMessage = {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  let data: {
    choices?: Array<{ finish_reason?: string | null; message?: ChoiceMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM OpenAI-compat invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const msg = data.choices?.[0]?.message;
  // DeepSeek thinking 等模型可能把最终答案放在 reasoning_content，content 为空；
  // MetaApp browser.llm.complete 路径必须能读到文本，否则被映射成 llm_unavailable。
  const primaryContent = msg?.content != null ? String(msg.content).trim() : '';
  const reasoningFallback = String(msg?.reasoning_content || msg?.reasoning || '').trim();
  const resolvedContent = primaryContent || reasoningFallback;
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'openai',
      stopReason: data.choices?.[0]?.finish_reason ?? null,
      contentBlockTypes: [
        ...(primaryContent ? ['text'] : []),
        ...(!primaryContent && reasoningFallback ? ['reasoning'] : []),
        ...(msg?.tool_calls?.length ? ['tool_calls'] : []),
      ],
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
  };
  if (resolvedContent) {
    out.content = resolvedContent;
  }
  if (msg?.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? '',
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
    }));
  }
  return out;
}

/**
 * DeepSeek Responses API (/responses) call with optional tools.
 *
 * Unlike chat/completions, the Responses API takes `instructions` (system) and
 * `input` (conversation), and supports a server-side `web_search` tool. It is
 * stateless on DeepSeek, so the full history is sent every turn — which also
 * maximizes DeepSeek's automatic context-cache hit rate.
 *
 * Response cache tokens come nested under input_tokens_details.cached_tokens
 * (distinct from chat/completions' top-level prompt_cache_hit_tokens).
 */
async function callDeepSeekResponsesStyle(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled'
): Promise<ChatCompletionResult> {
  const url = buildDeepSeekResponsesURL(baseURL);
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === 'system' && m.content) {
      instructions.push(m.content);
      continue;
    }
    if (m.role === 'user' || m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) {
        parts.push({ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content });
      }
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
          });
        }
      }
      if (parts.length > 0) {
        input.push({ role: m.role, content: parts });
      }
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content ?? '',
      });
    }
  }

  // Tools: web_search first (server-side, stable across turns for cache), then
  // any caller-supplied function tools.
  const responseTools: Array<Record<string, unknown>> = [{ type: 'web_search' }];
  if (Array.isArray(tools)) {
    for (const t of tools) {
      responseTools.push({ type: 'function', name: t.function.name, parameters: t.function.parameters ?? {} });
    }
  }

  const body: Record<string, unknown> = {
    model,
    input,
    tools: responseTools,
    tool_choice: 'auto',
  };
  if (instructions.length > 0) {
    body.instructions = instructions.join('\n\n');
  }
  body.max_output_tokens = maxTokens ?? resolveDefaultMaxOutputTokens(thinking);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  // Reasoning effort: 'disabled' must be explicit ({ effort: 'none' }) — an
  // omitted field means thinking stays ON. See resolveDeepSeekResponsesReasoning.
  body.reasoning = resolveDeepSeekResponsesReasoning(thinking);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] DeepSeek Responses error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  type ResponsesOutputItem = {
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ text?: string }>;
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string;
  };
  let data: {
    id?: string;
    model?: string;
    status?: string;
    output?: ResponsesOutputItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] DeepSeek Responses invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const outputItems = data.output ?? [];
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'openai',
      stopReason: data.status === 'incomplete' ? 'length' : 'stop',
      contentBlockTypes: [],
    },
  };
  const toolCalls: ToolCallResult[] = [];
  let hasWebSearch = false;

  for (const item of outputItems) {
    const itemType = item.type;
    if (itemType === 'message') {
      for (const part of item.content ?? []) {
        if ((part.type === 'output_text' || part.type === 'text') && part.text) {
          out.content = (out.content ?? '') + part.text;
          out.responseMetadata.contentBlockTypes!.push('text');
        }
      }
    } else if (itemType === 'reasoning') {
      const reasoningText = (item.summary ?? []).map((s) => s.text ?? '').join('');
      if (reasoningText && !out.content) {
        // Fallback: if only reasoning is present, surface it (matches chat/completions behavior).
        out.content = reasoningText.trim();
        out.responseMetadata.contentBlockTypes!.push('reasoning');
      }
    } else if (itemType === 'web_search_call') {
      hasWebSearch = true;
    } else if (itemType === 'function_call' && (item.call_id || item.id) && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || '',
        name: item.name,
        arguments: item.arguments || '{}',
      });
    }
  }

  if (hasWebSearch) {
    out.responseMetadata.contentBlockTypes!.push('web_search');
  }
  if (out.content) {
    out.content = out.content.trim();
  }
  if (toolCalls.length) {
    out.tool_calls = toolCalls;
    out.responseMetadata.contentBlockTypes!.push('tool_calls');
  }

  // Cache + token accounting from the nested Responses usage shape.
  const promptTokens = data.usage?.input_tokens ?? null;
  const completionTokens = data.usage?.output_tokens ?? null;
  out.responseMetadata.inputTokens = promptTokens;
  out.responseMetadata.outputTokens = completionTokens;
  if (promptTokens != null) {
    const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
    // Stash cache fields on metadata for the usage accumulator; cognitive-layer
    // results don't have a dedicated cache field yet, so we encode it here for
    // future wiring into the usage stats pipeline.
    out.responseMetadata.cacheReadTokens = cached;
    out.responseMetadata.cacheCreationTokens = Math.max(promptTokens - cached, 0);
  }

  return out;
}

function formatEmptyCompletionError(metadata?: ChatCompletionResponseMetadata): string {
  if (!metadata) return 'LLM returned empty content';
  const details = [
    metadata.stopReason ? `stop_reason=${metadata.stopReason}` : null,
    metadata.contentBlockTypes?.length ? `blocks=${metadata.contentBlockTypes.join(',')}` : 'blocks=none',
    metadata.outputTokens != null ? `output_tokens=${metadata.outputTokens}` : null,
  ].filter(Boolean);
  return `LLM returned no text (${details.join('; ')})`;
}