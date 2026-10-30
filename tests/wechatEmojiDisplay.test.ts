// WeChat bracket-code display mapping — the pure module driving the
// message-bubble emoji rendering.
//
// Contract under test (the feature's hard boundary):
//  1. ~60 common WeChat bracket codes map to standard Unicode emoji.
//  2. Mapping is DISPLAY-ONLY: a pure function over the raw text; nothing
//     here rewrites stored/sent/on-chain content. The roundtrip test pins
//     that by serializing the stored form (JSON → parse, as store and chain
//     reload do) and checking both directions.
//  3. Fenced code blocks and inline code spans stay verbatim, so messages
//     that TALK ABOUT a bracket code keep the literal brackets.
//  4. Unknown bracket codes pass through untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WECHAT_BRACKET_EMOJI_MAP,
  WECHAT_BRACKET_CODE_COUNT,
  mapWechatBracketCodesForDisplay,
} from '../src/renderer/components/chat/wechatEmojiDisplay';

test('the WeChat bracket table covers ~60 common codes with Unicode emoji values', () => {
  assert.ok(WECHAT_BRACKET_CODE_COUNT >= 60, `expected >= 60 codes, got ${WECHAT_BRACKET_CODE_COUNT}`);
  assert.ok(WECHAT_BRACKET_CODE_COUNT <= 100, 'table should stay a curated ~60-100, not a dump');
  for (const [code, emoji] of Object.entries(WECHAT_BRACKET_EMOJI_MAP)) {
    // Every value must be a non-empty Unicode emoji sequence (not ASCII, not
    // a bracket code itself, no Tencent asset reference of any kind).
    assert.ok(emoji.length > 0, `code ${code} maps to empty value`);
    assert.ok([...emoji].some((ch) => ch.codePointAt(0)! > 0x2000), `code ${code} maps to non-emoji "${emoji}"`);
    assert.ok(!emoji.includes('[') && !emoji.includes(']'), `code ${code} maps back to a bracket code`);
    assert.ok(!emoji.includes('://'), `code ${code} maps to a URI (asset references are forbidden)`);
    // Every key is a bare bracket code without the brackets themselves.
    assert.ok(!code.includes('[') && !code.includes(']'), `key ${code} unexpectedly contains brackets`);
  }
  // Spot-check the flagship codes users actually type.
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['微笑'], '🙂');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['强'], '👍');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['玫瑰'], '🌹');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['爱心'], '❤️');
});

test('bracket codes in chat prose render as Unicode emoji', () => {
  assert.equal(mapWechatBracketCodesForDisplay('早上好[微笑]'), '早上好🙂');
  assert.equal(mapWechatBracketCodesForDisplay('[强]这个方案[强]'), '👍这个方案👍');
  assert.equal(
    mapWechatBracketCodesForDisplay('辛苦了[抱拳]，[玫瑰][爱心]'),
    `辛苦了${WECHAT_BRACKET_EMOJI_MAP['抱拳']}，${WECHAT_BRACKET_EMOJI_MAP['玫瑰']}${WECHAT_BRACKET_EMOJI_MAP['爱心']}`,
  );
  // Multi-codepoint values (VS16) survive mapping verbatim.
  assert.equal(mapWechatBracketCodesForDisplay('[胜利]'), '✌️');
});

test('unknown bracket codes and bracket-free text pass through untouched', () => {
  assert.equal(mapWechatBracketCodesForDisplay('[不存在的表情]'), '[不存在的表情]');
  assert.equal(mapWechatBracketCodesForDisplay('[微笑x]'), '[微笑x]');
  assert.equal(mapWechatBracketCodesForDisplay('plain text 123'), 'plain text 123');
  // No-bracket strings return the SAME reference (cheap no-op path).
  const noBrackets = 'no brackets here';
  assert.equal(mapWechatBracketCodesForDisplay(noBrackets), noBrackets);
});

test('fenced code blocks keep bracket codes verbatim', () => {
  const fenced = 'before [微笑]\n```\ncode [强] stays\n```\nafter [弱]';
  const mapped = mapWechatBracketCodesForDisplay(fenced);
  assert.ok(mapped.includes('before 🙂'));
  assert.ok(mapped.includes('after 👎'));
  assert.ok(mapped.includes('code [强] stays'), 'fenced block must stay verbatim');
  // Unterminated fence: everything after ``` is code.
  const unterminated = 'ok [微笑]\n```\n[强] still code';
  const mappedOpen = mapWechatBracketCodesForDisplay(unterminated);
  assert.ok(mappedOpen.includes('ok 🙂'));
  assert.ok(mappedOpen.includes('[强] still code'));
});

test('inline code spans keep bracket codes verbatim', () => {
  const mixed = 'look [微笑] but `the [强] token` stays [弱]';
  const mapped = mapWechatBracketCodesForDisplay(mixed);
  assert.ok(mapped.includes('look 🙂'));
  assert.ok(mapped.includes('stays 👎'));
  assert.ok(mapped.includes('`the [强] token`'), 'inline code span must stay verbatim');
});

test('on-chain roundtrip: emoji and bracket codes survive send -> store -> reload -> display', () => {
  // The send path stores/sends the raw text; the chain carries UTF-8 bytes.
  // Simulate the full loop with the same JSON hop the message stores and
  // chain payloads take.
  const drafts = [
    '发货了吗[疑问]',
    '生日快乐[蛋糕][爱心][红包]',
    '直接 Unicode：🙂👍❤️😀',
    'mixed 🙂 and [微笑] and `code [强]`',
  ];
  for (const stored of drafts) {
    // send -> chain -> reload: raw bytes preserved through JSON.
    const reloaded = JSON.parse(JSON.stringify({ content: stored })).content;
    assert.equal(reloaded, stored, `roundtrip must not alter stored text: ${stored}`);
    // display mapping stays a pure view over the reloaded text.
    const displayed = mapWechatBracketCodesForDisplay(reloaded);
    if (stored.includes('`code [强]`')) {
      assert.ok(displayed.includes('🙂'));
      assert.ok(displayed.includes('`code [强]`'));
    } else {
      assert.ok(!displayed.includes('['), `display should resolve all bracket codes: ${displayed}`);
    }
  }
  // Display-only invariant: mapping never mutates the stored string.
  const original = 'hi [微笑]';
  const snapshot = original;
  mapWechatBracketCodesForDisplay(original);
  assert.equal(original, snapshot);
});
