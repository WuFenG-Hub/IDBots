/**
 * OpenCode Go gateway per-model protocol resolution — main-process side
 * (renderer mirror: src/renderer/services/opencodeGoProtocol.ts; renderer
 * code must not import main).
 *
 * The gateway serves each model over exactly ONE wire protocol — pi-ai's
 * installed catalog (dsh-runtime node_modules
 * @earendil-works/pi-ai/dist/providers/data/opencode-go.json) declares the
 * serving protocol per model — and answers every other protocol with
 *
 *   HTTP 400 {"type":"ModelProtocolUnsupported",
 *             "message":"Model does not support this protocol."}
 *
 * The app, meanwhile, configures ONE provider-level apiFormat for every model
 * of the built-in 'opencode' provider. The 'responses' default was chosen for
 * DeepSeek Flash ("carries reasoning there, gateway serves pro/flash alike on
 * /v1/responses") and works for it — but the gateway serves the GLM line ONLY
 * over chat completions, so every turn on glm-5.3-flash died with
 * ModelProtocolUnsupported the moment the model catalog grew past deepseek
 * (2026-10-13 user incident: opencode + glm-5.3-flash + effort max; the
 * effort pick was coincidental — the protocol was the failure, and the same
 * route fails with effort off). deepseek-v4.1-flash stays untouched: it is
 * verified working on /v1/responses and keeps the Responses reasoning wire.
 *
 * Two evidence-backed corrections, applied ONLY when the route's base URL
 * points at the gateway (opencode.ai host — an 'opencode'-keyed provider with
 * a custom relay base URL keeps the configured format untouched):
 *
 * 1. GLM family (glm-4.5+/5.x+, same pattern as dshModelReasoning) → chat
 *    completions. Everything downstream follows the corrected format because
 *    it keys off apiFormat: dshModelReasoningDeclaration then supplies
 *    GLM_CHAT_COMPLETIONS_DECLARATION (the zai thinking dialect with explicit
 *    enable/disable), so the effort selector keeps working — low/high/max all
 *    map to the single 'enabled' wire state, exactly like the zhipu GLM
 *    routes.
 * 2. Responses-only models (gpt-*-luna, grok-4.6/4.7, muse-spark-*) → the
 *    Responses wire. They fail /chat/completions with the same 400 (the Luna
 *    pair is responses-only; zai-org/feedback#840), so a chat-completions or
 *    anthropic config is corrected up.
 *
 * Unknown models pass through untouched: the gateway's catalog grows with
 * kernel upgrades while this table is static, and a wrong correction would
 * break a currently-working route — the configured format is the safer
 * default for anything this module cannot vouch for.
 */
import { isOpenCodeGoBaseUrl } from './opencodeGatewayHeaders';
import { isGlmFamilyModelId } from './dshModelReasoning';

export type OpenCodeGoApiFormat = 'openai' | 'responses' | 'anthropic';

/** Bare model id: drop any vendor prefix ("z-ai/glm-5.3-flash" → "glm-5.3-flash"). */
export function bareOpenCodeGoModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

// Models the gateway serves ONLY over the OpenAI Responses wire (pi-ai
// opencode-go.json: openai-responses section). Matched on the bare id,
// case-insensitive, tolerant of tag suffixes.
const RESPONSES_ONLY_PATTERNS = [
  /^gpt-[\d.]+-luna(?:[.\-_].*)?$/i,
  /^grok-4\.[67](?:[.\-_].*)?$/i,
  /^muse-spark-/i,
];

const isResponsesOnlyModelId = (modelId: string): boolean => {
  const bare = bareOpenCodeGoModelId(modelId);
  return RESPONSES_ONLY_PATTERNS.some((pattern) => pattern.test(bare));
};

export interface OpenCodeGoApiFormatInput {
  /** Route base URL — the correction applies only to gateway hosts. */
  baseUrl?: string | null;
  /** Route model id (vendor prefixes are stripped before matching). */
  model?: string | null;
  /** The configured provider-level apiFormat. */
  apiFormat: OpenCodeGoApiFormat;
}

/**
 * ApiFormat a route should actually ride: the configured format, corrected
 * per model for the OpenCode Go gateway when the configured format is one the
 * gateway does not serve for that model. Non-gateway routes and unknown
 * models pass through unchanged.
 */
export function resolveOpenCodeGoApiFormat(input: OpenCodeGoApiFormatInput): OpenCodeGoApiFormat {
  if (!isOpenCodeGoBaseUrl(input.baseUrl)) return input.apiFormat;
  const model = String(input.model ?? '').trim();
  if (!model) return input.apiFormat;
  // GLM is completions-only on this gateway (responses AND the anthropic
  // /v1/messages wire both answer ModelProtocolUnsupported for the family —
  // pi-ai's catalog lists it exclusively under openai-completions).
  if (input.apiFormat !== 'openai' && isGlmFamilyModelId(model)) return 'openai';
  if (input.apiFormat !== 'responses' && isResponsesOnlyModelId(model)) return 'responses';
  return input.apiFormat;
}
