/**
 * GT#90 (Fix 5): the `check_metafile_route` host tool — one-call incident
 * triage for metafile delivery routes. GT#90's render-channel outage cost 92
 * minutes of wall time, and the first ~25 minutes of the response were three
 * seats (chair, worker, supervisor) hand-rolling probes with curl/browser
 * turns — one probe was even malformed (bare pinId) and briefly misdeclared
 * the healthy route dead. This tool probes BOTH content routes for a pin with
 * redirect chains exposed and magic-byte verification, and renders a verdict
 * that names the known failure signature (accelerate-route-only degradation
 * = renders break while direct downloads work).
 *
 * Read-only, route-agnostic, and free (plain fetches, no LLM). Registered on
 * every cowork surface alongside the media tools.
 */

import {
  METAFILE_ACCELERATE_CONTENT_API_BASE_URL,
  METAFILE_CONTENT_API_BASE_URL,
} from './metaAppZipDownload.js';

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

/** Extract a metafile pinId from metafile://<pinId>, a bare pinId, or a pin:// ref. */
export function extractProbePinId(input: string): string | null {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  const metafile = /^metafile:\/\/(.+)$/iu.exec(trimmed);
  const candidate = metafile ? metafile[1] : trimmed;
  if (/^[0-9a-f]{60,70}i0$/iu.test(candidate)) return candidate;
  return null;
}

/** Sniff the leading magic bytes of a payload into a human-readable kind. */
export function sniffMagicKind(head: Uint8Array): string | null {
  if (head.length < 4) return null;
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpeg';
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  if (startsWith(0x47, 0x49, 0x46)) return 'gif';
  if (startsWith(0x52, 0x49, 0x46, 0x46) && head.length >= 12 && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return 'webp';
  // mp4/mov carry "ftyp" at offset 4
  if (head.length >= 8 && String.fromCharCode(...head.slice(4, 8)) === 'ftyp') return 'mp4';
  return null;
}

export type RouteProbeResult = {
  route: 'accelerate' | 'direct' | 'redirect-target';
  url: string;
  ok: boolean;
  httpStatus: number | null;
  redirectedTo: string | null;
  contentType: string | null;
  declaredLength: number | null;
  receivedBytes: number;
  magic: string | null;
  elapsedMs: number;
  error: string | null;
};

const PROBE_HEAD_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

/** Probe ONE url with manual redirects, reading only the first PROBE_HEAD_BYTES. */
export async function probeRoute(
  route: RouteProbeResult['route'],
  url: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<RouteProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
    const location = response.headers?.get?.('location') ?? null;
    const contentType = response.headers?.get?.('content-type') ?? null;
    const declaredRaw = response.headers?.get?.('content-length');
    const declaredLength = declaredRaw != null && Number.isFinite(Number(declaredRaw)) ? Number(declaredRaw) : null;
    let receivedBytes = 0;
    let magic: string | null = null;
    if (response.body && response.status >= 200 && response.status < 300) {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      if (first.value && first.value.length > 0) {
        receivedBytes = first.value.length;
        magic = sniffMagicKind(first.value);
      }
      try { await reader.cancel(); } catch { /* best-effort */ }
    }
    return {
      route, url,
      ok: response.status >= 200 && response.status < 300 && receivedBytes > 0,
      httpStatus: response.status,
      redirectedTo: location,
      contentType,
      declaredLength,
      receivedBytes,
      magic,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    return {
      route, url,
      ok: false,
      httpStatus: null,
      redirectedTo: null,
      contentType: null,
      declaredLength: null,
      receivedBytes: 0,
      magic: null,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Overall verdict from the two route probes (the GT#90 signature named). */
export function verdictFromProbes(accelerate: RouteProbeResult, direct: RouteProbeResult): string {
  if (accelerate.ok && direct.ok) return 'HEALTHY: both routes serve real bytes.';
  if (!accelerate.ok && direct.ok) {
    return 'RENDER-PATH DEGRADED (the GT#90 signature): the accelerate route fails while the direct content route is healthy. The Bot Browser render path rides the accelerate route — images will render broken even though byte-level downloads work. Rendering evidence will stay broken until the accelerate route recovers; direct downloads remain usable.';
  }
  if (accelerate.ok && !direct.ok) {
    return 'PARTIAL: the accelerate route is healthy but the direct content route fails. Renders should work; direct-download verification will not.';
  }
  return 'UNREACHABLE on both content routes — check the pin itself (typo, never published, or pruned) before blaming the routes.';
}

function renderProbe(result: RouteProbeResult): string {
  if (result.error) {
    return `- ${result.route} ${result.url}\n  FAIL: ${result.error} (${result.elapsedMs}ms)`;
  }
  const lines = [
    `- ${result.route} ${result.url}`,
    `  ${result.ok ? 'OK' : 'FAIL'}: HTTP ${result.httpStatus}${result.redirectedTo ? ` → 307 redirect to ${result.redirectedTo}` : ''}, ${result.receivedBytes} byte(s) read${result.declaredLength != null ? ` (content-length ${result.declaredLength})` : ''}${result.contentType ? `, ${result.contentType}` : ''}${result.magic ? `, magic=${result.magic}` : ', no recognizable magic'} (${result.elapsedMs}ms)`,
  ];
  if (result.redirectedTo) lines.push(`  redirect target not auto-followed — probe it explicitly if the route verdict is unclear`);
  return lines.join('\n');
}

export function buildMetafileRouteAgentTools(deps: {
  tool: SdkToolFactory;
  fetchImpl?: typeof globalThis.fetch;
}): unknown[] {
  const { tool } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const checkMetafileRoute = tool(
    'check_metafile_route',
    [
      'Probe BOTH metafile content routes (accelerate + direct) for one pin in a single call and return a route-health verdict with redirect chains and magic-byte verification. Input: a metafile:// URI or a bare metafile pinId.',
      'Use this BEFORE declaring any metafile delivery/render route broken or degraded, and cite its verdict instead of hand-rolled one-off probes. Read-only and free.',
    ].join(' '),
    {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'metafile:// URI or bare pinId (e.g. metafile://ab…i0)' },
      },
      required: ['uri'],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    async (args: { uri?: string }) => {
      const pinId = extractProbePinId(String(args?.uri ?? ''));
      if (!pinId) {
        return textResult('Invalid input: pass a metafile:// URI or a bare metafile pinId (64-hex + i0).', true);
      }
      const encoded = encodeURIComponent(pinId);
      const [accelerate, direct] = await Promise.all([
        probeRoute('accelerate', `${METAFILE_ACCELERATE_CONTENT_API_BASE_URL}${encoded}`, fetchImpl),
        probeRoute('direct', `${METAFILE_CONTENT_API_BASE_URL}${encoded}`, fetchImpl),
      ]);
      const report = [
        `metafile route check for ${pinId}:`,
        renderProbe(accelerate),
        renderProbe(direct),
        '',
        `VERDICT: ${verdictFromProbes(accelerate, direct)}`,
      ].join('\n');
      return textResult(report);
    },
  );

  return [checkMetafileRoute];
}
