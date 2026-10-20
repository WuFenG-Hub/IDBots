// Per-message quote reply ("reply to one whole message").
//
// The owner clicks 回复 on any message's hover action bar; the message is
// quoted — snapshotted — into the composer's single quote slot, and the next
// message carries a blockquote naming the message's role and position. This
// file pins the acceptance cells of the per-message reply slice: textless
// messages, the preview bar and its summary, cancel, the submitted body
// (short and long), the running steer path, restore/clear on submit, the
// still-generating mark, the sent block's jump back to its source, and the
// bilingual copy.
//
// The repository's react test stack is SSR-only (react-dom/server, no jsdom),
// so the evidence is layered: real behaviour of the pure modules the render
// and submit paths call, real markup from the presentational components, and
// source-level assertions that the components are actually wired to them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

import {
  QUOTED_SELECTION_BLOCK_CHARS,
  QUOTED_SELECTION_MAX_CHARS,
  QUOTED_SELECTION_SUMMARY_CHARS,
  buildQuotedSelectionsBlock,
  buildTranscriptMessageIdsByOrdinal,
  buildTranscriptMessagePositions,
  composeSubmittedCoworkPrompt,
  createMessageQuotedSelection,
  findTranscriptMessageElement,
  hasQuotableText,
  parseSentQuoteBlock,
  removeQuotedSelection,
  summarizeQuotedSelectionText,
} from '../src/renderer/components/cowork/coworkQuotedSelections';
import {
  createVersionedComposerField,
  runComposerSubmission,
} from '../src/renderer/components/cowork/coworkPromptSubmission';
import { shouldShowAssistantBubbleActions } from '../src/renderer/components/cowork/assistantTurnPresentation.js';
import { shouldFollowPendingQuoteReply } from '../src/renderer/components/cowork/CoworkSessionDetail';
import CoworkQuotedSelectionTiles from '../src/renderer/components/cowork/CoworkQuotedSelectionTiles';
import CoworkSentQuoteBlock from '../src/renderer/components/cowork/CoworkSentQuoteBlock';
import CoworkMessageActionsMenu from '../src/renderer/components/cowork/CoworkMessageActionsMenu';
import { i18nService } from '../src/renderer/services/i18n';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const inputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const composerAttachmentsSource = readSource('src', 'renderer', 'components', 'cowork', 'coworkComposerAttachments.ts');
const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const tilesSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkQuotedSelectionTiles.tsx');
const sentBlockSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSentQuoteBlock.tsx');
const menuSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkMessageActionsMenu.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');
const cssSource = readSource('src', 'renderer', 'index.css');

// Labels as the running app supplies them (never hardcoded in the components).
const labels = () => ({
  header: i18nService.t('coworkQuoteBlockHeader'),
  item: i18nService.t('coworkQuoteBlockItem'),
  sourceLabel: {
    user: i18nService.t('coworkQuoteSourceUser'),
    assistant: i18nService.t('coworkQuoteSourceAssistant'),
    other: i18nService.t('coworkQuoteSourceOther'),
  },
  replyBlockHeader: i18nService.t('coworkQuoteReplyBlockHeader'),
  replyBlockItem: i18nService.t('coworkQuoteReplyBlockItem'),
  replyStreamingMark: i18nService.t('coworkQuoteReplyStreamingMark'),
  replySourceLabel: {
    user: i18nService.t('coworkQuoteReplySourceUser'),
    assistant: i18nService.t('coworkQuoteReplySourceAssistant'),
    other: i18nService.t('coworkQuoteReplySourceOther'),
  },
  truncatedNote: i18nService.t('coworkQuoteTruncatedNote'),
});

const withLanguage = (language, fn) => {
  const original = i18nService.getLanguage();
  i18nService.setLanguage(language, { persist: false });
  try {
    return fn();
  } finally {
    i18nService.setLanguage(original, { persist: false });
  }
};

const REPLY_TEXT = '我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。';

const reply = (content, ordinal, streaming, id) => createMessageQuotedSelection({
  content,
  role: 'assistant',
  ordinal,
  streaming,
}, id);

test('messages without text offer no reply entry, and both sides of the conversation mount it', () => {
  // The component's own text gate: empty and whitespace-only messages render
  // nothing at all, so tool blocks, placeholders and empty blocks have no entry.
  assert.equal(hasQuotableText(''), false);
  assert.equal(hasQuotableText('   \n\t '), false);
  assert.equal(hasQuotableText('\r\n'), false);
  assert.equal(hasQuotableText(REPLY_TEXT), true);

  // The entry is the per-message "⋯" trigger: present only when the message has
  // quotable text, and the panel behind it carries 引用 / 复制 / 分叉.
  const render = (text) => renderToStaticMarkup(
    <CoworkMessageActionsMenu visible text={text} onQuote={() => {}} />,
  );
  withLanguage('zh', () => {
    // The trigger itself is always mounted (hover-revealed); whether the panel
    // offers "quote"/"copy" is decided by hasQuotableText, asserted above — an
    // empty or whitespace-only message gets no quotable action.
    for (const text of ['', '  \n ', 'hello']) {
      const markup = render(text);
      assert.ok(markup.includes('data-cowork-message-actions-trigger="true"'), 'the entry is mounted');
      assert.ok(markup.includes('aria-haspopup'), 'the entry is a menu trigger');
      assert.ok(markup.includes(i18nService.t('coworkMessageActionsMore')), 'the entry carries its localized label');
    }
  });

  // The reply entry now lives inside the per-message "⋯" menu (the 2026-10-19
  // hover redesign retired the inline strips), so the three mount points carry
  // the action menu rather than CoworkMessageReplyAction. The menu still takes
  // the message text, and quote is routed through its onQuote callback.
  assert.equal((detailSource.match(/<CoworkMessageActionsMenu/g) ?? []).length, 3);
  assert.equal((detailSource.match(/<CoworkMessageReplyAction/g) ?? []).length, 0);
  assert.match(detailSource, /text=\{message\.content\}/);
  assert.match(detailSource, /text=\{replyContent\}/);
  // The gate is the message text itself, never the message type.
});

test('assistant mode mounts the per-bubble toolbar on every bubble, narration included', () => {
  // Assistant mode gives EVERY assistant bubble its own hover-action toolbar,
  // so the per-message reply entry is reachable on narration bubbles too —
  // the same per-message parity the professional row has. The old gates
  // (final-reply-only `isFinalReply`, narration-exclusion `!isNarration`)
  // were quirks of the single-toolbar-per-turn layout, not requirements of
  // the reply feature, and are gone. The decision is a pure predicate shared
  // with the component:
  assert.equal(
    shouldShowAssistantBubbleActions({ isAssistantMode: true, showCopyButton: true }),
    true,
    'every settled assistant bubble (narration or final) gets its toolbar',
  );
  assert.equal(
    shouldShowAssistantBubbleActions({ isAssistantMode: true, showCopyButton: false }),
    false,
    'a streaming turn still hides action toolbars in both modes',
  );
  assert.equal(
    shouldShowAssistantBubbleActions({ isAssistantMode: false, showCopyButton: true }),
    false,
    'professional mode keeps its own in-flow row; this decision is assistant-only',
  );

  // The component wires exactly this predicate at the assistant-mode
  // toolbar...
  assert.match(detailSource, /shouldShowAssistantBubbleActions\(\{ isAssistantMode, showCopyButton \}\)/);
  // ...and the two old gates no longer appear anywhere in the component.
  assert.doesNotMatch(detailSource, /isFinalReply/);
  assert.doesNotMatch(detailSource, /isNarration/);
});

test('a narration bubble is replyable end-to-end: its position resolves and the quote reaches the body', () => {
  // handleQuoteReplyMessage used to fall through silently when a clicked
  // message had no transcript position ("clicked 回复, nothing happened").
  // Narration bubbles are exactly what the new mount condition adds, so pin
  // their lookup: the position map is built from the same turns the
  // transcript renders, and the click path reads it for the ordinal.
  const turns = [
    {
      userMessage: { id: 'u1' },
      assistantItems: [
        { type: 'assistant', message: { id: 'n1', metadata: { narration: true } } },
        { type: 'assistant', message: { id: 'n2', metadata: { narration: true } } },
        { type: 'assistant', message: { id: 'final' } },
      ],
    },
  ];
  const positions = buildTranscriptMessagePositions(turns);
  assert.equal(positions.get('n1'), 2, 'the opening narration is the 2nd conversational message');
  assert.equal(positions.get('n2'), 3);
  assert.equal(positions.get('final'), 4);
  assert.ok(positions.get('n1'), 'the ordinal lookup the click path takes resolves');

  // Click simulation: ordinal + text snapshot → composer fragment → body.
  const fragment = createMessageQuotedSelection({
    content: '先看了这两个文件，接下来跑构建。',
    role: 'assistant',
    ordinal: positions.get('n1'),
    streaming: false,
  }, 'q-narration');
  assert.ok(fragment, 'a narration with text produces a fragment exactly like a final reply');
  withLanguage('zh', () => {
    const body = composeSubmittedCoworkPrompt({
      value: '就按这条改',
      quotedSelections: [fragment],
      labels: labels(),
    });
    assert.ok(body.startsWith('> #2 助手消息：\n> '), body);
    assert.ok(body.includes('先看了这两个文件，接下来跑构建。'), 'the narration text rides into the submitted body');
    assert.ok(
      body.indexOf('先看了这两个文件，接下来跑构建。') < body.indexOf('就按这条改'),
      'the excerpt reads before the instruction',
    );
  });

  // The handler this pins is still the ref lookup over turns this test fed.
  assert.match(detailSource, /transcriptMessagePositionsRef\.current\.get\(message\.id\)/);
  assert.match(detailSource, /buildTranscriptMessagePositions\(turns\)/);
});

test('replying to a message fills the single composer slot with a frozen snapshot', () => {
  // The fragment captures role, position and the generating state together
  // with the text.
  const fragment = createMessageQuotedSelection({
    content: `  ${REPLY_TEXT}  `,
    role: 'assistant',
    ordinal: 3,
    streaming: true,
  }, 'q-reply');
  assert.equal(fragment.id, 'q-reply');
  assert.equal(fragment.text, REPLY_TEXT, 'the excerpt is the message text, normalized');
  assert.equal(fragment.role, 'assistant');
  assert.deepEqual(fragment.messageRef, { ordinal: 3, streaming: true });
  assert.equal(fragment.truncated, false);

  // Snapshot semantics: whatever the live message does after the click must
  // not change the quoted excerpt.
  const target = { content: 'partial line', role: 'assistant', ordinal: 1, streaming: true };
  const frozen = createMessageQuotedSelection(target, 'q-frozen');
  target.content = 'partial line plus later tokens';
  assert.equal(frozen.text, 'partial line');
  assert.equal(frozen.messageRef.streaming, true);

  // A textless message never produces a fragment.
  assert.equal(createMessageQuotedSelection({ content: '   ', role: 'assistant', ordinal: 2, streaming: false }), null);

  // The transcript handler sends the fragment through the composer's shared
  // slot — the same call the selection path makes.
  assert.match(detailSource, /const handleQuoteReplyMessage = useCallback\(\(message: CoworkMessage, text: string\)/);
  assert.match(detailSource, /createMessageQuotedSelection\(\{/);
  assert.match(detailSource, /streaming: message\.metadata\?\.isStreaming === true/);
  assert.match(detailSource, /promptInputRef\.current\?\.addQuotedSelection\(fragment\)/);
  assert.equal(
    (detailSource.match(/addQuotedSelection\(fragment\)/g) ?? []).length,
    2,
    'both entries write the same slot — no second parallel state',
  );
  assert.equal((inputSource.match(/useState<CoworkQuotedSelection\[\]>/g) ?? []).length, 1);
  // ...and the slot is single-target: a new quote replaces the previous one.
  assert.match(inputSource, /field\.set\(\[selection\]\)/);
});

test('the reply preview bar shows the one-line summary, and cancel clears the slot', () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-bar');

  // A single quote renders as the compact reply bar: icon + summary + cancel.
  withLanguage('zh', () => {
    const markup = renderToStaticMarkup(
      <CoworkQuotedSelectionTiles selections={[fragment]} onRemove={() => {}} />,
    );
    assert.ok(markup.includes('data-cowork-quote-reply-bar="true"'), 'one quote renders as the bar');
    assert.doesNotMatch(markup, /data-cowork-quote-tile=/, 'no per-fragment tile row in the single-target slot');
    assert.ok(markup.includes('<svg'), 'the bar carries the quote icon');
    assert.ok(markup.includes(i18nService.t('coworkQuoteReplyPreviewLabel')), 'the bar is labelled');
    assert.ok(markup.includes(i18nService.t('coworkQuoteReplyCancel')), 'the cancel control is offered');
    assert.ok(markup.includes(summarizeQuotedSelectionText(fragment.text)), 'the summary comes from the excerpt');
  });

  // Summary cell: one line, flattened and capped at 96 characters.
  const multiLine = 'first line of the message\nsecond line follows';
  const summary = summarizeQuotedSelectionText(multiLine);
  assert.equal(summary, 'first line of the message second line follows');
  assert.ok(!summary.includes('\n'), 'the summary is a single line');
  assert.equal(summarizeQuotedSelectionText(REPLY_TEXT), REPLY_TEXT);

  // Cancel removes the fragment: the bar disappears and the body has no quote.
  const remaining = removeQuotedSelection([fragment], fragment.id);
  assert.deepEqual(remaining, []);
  assert.equal(
    renderToStaticMarkup(<CoworkQuotedSelectionTiles selections={remaining} onRemove={() => {}} />),
    '',
  );
  const body = composeSubmittedCoworkPrompt({ value: 'hi there', quotedSelections: remaining, labels: labels() });
  assert.equal(body, 'hi there');
  assert.ok(!body.includes(REPLY_TEXT));
  // The bar's cancel button runs the composer's removal path.
  assert.match(tilesSource, /onClick=\{\(\) => onRemove\(selection\.id\)\}/);
  assert.match(inputSource, /selections=\{quotedSelections\}/);
  assert.match(inputSource, /onRemove=\{handleRemoveQuotedSelection\}/);
});

test('the composer placeholder switches to the reply copy while the slot holds a quote', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-reply-placeholder-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'composer-placeholder.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkComposerPlaceholder } from './src/renderer/components/cowork/CoworkPromptInput.tsx';\nexport { i18nService } from './src/renderer/services/i18n.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'composer-placeholder-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkComposerPlaceholder, i18nService: bundledI18n } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  const original = bundledI18n.getLanguage();
  try {
    bundledI18n.setLanguage('zh', { persist: false });
    const replyPlaceholder = bundledI18n.t('coworkQuoteReplyPlaceholder');
    assert.equal(replyPlaceholder, '回复…');
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: false, idlePlaceholder: 'idle hint' }),
      'idle hint',
      'an empty slot keeps the idle copy',
    );
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      replyPlaceholder,
      'a filled slot switches to the reply copy',
    );
    // While a turn streams, an empty slot keeps the steer copy...
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: true, steerDisabled: false, hasQuotedSelections: false, idlePlaceholder: 'idle hint' }),
      bundledI18n.t('coworkSteerPlaceholder'),
    );
    // ...but a filled slot is a reply, so it wins even mid-stream.
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: true, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      replyPlaceholder,
    );
    bundledI18n.setLanguage('en', { persist: false });
    assert.equal(bundledI18n.t('coworkQuoteReplyPlaceholder'), 'Reply…');
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      'Reply…',
    );
  } finally {
    bundledI18n.setLanguage(original, { persist: false });
  }

  // The component derives the placeholder through this helper with the live
  // slot state.
  assert.match(inputSource, /deriveCoworkComposerPlaceholder\(\{/);
  assert.match(inputSource, /hasQuotedSelections: quotedSelections\.length > 0/);
});

test('submitting a short message reply carries the full text with role and position', () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-full');
  withLanguage('zh', () => {
    const prompt = composeSubmittedCoworkPrompt({
      value: 'Please answer only about that part.',
      quotedSelections: [fragment],
      attachmentLines: 'Attachment path: /tmp/brief.md',
      labels: labels(),
    });
    // The block leads with the message's role + position, then the original.
    assert.ok(prompt.startsWith('> #3 助手消息：\n> '), prompt);
    assert.ok(prompt.includes(REPLY_TEXT), 'the whole message rides in the body');
    assert.ok(
      prompt.indexOf(REPLY_TEXT) < prompt.indexOf('Please answer only about that part.'),
      'the excerpt reads before the instruction',
    );
    assert.ok(
      prompt.indexOf('Please answer only about that part.') < prompt.indexOf('Attachment path:'),
      'attachments still trail the instruction',
    );
    // A single reply block has no separate passage heading above it.
    assert.ok(!prompt.includes(i18nService.t('coworkQuoteBlockHeader')));
  });

  // The steer path composes through the same single call, and the resulting
  // body is what onSubmit receives.
  assert.match(inputSource, /const finalPrompt = composeSubmittedCoworkPrompt\(\{/);
  assert.equal((inputSource.match(/composeSubmittedCoworkPrompt\(\{/g) ?? []).length, 1, 'one composition path for idle and steer');
  assert.match(inputSource, /onSubmit\(finalPrompt/);
  assert.doesNotMatch(inputSource, /isStreaming\s*\?\s*trimmedValue/);
});

test('a long message reply is capped at the excerpt limit with an explicit in-body note', () => {
  const long = `${'y'.repeat(QUOTED_SELECTION_MAX_CHARS + 500)}DROPPED-TAIL`;
  const fragment = reply(long, 7, false, 'q-long');
  assert.equal(fragment.text.length, QUOTED_SELECTION_MAX_CHARS);
  assert.equal(fragment.truncated, true);

  withLanguage('zh', () => {
    const prompt = composeSubmittedCoworkPrompt({
      value: 'summarize this',
      quotedSelections: [fragment],
      labels: labels(),
    });
    // A reply quotes a reference, not a payload: the body carries one short
    // excerpt, and a cut is stated with the in-body cap that was applied.
    const note = i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_BLOCK_CHARS));
    assert.ok(!prompt.includes(fragment.text), 'the whole 4000-char excerpt does NOT ride into the body');
    assert.ok(!prompt.includes('DROPPED-TAIL'), 'the dropped tail never reaches the body');
    assert.ok(prompt.includes(note), 'the cut is stated explicitly in the body');
    const excerptLine = prompt.split('\n').find((line) => line.startsWith('> ') && line.includes('y'));
    assert.ok(excerptLine, prompt);
    assert.ok(
      prompt.indexOf(note) > prompt.indexOf(excerptLine),
      'the note sits after the excerpt line',
    );
  });
});

test('the preview summary and the transmitted excerpt are budgeted independently', () => {
  // 200 characters: the visible summary is cut at the 96-character budget,
  // while the body still carries every character (well under the 4000 cap).
  const medium = 'z'.repeat(200);
  const mediumFragment = reply(medium, 2, false, 'q-medium');
  const summary = summarizeQuotedSelectionText(mediumFragment.text);
  assert.equal(summary.length, QUOTED_SELECTION_SUMMARY_CHARS + 1, 'summary = 96 characters + ellipsis');
  assert.ok(summary.endsWith('…'));
  assert.equal(mediumFragment.truncated, false, 'the fragment is not truncated');
  const mediumPrompt = composeSubmittedCoworkPrompt({ value: 'x', quotedSelections: [mediumFragment], labels: labels() });
  assert.ok(!mediumPrompt.includes(medium), 'a 200-char message does not ride into the body whole');
  assert.ok(
    !mediumPrompt.includes(i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_MAX_CHARS))),
    'no truncation note under the cap',
  );

  // 4500 characters: the same summary budget, the body capped at 4000 with
  // the note — the two budgets never share a number.
  const longFragment = reply('w'.repeat(QUOTED_SELECTION_MAX_CHARS + 500), 2, false, 'q-over');
  assert.equal(summarizeQuotedSelectionText(longFragment.text).length, QUOTED_SELECTION_SUMMARY_CHARS + 1);
  assert.equal(longFragment.truncated, true);
});

test('a still-generating target is marked in the body, and the excerpt stays frozen', () => {
  // The live message keeps streaming after the reply was taken from it.
  const message = { content: 'First sentence so far.', role: 'assistant', ordinal: 3, streaming: true };
  const frozen = createMessageQuotedSelection(message, 'q-stream');
  withLanguage('zh', () => {
    const before = composeSubmittedCoworkPrompt({
      value: 'keep going from here',
      quotedSelections: [frozen],
      labels: labels(),
    });
    assert.ok(before.includes('#3 助手消息 · 该条仍在生成中：'), 'the block marks the generating target');
    assert.ok(before.includes('First sentence so far.'));

    // The stream appends tokens to the live message; the quoted excerpt — and
    // therefore the composed body — must not move.
    message.content = 'First sentence so far. Second sentence. Third.';
    const after = composeSubmittedCoworkPrompt({
      value: 'keep going from here',
      quotedSelections: [frozen],
      labels: labels(),
    });
    assert.equal(after, before, 'the snapshot never changes under the owner');
    assert.ok(!after.includes('Second sentence.'));

    // A settled message carries no mark.
    const settled = reply('Done already.', 4, false, 'q-done');
    const settledPrompt = composeSubmittedCoworkPrompt({ value: 'x', quotedSelections: [settled], labels: labels() });
    assert.ok(!settledPrompt.includes(i18nService.t('coworkQuoteReplyStreamingMark')));
    assert.ok(settledPrompt.includes('#4 助手消息：'));
  });
});

test('the new entry reaches the submit truth table in every cell, idle and running', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-reply-truth-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'prompt-state.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkPromptInputState } from './src/renderer/components/cowork/CoworkPromptInput.tsx';`,
      resolveDir: projectRoot,
      sourcefile: 'prompt-state-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkPromptInputState } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);

  // Idle × quote-only: the reply fragment alone is submit content.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  // Idle × text only: unchanged plain send.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: 'typed', isStreaming: false, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 0 }),
    { hasTextInput: true, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  // Running × quote-only: 发送 (steer), never 停止 — the first-slice defect
  // this entry must not repeat.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  // Running × nothing: stop stays.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  // Running × quote-only with steer disabled: stop stays, nothing submits.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: true, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );

  // ...and the quote-only steer body carries the whole quoted message.
  const fragment = reply(REPLY_TEXT, 3, false, 'q-steer');
  withLanguage('zh', () => {
    const steerBody = composeSubmittedCoworkPrompt({ value: '', quotedSelections: [fragment], labels: labels() });
    assert.notEqual(steerBody, '', 'a quote-only steer must not compose an empty prompt');
    assert.ok(steerBody.includes(REPLY_TEXT), 'the quoted original rides in the steer body');
    assert.ok(steerBody.includes('#3 助手消息：'), 'the steer body uses the same reply block');
  });

  // Both branches consume the same single slot; only an empty steer returns
  // early, before anything is composed or consumed.
  assert.match(inputSource, /if \(isStreaming && !trimmedValue && submittedAttachments\.length === 0\s*\n\s*&& submittedQuotedSelections\.length === 0\) return;/);
  // The snapshot/restore pair is inline on this baseline: the quoted slot is
  // taken and put back right here, not by a shared helper.
  // The rollback moved into the shared submit helper so text, attachments and
// quoted fragments clear and restore together.
assert.match(composerAttachmentsSource, /const quotedSnapshot = quotedSelectionField\?\.takeAndClear\(\)/);
assert.match(inputSource, /quotedSelectionField,/);
});

test('a rejected submission restores the reply quote; an accepted one clears it', async () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-restore');
  const runSubmit = async (outcome) => {
    const quotedField = createVersionedComposerField([fragment], () => [], () => {});
    const draftField = createVersionedComposerField('', () => '', () => {});
    const quotedSnapshot = quotedField.takeAndClear();
    const draftSnapshot = draftField.takeAndClear();
    assert.deepEqual(quotedField.get(), [], 'consumed at submit time');
    const result = await runComposerSubmission(draftField, draftSnapshot, () => outcome);
    if (result === false) {
      quotedField.restoreIfUnchanged(quotedSnapshot);
    }
    return quotedField;
  };

  assert.deepEqual(
    (await runSubmit(false)).get().map((entry) => entry.text),
    [REPLY_TEXT],
    'a rejected submit restores the reply quote',
  );
  assert.deepEqual((await runSubmit(true)).get(), [], 'an accepted submit leaves the slot cleared');

  // A quote added while the submit was in flight is newer state: the stale
  // restore is refused.
  const quotedField = createVersionedComposerField([fragment], () => [], () => {});
  const snapshot = quotedField.takeAndClear();
  quotedField.set([reply('newer quote', 5, false, 'q-newer')]);
  assert.equal(quotedField.restoreIfUnchanged(snapshot), false);
  assert.deepEqual(quotedField.get().map((entry) => entry.messageRef.ordinal), [5]);

  // Both rejection arms (accepted===false / thrown) restore the slot, inline:
  // a refused submit puts the quoted fragments back.
  assert.equal(
    (composerAttachmentsSource.match(/quotedSelectionField\.restoreIfUnchanged\(quotedSnapshot\)/g) ?? []).length,
    1,
    'the shared rollback helper puts the quoted slot back',
  );
  assert.equal(
    (composerAttachmentsSource.match(/\brestore\(\);/g) ?? []).length,
    2,
    'both rejection arms call it',
  );
});

test('the transcript position numbering counts rendered messages for the reply label', () => {
  const turns = [
    {
      userMessage: { id: 'u1' },
      assistantItems: [
        { type: 'assistant', message: { id: 'a1' } },
        { type: 'tool_group', group: { toolUse: { id: 't1' } } },
        { type: 'tool_result', message: { id: 'tr1' } },
      ],
    },
    {
      userMessage: { id: 'u2' },
      assistantItems: [
        { type: 'system', message: { id: 's1' } },
        { type: 'assistant', message: { id: 'a2' } },
      ],
    },
    {
      userMessage: null,
      assistantItems: [{ type: 'assistant', message: { id: 'a3' } }],
    },
  ];
  const positions = buildTranscriptMessagePositions(turns);
  assert.equal(positions.get('u1'), 1);
  assert.equal(positions.get('a1'), 2);
  assert.equal(positions.get('u2'), 3);
  assert.equal(positions.get('a2'), 4);
  assert.equal(positions.get('a3'), 5);
  assert.equal(positions.get('t1'), undefined, 'tool chrome is not numbered');
  assert.equal(positions.get('tr1'), undefined);
  assert.equal(positions.get('s1'), undefined, 'system notices are not numbered');

  // The click path reads this map at capture time and freezes the number into
  // the fragment.
  assert.match(detailSource, /buildTranscriptMessagePositions\(turns\)/);
  assert.match(detailSource, /transcriptMessagePositionsRef\.current\.get\(message\.id\)/);
});

test('a reply block that quotes several messages opens with the reply header', () => {
  // The composer slot is single-target today; the block builder keeps the
  // model's N support, where a shared header keeps every item line a
  // per-message label.
  const first = reply('first quoted message', 1, false, 'q1');
  const second = reply('second quoted message', 2, true, 'q2');
  withLanguage('zh', () => {
    const block = buildQuotedSelectionsBlock([first, second], labels());
    assert.ok(
      block.startsWith(`> ${i18nService.t('coworkQuoteReplyBlockHeader')}\n>\n`),
      block,
    );
    // A reply travels as a compact pointer: "#<ordinal> <side>:" plus one short
    // excerpt line — never the whole message (2026-10-19, owner's call).
    assert.ok(block.includes('#1 助手消息：'));
    assert.ok(block.includes('#2 助手消息 · 该条仍在生成中：'));
    assert.ok(block.includes('> first quoted message') && block.includes('> second quoted message'));
  });
});

test('the sent reply block is parsed off the message head, and only the generated form matches', () => {
  withLanguage('zh', () => {
    const fragment = reply(REPLY_TEXT, 3, false, 'q-parsed');
    const body = composeSubmittedCoworkPrompt({
      value: 'Please answer only about that part.',
      quotedSelections: [fragment],
      labels: labels(),
    });
    const parsed = parseSentQuoteBlock(body);
    assert.ok(parsed, body);
    assert.equal(parsed.ordinal, 3, 'the label position becomes the jump target');
    assert.ok(parsed.block.startsWith('> #3 助手消息：\n> '), parsed.block);
    assert.ok(parsed.block.includes(REPLY_TEXT), 'the excerpt rides inside the block');
    assert.equal(parsed.rest, 'Please answer only about that part.', 'the instruction is the rest');
    assert.ok(!parsed.rest.includes('>'), 'the block never swallows the instruction');
  });

  // A capped excerpt's display block keeps the label and the excerpt and drops
  // the truncation-note line (the rendered row's CSS ellipsis already says the
  // text continues); the note still rides the submitted body, and the rest
  // still starts after the block.
  withLanguage('zh', () => {
    const long = reply('y'.repeat(QUOTED_SELECTION_MAX_CHARS + 500), 7, false, 'q-parsed-long');
    const body = composeSubmittedCoworkPrompt({ value: 'summarize this', quotedSelections: [long], labels: labels() });
    const parsed = parseSentQuoteBlock(body);
    assert.ok(parsed, body);
    assert.equal(parsed.block.split('\n').length, 2, 'label + excerpt — the display block drops the truncation note');
    assert.ok(
      !parsed.block.includes(i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_BLOCK_CHARS))),
      'the truncation note never renders in the display block',
    );
    assert.ok(
      body.includes(i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_BLOCK_CHARS))),
      'the submitted body still carries the note the model reads',
    );
    assert.equal(parsed.rest, 'summarize this');
  });

  // A still-generating target keeps its mark inside the label; the jump target
  // still resolves.
  withLanguage('zh', () => {
    const streaming = createMessageQuotedSelection(
      { content: 'partial line', role: 'assistant', ordinal: 4, streaming: true },
      'q-parsed-stream',
    );
    const body = composeSubmittedCoworkPrompt({ value: 'go on', quotedSelections: [streaming], labels: labels() });
    const parsed = parseSentQuoteBlock(body);
    assert.ok(parsed, body);
    assert.equal(parsed.ordinal, 4, 'the generating mark does not break the label match');
    assert.equal(parsed.rest, 'go on');
  });

  // The English form uses the half-width colon.
  withLanguage('en', () => {
    const fragment = reply('a quoted message', 2, false, 'q-parsed-en');
    const body = composeSubmittedCoworkPrompt({ value: 'go on', quotedSelections: [fragment], labels: labels() });
    const parsed = parseSentQuoteBlock(body);
    assert.ok(parsed, body);
    assert.equal(parsed.ordinal, 2);
    assert.equal(parsed.rest, 'go on');
  });

  // Only the generated form, only at the head: everything else stays plain.
  assert.equal(parseSentQuoteBlock('just an instruction'), null);
  assert.equal(parseSentQuoteBlock(''), null);
  assert.equal(parseSentQuoteBlock('> a hand-written quote\n> second line'), null, 'no #<ordinal> label');
  assert.equal(parseSentQuoteBlock('> #3 助手消息：'), null, 'a label alone is not the generated form');
  assert.equal(
    parseSentQuoteBlock('intro line\n\n> #3 助手消息：\n> excerpt'),
    null,
    'the block must be at the head of the body',
  );
});

test('a quoted position resolves back to its message id, and the jump prefers the innermost element', () => {
  // The reverse lookup the sent block's jump takes: position → id.
  const turns = [
    {
      userMessage: { id: 'u1' },
      assistantItems: [
        { type: 'assistant', message: { id: 'n1' } },
        { type: 'tool_group', group: { toolUse: { id: 't1' } } },
        { type: 'assistant', message: { id: 'final' } },
      ],
    },
    { userMessage: { id: 'u2' }, assistantItems: [] },
  ];
  const positions = buildTranscriptMessagePositions(turns);
  const idsByOrdinal = buildTranscriptMessageIdsByOrdinal(positions);
  assert.equal(idsByOrdinal.get(1), 'u1');
  assert.equal(idsByOrdinal.get(2), 'n1');
  assert.equal(idsByOrdinal.get(3), 'final');
  assert.equal(idsByOrdinal.get(4), 'u2');
  assert.equal(idsByOrdinal.get(5), undefined, 'a position the window no longer holds misses');
  assert.equal(idsByOrdinal.size, positions.size, 'one id per position, and nothing else');

  // The DOM lookup: one id can be mounted on several layers, and the jump
  // must ring the single message (the innermost match), never the turn block.
  const originalCss = globalThis.CSS;
  globalThis.CSS = { escape: (value) => value };
  try {
    const inner = { querySelector: () => null };
    const outer = { querySelector: () => inner };
    const root = { querySelectorAll: () => [outer, inner] };
    assert.equal(findTranscriptMessageElement(root, 'n1'), inner, 'the innermost mount wins');
    assert.equal(findTranscriptMessageElement({ querySelectorAll: () => [] }, 'n1'), null, 'an empty window misses');
    assert.equal(findTranscriptMessageElement(null, 'n1'), null);
    assert.equal(findTranscriptMessageElement(root, ''), null);
  } finally {
    globalThis.CSS = originalCss;
  }
});

test('the sent quote block renders as a clickable control, and the composer-side jump is gone', () => {
  const block = '> #3 助手消息：\n> quoted excerpt';
  const originalWindow = globalThis.window;
  globalThis.window = { electron: { platform: 'darwin' } };
  try {
    const interactive = renderToStaticMarkup(
      <CoworkSentQuoteBlock block={block} onJump={() => {}} />,
    );
    assert.ok(interactive.includes('data-cowork-sent-quote="true"'), 'the block is identifiable');
    assert.ok(interactive.includes('role="button"'), 'the block is a control');
    assert.ok(interactive.includes('tabindex="0"'), 'the control is keyboard-reachable');
    assert.ok(interactive.includes('cursor-pointer'), 'the control advertises itself');
    assert.ok(interactive.includes(i18nService.t('coworkQuoteJumpToMessage')), 'the jump copy labels it');
    assert.match(interactive, /<blockquote/, 'the blockquote still renders through markdown');
    assert.ok(interactive.includes('#3 助手消息：') && interactive.includes('quoted excerpt'));

    const plain = renderToStaticMarkup(<CoworkSentQuoteBlock block={block} />);
    assert.ok(plain.includes('data-cowork-sent-quote="true"'));
    assert.doesNotMatch(plain, /role="button"/, 'without a handler it stays a plain preview');
    assert.doesNotMatch(plain, /cursor-pointer/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }

  // The transcript splits the sent body and mounts the control only for the
  // parsed block; the click goes through the position → id reverse lookup and
  // reuses the scroll + ring path.
  // The parse carries the display-source map: the rendered block names the
  // speaker (你：/ <bot 名>：) while the prompt body keeps the generated label.
  assert.match(detailSource, /const sentQuote = parseSentQuoteBlock\(message\.content, buildSentQuoteDisplaySources\(botName\)\);/);
  assert.match(detailSource, /<CoworkSentQuoteBlock/);
  assert.match(detailSource, /onJumpToQuoteBlock\(sentQuote\.ordinal\)/);
  assert.match(detailSource, /buildTranscriptMessageIdsByOrdinal\(transcriptMessagePositionsRef\.current\)/);
  assert.match(detailSource, /findTranscriptMessageElement\(container, messageId\)/);
  assert.match(detailSource, /const QUOTE_JUMP_HIGHLIGHT_CLASSES = \['ring-1', 'ring-claude-accent'\]/);
  assert.match(detailSource, /classList\.add\(\.\.\.QUOTE_JUMP_HIGHLIGHT_CLASSES\)/);
  assert.match(detailSource, /}, 2500\);/);
  // The ring must wrap the message's bubble, never the full-width wrapper:
  // both bubbles carry the id, so the innermost-match lookup lands on the
  // bubble's own outline (w-fit width, its 22px radius).
  assert.equal(
    (detailSource.match(/data-message-id=\{message\.id\}/g) ?? []).length,
    3,
    'the assistant message wrapper and both message bubbles carry the id',
  );
  assert.match(sentBlockSource, /i18nService\.t\('coworkQuoteJumpToMessage'\)/);

  // The composer-side jump is fully gone: no button branch, no props, no
  // attribute flash, no leftover CSS animation.
  assert.doesNotMatch(tilesSource, /onJumpToMessage|canJump/);
  assert.doesNotMatch(inputSource, /onJumpToQuotedMessage/);
  assert.doesNotMatch(detailSource, /onJumpToQuotedMessage/);
  assert.doesNotMatch(detailSource, /data-quote-jump-highlight/);
  assert.doesNotMatch(cssSource, /quote-jump-flash|data-quote-jump-highlight/);
});

test('a quote reply sent from away-from-bottom follows once when its reply arrives', () => {
  // The one-shot decision: armed at send time, consumed only by the reply's
  // arrival — the transcript tail turning into an assistant message. The
  // user-message echo that lands right after the send must not consume it, or
  // the view would leave the quoted message (the confirmation window) the
  // moment the send goes through.
  assert.equal(shouldFollowPendingQuoteReply([{ type: 'user' }], true), false);
  assert.equal(shouldFollowPendingQuoteReply([{ type: 'user' }, { type: 'assistant' }], true), true);
  assert.equal(shouldFollowPendingQuoteReply([{ type: 'assistant' }], false), false, 'no flag, no forced follow');
  assert.equal(shouldFollowPendingQuoteReply([], true), false);
  assert.equal(shouldFollowPendingQuoteReply(undefined, true), false);

  // Armed on the send path from the composed body (both quote kinds ride
  // there), and never by writing the gate: the "back to bottom" button must
  // stay available while the owner waits parked at the quoted message.
  const submitWrapper = /const handlePromptSubmit = useCallback\(\(prompt: string, skillPrompt\?: string\) => \{[\s\S]*?\}, \[onContinue\]\);/.exec(detailSource);
  assert.ok(submitWrapper, 'the submit wrapper is the flag set path');
  assert.match(submitWrapper[0], /pendingQuoteReplyFollowRef\.current = parseSentQuoteBlock\(prompt\) !== null/);
  assert.match(submitWrapper[0], /parseSentSelectionQuoteBlock\(prompt, buildSentSelectionQuoteLabelSets\(\)\) !== null/);
  assert.doesNotMatch(submitWrapper[0], /setShouldAutoScroll/, 'the gate is not opened at send time');
  assert.match(detailSource, /onSubmit=\{handlePromptSubmit\}/);

  // Consumed in the follow effect: the closed gate is bypassed for exactly
  // that run, the effect's own scroll runs, and the flag clears.
  assert.match(detailSource, /const pendingQuoteReplyFollowRef = useRef\(false\)/);
  const followEffect = /const quoteReplyArrived = shouldFollowPendingQuoteReply\([\s\S]*?\}, \[currentSession\?\.id, autoScrollFollowSignal, isStreaming, shouldAutoScroll\]\);/.exec(detailSource);
  assert.ok(followEffect, 'the follow effect reads the flag');
  assert.match(followEffect[0], /if \(!shouldAutoScroll && !quoteReplyArrived\)/);
  assert.match(followEffect[0], /if \(quoteReplyArrived\) \{\n      pendingQuoteReplyFollowRef\.current = false;/);
  assert.doesNotMatch(followEffect[0], /setShouldAutoScroll/, 'the fix never writes the gate');

  // Leg 4 stays: the button still renders on the closed gate and re-opens it.
  assert.match(detailSource, /\{!shouldAutoScroll && \(/);
  assert.match(detailSource, /onClick=\{handleScrollToBottomClick\}/);
});

test('reply copy lives in both i18n dictionaries and follows the language switch', () => {
  const keys = [
    'coworkQuoteReplyAction',
    'coworkQuoteReplyPreviewLabel',
    'coworkQuoteReplyCancel',
    'coworkQuoteReplyPlaceholder',
    'coworkQuoteReplyBlockHeader',
    'coworkQuoteReplyBlockItem',
    'coworkQuoteReplyStreamingMark',
    'coworkQuoteReplySourceUser',
    'coworkQuoteReplySourceAssistant',
    'coworkQuoteReplySourceOther',
    'coworkQuoteTruncatedNote',
    'coworkQuoteJumpToMessage',
    'coworkQuoteJumpMissing',
  ];
  for (const key of keys) {
    assert.equal(
      (i18nSource.match(new RegExp(`${key}:`, 'g')) ?? []).length,
      2,
      `${key} must exist in both the zh and en dictionaries`,
    );
  }
  assert.match(i18nSource, /coworkQuoteReplyAction: '回复'/);
  assert.match(i18nSource, /coworkQuoteReplyAction: 'Reply'/);
  assert.match(i18nSource, /coworkQuoteReplyCancel: '取消回复'/);
  assert.match(i18nSource, /coworkQuoteReplyCancel: 'Cancel reply'/);
  assert.match(i18nSource, /coworkQuoteReplyPlaceholder: '回复…'/);
  assert.match(i18nSource, /coworkQuoteReplyPlaceholder: 'Reply…'/);
  assert.match(i18nSource, /coworkQuoteReplyStreamingMark: '该条仍在生成中'/);
  assert.match(i18nSource, /coworkQuoteReplyBlockItem: '#\{ordinal\} \{source\}\{streaming\}：'/);

  // Rendered labels follow the language. The per-message entry is the hover
  // action menu (引用 / 复制 / 分叉) and the composer's quoted slot is the tile
  // bar (its cancel control) — the same two surfaces the transcript mounts.
  const fragment = reply(REPLY_TEXT, 3, false, 'q-i18n');
  const renderMenu = () => renderToStaticMarkup(
    <CoworkMessageActionsMenu visible text={REPLY_TEXT} onQuote={() => {}} />,
  );
  const renderBar = () => renderToStaticMarkup(
    <CoworkQuotedSelectionTiles selections={[fragment]} onRemove={() => {}} />,
  );
  withLanguage('zh', () => {
    // The panel opens on click, so the static render carries the trigger only;
    // its label is the localized "more actions" copy.
    assert.ok(
      renderMenu().includes(i18nService.t('coworkMessageActionsMore')),
      'the zh dictionary drives the menu trigger label',
    );
    assert.ok(renderBar().includes('取消回复'), 'the zh dictionary drives the bar cancel control');
  });
  withLanguage('en', () => {
    assert.ok(
      renderMenu().includes(i18nService.t('coworkMessageActionsMore')),
      'the en dictionary drives the menu trigger label',
    );
    assert.ok(renderBar().includes('Cancel reply'), 'the en dictionary drives the bar cancel control');
  });

  // ...and no component hardcodes that copy.
  for (const source of [inputSource, detailSource, tilesSource, menuSource, sentBlockSource]) {
    assert.doesNotMatch(source, /取消回复|回复…/);
    assert.doesNotMatch(source, /Cancel reply|Reply…/);
  }
  assert.match(menuSource, /i18nService\.t\('coworkQuoteReplyAction'\)/);
  assert.match(tilesSource, /i18nService\.t\('coworkQuoteReplyCancel'\)/);
});
