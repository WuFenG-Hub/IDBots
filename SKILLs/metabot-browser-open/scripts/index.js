#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs');

const DEFAULT_RPC_URL = 'http://127.0.0.1:31200';
const OPEN_PATH = '/api/idbots/bot-browser/open';
const TABS_PATH = '/api/idbots/bot-browser/tabs';
const TAB_ACTIONS = new Set(['open-tab', 'close-tab', 'switch-tab', 'get-tabs', 'get-active-tab']);
const PIN_ID_RE = /\b[0-9a-f]{64}i0\b/i;
const GLOBAL_META_ID_RE = /\bid[qprzyt]1[a-z0-9]{20,}\b/i;
const SUPPORTED_URI_RE = /\b(metaid|pin|metaapp|map|metafile):\/\/[^\s"'<>，。！？、]+/i;
const ANY_URI_SCHEME_RE = /\b([a-z][a-z0-9+.-]*):\/\//i;
const WEB3_DOMAIN_RE = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:eth|lens|crypto|nft|wallet|bitcoin|btc|dao|888|zil|blockchain|polygon|sol|arb|base)\b/i;
const TRAILING_PUNCTUATION_RE = /[),.;!?，。！？、）]+$/;

function cleanToken(value) {
  return String(value || '').trim().replace(TRAILING_PUNCTUATION_RE, '');
}

function resolveRpcToken(env) {
  const fromEnv = String(env.IDBOTS_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  // DSH sessions scrub *TOKEN* env names from bash; fall back to the
  // host-written token mirror file (path rides the scrub-proof AUTHFILE name).
  const authFile = String(env.IDBOTS_RPC_AUTHFILE || '').trim();
  if (!authFile) return '';
  try {
    return fs.readFileSync(authFile, 'utf8').trim();
  } catch {
    return '';
  }
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

function inferTabAction(text) {
  const value = String(text || '');
  if (/(?:关闭|close)\s*(?:第\s*)?(?:tab|标签页?)\s*#?\s*\d+/i.test(value)) return 'close-tab';
  if (/(?:切换(?:到)?|switch(?:\s+to)?)\s*(?:第\s*)?(?:tab|标签页?)\s*#?\s*\d+/i.test(value)) return 'switch-tab';
  if (/(?:当前|active|current)[^\n]*(?:tab|标签页?)[^\n]*(?:uri|地址|网址)|(?:uri|地址|网址)[^\n]*(?:当前|active|current)[^\n]*(?:tab|标签页?)/i.test(value)) {
    return 'get-active-tab';
  }
  if (/(?:列出|所有|全部|list)[^\n]*(?:tabs?|标签页?)/i.test(value)) return 'get-tabs';
  if (/(?:新建|新增|新的?|new|another)[^\n]*(?:tab|标签页?)/i.test(value)) return 'open-tab';
  return 'open';
}

function normalizeAction(value, text) {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'open' || TAB_ACTIONS.has(action)) return action;
  if (action) return null;
  return inferTabAction(text);
}

function pickTabId(input, text) {
  const explicit = input && typeof input === 'object' && !Array.isArray(input)
    ? input.tabId ?? input.tab_id ?? input.id
    : null;
  const inferred = String(text || '').match(/(?:tab|标签页?)\s*#?\s*(\d+)/i)?.[1];
  const tabId = Number(explicit ?? inferred);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
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

function normalizeBrowserCommand(input) {
  const payload = input?.payload;
  const target = String(pickPayloadTarget(payload) || '').trim();
  const payloadAction = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.action
    : null;
  const action = normalizeAction(input?.action ?? payloadAction, target);
  if (!action) {
    return { success: false, error: 'Unsupported Browser action.' };
  }

  if (action === 'open') {
    const normalized = normalizeBrowserOpenTarget(payload);
    return normalized.success ? { ...normalized, action } : normalized;
  }

  if (action === 'open-tab') {
    if (!target || /^(?:新建|新增|新的?|new)(?:\s+(?:tab|标签页?))?\s*$/i.test(target)) {
      return { success: true, action };
    }
    const normalized = normalizeBrowserOpenTarget(payload);
    return normalized.success ? { ...normalized, action } : normalized;
  }

  if (action === 'close-tab' || action === 'switch-tab') {
    const tabId = pickTabId(payload, target) ?? Number(input?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { success: false, error: 'A positive tab id is required.' };
    }
    return { success: true, action, tabId };
  }

  return { success: true, action };
}

function parsePayloadRaw() {
  const { values } = parseArgs({
    options: {
      payload: { type: 'string', short: 'p' },
      target: { type: 'string', short: 't' },
      uri: { type: 'string', short: 'u' },
      'actor-id': { type: 'string' },
      action: { type: 'string', short: 'a' },
      'tab-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write('Usage: node scripts/index.js [--action <action>] [--target "<target>"] [--tab-id <id>]\n');
    process.exit(0);
  }

  if (values.payload && values.payload.trim()) {
    try {
      const parsed = JSON.parse(values.payload);
      return {
        payload: parsed,
        actorId: typeof parsed?.actorId === 'string' ? parsed.actorId.trim() : '',
        action: typeof values.action === 'string' ? values.action.trim() : '',
        tabId: values['tab-id'],
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
      action: typeof values.action === 'string' ? values.action.trim() : '',
      tabId: values['tab-id'],
      dryRun: Boolean(values['dry-run']),
    };
  }

  if (values.target && values.target.trim()) {
    return {
      payload: { target: values.target.trim() },
      actorId: typeof values['actor-id'] === 'string' ? values['actor-id'].trim() : '',
      action: typeof values.action === 'string' ? values.action.trim() : '',
      tabId: values['tab-id'],
      dryRun: Boolean(values['dry-run']),
    };
  }

  if (!process.stdin.isTTY) {
    const stdin = fs.readFileSync(0, 'utf8').trim();
    if (stdin) {
      try {
        return {
          payload: JSON.parse(stdin),
          actorId: '',
          action: typeof values.action === 'string' ? values.action.trim() : '',
          tabId: values['tab-id'],
          dryRun: Boolean(values['dry-run']),
        };
      } catch {
        return {
          payload: stdin,
          actorId: '',
          action: typeof values.action === 'string' ? values.action.trim() : '',
          tabId: values['tab-id'],
          dryRun: Boolean(values['dry-run']),
        };
      }
    }
  }

  return {
    payload: '',
    actorId: '',
    action: typeof values.action === 'string' ? values.action.trim() : '',
    tabId: values['tab-id'],
    dryRun: Boolean(values['dry-run']),
  };
}

async function openBotBrowser(input, env = process.env) {
  const command = normalizeBrowserCommand(input);
  if (!command.success) {
    return command;
  }

  const actorId = input.actorId || null;
  if (input.dryRun || env.IDBOTS_BROWSER_OPEN_DRY_RUN === '1') {
    return {
      success: true,
      ...command,
      actorId,
      message: `Would run IDBots Bot Browser action: ${command.action}`,
    };
  }

  const rpcBase = String(env.IDBOTS_RPC_URL || DEFAULT_RPC_URL).replace(/\/+$/, '');
  const rpcToken = resolveRpcToken(env);
  const rpcHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (rpcToken) headers.Authorization = `Bearer ${rpcToken}`;
    return headers;
  };
  const path = command.action === 'open' ? OPEN_PATH : TABS_PATH;
  const body = command.action === 'open'
    ? { uri: command.uri, actorId }
    : { action: command.action, uri: command.uri, tabId: command.tabId };
  const response = await fetch(`${rpcBase}${path}`, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
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
    action: command.action,
    uri: result.uri || command.uri,
    actorId,
    ...(result.result || {}),
    message: command.action === 'open'
      ? `Opened IDBots Bot Browser: ${result.uri || command.uri}`
      : `Completed IDBots Bot Browser action: ${command.action}`,
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
  normalizeBrowserCommand,
  normalizeBrowserOpenTarget,
  openBotBrowser,
};
