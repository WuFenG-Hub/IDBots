// Feedback-desert nudge decision logic (dream review P2-2, global one-shot
// redesign 2026-10-23). Component-level test following the repo harness: the
// pure helper is imported directly, and the wiring is asserted against the
// component sources.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEEDBACK_NUDGE_DONE_KEY,
  FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES,
  shouldShowFeedbackNudge,
  readFeedbackNudgeDone,
  writeFeedbackNudgeDone,
} from '../src/renderer/components/cowork/feedbackNudge.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detailSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
  'utf8',
);
const hintSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'FeedbackNudgeHint.tsx'),
  'utf8',
);
const i18nSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
  'utf8',
);

function makeStorage(initial = new Map<string, string>()) {
  const memory = initial;
  return {
    get length() { return memory.size; },
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    key: (index: number) => [...memory.keys()][index] ?? null,
    dump: memory,
  };
}

test('hidden below the assistant-message threshold', () => {
  for (const count of [0, 1, 4, FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES - 1]) {
    assert.equal(
      shouldShowFeedbackNudge({ assistantMessageCount: count, sessionFeedbackCount: 0, done: false }),
      false,
      `${count} assistant messages → hidden`,
    );
  }
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES, sessionFeedbackCount: 0, done: false }),
    true,
    'at the threshold → shown',
  );
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 12, sessionFeedbackCount: 0, done: false }),
    true,
  );
});

test('any feedback in the session kills it', () => {
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 9, sessionFeedbackCount: 1, done: false }),
    false,
    'one thumb anywhere in the session suppresses the nudge',
  );
});

test('the one-shot is global: consumed once, hidden everywhere', () => {
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 9, sessionFeedbackCount: 0, done: true }),
    false,
    'done suppresses the nudge regardless of the session',
  );
});

test('one-shot persistence is a single global key, storage-failure safe, and clears legacy keys', () => {
  const storage = makeStorage();
  assert.equal(readFeedbackNudgeDone(storage), false);
  writeFeedbackNudgeDone(storage);
  assert.equal(readFeedbackNudgeDone(storage), true, 'consumed once stays consumed');
  assert.equal(storage.dump.get(FEEDBACK_NUDGE_DONE_KEY), '1');
  assert.equal(FEEDBACK_NUDGE_DONE_KEY.includes(':'), true);

  const legacy = makeStorage(new Map([
    ['cowork:feedback-nudge-dismissed:s1', '1'],
    ['cowork:feedback-nudge-dismissed:s2', '1'],
    ['cowork:other-key', '1'],
  ]));
  writeFeedbackNudgeDone(legacy);
  assert.equal(legacy.dump.has('cowork:feedback-nudge-dismissed:s1'), false, 'legacy per-session keys cleared');
  assert.equal(legacy.dump.has('cowork:feedback-nudge-dismissed:s2'), false);
  assert.equal(legacy.dump.get('cowork:other-key'), '1', 'unrelated keys untouched');

  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(readFeedbackNudgeDone(broken), false, 'storage failures fail open');
  assert.doesNotThrow(() => writeFeedbackNudgeDone(broken as never));
});

test('the hint renders near the message controls, never as a popup, and consumes the one-shot on display', () => {
  assert.ok(detailSource.includes('import FeedbackNudgeHint'), 'session detail mounts the hint');
  assert.ok(detailSource.includes('<FeedbackNudgeHint'), 'rendered with the live session');
  assert.ok(
    detailSource.includes('key={`feedback-nudge-${currentSession.id}`}'),
    'keyed by session id so the lazy storage read re-runs on switch',
  );
  const mountBlock = detailSource.slice(
    detailSource.indexOf('<FeedbackNudgeHint'),
    detailSource.indexOf('<FeedbackNudgeHint') + 600,
  );
  assert.ok(!mountBlock.includes('sessionId'), 'the nudge mount passes no session id (global one-shot)');
  // Strip comments before the popup-pattern scan (the doc comment itself
  // mentions what the hint must NOT be).
  const hintCode = hintSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/alert\(|\btoast\b|\bmodal\b|position:\s*fixed|className="[^"]*\bfixed\b/.test(hintCode), 'no popup/toast/overlay pattern in the hint');
  assert.ok(hintSource.includes('data-feedback-nudge'), 'a stable hook for future UI tests');
  assert.ok(hintSource.includes("i18nService.t('coworkFeedbackNudge')"), 'copy goes through i18n');
  assert.ok(hintSource.includes('feedbackLoaded: boolean;'), 'the loaded gate is a declared prop (review Minor 5)');
  assert.ok(!hintSource.includes('sessionId'), 'the hint takes no session id (global one-shot)');
  assert.ok(
    hintSource.includes('useEffect') && hintSource.includes('if (visible) writeFeedbackNudgeDone'),
    'displaying the hint consumes the global one-shot',
  );
  assert.ok(hintSource.includes('aria-label={i18nService.t(\'close\')}'), 'the dismiss button has an aria-label');
});

test('i18n carries the hint copy in both languages', () => {
  const zh = /coworkFeedbackNudge: '给回复点个赞或踩[^']*',/.test(i18nSource);
  const en = /coworkFeedbackNudge: 'Rate a reply — your bot reviews feedback every night and adjusts\.?',/.test(i18nSource);
  assert.ok(zh, 'Chinese copy present');
  assert.ok(en, 'English copy present (English is the default)');
});
