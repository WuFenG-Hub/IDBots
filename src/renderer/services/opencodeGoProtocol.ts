/**
 * OpenCode Go gateway per-model protocol resolution — renderer-side mirror of
 * src/main/libs/opencodeGoProtocol.ts (renderer code must not import main).
 *
 * The gateway serves each model over exactly ONE wire protocol and answers
 * every other protocol with HTTP 400 {"type":"ModelProtocolUnsupported",
 * "message":"Model does not support this protocol."} — while the app
 * configures ONE provider-level apiFormat for every model of the built-in
 * 'opencode' provider. The 'responses' default works for DeepSeek Flash but
 * not for the GLM line, which the gateway serves ONLY over chat completions
 * (2026-10-13 user incident: opencode + glm-5.3-flash turned failed with
 * ModelProtocolUnsupported; the reasoning-effort pick was coincidental).
 *
 * Keep the family patterns in sync with the main module (which sources GLM
 * from src/main/libs/dshModelReasoning.ts) and pi-ai's installed catalog
 * opencode-go.json. Unknown models pass through untouched.
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

// Models the gateway serves ONLY over the OpenAI Responses wire (pi-ai
// opencode-go.json: openai-responses section; the Luna pair also per
// zai-org/feedback#840). Matched on the bare id, case-insensitive.
const RESPONSES_ONLY_PATTERNS = [
  /^gpt-[\d.]+-luna(?:[.\-_].*)?$/i,
  /^grok-4\.[67](?:[.\-_].*)?$/i,
  /^muse-spark-/i,
];

const isGlmFamilyModelId = (modelId: string): boolean => GLM_PATTERN.test(bareOpenCodeGoModelId(modelId));

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
  if (input.apiFormat === 'responses' && isGlmFamilyModelId(model)) return 'openai';
  if (input.apiFormat !== 'responses' && isResponsesOnlyModelId(model)) return 'responses';
  return input.apiFormat;
}
