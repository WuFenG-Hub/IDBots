/**
 * Vendored from the desktop chat emoji catalog:
 *   src/renderer/components/chat/emojiData.ts
 * (desktop worktree wt-emoji-picker, single-page final scope; catalog
 *  re-vendored 2026-10-29 for the WeChat first-panel trim: ONE category,
 *  85 entries — the 78 WeChat bracket-code targets (77 unique chars) plus
 *  the curated laugh/think family, fold-hands and party-popper).
 *
 * The desktop file is byte-identical data-wise: every non-ASCII character
 * here is escaped as \uXXXX so this module stays pure ASCII (the mobile
 * repo's static i18n gate forbids CJK characters in src/mobile sources
 * outside i18n.ts). Runtime values are identical to the desktop module.
 *
 * Keep in sync with the desktop file until the two are unified. Do NOT
 * edit the data by hand: re-run the escape step instead.
 */

export interface EmojiEntry {
  /** The emoji character (or sequence) inserted into the composer. */
  char: string;
  /** Space-separated bilingual search keywords. */
  keywords: string;
}

export interface EmojiCategory {
  /** Stable category id (also the tab aria-controls value). */
  id: string;
  /** i18n key resolved by the picker UI for the tab label. */
  labelKey: string;
  emojis: EmojiEntry[];
}

const entry = (char: string, keywords: string): EmojiEntry => ({ char, keywords });

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    labelKey: 'emojiCategorySmileys',
    emojis: [
      entry('\ud83d\ude42', 'slight smile \u5fae\u7b11'),
      entry('\ud83d\ude15', 'confused \u56f0\u60d1 \u832b\u7136 \u6487\u5634'),
      entry('\ud83d\ude0d', 'heart eyes love \u8272 \u82b1\u75f4 \u7231'),
      entry('\ud83d\ude33', 'flushed embarrassed \u8138\u7ea2 \u5c34\u5c2c \u5bb3\u7f9e \u53d1\u5446'),
      entry('\ud83d\ude0f', 'smirk \u5f97\u610f \u5978\u7b11 \u574f\u7b11 \u9634\u7b11'),
      entry('\ud83d\ude22', 'cry tear sad \u54ed \u96be\u8fc7 \u6d41\u6cea'),
      entry('\ud83e\udd10', 'zipper mouth \u95ed\u5634 \u4fdd\u5bc6'),
      entry('\ud83d\ude34', 'sleeping \u7761\u89c9 \u7761 Zzz'),
      entry('\ud83d\ude2d', 'sob cry loud \u5927\u54ed \u54ed\u568e \u6cea\u5954'),
      entry('\ud83d\ude13', 'downcast sweat \u5c34\u5c2c \u6c57 \u5931\u671b'),
      entry('\ud83d\ude20', 'angry mad \u53d1\u6012 \u751f\u6c14'),
      entry('\ud83d\ude1c', 'wink tongue \u8c03\u76ae \u7728\u773c \u5410\u820c'),
      entry('\ud83d\ude01', 'grin beam \u5472\u7259 \u9732\u9f7f \u7b11'),
      entry('\ud83d\ude2e', 'open mouth wow \u60ca\u8bb6 \u54c7 \u5f20\u5634'),
      entry('\ud83d\ude14', 'pensive sad \u96be\u8fc7 \u5931\u843d \u5fe7\u90c1'),
      entry('\ud83d\ude0e', 'cool sunglasses \u9177 \u58a8\u955c \u5e05'),
      entry('\ud83d\ude05', 'sweat smile \u51b7\u6c57 \u5c34\u5c2c \u6c57 \u7b11'),
      entry('\ud83d\ude2b', 'tired \u6293\u72c2 \u7d2f \u6b32\u54ed\u65e0\u6cea'),
      entry('\ud83e\udd2e', 'vomit \u5410 \u6076\u5fc3 \u5455\u5410'),
      entry('\ud83e\udd2d', 'hand over mouth \u5077\u7b11 \u63a9\u5634 \u7b11'),
      entry('\ud83d\udc43', 'nose \u9f3b\u5b50 \u95fb \u62a0\u9f3b'),
      entry('\ud83e\udd26', 'face palm \u6342\u8138 \u65e0\u8bed'),
      entry('\ud83d\ude41', 'frown sad \u4e0d\u9ad8\u5174 \u76b1\u7709'),
      entry('\ud83e\udd70', 'love hearts \u53ef\u7231 \u604b\u7231 \u7231\u4f60'),
      entry('\ud83d\ude44', 'eye roll \u767d\u773c \u7ffb\u767d\u773c'),
      entry('\ud83d\ude24', 'triumph huff \u50b2\u6162 \u751f\u6c14 \u54fc'),
      entry('\ud83d\udca6', 'sweat droplets \u6c57 \u6c34\u82b1'),
      entry('\ud83d\ude25', 'sad relieved sweat \u64e6\u6c57 \u5931\u843d \u677e\u4e86\u53e3\u6c14'),
      entry('\ud83d\ude03', 'smiley big smile \u5927\u7b11 \u61a8\u7b11 \u5f00\u5fc3'),
      entry('\ud83d\ude0c', 'relieved \u60a0\u95f2 \u8212\u670d \u5b89\u5fc3'),
      entry('\ud83e\udd7a', 'pleading begging \u59d4\u5c48 \u6c42\u6c42 \u53ef\u601c'),
      entry('\ud83d\ude3f', 'cat cry \u732b \u54ed \u53ef\u601c'),
      entry('\ud83d\ude31', 'scream fear \u60ca\u6050 \u5413\u6b7b \u5c16\u53eb'),
      entry('\ud83d\ude0a', 'blush smile \u5bb3\u7f9e \u5fae\u7b11 \u8138\u7ea2'),
      entry('\ud83d\ude35', 'dizzy \u6655 \u75af\u4e86 \u5934\u6655'),
      entry('\ud83e\udd2f', 'mind blown explosion \u75af\u4e86 \u8111\u6d1e \u7206\u70b8'),
      entry('\ud83d\ude29', 'weary tired \u8870 \u7d2f \u75b2\u60eb'),
      entry('\ud83d\udc80', 'skull dead \u9ab7\u9ac5 \u6b7b \u9aa8\u5934'),
      entry('\ud83d\udd28', 'hammer \u9524\u5b50 \u6572\u6253'),
      entry('\ud83d\udc4b', 'wave hello \u518d\u89c1 \u6325\u624b \u4f60\u597d \u62dc\u62dc'),
      entry('\ud83d\udcaa', 'flex bicep strong \u5f3a\u58ee \u808c\u8089 \u52a0\u6cb9 \u594b\u6597'),
      entry('\ud83e\udd2c', 'cursing swear \u5492\u9a82 \u9a82\u4eba \u810f\u8bdd'),
      entry('\u2753', 'question mark \u7591\u95ee \u95ee\u53f7'),
      entry('\ud83e\udd2b', 'shush quiet \u5618 \u5b89\u9759 \u4fdd\u5bc6'),
      entry('\ud83d\ude28', 'fear scared \u53d1\u6296 \u5bb3\u6015 \u6050\u60e7'),
      entry('\ud83d\ude12', 'unamused \u65e0\u8bed \u4e0d\u9ad8\u5174 \u54fc'),
      entry('\ud83d\ude00', 'grinning smile happy \u5f00\u5fc3 \u7b11 \u54c8\u54c8'),
      entry('\ud83d\ude04', 'smile laugh eyes \u54c8\u54c8 \u7b11 \u5f00\u5fc3'),
      entry('\ud83d\ude06', 'lol squint laugh \u5927\u7b11 \u54c8\u54c8'),
      entry('\ud83e\udd23', 'rofl laugh \u6eda\u5730\u7b11 \u5927\u7b11'),
      entry('\ud83d\ude02', 'joy tears laugh \u7b11\u54ed \u9ad8\u5174 \u773c\u6cea'),
      entry('\ud83e\udd14', 'thinking \u601d\u8003 \u60f3 \u8003\u8651 \u7591\u95ee'),
      entry('\ud83e\udd17', 'hug \u62e5\u62b1 \u62b1\u62b1'),
      entry('\ud83d\udc4d', 'thumbs up like \u5f3a \u70b9\u8d5e \u8d5e \u597d'),
      entry('\ud83d\udc4e', 'thumbs down dislike \u5f31 \u8e29 \u4e0d\u8d5e\u6210'),
      entry('\ud83e\udd1d', 'handshake deal \u63e1\u624b \u5408\u4f5c \u8fbe\u6210'),
      entry('\u270c\ufe0f', 'victory peace \u80dc\u5229 \u8036 \u548c\u5e73'),
      entry('\ud83d\udc4a', 'fist bump punch \u62b1\u62f3 \u51fa\u62f3 \u6253\u62f3'),
      entry('\u270a', 'raised fist \u62f3\u5934 \u52a0\u6cb9'),
      entry('\ud83d\ude18', 'kiss heart \u4eb2\u4eb2 \u7231\u4f60 \u98de\u543b'),
      entry('\ud83d\udc8b', 'kiss mark \u98de\u543b \u4eb2\u5634 \u5507\u5370'),
      entry('\ud83d\udc4f', 'clap applause \u9f13\u638c \u62cd\u624b \u8d5e'),
      entry('\ud83d\ude47', 'bow \u78d5\u5934 \u97a0\u8eac \u62dc'),
      entry('\ud83d\udc4c', 'ok perfect OK \u597d \u5b8c\u7f8e'),
      entry('\u26d4', 'no entry forbid \u7981\u6b62 \u4e0d\u51c6 no NO'),
      entry('\ud83d\ude4f', 'pray thanks please \u611f\u8c22 \u62dc\u6258 \u7948\u7977 \u5408\u5341'),
      entry('\ud83d\udc37', 'pig face \u732a \u732a\u5934'),
      entry('\ud83d\udc14', 'chicken \u9e21 \u5c0f\u9e21'),
      entry('\ud83c\udf19', 'crescent moon \u6708\u4eae \u6708\u7259'),
      entry('\u2600\ufe0f', 'sun sunny \u592a\u9633 \u6674'),
      entry('\ud83c\udf27', 'cloud with rain \u4e0b\u96e8 \u96e8'),
      entry('\u2615', 'coffee \u5496\u5561'),
      entry('\ud83c\udf70', 'cake shortcake \u86cb\u7cd5'),
      entry('\ud83c\udf7a', 'beer \u5564\u9152 \u5e72\u676f'),
      entry('\ud83c\udf5a', 'cooked rice \u7c73\u996d \u767d\u996d'),
      entry('\ud83c\udf49', 'watermelon \u897f\u74dc'),
      entry('\u26bd', 'soccer football \u8db3\u7403 \u7403'),
      entry('\ud83c\udf39', 'rose \u73ab\u7470 \u82b1'),
      entry('\ud83e\udd40', 'wilted flower \u51cb\u8c22 \u67af\u840e'),
      entry('\u2764\ufe0f', 'red heart love \u7231\u5fc3 \u7231 \u7ea2\u5fc3'),
      entry('\ud83d\udc94', 'broken heart \u5fc3\u788e \u5206\u624b'),
      entry('\ud83c\udf81', 'gift present \u793c\u7269 \u793c\u54c1'),
      entry('\ud83e\udde7', 'red envelope \u7ea2\u5305 \u538b\u5c81\u94b1'),
      entry('\ud83e\udde8', 'firecracker dynamite \u97ad\u70ae \u7206\u7af9 \u70b8\u836f'),
      entry('\ud83c\udf89', 'party popper \u5e86\u795d \u6d3e\u5bf9 \u6492\u82b1'),
    ],
  },
];

/**
 * Search the catalog by keyword. Matches are substring matches against the
 * bilingual keywords and the emoji itself, case-insensitive. Results are
 * de-duplicated by `char` (the same emoji may live in several categories)
 * and capped at `limit`.
 */
export const searchEmoji = (query: string, limit = 64): EmojiEntry[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const seen = new Set<string>();
  const results: EmojiEntry[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const emoji of category.emojis) {
      if (
        (emoji.keywords.toLowerCase().includes(normalized) || emoji.char.includes(query.trim()))
        && !seen.has(emoji.char)
      ) {
        seen.add(emoji.char);
        results.push(emoji);
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
};

/** Total number of catalog entries across all categories (test helper). */
export const countEmojiCatalogEntries = (): number =>
  EMOJI_CATEGORIES.reduce((sum, category) => sum + category.emojis.length, 0);
