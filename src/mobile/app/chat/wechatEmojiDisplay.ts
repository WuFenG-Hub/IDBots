/**
 * Vendored from the desktop chat emoji catalog:
 *   src/renderer/components/chat/wechatEmojiDisplay.ts
 * (desktop PR branch feat/chat-emoji-picker; synced at commit 1a26c43a7,
 * 2026-10-29: the 4-code addition [\u62A0\u9F3B \u6342\u8138 \u5978\u7B11 \u76B1\u7709] is included).
 *
 * The desktop file is byte-identical data-wise: every non-ASCII character
 * here is escaped as \uXXXX so this module stays pure ASCII (the mobile
 * repo's static i18n gate forbids CJK characters in src/mobile sources
 * outside i18n.ts). Runtime values are identical to the desktop module.
 *
 * Keep in sync with the desktop file until the two are unified. Do NOT
 * edit the data by hand: re-run the escape step instead.
 */

/** WeChat bracket code (without brackets) \u2192 Unicode stand-in. ~70 common codes. */
export const WECHAT_BRACKET_EMOJI_MAP: Readonly<Record<string, string>> = {
  // Faces & emotions
  \u5fae\u7b11: '\ud83d\ude42',
  \u6487\u5634: '\ud83d\ude15',
  \u8272: '\ud83d\ude0d',
  \u53d1\u5446: '\ud83d\ude33',
  \u5f97\u610f: '\ud83d\ude0f',
  \u6d41\u6cea: '\ud83d\ude22',
  \u95ed\u5634: '\ud83e\udd10',
  \u7761: '\ud83d\ude34',
  \u5927\u54ed: '\ud83d\ude2d',
  \u5c34\u5c2c: '\ud83d\ude13',
  \u53d1\u6012: '\ud83d\ude20',
  \u8c03\u76ae: '\ud83d\ude1c',
  \u5472\u7259: '\ud83d\ude01',
  \u60ca\u8bb6: '\ud83d\ude2e',
  \u96be\u8fc7: '\ud83d\ude14',
  \u9177: '\ud83d\ude0e',
  \u51b7\u6c57: '\ud83d\ude05',
  \u6293\u72c2: '\ud83d\ude2b',
  \u5410: '\ud83e\udd2e',
  \u5077\u7b11: '\ud83e\udd2d',
  \u62a0\u9f3b: '\ud83d\udc43',
  \u6342\u8138: '\ud83e\udd26',
  \u5978\u7b11: '\ud83d\ude0f',
  \u76b1\u7709: '\ud83d\ude41',
  \u53ef\u7231: '\ud83e\udd70',
  \u767d\u773c: '\ud83d\ude44',
  \u50b2\u6162: '\ud83d\ude24',
  \u6c57: '\ud83d\udca6',
  \u64e6\u6c57: '\ud83d\ude25',
  \u61a8\u7b11: '\ud83d\ude03',
  \u60a0\u95f2: '\ud83d\ude0c',
  \u59d4\u5c48: '\ud83e\udd7a',
  \u53ef\u601c: '\ud83d\ude3f',
  \u60ca\u6050: '\ud83d\ude31',
  \u5bb3\u7f9e: '\ud83d\ude0a',
  \u6655: '\ud83d\ude35',
  \u75af\u4e86: '\ud83e\udd2f',
  \u8870: '\ud83d\ude29',
  \u9ab7\u9ac5: '\ud83d\udc80',
  \u6572\u6253: '\ud83d\udd28',
  \u518d\u89c1: '\ud83d\udc4b',
  \u594b\u6597: '\ud83d\udcaa',
  \u5492\u9a82: '\ud83e\udd2c',
  \u7591\u95ee: '\u2753',
  \u5618: '\ud83e\udd2b',
  \u53d1\u6296: '\ud83d\ude28',
  \u54fc: '\ud83d\ude12',
  // Gestures & people
  \u62e5\u62b1: '\ud83e\udd17',
  \u5f3a: '\ud83d\udc4d',
  \u5f31: '\ud83d\udc4e',
  \u63e1\u624b: '\ud83e\udd1d',
  \u80dc\u5229: '\u270c\ufe0f',
  \u62b1\u62f3: '\ud83d\udc4a',
  \u62f3\u5934: '\u270a',
  \u7231\u4f60: '\ud83d\ude18',
  \u98de\u543b: '\ud83d\udc8b',
  \u9f13\u638c: '\ud83d\udc4f',
  \u78d5\u5934: '\ud83d\ude47',
  OK: '\ud83d\udc4c',
  NO: '\u26d4',
  // Objects, food, nature & symbols
  \u732a\u5934: '\ud83d\udc37',
  \u9e21: '\ud83d\udc14',
  \u6708\u4eae: '\ud83c\udf19',
  \u592a\u9633: '\u2600\ufe0f',
  \u4e0b\u96e8: '\ud83c\udf27',
  \u5496\u5561: '\u2615',
  \u86cb\u7cd5: '\ud83c\udf70',
  \u5564\u9152: '\ud83c\udf7a',
  \u7c73\u996d: '\ud83c\udf5a',
  \u897f\u74dc: '\ud83c\udf49',
  \u8db3\u7403: '\u26bd',
  \u73ab\u7470: '\ud83c\udf39',
  \u51cb\u8c22: '\ud83e\udd40',
  \u7231\u5fc3: '\u2764\ufe0f',
  \u5fc3\u788e: '\ud83d\udc94',
  \u793c\u7269: '\ud83c\udf81',
  \u7ea2\u5305: '\ud83e\udde7',
  \u97ad\u70ae: '\ud83e\udde8',
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
 * also leave INLINE `code` spans verbatim \u2014 a bracket code inside backticks
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
