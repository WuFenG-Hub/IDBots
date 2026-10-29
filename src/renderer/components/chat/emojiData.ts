/**
 * Curated Unicode emoji catalog for the chat emoji picker — a single
 * WeChat-style first-panel page (85 entries, 1 category; owner call
 * 2026-10-29: "就一个 tab，常用的直接嵌入到表情管理的第一层，像微信这样").
 *
 * Design notes:
 * - Standard Unicode emoji ONLY (rendered by the platform emoji font). No
 *   third-party artwork is bundled or referenced — the picker never ships
 *   proprietary emoji images (e.g. Tencent's WeChat artwork).
 * - Single flat page, ordered like the WeChat code table: every emoji
 *   targeted by the WeChat bracket-code display map (wechatEmojiDisplay.ts,
 *   78 codes → 77 unique chars — [得意] and [奸笑] both map to 😏) is
 *   pickable here, plus the curated laugh/think family (😀😄😆🤣😂🤔),
 *   🙏 and 🎉. Identical catalog on desktop and mobile.
 * - Entries carry bilingual (English + Chinese) space-separated keywords so
 *   search works for both `smile` and `笑`; the bracket-code word is part
 *   of the keywords (e.g. 抠鼻 for 👃) so codes are searchable too.
 * - `char` may be a multi-codepoint sequence (ZWJ joins, VS16 selectors);
 *   consumers must insert it verbatim, never truncate to one code unit.
 * - Pure data + pure helpers (no React, no i18n dependency) so tests can
 *   import this module directly.
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
      // Faces & emotions — WeChat code-table order (微笑 撇嘴 色 … 哼).
      entry('🙂', 'slight smile 微笑'),
      entry('😕', 'confused 困惑 茫然 撇嘴'),
      entry('😍', 'heart eyes love 色 花痴 爱'),
      entry('😳', 'flushed embarrassed 脸红 尴尬 害羞 发呆'),
      entry('😏', 'smirk 得意 奸笑 坏笑 阴笑'),
      entry('😢', 'cry tear sad 哭 难过 流泪'),
      entry('🤐', 'zipper mouth 闭嘴 保密'),
      entry('😴', 'sleeping 睡觉 睡 Zzz'),
      entry('😭', 'sob cry loud 大哭 哭嚎 泪奔'),
      entry('😓', 'downcast sweat 尴尬 汗 失望'),
      entry('😠', 'angry mad 发怒 生气'),
      entry('😜', 'wink tongue 调皮 眨眼 吐舌'),
      entry('😁', 'grin beam 呲牙 露齿 笑'),
      entry('😮', 'open mouth wow 惊讶 哇 张嘴'),
      entry('😔', 'pensive sad 难过 失落 忧郁'),
      entry('😎', 'cool sunglasses 酷 墨镜 帅'),
      entry('😅', 'sweat smile 冷汗 尴尬 汗 笑'),
      entry('😫', 'tired 抓狂 累 欲哭无泪'),
      entry('🤮', 'vomit 吐 恶心 呕吐'),
      entry('🤭', 'hand over mouth 偷笑 掩嘴 笑'),
      entry('👃', 'nose 鼻子 闻 抠鼻'),
      entry('🤦', 'face palm 捂脸 无语'),
      entry('🙁', 'frown sad 不高兴 皱眉'),
      entry('🥰', 'love hearts 可爱 恋爱 爱你'),
      entry('🙄', 'eye roll 白眼 翻白眼'),
      entry('😤', 'triumph huff 傲慢 生气 哼'),
      entry('💦', 'sweat droplets 汗 水花'),
      entry('😥', 'sad relieved sweat 擦汗 失落 松了口气'),
      entry('😃', 'smiley big smile 大笑 憨笑 开心'),
      entry('😌', 'relieved 悠闲 舒服 安心'),
      entry('🥺', 'pleading begging 委屈 求求 可怜'),
      entry('😿', 'cat cry 猫 哭 可怜'),
      entry('😱', 'scream fear 惊恐 吓死 尖叫'),
      entry('😊', 'blush smile 害羞 微笑 脸红'),
      entry('😵', 'dizzy 晕 疯了 头晕'),
      entry('🤯', 'mind blown explosion 疯了 脑洞 爆炸'),
      entry('😩', 'weary tired 衰 累 疲惫'),
      entry('💀', 'skull dead 骷髅 死 骨头'),
      entry('🔨', 'hammer 锤子 敲打'),
      entry('👋', 'wave hello 再见 挥手 你好 拜拜'),
      entry('💪', 'flex bicep strong 强壮 肌肉 加油 奋斗'),
      entry('🤬', 'cursing swear 咒骂 骂人 脏话'),
      entry('❓', 'question mark 疑问 问号'),
      entry('🤫', 'shush quiet 嘘 安静 保密'),
      entry('😨', 'fear scared 发抖 害怕 恐惧'),
      entry('😒', 'unamused 无语 不高兴 哼'),
      // Curated laugh/think family (high-frequency chat emoji kept from the
      // earlier broader catalog; WeChat's panel reads unfinished without them).
      entry('😀', 'grinning smile happy 开心 笑 哈哈'),
      entry('😄', 'smile laugh eyes 哈哈 笑 开心'),
      entry('😆', 'lol squint laugh 大笑 哈哈'),
      entry('🤣', 'rofl laugh 滚地笑 大笑'),
      entry('😂', 'joy tears laugh 笑哭 高兴 眼泪'),
      entry('🤔', 'thinking 思考 想 考虑 疑问'),
      // Gestures & people — WeChat code-table order (拥抱 强 弱 … OK NO) + 🙏.
      entry('🤗', 'hug 拥抱 抱抱'),
      entry('👍', 'thumbs up like 强 点赞 赞 好'),
      entry('👎', 'thumbs down dislike 弱 踩 不赞成'),
      entry('🤝', 'handshake deal 握手 合作 达成'),
      entry('✌️', 'victory peace 胜利 耶 和平'),
      entry('👊', 'fist bump punch 抱拳 出拳 打拳'),
      entry('✊', 'raised fist 拳头 加油'),
      entry('😘', 'kiss heart 亲亲 爱你 飞吻'),
      entry('💋', 'kiss mark 飞吻 亲嘴 唇印'),
      entry('👏', 'clap applause 鼓掌 拍手 赞'),
      entry('🙇', 'bow 磕头 鞠躬 拜'),
      entry('👌', 'ok perfect OK 好 完美'),
      entry('⛔', 'no entry forbid 禁止 不准 no NO'),
      entry('🙏', 'pray thanks please 感谢 拜托 祈祷 合十'),
      // Objects, food, nature & symbols — WeChat code-table order
      // (猪头 鸡 月亮 … 红包 鞭炮) + 🎉.
      entry('🐷', 'pig face 猪 猪头'),
      entry('🐔', 'chicken 鸡 小鸡'),
      entry('🌙', 'crescent moon 月亮 月牙'),
      entry('☀️', 'sun sunny 太阳 晴'),
      entry('🌧', 'cloud with rain 下雨 雨'),
      entry('☕', 'coffee 咖啡'),
      entry('🍰', 'cake shortcake 蛋糕'),
      entry('🍺', 'beer 啤酒 干杯'),
      entry('🍚', 'cooked rice 米饭 白饭'),
      entry('🍉', 'watermelon 西瓜'),
      entry('⚽', 'soccer football 足球 球'),
      entry('🌹', 'rose 玫瑰 花'),
      entry('🥀', 'wilted flower 凋谢 枯萎'),
      entry('❤️', 'red heart love 爱心 爱 红心'),
      entry('💔', 'broken heart 心碎 分手'),
      entry('🎁', 'gift present 礼物 礼品'),
      entry('🧧', 'red envelope 红包 压岁钱'),
      entry('🧨', 'firecracker dynamite 鞭炮 爆竹 炸药'),
      entry('🎉', 'party popper 庆祝 派对 撒花'),
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
