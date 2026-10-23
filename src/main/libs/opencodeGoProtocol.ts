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
 * /v1/responses") — but the gateway serves the GLM line ONLY over chat
 * completions, so every turn on glm-5.3-flash died with
 * ModelProtocolUnsupported the moment the model catalog grew past deepseek
 * (2026-10-13 user incident: opencode + glm-5.3-flash + effort max; the
 * effort pick was coincidental — the protocol was the failure, and the same
 * route fails with effort off).
 *
 * DeepSeek on /v1/responses "worked" only as a gateway translation: the
 * catalog lists deepseek-v4-pro / deepseek-v4.1-flash exclusively under
 * openai-completions (with DeepSeek's reasoning_content replay compat), and
 * on the Responses wire the gateway returns reasoning items without
 * encrypted_content, so every tool round's reasoning_content exists only in
 * the gateway's Responses→chat translation. That translation dropped it once
 * (2026-10-21 session b29803fc: 18 tool rounds fine, then — right after a
 * 144 s ask_user_question pause — DeepSeek rejected the next request with
 * "The `reasoning_content` in the thinking mode must be passed back to the
 * API"; the identical request replayed from the session log passes, so the
 * fault was the gateway's, not the client's). The host classifies that 400 as
 * won't-heal, so the session died on the spot. The family therefore rides the
 * gateway's own declared wire, where pi-ai owns the reasoning_content
 * round-trip end to end (requiresReasoningContentOnAssistantMessages).
 *
 * Three evidence-backed corrections, applied ONLY when the route's base URL
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
 * 2. DeepSeek V4 family (same membership as dshModelReasoning's declaration)
 *    → chat completions. dshModelReasoningDeclaration then supplies
 *    DEEPSEEK_V4_CHAT_COMPLETIONS_DECLARATION: the gateway accepts the
 *    family's `thinking: {type}` object plus reasoning_effort on this wire
 *    (verified live 2026-10-21, streaming and non-streaming, with tools), and
 *    returns `reasoning_content` that pi-ai stores and resends verbatim.
 * 3. Responses-only models (gpt-*-luna, grok-4.6/4.7, muse-spark-*) → the
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
import { isDeepSeekV4FamilyModelId, isGlmFamilyModelId } from './dshModelReasoning';

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
  // DeepSeek V4 is completions-only on this gateway too (pi-ai's catalog lists
  // the family exclusively under openai-completions, with the DeepSeek
  // reasoning_content replay compat). Riding the gateway's Responses
  // translation for the family proved unsafe: that translation dropped
  // reasoning_content once (2026-10-21 session b29803fc) and DeepSeek 400s a
  // tool round without it — a won't-heal death on the host side. On the chat
  // wire pi-ai owns the reasoning_content round-trip, so the failure class
  // cannot occur.
  if (input.apiFormat !== 'openai' && isDeepSeekV4FamilyModelId(model)) return 'openai';
  if (input.apiFormat !== 'responses' && isResponsesOnlyModelId(model)) return 'responses';
  return input.apiFormat;
}

// Route-key suffix per corrected wire. The DSH runtime's route table is a
// cross-session UNION keyed by provider key (mergeProviderRoute), and one
// provider entry carries exactly ONE apiFormat — so once the per-model
// correction puts model A on wire X and model B on wire Y under the same
// provider, the union mixes them and plugin validation fails the whole
// runtime boot (2026-10-14 incident: glm-5.3-flash's completions-only compat
// `supportsStore` landed on the deepseek 'responses' provider entry →
// "sets compat supportsStore, but its api is openai-responses" → every
// opencode turn, deepseek included, died at boot). A corrected route therefore
// rides a suffixed key ('opencode-oc'), giving each wire its own provider
// entry, credential env var (dshProviderApiKeyEnv), and runtime slot.
//
// The separator MUST be sanitize-stable: the runtime config's sanitizeRouteKey
// folds every char outside [a-zA-Z0-9_-] to '-', and the adapter registry is
// keyed by the SANITIZED route while the host passes the provider key RAW to
// runtime initialize and session/ensure. The original '.oc' separator folded
// to '-oc' on the registry side but stayed '.oc' on the lookup side, so every
// corrected-route boot died with `no adapter registered for provider
// "opencode.oc"` (2026-10-16 incident, first real opencode+GLM chat). A dash
// keeps the key identical on both sides. The credential env var is unchanged
// (dshProviderApiKeyEnv folds '-' and '.' alike), and the runtime slot key
// ('opencode-oc.auto-bc') stays filename-safe.
const WIRE_ROUTE_KEY_SUFFIX: Record<OpenCodeGoApiFormat, string> = {
  openai: 'oc',
  responses: 'rs',
  anthropic: 'am',
};

/** Runtime route key for a wire-corrected OpenCode Go gateway route. */
export function openCodeGoWireRouteKey(providerKey: string, ridingApiFormat: OpenCodeGoApiFormat): string {
  return `${providerKey}-${WIRE_ROUTE_KEY_SUFFIX[ridingApiFormat]}`;
}
