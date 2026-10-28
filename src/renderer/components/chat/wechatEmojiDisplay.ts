/**
 * Display-time mapping of WeChat bracket emoji codes (`[微笑]`, `[强]`, …) to
 * standard Unicode emoji, for chat message bubbles.
 *
 * Contract (the feature's hard boundary):
 * - DISPLAY ONLY. This module is a pure string function applied where a
 *   message is rendered; the stored/sent/on-chain text is never rewritten.
 *   What lives in the database and on the chain stays `[微笑]`; the bubble
 *   shows 🙂. Copy/quote actions upstream operate on the raw text and keep
 *   working unchanged.
 * - Standard Unicode codepoints only. WeChat's own emoji artwork is
 *   proprietary (Tencent) and is neither bundled nor referenced; each mapped
 *   value is a rough Unicode stand-in for the code's meaning, not a
 *   reproduction of any Tencent asset.
 * - Code spans stay verbatim: fenced code blocks (```…```) and inline code
 *   (`` `…` ``) are skipped, so a message that *talks about* `[微笑]`
 *   (or carries it inside code) still shows the literal brackets.
 */

/** WeChat bracket code (without brackets) → Unicode stand-in. ~70 common codes. */
export const WECHAT_BRACKET_EMOJI_MAP: Readonly<Record<string, string>> = {
  // Faces & emotions
  微笑: '🙂',
  撇嘴: '😕',
  色: '😍',
  发呆: '😳',
  得意: '😏',
  流泪: '😢',
  闭嘴: '🤐',
  睡: '😴',
  大哭: '😭',
  尴尬: '😓',
  发怒: '😠',
  调皮: '😜',
  呲牙: '😁',
  惊讶: '😮',
  难过: '😔',
  酷: '😎',
  冷汗: '😅',
  抓狂: '😫',
  吐: '🤮',
  偷笑: '🤭',
  抠鼻: '👃',
  捂脸: '🤦',
  奸笑: '😏',
  皱眉: '🙁',
  可爱: '🥰',
  白眼: '🙄',
  傲慢: '😤',
  汗: '💦',
  擦汗: '😥',
  憨笑: '😃',
  悠闲: '😌',
  委屈: '🥺',
  可怜: '😿',
  惊恐: '😱',
  害羞: '😊',
  晕: '😵',
  疯了: '🤯',
  衰: '😩',
  骷髅: '💀',
  敲打: '🔨',
  再见: '👋',
  奋斗: '💪',
  咒骂: '🤬',
  疑问: '❓',
  嘘: '🤫',
  发抖: '😨',
  哼: '😒',
  // Gestures & people
  拥抱: '🤗',
  强: '👍',
  弱: '👎',
  握手: '🤝',
  胜利: '✌️',
  抱拳: '👊',
  拳头: '✊',
  爱你: '😘',
  飞吻: '💋',
  鼓掌: '👏',
  磕头: '🙇',
  OK: '👌',
  NO: '⛔',
  // Objects, food, nature & symbols
  猪头: '🐷',
  鸡: '🐔',
  月亮: '🌙',
  太阳: '☀️',
  下雨: '🌧',
  咖啡: '☕',
  蛋糕: '🍰',
  啤酒: '🍺',
  米饭: '🍚',
  西瓜: '🍉',
  足球: '⚽',
  玫瑰: '🌹',
  凋谢: '🥀',
  爱心: '❤️',
  心碎: '💔',
  礼物: '🎁',
  红包: '🧧',
  鞭炮: '🧨',
};

/** Number of mapped codes (test-facing). */
export const WECHAT_BRACKET_CODE_COUNT = Object.keys(WECHAT_BRACKET_EMOJI_MAP).length;

const WECHAT_CODE_RE = new RegExp(
  `\\[(${Object.keys(WECHAT_BRACKET_EMOJI_MAP)
    .map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\]`,
  'g',
);

/**
 * Replace known WeChat bracket codes with Unicode emoji, skipping code spans.
 *
 * Mirrors the code-segment handling of the markdown preprocessing pipeline in
 * MarkdownContent (fenced ``` blocks stay verbatim); unlike that pipeline we
 * also leave INLINE `code` spans verbatim — a bracket code inside backticks
 * is someone quoting the code itself, which must not be swapped.
 */
export const mapWechatBracketCodesForDisplay = (text: string): string => {
  if (!text || text.indexOf('[') === -1) return text;
  // Split into code and non-code segments. Segments starting with ``` are
  // fenced blocks; a single leading ` is an inline span; anything else is
  // prose. The capture keeps the delimiters so `join('')` restores the input.
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((block) => {
      if (block.startsWith('```')) return block;
      return block
        .split(/(`[^`\n]*`)/g)
        .map((segment) => (segment.startsWith('`') ? segment : segment.replace(WECHAT_CODE_RE, (full, code: string) => (
          WECHAT_BRACKET_EMOJI_MAP[code] ?? full
        ))))
        .join('');
    })
    .join('');
};
