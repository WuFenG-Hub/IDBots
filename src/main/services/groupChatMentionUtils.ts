/**
 * Shared group-chat mention gating helpers, extracted from groupTaskDaemon.ts so
 * the OpenTeam guest daemon applies the exact same "respond only when
 * @-mentioned" semantics as local group-task members. Behavior must stay
 * byte-identical with the original groupTaskDaemon implementation.
 */

/** Minimal message shape required for mention gating. */
export interface GroupChatMentionMessage {
  content: string;
  /** Raw mention column (JSON array string). */
  mention: string | null;
}

/** Minimal bot shape required for mention gating. */
export interface GroupChatMentionBot {
  name: string;
  globalmetaid: string | null;
  metaid?: string;
}

/**
 * Word-boundary @-mention matching: a bot counts as "mentioned by name" ONLY
 * when the content contains an explicit `@BotName` token (the @ must not be
 * glued to a longer identifier and the name must match completely). A bare
 * name occurrence (e.g. a kickoff roster line "Members: Coder Bot, …" or a
 * recap "already checked Lucy's file") does NOT trigger a reply. This killed
 * the "kickoff mentions the full roster -> every member responds" problem and
 * the "one recap mentions two names -> two steps created" problem.
 */
export function contentMentionsBotName(content: string, botName: string): boolean {
  if (!content || !botName) return false;
  const name = botName.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The @ must not be preceded by a letter/digit/underscore (so @Builder does
  // not match @Builder2-style glued identifiers), and the name must match
  // completely (no trailing word chars); name matching is case-insensitive.
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, 'i');
  return pattern.test(content);
}

/** True when the mention JSON array contains the bot's globalMetaId or metaId. */
export function mentionContainsMetaId(
  mentionJson: string | null,
  globalMetaId: string | null,
  metaId: string | undefined,
): boolean {
  if (!mentionJson) return false;
  let ids: unknown[] = [];
  try {
    const parsed = JSON.parse(mentionJson) as unknown;
    ids = Array.isArray(parsed) ? parsed : [];
  } catch {
    return false;
  }
  if (ids.length === 0) return false;
  const targets = [globalMetaId, metaId]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);
  if (targets.length === 0) return false;
  return ids.some((id) => targets.includes(String(id).trim()));
}

/** Worker mention gate: mention-array hit OR explicit @name in the content. */
export function isMentioned(
  message: GroupChatMentionMessage,
  bot: GroupChatMentionBot,
): boolean {
  return mentionContainsMetaId(message.mention, bot.globalmetaid, bot.metaid)
    || contentMentionsBotName(message.content, bot.name);
}
