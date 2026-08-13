/**
 * Request-head byte-stability watch for the CoWork OpenAI-compat proxy.
 *
 * DeepSeek's automatic context cache matches the longest common PREFIX, so
 * the (system, tools) head of every request must stay byte-identical across
 * turns. The runner already hash-tracks the IDBots-assembled system prompt
 * (trackSystemPromptHash), but that covers only the APPENDED part — the SDK
 * prepends its own `claude_code` preset plus environment context, and the
 * tools list is assembled by the SDK too. The proxy is the only place that
 * sees the true wire bytes, so it fingerprints the request head per session
 * and reports drift.
 *
 * Only main-loop requests are fingerprinted: subagent and CLI side-job calls
 * carry agent-definition systems instead of the assembled IDBots prompt. The
 * signature marker below is always present in runner-assembled systems
 * (composeEffectiveSystemPrompt leads with the workspace-safety section) and
 * never in subagent definitions.
 *
 * Pure module: no I/O, no Electron imports.
 */

import { createHash } from 'crypto';

/**
 * IDBots system signature: composeEffectiveSystemPrompt always leads with the
 * workspace-safety section, so any runner-assembled system contains this line.
 */
export const REQUEST_HEAD_SYSTEM_SIGNATURE = '## Workspace Safety Policy';

export interface RequestHeadFingerprint {
  systemHash: string;
  toolsHash: string;
}

export type RequestHeadDriftKind = 'system' | 'tools' | 'both';

export interface RequestHeadDrift {
  kind: RequestHeadDriftKind;
  previous: RequestHeadFingerprint;
  next: RequestHeadFingerprint;
}

export function fingerprintText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Fingerprint the (system, tools) request head from wire bytes. */
export function fingerprintRequestHead(
  systemText: string,
  toolsInput: unknown
): RequestHeadFingerprint {
  return {
    systemHash: fingerprintText(systemText),
    toolsHash: fingerprintText(toolsInput === undefined ? '' : JSON.stringify(toolsInput)),
  };
}

/**
 * True when the request is the session's main loop rather than a subagent or
 * CLI side-job call (whose system carries an agent definition without the
 * assembled IDBots prompt).
 */
export function isMainLoopRequestHead(systemText: string): boolean {
  return systemText.includes(REQUEST_HEAD_SYSTEM_SIGNATURE);
}

/**
 * Compare a request head against the session baseline. Returns null when there
 * is no baseline (first observation) or nothing changed.
 */
export function compareRequestHead(
  baseline: RequestHeadFingerprint | undefined,
  next: RequestHeadFingerprint
): RequestHeadDrift | null {
  if (!baseline) {
    return null;
  }
  const systemChanged = baseline.systemHash !== next.systemHash;
  const toolsChanged = baseline.toolsHash !== next.toolsHash;
  if (!systemChanged && !toolsChanged) {
    return null;
  }
  return {
    kind: systemChanged && toolsChanged ? 'both' : systemChanged ? 'system' : 'tools',
    previous: baseline,
    next,
  };
}
