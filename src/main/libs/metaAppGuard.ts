// Host-side guard helpers for the local MetaApp launcher tools
// (open_metaapp / resolve_metaapp_url).
//
// Two protections live here:
// 1. Intent gate: an open/resolve call is only honored when the current user
//    turn explicitly asks for it (generic confirmations like "好的" never pass).
// 2. Alias / fuzzy matching: users rarely type the exact app id or full formal
//    name — aliases derived from the app id/name plus loose CJK token matching
//    let "今日门户" / "日报门户" / "Agent 日报" all hit the same
//    `agent-daily-portal` app.
//
// Quick-action (建议操作) sourced user turns bypass the intent gate entirely;
// that marker is written onto the user message metadata by the host
// (`metadata.source === 'quick_action'`) and checked by the runner before it
// ever calls into this module.

const METAAPP_GENERIC_CONFIRMATION_RE = /^(?:好|好的|好呀|好哒|行|可以|确定|确认|继续|开始吧|请开始|没问题|嗯|嗯嗯|ok|okay|yes|yep|sure)[!！。.\s]*$/i;
const METAAPP_EXPLICIT_INTENT_RE = /\b(?:open|launch|start|use|run)\b|(?:打开|开启|启动|运行|使用|进入)/i;
const METAAPP_CONTEXT_WORD_RE = /\b(?:metaapp|app|application)\b|(?:应用|应用页|本地应用|本地app|本地 App|MetaApp)/i;
// Contiguous CJK runs of 2+ chars act as fuzzy mention tokens (e.g. "门户"
// from "Agent Internet 门户" matches the user's "今日门户").
const METAAPP_CJK_RUN_RE = /[\u2e80-\u9fff\uf900-\ufaff]{2,}/g;
// Separators that split a display name into alias candidates.
const METAAPP_NAME_SEGMENT_SPLIT_RE = /[·•|｜/／,，、:：;；—–\-()（）[\]【】]+/;

/** User message metadata marker set when the turn was filled by a quick action. */
export const QUICK_ACTION_MESSAGE_SOURCE = 'quick_action';

export function normalizeMetaAppIntentText(text: string): string {
  return String(text || '').trim().toLowerCase();
}

/**
 * Build the alias candidate set for one app from its id and display name.
 * All aliases are normalized (trimmed + lowercased); entries shorter than 2
 * chars are dropped to avoid matching everything.
 */
export function buildMetaAppAliases(app: { id?: string; name?: string }): string[] {
  const aliases = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeMetaAppIntentText(value);
    if (normalized.length >= 2) {
      aliases.add(normalized);
    }
  };

  const id = String(app?.id || '');
  push(id);
  push(id.replace(/[-_]+/g, ' '));

  const name = String(app?.name || '');
  push(name);
  for (const segment of name.split(METAAPP_NAME_SEGMENT_SPLIT_RE)) {
    push(segment);
  }

  return [...aliases];
}

/**
 * Whether the user text mentions the app described by `aliases` — exact
 * substring of any alias, or a shared CJK run of 2+ chars (loose alias match).
 */
export function metaAppAliasesMentionedInText(userText: string, aliases: string[]): boolean {
  const normalizedText = normalizeMetaAppIntentText(userText);
  if (!normalizedText) {
    return false;
  }
  for (const alias of aliases) {
    if (alias.length >= 2 && normalizedText.includes(alias)) {
      return true;
    }
  }
  for (const alias of aliases) {
    const runs = alias.match(METAAPP_CJK_RUN_RE) || [];
    for (const run of runs) {
      if (normalizedText.includes(run)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Intent gate for the local MetaApp launcher tools. When `aliases` is given
 * (derived from the target app's id/name), mention detection uses the alias /
 * fuzzy matcher; otherwise it falls back to the exact app id only.
 */
export function isExplicitMetaAppUserRequest(userText: string, appId?: string, aliases?: string[]): boolean {
  const normalizedText = normalizeMetaAppIntentText(userText);
  if (!normalizedText) {
    return false;
  }
  if (METAAPP_GENERIC_CONFIRMATION_RE.test(normalizedText)) {
    return false;
  }

  const candidates = aliases && aliases.length > 0
    ? aliases
    : [normalizeMetaAppIntentText(appId || '')].filter((entry) => entry.length > 0);
  const mentionsApp = metaAppAliasesMentionedInText(userText, candidates);
  const hasIntentVerb = METAAPP_EXPLICIT_INTENT_RE.test(userText);
  const hasMetaAppContext = METAAPP_CONTEXT_WORD_RE.test(userText);

  if (mentionsApp && (hasIntentVerb || hasMetaAppContext)) {
    return true;
  }

  return hasIntentVerb && hasMetaAppContext;
}
