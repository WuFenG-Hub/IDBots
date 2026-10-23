/**
 * Family-aware resolution of an OpenAI-compatible (chat/completions) choice
 * message into answer content — owns the "promote reasoning_content into
 * content?" decision so the openai-compat resolver in
 * services/cognitiveChatCompletion.ts stays a thin caller.
 *
 * Why family-aware at all (the 2026-10-23 ack-bubble leak): the turn-ack pass
 * ran on an always-thinking GLM-5.x brain, the ack budget burned inside
 * hidden reasoning, `content` came back empty, and the then-unconditional
 * fallback PROMOTED `reasoning_content` into the answer — a mid-thought
 * English analysis fragment then shipped as the ack bubble. For the GLM
 * family `reasoning_content` is ALWAYS hidden thinking (GLM-5.x cannot turn
 * thinking off — see ./modelThinking), so promoting it can only ever leak
 * reasoning as the answer. For the DeepSeek dialect the final answer CAN land
 * in `reasoning_content` with an empty `content`, so promotion must stay.
 * Unknown families keep the historical promote-if-empty behavior.
 */
import { thinkingWireFamily } from './modelThinking';

export type OpenAiCompatChoiceMessage = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
};

export type OpenAiCompatContentResolution = {
  /** Resolved answer content; '' when the message yields nothing usable. */
  content: string;
  /** True when `content` was promoted out of a reasoning field. */
  promotedFromReasoning: boolean;
  /**
   * text/reasoning entries for responseMetadata.contentBlockTypes. The
   * 'reasoning' entry is deliberately decoupled from promotion: it is
   * reported whenever reasoning fields are the only content-ish signal —
   * promoted or not — so consumers like the turn-ack guard (coworkUtil)
   * can still detect thinking-only replies on GLM. tool_calls is appended
   * by the caller.
   */
  contentBlockTypes: string[];
};

export function resolveOpenAiCompatContent(
  modelId: string | null | undefined,
  msg: OpenAiCompatChoiceMessage | null | undefined
): OpenAiCompatContentResolution {
  const primaryContent = msg?.content != null ? String(msg.content).trim() : '';
  const reasoningFallback = String(msg?.reasoning_content || msg?.reasoning || '').trim();
  if (primaryContent) {
    return { content: primaryContent, promotedFromReasoning: false, contentBlockTypes: ['text'] };
  }
  const blockTypes = reasoningFallback ? ['reasoning'] : [];
  if (reasoningFallback && thinkingWireFamily(modelId) !== 'glm') {
    return { content: reasoningFallback, promotedFromReasoning: true, contentBlockTypes: blockTypes };
  }
  return { content: '', promotedFromReasoning: false, contentBlockTypes: blockTypes };
}
