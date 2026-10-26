/**
 * Issue #22 (observability, peer review 2026-10-20): when the nightly dream
 * consolidation or the weekly long dream fails to parse the LLM output, the
 * raw text used to be discarded — five weekly parse failures could be counted
 * but never located afterwards. Every parse-failure branch now leaves ONE
 * single-line console.warn carrying the raw output's head/tail excerpt
 * (200 + 200 chars by default).
 *
 * Covers:
 *   1. formatParseFailureExcerpt unit boundaries: <200, =200, mid-window
 *      (201–400 lossless), 401, 1000, empty, null;
 *   2. escapeForSingleLine: \n \r \t, C0 controls, U+2028/U+2029 — the
 *      rendered record can never wrap the log line;
 *   3. end-to-end nightly: runNow against an always-unparseable model leaves
 *      attempt-1 and after-retry warn lines containing the head and the tail
 *      of the raw output, with the omitted middle truly absent;
 *   4. end-to-end self-identity repair: an unusable short repair reply warns
 *      with the lossless whole-raw excerpt and the run still completes
 *      (note: the repair branch is a PROSE extractor — a long garbage reply
 *      would be accepted as the identity, so the discard path is short input);
 *   5. end-to-end weekly: a weekly long dream whose output is unparseable
 *      warns with the excerpt and the run still completes (weekly failure is
 *      observability, not a run failure).
 *
 * NOTE: imports the dist-electron build — run `npx -p typescript@5 tsc
 * --project electron-tsconfig.json` first (the compile:electron script).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

const {
  PARSE_FAILURE_EXCERPT_HEAD_CHARS,
  PARSE_FAILURE_EXCERPT_TAIL_CHARS,
  escapeForSingleLine,
  formatParseFailureExcerpt,
} = require('../dist-electron/main/libs/parseFailureExcerpt.js');

function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamService } = loadDreamServiceModule();
const { DreamStore } = require('../dist-electron/main/dreamStore.js');

const DAY = '2026-08-06';
const DAY_START = new Date(2026, 7, 6).getTime();
const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

const metabotStoreStub = () => ({
  listMetabots: () => [
    { id: 5, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
  ],
});

/** Collect console.warn single lines while fn runs. */
async function captureWarns(fn) {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { lines, result: await fn() };
  } finally {
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. Unit boundaries of the excerpt helper.
// ---------------------------------------------------------------------------

test('defaults are 200 head / 200 tail', () => {
  assert.equal(PARSE_FAILURE_EXCERPT_HEAD_CHARS, 200);
  assert.equal(PARSE_FAILURE_EXCERPT_TAIL_CHARS, 200);
});

test('shorter than 200: whole string, no omission marker', () => {
  const raw = `first line\nsecond line`;
  const out = formatParseFailureExcerpt(raw);
  assert.equal(out, 'first line\\nsecond line');
  assert.ok(!out.includes('chars omitted'));
});

test('exactly 200 chars: whole string, marker-free', () => {
  const raw = 'a'.repeat(200);
  const out = formatParseFailureExcerpt(raw);
  assert.equal(out, raw);
  assert.ok(!out.includes('chars omitted'));
});

test('between 201 and 400 chars: lossless whole string (head/tail would overlap)', () => {
  const raw = `${'a'.repeat(150)}${'b'.repeat(100)}${'c'.repeat(150)}`; // 400
  assert.equal(formatParseFailureExcerpt(raw), raw);
  const raw399 = `${'a'.repeat(150)}${'b'.repeat(99)}${'c'.repeat(150)}`; // 399
  assert.equal(formatParseFailureExcerpt(raw399), raw399);
  const raw201 = 'x'.repeat(201);
  assert.equal(formatParseFailureExcerpt(raw201), raw201);
});

test('401 chars: head 200 + omitted 1 + tail 200', () => {
  const raw = `${'a'.repeat(200)}b${'c'.repeat(200)}`;
  const out = formatParseFailureExcerpt(raw);
  assert.equal(out, `${'a'.repeat(200)}…(+1 chars omitted)…${'c'.repeat(200)}`);
});

test('1000 chars: omitted count is 600', () => {
  const raw = `${'a'.repeat(200)}${'b'.repeat(600)}${'c'.repeat(200)}`;
  const out = formatParseFailureExcerpt(raw);
  assert.ok(out.startsWith('a'.repeat(200)));
  assert.ok(out.endsWith('c'.repeat(200)));
  assert.ok(out.includes('…(+600 chars omitted)…'));
  assert.ok(!out.includes('b'), 'the omitted middle must be absent');
});

test('truncation slices the RAW string, escaping happens per side', () => {
  // A newline at char 199: head keeps 200 raw chars including it, tail keeps
  // the last 200 raw chars; the escape never inflates the window.
  const raw = `${'a'.repeat(199)}\n${'b'.repeat(300)}${'c'.repeat(200)}`;
  const out = formatParseFailureExcerpt(raw); // len 700 → omitted 300
  assert.ok(out.startsWith(`${'a'.repeat(199)}\\n`));
  assert.ok(out.endsWith('c'.repeat(200)));
  assert.ok(!out.includes('b'));
  assert.ok(!out.includes('\n'), 'rendered record must stay single-line');
});

test('control characters are escaped: \\r \\t C0 and U+2028/U+2029', () => {
  const out = escapeForSingleLine('a\rb\tc\x01d\u2028e\u2029f');
  assert.equal(out, 'a\\rb\\tc\\u0001d\\u2028e\\u2029f');
  // and escaping applies inside excerpts too
  const raw = `x\r${'y'.repeat(500)}`;
  const excerpt = formatParseFailureExcerpt(raw);
  assert.ok(excerpt.startsWith('x\\r'));
  assert.ok(!/[\x00-\x1f\x7f\u2028\u2029]/.test(excerpt), 'no raw control chars survive');
});

test('empty and null inputs render as empty strings', () => {
  assert.equal(formatParseFailureExcerpt(''), '');
  assert.equal(formatParseFailureExcerpt(null), '');
  assert.equal(formatParseFailureExcerpt(undefined), '');
});

// ---------------------------------------------------------------------------
// 3. End-to-end nightly consolidation parse failure.
// ---------------------------------------------------------------------------

test('nightly dream parse failure leaves head/tail warn lines (attempt 1 + after retry)', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊交付', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['u1', session.id, 'user', '今天怎么样', '{}', DAY_START + 1000, 1],
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '挺好的', '{}', DAY_START + 2000, 2],
  );

  const headMark = 'HEADMARKER-not-json';
  const tailMark = 'TAILMARK-not-json';
  const badRaw = `${headMark}\n${'a'.repeat(180)}${'7'.repeat(600)}${'c'.repeat(200 - tailMark.length)}${tailMark}`;
  // head window = 19+1+180 = 200 raw chars; tail window = 200; omitted = 600
  assert.equal(badRaw.length, 1000);

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 7, 3, 0),
    performChat: async () => badRaw,
  });
  try {
    const { lines } = await captureWarns(async () => {
      try {
        await service.runNow(5, DAY);
      } catch {
        // a failed run may reject runNow; the warns are the subject here
      }
    });

    const attempt1 = lines.filter((line) => line.includes('attempt 1/2'));
    const afterRetry = lines.filter((line) => line.includes('unparseable after retry for metabot 5'));
    assert.ok(attempt1.length >= 1, `attempt-1 forensic warn missing; got: ${JSON.stringify(lines)}`);
    assert.ok(afterRetry.length >= 1, 'after-retry forensic warn missing');

    for (const line of [...attempt1, ...afterRetry]) {
      assert.ok(line.includes('metabot 5'), 'attribution to the metabot id');
      assert.ok(line.includes('raw output (1000 chars)'), 'raw length reported');
      assert.ok(line.includes('HEADMARKER-not-json'), 'head excerpt present');
      assert.ok(line.endsWith('TAILMARK-not-json'), 'tail excerpt present at line end');
      assert.ok(!line.includes('7'), 'omitted middle absent');
      assert.ok(line.includes('…(+600 chars omitted)…'), 'omission count present');
      assert.ok(line.includes('HEADMARKER-not-json\\na'), 'newline inside the head is escaped');
      assert.ok(!line.includes('\n'), 'the record must be a single log line');
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. End-to-end self-identity repair parse failure (nit-E closure).
// ---------------------------------------------------------------------------

test('self-identity repair failure keeps the repair-output excerpt and still completes', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const session = coworkStore.createSession('聊身份', '/tmp/a', '', 'local', [], 5);
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['u1', session.id, 'user', '今天怎么样', '{}', DAY_START + 1000, 1],
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['a1', session.id, 'assistant', '挺好的', '{}', DAY_START + 2000, 2],
  );

  const shortIdentityDaily = JSON.stringify({
    daily_summary: '今天很充实。',
    sections: {},
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: '我是小火。',
    capability_learnings: [],
  });
  // The repair call is a PROSE extractor, not a JSON parser: long garbage
  // (>=200 non-whitespace chars) would be ACCEPTED as the new identity. The
  // discarded-raw path is the short/unusable reply — exactly the case where
  // the forensic excerpt matters (<200 chars: whole-string rendering).
  const badRepair = `修复失败\n${'x'.repeat(30)}`;
  assert.equal(badRepair.length, 35);

  let call = 0;
  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 7, 3, 0),
    // call 1: nightly dream parses but self_identity is below the minimum;
    // call 2: the targeted repair call returns an unusable short reply.
    performChat: async () => {
      call += 1;
      return call === 1 ? shortIdentityDaily : badRepair;
    },
  });
  try {
    const { lines } = await captureWarns(async () => {
      await service.runNow(5, DAY);
    });

    const repairWarn = lines.filter((line) => line.includes('self_identity still below minimum'));
    assert.ok(repairWarn.length >= 1, `repair forensic warn missing; got: ${JSON.stringify(lines)}`);
    const line = repairWarn[0];
    assert.ok(line.includes('metabot 5'));
    assert.ok(line.includes('repair output (35 chars)'));
    assert.ok(line.includes('修复失败\\nx'), 'whole short raw kept with the newline escaped');
    assert.ok(!line.includes('chars omitted'), 'short raw rendered losslessly, no omission marker');
    assert.ok(!line.includes('\n'), 'the record must be a single log line');

    // Best-effort semantics unchanged: the run completes with the short identity.
    const run = dreamStore.getRun(5, DAY);
    assert.ok(run, 'run recorded');
    assert.equal(run.status, 'completed', `run status: ${run.status}`);
  } finally {
    cleanup();
  }
});


// ---------------------------------------------------------------------------
// 5. End-to-end weekly long dream parse failure.
// ---------------------------------------------------------------------------

test('weekly long dream parse failure warns with excerpt and the run still completes', async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  // Previous ISO week of 2026-08-10 (Mon): 08-03 .. 08-09. Seed 3 daily
  // summaries (WEEKLY_DREAM_MIN_DAYS = 3) so the weekly long dream triggers.
  for (const date of ['2026-08-04', '2026-08-05', '2026-08-06']) {
    dreamStore.upsertDailySummary({
      metabotId: 5,
      summaryDate: date,
      summaryText: `${date} 的日常总结。`,
      sections: {},
      stats: {},
      llmId: 'stub',
    });
  }

  const goodDaily = JSON.stringify({
    daily_summary: '今天很充实。',
    sections: {},
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: LONG_IDENTITY,
    capability_learnings: [],
  });
  const headMark = 'WEEKLY-HEAD-bad';
  const tailMark = 'WEEKLY-TAIL';
  const badWeekly = `${headMark}\n${'a'.repeat(200 - headMark.length - 1)}${'7'.repeat(600)}${'c'.repeat(200 - tailMark.length)}${tailMark}`;
  assert.equal(badWeekly.length, 1000);

  const service = new DreamService({
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    llmTimeoutMs: 5000,
    now: () => new Date(2026, 7, 11, 3, 0),
    performChat: async (systemPrompt) => {
      return String(systemPrompt).includes('每周长梦') ? badWeekly : goodDaily;
    },
  });
  try {
    const { lines } = await captureWarns(async () => {
      await service.runNow(5, '2026-08-10');
    });

    const weeklyWarn = lines.filter((line) => line.includes('Weekly long dream parse failed'));
    assert.ok(weeklyWarn.length >= 1, `weekly forensic warn missing; got: ${JSON.stringify(lines)}`);
    const line = weeklyWarn[0];
    assert.ok(line.includes('metabot 5'));
    assert.ok(line.includes('raw output (1000 chars)'));
    assert.ok(line.includes('WEEKLY-HEAD-bad'), 'head excerpt present');
    assert.ok(line.endsWith('WEEKLY-TAIL'), 'tail excerpt present at line end');
    assert.ok(!line.includes('7'), 'omitted middle absent');
    assert.ok(line.includes('…(+600 chars omitted)…'), 'omission count present');
    assert.ok(!line.includes('\n'), 'the record must be a single log line');

    // Weekly parse failure is observability, not a run failure: the run
    // must complete and no weekly summary may be stored.
    const run = dreamStore.getRun(5, '2026-08-10');
    assert.ok(run, 'run recorded');
    assert.equal(run.status, 'completed', `run status: ${run.status}`);
    assert.ok(!dreamStore.getWeeklySummary(5, '2026-08-03'), 'no weekly summary stored');
  } finally {
    cleanup();
  }
});
