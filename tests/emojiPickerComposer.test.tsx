// Chat emoji picker — component and wiring tests.
//
// Harness note (same as tests/coworkComposerImageAttachment.test.tsx): this
// repo's renderer tests are server-rendered (no DOM/jsdom), so React event
// handlers cannot be fired by mounting. The picker panel and the bubble
// display mapping are asserted via SSR markup; the composer's caret-insertion
// WIRING is pinned against the real CoworkPromptInput source (the module the
// handlers live in), which is this repo's established convention for
// handler-contract coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmojiMenuButton from '../src/renderer/components/chat/EmojiPickerPopover';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';
import { i18nService } from '../src/renderer/services/i18n';
import type { GroupChatTranscriptMessage } from '../src/renderer/types/groupTask';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf-8');

const TXID = 'e'.repeat(64);

const groupMessage = (content: string): GroupChatTranscriptMessage => ({
  id: 1,
  pinId: `${TXID}i0`,
  txId: TXID,
  senderName: 'Worker Bot',
  senderGlobalMetaId: 'idq1worker',
  senderAvatar: 'https://example.com/bot.png',
  content,
  contentType: 'text',
  chainTimestamp: new Date(2026, 9, 29, 9, 5, 0).getTime(),
  msgIndex: 1,
  replyPin: null,
});

test('emoji trigger renders a toolbar button with picker aria wiring', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open={false} buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /aria-label="[^"]*"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-haspopup="menu"/);
  // Closed state renders no panel.
  assert.doesNotMatch(markup, /role="dialog"/);
});

test('open picker renders search box, category tabs, and a Unicode emoji grid', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /role="dialog"/);
  // Search input present with its placeholder copy.
  assert.match(markup, /type="text"[^>]*placeholder="[^"]+"/);
  // Category tablist with tabs (>= 8 categories in the catalog).
  assert.match(markup, /role="tablist"/);
  const tabCount = (markup.match(/role="tab"/g) ?? []).length;
  assert.ok(tabCount >= 8, `expected >= 8 category tabs, got ${tabCount}`);
  // Emoji grid options (role=option) carry the emoji as button text.
  assert.match(markup, /role="option"/);
  assert.ok(markup.includes('😀'), 'grid should render the first smileys category');
});

test('disabled trigger renders disabled', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open={false} buttonRef={{ current: null }} disabled onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /disabled/);
});

test('composer wires the emoji button next to the + button in both layout branches, inserting at the caret', () => {
  const source = readSource('../src/renderer/components/cowork/CoworkPromptInput.tsx');
  // Two render branches (wide toolbar row + single-line composer) each mount
  // the picker directly after the PlusMenuButton.
  const emojiButtonCount = (source.match(/<EmojiMenuButton/g) ?? []).length;
  assert.equal(emojiButtonCount, 2, 'both composer branches must render the emoji button');
  // Every PlusMenuButton JSX mount is followed by an EmojiMenuButton mount.
  // (The negative lookahead skips the `React.FC<PlusMenuButtonProps>` type
  // reference, whose `<PlusMenuButton` prefix would otherwise match.)
  const plusBlockEnds = [...source.matchAll(/<PlusMenuButton(?![A-Za-z])[\s\S]*?\/>/g)].map((m) => m.index! + m[0].length);
  assert.ok(plusBlockEnds.length === 2, `expected 2 PlusMenuButton mounts, got ${plusBlockEnds.length}`);
  for (const end of plusBlockEnds) {
    const between = source.slice(end, end + 400);
    assert.ok(
      between.includes('<EmojiMenuButton'),
      'an EmojiMenuButton must directly follow each PlusMenuButton mount',
    );
  }
  // Insertion path: read live selection -> applyTextareaChange(start, end, emoji)
  // -> refocus, i.e. the same DOM path paste uses (setRangeText 'end' mode
  // lands the caret after the inserted sequence).
  assert.match(source, /const handlePickEmoji = \(emoji: string\) => \{[\s\S]*?readLiveSelection\(\)[\s\S]*?applyTextareaChange\(start, end, emoji\)[\s\S]*?textarea\.focus\(\)/);
  // The picker follows the textarea's own disabled gate, not the attachment gate.
  assert.match(source, /const emojiPickerDisabled = disabled \|\| \(isStreaming && steerDisabled\)/);
});

test('group-task message bubbles render WeChat bracket codes as Unicode emoji (display-only)', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem message={groupMessage('收到[强]，马上开始[奋斗]')} senderDisplayName="Worker Bot" />,
  );
  assert.ok(markup.includes('👍'), 'bubble should show 👍 for [强]');
  assert.ok(markup.includes('💪'), 'bubble should show 💪 for [奋斗]');
  assert.ok(!markup.includes('[强]') && !markup.includes('[奋斗]'), 'bracket codes must not leak into the bubble');
  // The raw pin id and txid still render verbatim (chain data untouched).
  assert.match(markup, /txid:/);
});

test('group-task bubbles keep bracket codes verbatim inside code spans', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem message={groupMessage('跑 `code [强] here` 然后[微笑]')} senderDisplayName="Worker Bot" />,
  );
  assert.ok(markup.includes('[强]'), 'inline code span must keep the literal bracket code');
  assert.ok(markup.includes('🙂'), 'prose outside code still maps');
});

test('A2A private-chat bubbles render WeChat bracket codes as Unicode emoji', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-emoji-1',
        type: 'user',
        content: '早上好[微笑]，辛苦了[抱拳]',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'incoming', senderName: 'Peer', txid: TXID },
      }}
      peerName="Peer"
    />,
  );
  assert.ok(markup.includes('🙂'), 'A2A bubble should show 🙂 for [微笑]');
  assert.ok(markup.includes('👊'), 'A2A bubble should show 👊 for [抱拳]');
  assert.ok(!markup.includes('[微笑]') && !markup.includes('[抱拳]'), 'bracket codes must not leak');
});

test('cowork user bubbles route their body through the display mapping', () => {
  // UserMessageBody is not exported; pin the wiring in the transcript source
  // (the module the render lives in), same convention as the composer test.
  const source = readSource('../src/renderer/components/cowork/CoworkSessionDetail.tsx');
  assert.match(
    source,
    /content=\{mapWechatBracketCodesForDisplay\(body\)\}/,
    'UserMessageBody must pass its body through the display-only mapping',
  );
});

test('emoji picker copy resolves in both shipped locales', () => {
  for (const locale of ['zh', 'en'] as const) {
    const title = i18nService.tIn(locale, 'composerEmojiTitle');
    assert.ok(title && title.length > 0, `composerEmojiTitle missing for ${locale}`);
    assert.ok(i18nService.tIn(locale, 'emojiPickerSearchPlaceholder').length > 0);
    assert.ok(i18nService.tIn(locale, 'emojiPickerNoResults').length > 0);
    for (const key of [
      'emojiCategoryRecent',
      'emojiCategorySmileys',
      'emojiCategoryPeople',
      'emojiCategoryAnimals',
      'emojiCategoryFood',
      'emojiCategoryActivities',
      'emojiCategoryTravel',
      'emojiCategoryObjects',
      'emojiCategorySymbols',
      'emojiCategoryFlags',
    ]) {
      assert.ok(i18nService.tIn(locale, key).length > 0, `${key} missing for ${locale}`);
    }
  }
});
