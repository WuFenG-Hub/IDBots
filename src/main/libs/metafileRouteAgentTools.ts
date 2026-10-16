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
 * Redirect handling (rev 2): the accelerate route's NORMAL, HEALTHY shape is a
 * 307 to the OSS origin — so a 3xx is a HOP, never a verdict. Rev 1 probed with
 * `redirect: 'manual'`, stopped at the 3xx, read its 0-byte body, and let the
 * verdict call a healthy route "RENDER-PATH DEGRADED ... images will render
 * broken" — the exact opposite of the truth, since browsers follow the 307.
 * Rev 2 walks the chain itself (bounded by MAX_REDIRECT_HOPS), reads the head
 * bytes at the terminal URL, and keeps three probe states apart instead of
 * collapsing them into a boolean: `redirect-not-followed` (probe inconclusive),
 * `bytes-unavailable` (route answered, no payload), `unreachable` (route broke).
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

/**
 * Terminal state of one probe. `ok` means "2xx and real payload bytes"; the
 * other three are deliberately distinct, because rev 1 conflated them:
 * - `redirect-not-followed`: stopped at a 3xx. The probe says NOTHING about the
 *   route and must never be escalated to a failure verdict.
 * - `bytes-unavailable`: reached a terminal response that carried no usable
 *   payload (0 bytes, or the indexer's {"code":40400} not-found envelope).
 * - `unreachable`: the route itself failed — transport error or HTTP >= 400.
 */
export type ProbeState = 'ok' | 'redirect-not-followed' | 'bytes-unavailable' | 'unreachable';

export type RouteProbeResult = {
  route: 'accelerate' | 'direct' | 'redirect-target';
  url: string;
  state: ProbeState;
  ok: boolean;
  httpStatus: number | null;
  /** First hop actually taken (or, when not followed, the hop declined). */
  redirectedTo: string | null;
  /** Every Location hop this probe followed, in order. */
  redirectChain: string[];
  finalUrl: string | null;
  contentType: string | null;
  declaredLength: number | null;
  receivedBytes: number;
  magic: string | null;
  /** Was the body the indexer's JSON not-found envelope rather than a payload? */
  indexerNotFound: boolean;
  elapsedMs: number;
  error: string | null;
};

const PROBE_TIMEOUT_MS = 20_000;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;
/** Marker inside the indexer's "file not found" JSON envelope (HTTP 200 + ~72B). */
const INDEXER_NOT_FOUND_MARKER = '"code":40400';

/**
 * The indexer answers a missing/pruned pin with HTTP 200 and a tiny JSON
 * envelope — {"code":40400,"message":"file not found",...} — on BOTH routes.
 * Those bytes mean "no content here", not "a payload was served"; counting them
 * as success is how rev 1 reported a never-published pin as HEALTHY.
 */
export function isIndexerNotFoundEnvelope(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  try {
    return new TextDecoder().decode(head.subarray(0, 512)).includes(INDEXER_NOT_FOUND_MARKER);
  } catch {
    return false;
  }
}

function headerNumber(response: Response, name: string): number | null {
  const raw = response.headers?.get?.(name) ?? null;
  return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
}

/**
 * Probe ONE url with bounded MANUAL redirects, reading only the first chunk of
 * the terminal body. Manual walking (rather than `redirect: 'follow'`) keeps the
 * chain reportable; following at all is what keeps a healthy 307 → OSS route
 * from being misreported as broken.
 */
export async function probeRoute(
  route: RouteProbeResult['route'],
  url: string,
  fetchImpl: typeof globalThis.fetch,
  options: { maxRedirects?: number } = {},
): Promise<RouteProbeResult> {
  const startedAt = Date.now();
  const maxRedirects = Number.isFinite(options.maxRedirects)
    ? Math.max(0, Number(options.maxRedirects))
    : MAX_REDIRECT_HOPS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const redirectChain: string[] = [];
  let currentUrl = url;

  const base = (): Pick<RouteProbeResult, 'route' | 'url' | 'redirectChain' | 'elapsedMs'> => ({
    route,
    url,
    redirectChain,
    elapsedMs: Date.now() - startedAt,
  });

  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetchImpl(currentUrl, { redirect: 'manual', signal: controller.signal });
      const status = response.status;
      const location = response.headers?.get?.('location') ?? null;

      if (status >= REDIRECT_STATUS_MIN && status <= REDIRECT_STATUS_MAX) {
        // A redirect body is not a payload — drain it, then decide whether we
        // are allowed to keep walking.
        try { await response.body?.cancel(); } catch { /* best-effort */ }
        const nextUrl = location ? new URL(location, currentUrl).toString() : null;
        if (!nextUrl || hop >= maxRedirects) {
          return {
            ...base(),
            state: 'redirect-not-followed',
            ok: false,
            httpStatus: status,
            redirectedTo: redirectChain[0] ?? nextUrl,
            finalUrl: currentUrl,
            contentType: response.headers?.get?.('content-type') ?? null,
            declaredLength: headerNumber(response, 'content-length'),
            receivedBytes: 0,
            magic: null,
            indexerNotFound: false,
            error: null,
          };
        }
        redirectChain.push(nextUrl);
        currentUrl = nextUrl;
        continue;
      }

      let receivedBytes = 0;
      let magic: string | null = null;
      let indexerNotFound = false;
      if (status >= 200 && status < 300 && response.body) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        if (first.value && first.value.length > 0) {
          receivedBytes = first.value.length;
          magic = sniffMagicKind(first.value);
          indexerNotFound = isIndexerNotFoundEnvelope(first.value);
        }
        try { await reader.cancel(); } catch { /* best-effort */ }
      }
      const ok = status >= 200 && status < 300 && receivedBytes > 0 && !indexerNotFound;
      const state: ProbeState = ok ? 'ok' : status >= 200 && status < 300 ? 'bytes-unavailable' : 'unreachable';
      return {
        ...base(),
        state,
        ok,
        httpStatus: status,
        redirectedTo: redirectChain[0] ?? null,
        finalUrl: currentUrl,
        contentType: response.headers?.get?.('content-type') ?? null,
        declaredLength: headerNumber(response, 'content-length'),
        receivedBytes,
        magic,
        indexerNotFound,
        error: null,
      };
    }
  } catch (error) {
    return {
      ...base(),
      state: 'unreachable',
      ok: false,
      httpStatus: null,
      redirectedTo: redirectChain[0] ?? null,
      finalUrl: currentUrl,
      contentType: null,
      declaredLength: null,
      receivedBytes: 0,
      magic: null,
      indexerNotFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Overall verdict from the two route probes (the GT#90 signature named).
 * A probe that stopped at an unfollowed redirect is INCONCLUSIVE — it is never
 * escalated into a route verdict, because that is precisely the rev-1 false
 * alarm ("images will render broken" while the route was healthy).
 */
export function verdictFromProbes(accelerate: RouteProbeResult, direct: RouteProbeResult): string {
  const unfollowed = [accelerate, direct].filter((probe) => probe.state === 'redirect-not-followed');
  if (unfollowed.length > 0) {
    return [
      `INCONCLUSIVE: the ${unfollowed.map((probe) => probe.route).join(' + ')} probe stopped at a redirect it did not follow, so it says nothing about the route.`,
      `This is NOT a failure verdict — re-probe the redirect target explicitly before concluding anything about the route.`,
    ].join(' ');
  }
  if (accelerate.ok && direct.ok) return 'HEALTHY: both routes serve real bytes.';
  if (!accelerate.ok && direct.ok) {
    return 'RENDER-PATH DEGRADED (the GT#90 signature): the accelerate route fails while the direct content route is healthy. The Bot Browser render path rides the accelerate route — images will render broken even though byte-level downloads work. Rendering evidence will stay broken until the accelerate route recovers; direct downloads remain usable.';
  }
  if (accelerate.ok && !direct.ok) {
    return 'PARTIAL: the accelerate route is healthy but the direct content route fails. Renders should work; direct-download verification will not.';
  }
  return 'UNREACHABLE on both content routes — check the pin itself (typo, never published, or pruned) before blaming the routes.';
}

/** Human label for a probe state — the three failure modes stay separated. */
function stateLine(result: RouteProbeResult): string {
  switch (result.state) {
    case 'ok':
      return `  state: route healthy — real payload bytes read${result.magic ? ` (magic=${result.magic})` : ''}, after ${result.redirectChain.length} redirect hop(s)`;
    case 'redirect-not-followed':
      return `  state: redirect-not-followed — probe stopped at HTTP ${result.httpStatus}${result.redirectedTo ? ` → ${result.redirectedTo}` : ''} and did NOT follow it; this says nothing about the route (inconclusive, not a failure)`;
    case 'bytes-unavailable':
      return `  state: no-bytes — route answered HTTP ${result.httpStatus}${result.redirectChain.length > 0 ? ` after ${result.redirectChain.length} redirect hop(s)` : ''} but carried no usable payload${result.indexerNotFound ? ' (indexer error envelope {"code":40400} = file not found/pruned, not a served payload)' : ''}`;
    default:
      return `  state: route-broken — ${result.error ? `transport error: ${result.error}` : `terminal HTTP ${result.httpStatus}`}`;
  }
}

function renderProbe(result: RouteProbeResult): string {
  if (result.error && result.httpStatus == null) {
    return `- ${result.route} ${result.url}\n  FAIL: ${result.error} (${result.elapsedMs}ms)\n${stateLine(result)}`;
  }
  const statusBit = result.redirectChain.length > 0
    ? `HTTP ${result.httpStatus} (after ${result.redirectChain.length} redirect hop(s))`
    : `HTTP ${result.httpStatus}`;
  const bits = [
    statusBit,
    `${result.receivedBytes} byte(s) read`,
    ...(result.declaredLength != null ? [`content-length ${result.declaredLength}`] : []),
    ...(result.contentType ? [result.contentType] : []),
    result.magic ? `magic=${result.magic}` : 'no recognizable magic',
  ];
  const lines = [
    `- ${result.route} ${result.url}`,
    `  ${result.ok ? 'OK' : 'FAIL'}: ${bits.join(', ')} (${result.elapsedMs}ms)`,
  ];
  if (result.redirectChain.length > 0) {
    lines.push(`  redirect chain: ${result.redirectChain.join(' → ')}`);
  } else if (result.redirectedTo) {
    lines.push(`  redirect target (not followed): ${result.redirectedTo}`);
  }
  lines.push(stateLine(result));
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
      'Redirects are FOLLOWED (up to 5 hops) before any byte is read, because a healthy accelerate route normally answers 307 → OSS; an unfollowed redirect is reported as INCONCLUSIVE, never as a route failure.',
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
