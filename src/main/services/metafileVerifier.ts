/**
 * Post-upload availability verification for uploaded MetaWeb files.
 * Ported from open-agent-connect src/core/files/metafileVerifier.ts:
 * probes the accelerate (download), content (preview), and legacy content
 * URLs with HEAD first, falling back to GET on 403/405, across several
 * attempts with a delay between rounds.
 */

import {
  DOWNLOAD_URL_BASE,
  PREVIEW_URL_BASE,
  LEGACY_CONTENT_URL_BASE,
} from './metaFileUploadShared.js';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 250;

export interface MetafileVerificationResult {
  ok: boolean;
  url: string | null;
  attempts: number;
  error?: string;
}

function normalizePinId(pinId: string): string {
  const normalized = String(pinId || '').trim();
  if (!normalized) {
    throw new Error('pinId is required');
  }
  return normalized;
}

export function buildMetafileContentUrls(pinId: string): string[] {
  const normalized = normalizePinId(pinId);
  return [
    `${DOWNLOAD_URL_BASE}/${normalized}`,
    `${PREVIEW_URL_BASE}/${normalized}`,
    `${LEGACY_CONTENT_URL_BASE}/${normalized}`,
  ];
}

async function probeUrl(url: string): Promise<{ ok: boolean; status?: number }> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'HEAD' });
  } catch (error) {
    return { ok: false };
  }
  if (response.ok) {
    return { ok: true, status: response.status };
  }
  if (response.status === 403 || response.status === 405) {
    try {
      const getResponse = await fetch(url);
      return { ok: getResponse.ok, status: getResponse.status };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false, status: response.status };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function verifyMetafileAvailability(input: {
  pinId: string;
  attempts?: number;
  delayMs?: number;
}): Promise<MetafileVerificationResult> {
  const attempts = Number.isInteger(input.attempts) && input.attempts > 0
    ? input.attempts
    : DEFAULT_ATTEMPTS;
  const delayMs = Number.isFinite(Number(input.delayMs)) && Number(input.delayMs) >= 0
    ? Number(input.delayMs)
    : DEFAULT_DELAY_MS;
  const urls = buildMetafileContentUrls(input.pinId);

  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const url of urls) {
      const probe = await probeUrl(url);
      if (probe.ok) {
        return { ok: true, url, attempts: attempt };
      }
      lastError = probe.status != null ? `HTTP ${probe.status}` : 'request failed';
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return { ok: false, url: null, attempts, error: lastError || 'unreachable' };
}
