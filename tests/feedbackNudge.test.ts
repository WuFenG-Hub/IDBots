// Feedback-desert nudge decision logic (dream review P2-2). Component-level
// test following the repo harness: the pure helper is imported directly, and
// the wiring is asserted against the component sources.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES,
  shouldShowFeedbackNudge,
  feedbackNudgeDismissKey,
  readFeedbackNudgeDismissed,
  writeFeedbackNudgeDismissed,
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

test('hidden below the assistant-message threshold', () => {
  for (const count of [0, 1, 4, FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES - 1]) {
    assert.equal(
      shouldShowFeedbackNudge({ assistantMessageCount: count, sessionFeedbackCount: 0, dismissed: false }),
      false,
      `${count} assistant messages → hidden`,
    );
  }
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: FEEDBACK_NUDGE_MIN_ASSISTANT_MESSAGES, sessionFeedbackCount: 0, dismissed: false }),
    true,
    'at the threshold → shown',
  );
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 12, sessionFeedbackCount: 0, dismissed: false }),
    true,
  );
});

test('any feedback in the session kills it forever', () => {
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 9, sessionFeedbackCount: 1, dismissed: false }),
    false,
    'one thumb anywhere in the session suppresses the nudge',
  );
});

test('a per-session dismissal suppresses it', () => {
  assert.equal(
    shouldShowFeedbackNudge({ assistantMessageCount: 9, sessionFeedbackCount: 0, dismissed: true }),
    false,
  );
});

test('dismissal persistence is per-session and storage-failure safe', () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
  };
  assert.equal(readFeedbackNudgeDismissed(storage, 's1'), false);
  writeFeedbackNudgeDismissed(storage, 's1');
  assert.equal(readFeedbackNudgeDismissed(storage, 's1'), true, 'dismissed session stays dismissed');
  assert.equal(readFeedbackNudgeDismissed(storage, 's2'), false, 'other sessions unaffected');
  assert.equal(feedbackNudgeDismissKey('s1'), 'cowork:feedback-nudge-dismissed:s1');

  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(readFeedbackNudgeDismissed(broken, 's1'), false, 'storage failures fail open');
  assert.doesNotThrow(() => writeFeedbackNudgeDismissed(broken, 's1'));
});

test('the hint renders near the message controls and never as a popup', () => {
  assert.ok(detailSource.includes('import FeedbackNudgeHint'), 'session detail mounts the hint');
  assert.ok(detailSource.includes('<FeedbackNudgeHint'), 'rendered with the live session');
  assert.ok(detailSource.includes('sessionId={currentSession.id}'), 'scoped to the current session');
  // Strip comments before the popup-pattern scan (the doc comment itself
  // mentions what the hint must NOT be).
  const hintCode = hintSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/alert\(|\btoast\b|\bmodal\b|position:\s*fixed|className="[^"]*\bfixed\b/.test(hintCode), 'no popup/toast/overlay pattern in the hint');
  assert.ok(hintSource.includes('data-feedback-nudge'), 'a stable hook for future UI tests');
  assert.ok(hintSource.includes("i18nService.t('coworkFeedbackNudge')"), 'copy goes through i18n');
});

test('i18n carries the hint copy in both languages', () => {
  const zh = /coworkFeedbackNudge: '给回复点个赞或踩[^']*',/.test(i18nSource);
  const en = /coworkFeedbackNudge: 'Rate a reply — your bot reviews feedback every night and adjusts\.?',/.test(i18nSource);
  assert.ok(zh, 'Chinese copy present');
  assert.ok(en, 'English copy present (English is the default)');
});
