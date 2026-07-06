#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');

const DEFAULT_RPC_URL = 'http://127.0.0.1:31200';
const OPEN_PATH = '/api/idbots/bot-browser/open';
const PIN_ID_RE = /\b[0-9a-f]{64}i0\b/i;
const GLOBAL_META_ID_RE = /\bid[qprzyt]1[a-z0-9]{20,}\b/i;
const SUPPORTED_URI_RE = /\b(metaid|pin|metaapp|map|metafile):\/\/[^\s"'<>，。！？、]+/i;
const ANY_URI_SCHEME_RE = /\b([a-z][a-z0-9+.-]*):\/\//i;
const WEB3_DOMAIN_RE = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:eth|lens|crypto|nft|wallet|bitcoin|btc|dao|888|zil|blockchain|polygon|sol|arb|base)\b/i;
const TRAILING_PUNCTUATION_RE = /[),.;!?，。！？、）]+$/;

function cleanToken(value) {
  return String(value || '').trim().replace(TRAILING_PUNCTUATION_RE, '');
}

function normalizeSupportedUri(rawUri) {
  const cleaned = cleanToken(rawUri);
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(cleaned);
  if (!match) {
    return null;
  }

  const scheme = match[1].toLowerCase();
  if (!['metaid', 'pin', 'metaapp', 'map', 'metafile'].includes(scheme)) {
    return null;
  }

  const rest = match[2].trim();
  if (!rest || /\s/.test(rest)) {
    return null;
  }

  return `${scheme}://${scheme === 'map' ? rest : rest.toLowerCase()}`;
}

function pickPayloadTarget(payload) {
  if (payload == null) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  return (
    payload.uri ||
    payload.target ||
    payload.text ||
    payload.query ||
    payload.message ||
    payload.input ||
    ''
  );
}

function normalizeBrowserOpenTarget(input) {
  const text = String(pickPayloadTarget(input) || '').trim();
  if (!text) {
    return { success: false, error: 'Missing Browser target.' };
  }

  const explicitSupportedUri = text.match(SUPPORTED_URI_RE)?.[0];
  if (explicitSupportedUri) {
    const uri = normalizeSupportedUri(explicitSupportedUri);
    if (uri) {
      return { success: true, uri };
    }
  }

  const explicitScheme = text.match(ANY_URI_SCHEME_RE)?.[1];
  if (explicitScheme) {
    return { success: false, error: `Unsupported Browser URI scheme: ${explicitScheme.toLowerCase()}.` };
  }

  const pinId = text.match(PIN_ID_RE)?.[0]?.toLowerCase();
  if (pinId) {
    if (/(?:\bmeta\s*app\b|\bmetaapp\b|\bapp\b|应用)/i.test(text)) {
      return { success: true, uri: `metaapp://${pinId}` };
    }
    return { success: true, uri: `pin://${pinId}` };
  }

  const globalMetaId = text.match(GLOBAL_META_ID_RE)?.[0]?.toLowerCase();
  if (globalMetaId) {
    return { success: true, uri: `metaid://${globalMetaId}` };
  }

  const domain = text.match(WEB3_DOMAIN_RE)?.[0]?.toLowerCase();
  if (domain) {
    return { success: true, uri: `metaid://${domain}` };
  }

  return { success: false, error: 'No supported Browser target found.' };
}

function parsePayloadRaw() {
  const { values } = parseArgs({
    options: {
      payload: { type: 'string', short: 'p' },
      target: { type: 'string', short: 't' },
      uri: { type: 'string', short: 'u' },
      'actor-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write('Usage: node scripts/index.js --target "<target>"\n');
    process.exit(0);
  }

  if (values.payload && values.payload.trim()) {
    try {
      const parsed = JSON.parse(values.payload);
      return {
        payload: parsed,
        actorId: typeof parsed?.actorId === 'string' ? parsed.actorId.trim() : '',
        dryRun: Boolean(values['dry-run']),
      };
    } catch (error) {
      throw new Error(`Invalid payload JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (values.uri && values.uri.trim()) {
    return {
      payload: { uri: values.uri.trim() },
      actorId: typeof values['actor-id'] === 'string' ? values['actor-id'].trim() : '',
      dryRun: Boolean(values['dry-run']),
    };
  }

  if (values.target && values.target.trim()) {
    return {
      payload: { target: values.target.trim() },
      actorId: typeof values['actor-id'] === 'string' ? values['actor-id'].trim() : '',
      dryRun: Boolean(values['dry-run']),
    };
  }

  if (!process.stdin.isTTY) {
    const stdin = fs.readFileSync(0, 'utf8').trim();
    if (stdin) {
      try {
        return { payload: JSON.parse(stdin), actorId: '', dryRun: Boolean(values['dry-run']) };
      } catch {
        return { payload: stdin, actorId: '', dryRun: Boolean(values['dry-run']) };
      }
    }
  }

  return { payload: '', actorId: '', dryRun: Boolean(values['dry-run']) };
}

async function openBotBrowser(input, env = process.env) {
  const normalized = normalizeBrowserOpenTarget(input.payload);
  if (!normalized.success) {
    return normalized;
  }

  const actorId = input.actorId || null;
  if (input.dryRun || env.IDBOTS_BROWSER_OPEN_DRY_RUN === '1') {
    return { success: true, uri: normalized.uri, actorId, message: `Would open IDBots Bot Browser: ${normalized.uri}` };
  }

  const rpcBase = String(env.IDBOTS_RPC_URL || DEFAULT_RPC_URL).replace(/\/+$/, '');
  const response = await fetch(`${rpcBase}${OPEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri: normalized.uri, actorId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    return {
      success: false,
      error: result.error || `IDBots Bot Browser open request failed with HTTP ${response.status}.`,
    };
  }

  return {
    success: true,
    uri: result.uri || normalized.uri,
    actorId,
    message: `Opened IDBots Bot Browser: ${result.uri || normalized.uri}`,
  };
}

async function main() {
  const input = parsePayloadRaw();
  const result = await openBotBrowser(input);
  if (!result.success) {
    process.stderr.write(`[metabot-browser-open] Error: ${result.error || 'Browser open failed.'}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[metabot-browser-open] Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  normalizeBrowserOpenTarget,
  openBotBrowser,
};
