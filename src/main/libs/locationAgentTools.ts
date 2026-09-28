import { z } from 'zod';
import type { CoarseLocation, PreciseLocation } from '../services/hostLocationService';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Host-side geolocation surface. The default implementation lives in main.ts
 * and combines services/hostLocationService.ts (IP lookup + reverse geocoding)
 * with an OS fix from a renderer's navigator.geolocation; tests inject a fake
 * so plain `node --test` never touches electron or the network.
 */
export type LocationHost = {
  /** IP-based city-level lookup; no permission or consent needed. */
  getCoarseLocation(): Promise<CoarseLocation>;
  /**
   * OS geolocation fix reverse-geocoded to a street-level address. Throws
   * when the OS denies/disables location or the fix times out.
   */
  getPreciseLocation(): Promise<PreciseLocation>;
};

/**
 * Outcome of the per-session precise-location consent gate (implemented in
 * coworkRunner). 'unattended' means the session cannot show a prompt at all
 * (autoApprove / acceptEdits / bypassPermissions / A2A service orders) — the
 * tool must fall back to coarse instead of blocking on a dialog nobody answers.
 */
export type PreciseLocationConsent = 'granted' | 'denied' | 'unattended';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PRECISE_REMEDIATION_HINT =
  'On macOS check System Settings > Privacy & Security > Location Services (IDBots must be allowed); on Windows check Settings > Privacy & security > Location.';

/**
 * Inline MCP tool that reports the host machine's geographic location.
 * Registered for every cowork surface; coarse is IP-based and unprompted,
 * precise is consent-gated per session and fails closed to coarse.
 */
export function buildLocationAgentTools(deps: {
  tool: SdkToolFactory;
  locationHost: LocationHost;
  requestPreciseConsent: () => Promise<PreciseLocationConsent>;
}): unknown[] {
  const { tool, locationHost, requestPreciseConsent } = deps;

  const coarseOnly = async (fallbackReason: string) => {
    try {
      const coarse = await locationHost.getCoarseLocation();
      return textResult(JSON.stringify({
        ...coarse,
        requestedGranularity: 'precise',
        preciseFallbackReason: fallbackReason,
      }, null, 2));
    } catch (error) {
      return textResult(
        `get_host_location failed: precise location is unavailable (${fallbackReason}), and the coarse IP-based fallback also failed: ${errorMessage(error)}. The host may be offline or the geolocation providers may be unreachable — ask the user to type their city instead.`,
        true,
      );
    }
  };

  const getHostLocation = tool(
    'get_host_location',
    [
      'Report the host machine\'s geographic location for "where am I", timezone, weather, and nearby-services queries.',
      'granularity="coarse" (default) uses IP-based geolocation: city-level (sometimes district-level) accuracy, no permission or prompt needed — the right choice for almost every "where am I / what\'s nearby" question.',
      'granularity="precise" uses the OS geolocation service (macOS CoreLocation / Windows Location) reverse-geocoded to a street-level address. It requires the OS location permission AND one-time in-app user consent per session (the user sees a prompt), so only request it when street-level accuracy is genuinely needed; unattended sessions cannot consent and automatically fall back to coarse, as do OS failures.',
      'The result JSON carries source ("ip" or "system"), provider, country/region/city(/district), latitude/longitude, timezone when known, accuracyNote, and fetchedAt — always relay the accuracy when you use the result.',
      'NEITHER granularity is a delivery address: never present an IP-based city or even the precise reverse-geocoded address as the user\'s shipping/delivery address — ask the user to confirm or dictate the full address first.',
    ].join(' '),
    {
      granularity: z
        .enum(['coarse', 'precise'])
        .optional()
        .describe('"coarse" (default): IP-based city-level lookup, no prompt. "precise": OS geolocation, street-level, consent-gated.'),
    },
    async (args: { granularity?: 'coarse' | 'precise' }) => {
      const granularity = args.granularity ?? 'coarse';

      if (granularity === 'precise') {
        const consent = await requestPreciseConsent();
        if (consent === 'granted') {
          try {
            const precise = await locationHost.getPreciseLocation();
            return textResult(JSON.stringify(precise, null, 2));
          } catch (error) {
            return coarseOnly(`the OS location fix failed (${errorMessage(error)}). ${PRECISE_REMEDIATION_HINT}`);
          }
        }
        return coarseOnly(
          consent === 'unattended'
            ? 'this session is unattended, so the in-app consent prompt cannot be shown — precise location requires an interactive session where the user approves it once'
            : 'the user declined the precise-location consent prompt',
        );
      }

      try {
        const coarse = await locationHost.getCoarseLocation();
        return textResult(JSON.stringify(coarse, null, 2));
      } catch (error) {
        return textResult(
          `get_host_location failed: ${errorMessage(error)}. The host may be offline or the geolocation providers may be unreachable — try again later or ask the user to type their city instead.`,
          true,
        );
      }
    }
  );

  return [getHostLocation];
}
