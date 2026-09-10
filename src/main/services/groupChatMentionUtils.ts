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

/**
 * GT#72: does the content ADDRESS the bot by a bare roster-name form? Chairs
 * routinely address assignees without the @ ("阿码，第二棒正式开工…" for the
 * roster name "Builder阿码"; "小明，接评审棒" for "小明同学"). Accepted forms:
 * the FULL roster name, or a unique trimmed form — a prefix or suffix of the
 * name of at least 2 chars ("阿码" drops the latin prefix, "小明" drops the
 * trailing part). A candidate that also addresses ANOTHER roster member is
 * ambiguous and does not count (the @-token stays the only wake). Callers
 * gate this on assignment-shaped chair messages ([DEADLINE] tag) — verdict
 * prose and liveness notices that merely cite a name must stay quiet.
 */
export function contentAddressesRosterName(
  content: string | null | undefined,
  botName: string | null | undefined,
  rosterNames: Array<string | null | undefined>,
): boolean {
  const name = (botName ?? '').trim().toLowerCase();
  const text = String(content ?? '').toLowerCase();
  if (!text || !name) return false;
  const others = rosterNames
    .map((other) => (other ?? '').trim().toLowerCase())
    .filter((other) => other && other !== name);
  const addressesOnlyThis = (candidate: string): boolean =>
    !others.some((other) => other.startsWith(candidate) || other.endsWith(candidate));
  // CJK candidates have no word boundaries — plain containment. Latin
  // candidates must match as whole words, or a 2-char head ("co" of
  // "Coder Bot") would fire on every "confirm"/"code" in the message.
  const contains = (candidate: string): boolean => {
    if (/[\u4e00-\u9fff]/.test(candidate)) return text.includes(candidate);
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`).test(text);
  };
  if (contains(name)) return addressesOnlyThis(name);
  // Trimmed forms: prefixes and suffixes of the roster name, 2..len-1 chars.
  for (let cut = 2; cut < name.length; cut += 1) {
    const head = name.slice(0, cut);
    if (contains(head) && addressesOnlyThis(head)) return true;
    const tail = name.slice(name.length - cut);
    if (contains(tail) && addressesOnlyThis(tail)) return true;
  }
  return false;
}

/** Worker mention gate: mention-array hit OR explicit @name in the content. */
export function isMentioned(
  message: GroupChatMentionMessage,
  bot: GroupChatMentionBot,
): boolean {
  return mentionContainsMetaId(message.mention, bot.globalmetaid, bot.metaid)
    || contentMentionsBotName(message.content, bot.name);
}
