/**
 * OpenCode Go gateway per-model protocol resolution — renderer-side mirror of
 * src/main/libs/opencodeGoProtocol.ts (renderer code must not import main).
 *
 * The gateway serves each model over exactly ONE wire protocol and answers
 * every other protocol with HTTP 400 {"type":"ModelProtocolUnsupported",
 * "message":"Model does not support this protocol."} — while the app
 * configures ONE provider-level apiFormat for every model of the built-in
 * 'opencode' provider. The 'responses' default sends the GLM line to a wire
 * the gateway does not serve for it (2026-10-13 user incident: opencode +
 * glm-5.3-flash failed with ModelProtocolUnsupported; the reasoning-effort
 * pick was coincidental), and for the DeepSeek V4 line it rides a gateway
 * Responses→chat translation that dropped `reasoning_content` once and let
 * DeepSeek 400 the turn (2026-10-21 session b29803fc). Both families ride
 * the gateway's declared chat-completions wire; the responses-only set
 * (luna / grok-4.6-4.7 / muse-spark) is corrected up to /v1/responses.
 *
 * Keep the family patterns in sync with the main module (which sources GLM
 * and DeepSeek V4 from src/main/libs/dshModelReasoning.ts) and pi-ai's
 * installed catalog opencode-go.json. Unknown models pass through untouched.
 */
import { isOpenCodeGoBaseUrl } from './opencodeGatewayHeaders';

export type OpenCodeGoApiFormat = 'openai' | 'responses' | 'anthropic';

/** Bare model id: drop any vendor prefix ("z-ai/glm-5.3-flash" → "glm-5.3-flash"). */
export function bareOpenCodeGoModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || trimmed;
}

// Mirror of dshModelReasoning.ts GLM_PATTERN (glm-4.5+ and the 5.x+ line).
const GLM_PATTERN = /^glm-(?:4\.[5-9](?:[.\-_].*)?|5(?:[.\-_].*)?|[6-9]\d*(?:[.\-_].*)?)/i;

// Mirror of dshModelReasoning.ts DEEPSEEK_V4_PATTERN + DEEPSEEK_V4_EXPLICIT_IDS
// (deepseek-v4*, deepseek-flash*, and the relay's deepseek-chat /
// deepseek-4.1-flash aliases).
const DEEPSEEK_V4_PATTERN = /deepseek-(?:v4|flash)(?:[.\-_]|$)/i;
const DEEPSEEK_V4_EXPLICIT_IDS = new Set(['deepseek-chat', 'deepseek-4.1-flash']);

// Models the gateway serves ONLY over the OpenAI Responses wire (pi-ai
// opencode-go.json: openai-responses section; the Luna pair also per
// zai-org/feedback#840). Matched on the bare id, case-insensitive.
const RESPONSES_ONLY_PATTERNS = [
  /^gpt-[\d.]+-luna(?:[.\-_].*)?$/i,
  /^grok-4\.[67](?:[.\-_].*)?$/i,
  /^muse-spark-/i,
];

const isGlmFamilyModelId = (modelId: string): boolean => GLM_PATTERN.test(bareOpenCodeGoModelId(modelId));

const isDeepSeekV4FamilyModelId = (modelId: string): boolean => {
  const bare = bareOpenCodeGoModelId(modelId);
  return DEEPSEEK_V4_PATTERN.test(bare) || DEEPSEEK_V4_EXPLICIT_IDS.has(bare.toLowerCase());
};

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
  // /v1/messages wire both answer ModelProtocolUnsupported for the family).
  if (input.apiFormat !== 'openai' && isGlmFamilyModelId(model)) return 'openai';
  // DeepSeek V4 is completions-only on this gateway too; its Responses
  // translation dropped reasoning_content once (2026-10-21), so the family
  // rides the declared wire where the client owns the round-trip.
  if (input.apiFormat !== 'openai' && isDeepSeekV4FamilyModelId(model)) return 'openai';
  if (input.apiFormat !== 'responses' && isResponsesOnlyModelId(model)) return 'responses';
  return input.apiFormat;
}
