import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SIMPLELOG_PATH,
  SIMPLELOG_CONTENT_MAX_BYTES,
  buildSimpleLogPayload,
  validateSimpleLogPayload,
  isSimpleLogRecord,
  normalizeChainUriToken,
  parseSimpleLogPayloadText,
  simpleLogTaskAnchor,
} = require('../dist-electron/main/libs/simpleLogProtocol.js');

const PIN_A = '5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0';
const PIN_B = 'ed64f554ecb95e22a267a6314bd30ca3c0bac33f389e746ad5cbe04ceeda033ci0';
const TASKID = 'b0eb2dd4203bec74a641fa4b09f7370bf88504f83467f78ea5c40ff7aa1cd92di0';

// ---------------------------------------------------------------------------
// Writer contract — legal samples (the protocol's mandatory fields)
// ---------------------------------------------------------------------------

test('simplelog build: minimal legal record (taskkey anchor) keeps only asserted fields', () => {
  const built = buildSimpleLogPayload({
    kind: 'status',
    summary: '第一棒完成：写入工具与台账提取器已落地',
    taskkey: 'local:184',
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.deepEqual(built.payload, {
    v: 1,
    kind: 'status',
    summary: '第一棒完成：写入工具与台账提取器已落地',
    taskkey: 'local:184',
  });
  assert.equal(built.warnings.length, 0);
});

test('simplelog build: full legal record (taskid + deliverables + refs + envelope)', () => {
  const built = buildSimpleLogPayload({
    kind: 'handoff',
    summary: '第二棒交接：时间线 MetaApp 开工',
    taskid: TASKID,
    step: '第二棒',
    status: 'executing',
    role: 'worker',
    toid: 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
    deliverables: [`pin://${PIN_A}`, `metaapp://${PIN_B}`],
    refs: [`pin://${PIN_B}`],
    content: '细节见 refs。',
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.equal(built.payload.v, 1);
  assert.equal(built.payload.taskid, TASKID);
  assert.deepEqual(built.payload.deliverables, [`pin://${PIN_A}`, `metaapp://${PIN_B}`]);
  assert.deepEqual(built.payload.refs, [`pin://${PIN_B}`]);
  assert.equal(built.payload.toid, 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz');
});

test('simplelog build: a correction requires refs and keeps the 更正: prefix', () => {
  const built = buildSimpleLogPayload({
    kind: 'status',
    summary: `更正：上一条的 taskid 抄错一位`,
    taskkey: 'local:184',
    refs: [`pin://${PIN_A}`],
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.match(built.payload.summary, /^更正：/);
});

test('simplelog build: markdown-wrapped deliverables are normalized to the bare URI (writer side)', () => {
  const built = buildSimpleLogPayload({
    kind: 'review',
    summary: '复核通过',
    taskkey: 'local:184',
    deliverables: [`[pin://${PIN_A}](pin://${PIN_A})`, `\`metaapp://${PIN_B}\``],
  });
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.deepEqual(built.payload.deliverables, [`pin://${PIN_A}`, `metaapp://${PIN_B}`]);
});

// ---------------------------------------------------------------------------
// Writer contract — rejected samples (nothing reaches the chain)
// ---------------------------------------------------------------------------

test('simplelog build: no taskid and no taskkey is rejected (record must be anchored)', () => {
  const built = buildSimpleLogPayload({ kind: 'status', summary: '无锚点记录' });
  assert.equal(built.ok, false);
  assert.match(built.errors.join('\n'), /taskid or taskkey is required/);
});

test('simplelog build: truncated deliverable URI is rejected', () => {
  const built = buildSimpleLogPayload({
    kind: 'status',
    summary: '交付一条被缩略的 URI',
    taskkey: 'local:184',
    deliverables: [`pin://${PIN_A.slice(0, 20)}…${PIN_A.slice(-4)}`],
  });
  assert.equal(built.ok, false);
  assert.match(built.errors.join('\n'), /truncated URI/);
});

test('simplelog build: content over the 4 KiB budget is rejected with the metafile route', () => {
  const built = buildSimpleLogPayload({
    kind: 'note',
    summary: '超预算正文',
    taskkey: 'local:184',
    content: 'x'.repeat(SIMPLELOG_CONTENT_MAX_BYTES + 1),
  });
  assert.equal(built.ok, false);
  assert.match(built.errors.join('\n'), /metafile/);
});

test('simplelog build: unknown kind, scheme-carrying taskid and Web2 deliverables are all rejected', () => {
  const badKind = buildSimpleLogPayload({ kind: 'progress', summary: 'x', taskkey: 'local:184' });
  assert.equal(badKind.ok, false);
  assert.match(badKind.errors.join('\n'), /not a SimpleLog kind/);

  const schemeTaskid = buildSimpleLogPayload({
    kind: 'status',
    summary: 'x',
    taskid: `pin://${TASKID}`,
  });
  assert.equal(schemeTaskid.ok, false);
  assert.match(schemeTaskid.errors.join('\n'), /BARE task pinid/);

  const web2 = buildSimpleLogPayload({
    kind: 'status',
    summary: 'x',
    taskkey: 'local:184',
    refs: [`https://openagentinternet.org/browser/metaapp/${PIN_A}`],
  });
  assert.equal(web2.ok, false);
  assert.match(web2.errors.join('\n'), /Web2 URL/);
});

test('simplelog build: a correction without refs, a bad toid and an oversized summary are rejected', () => {
  const noRefs = buildSimpleLogPayload({ kind: 'status', summary: '更正：上条作废', taskkey: 'local:184' });
  assert.equal(noRefs.ok, false);
  assert.match(noRefs.errors.join('\n'), /refs pointing at the entry it corrects/);

  const badToid = buildSimpleLogPayload({
    kind: 'handoff',
    summary: 'x',
    taskkey: 'local:184',
    toid: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
  });
  assert.equal(badToid.ok, false);
  assert.match(badToid.errors.join('\n'), /toid must be/);

  const longSummary = buildSimpleLogPayload({
    kind: 'status',
    summary: 'a'.repeat(201),
    taskkey: 'local:184',
  });
  assert.equal(longSummary.ok, false);
  assert.match(longSummary.errors.join('\n'), /caps it at 200/);
});

// ---------------------------------------------------------------------------
// URI discipline (shared by writer and ledger reader)
// ---------------------------------------------------------------------------

test('normalizeChainUriToken unwraps markdown/backtick/bracket dressing to the TARGET', () => {
  assert.deepEqual(normalizeChainUriToken(`pin://${PIN_A}`), { uri: `pin://${PIN_A}`, reason: null });
  assert.deepEqual(
    normalizeChainUriToken(`[查看](pin://${PIN_A})`),
    { uri: `pin://${PIN_A}`, reason: null },
  );
  assert.deepEqual(
    normalizeChainUriToken(`\`metafile://${PIN_A}.zip\``),
    { uri: `metafile://${PIN_A}.zip`, reason: null },
  );
  assert.deepEqual(
    normalizeChainUriToken(`<metaapp://${PIN_B}>`),
    { uri: `metaapp://${PIN_B}`, reason: null },
  );
  // Uppercase hex is the same object, never a second identity.
  assert.equal(normalizeChainUriToken(`pin://${PIN_A.toUpperCase()}`).uri, `pin://${PIN_A}`);
});

test('normalizeChainUriToken rejects what dressing cannot rescue', () => {
  // Truncated target behind a clean label.
  const dirty = normalizeChainUriToken(`[pin://${PIN_A}](pin://${PIN_A.slice(0, 20)}…)`);
  assert.equal(dirty.uri, null);
  assert.match(dirty.reason, /truncated/);
  assert.equal(normalizeChainUriToken(`pin://${TASKID.slice(0, 40)}`).uri, null);
  assert.match(normalizeChainUriToken('<pin://placeholder>').reason, /placeholder|not a complete/);
  assert.match(normalizeChainUriToken('https://example.com/a').reason, /Web2/);
  assert.match(normalizeChainUriToken(42).reason, /not a string/);
});

// ---------------------------------------------------------------------------
// Reader contract
// ---------------------------------------------------------------------------

test('validateSimpleLogPayload is tolerant on values but strict on the task anchor', () => {
  assert.equal(validateSimpleLogPayload({ v: 1, kind: 'weird-kind', summary: 's', taskkey: 'local:1' }).ok, true);
  assert.equal(isSimpleLogRecord({ v: 1, kind: 'status', summary: 's' }), false);
  assert.equal(isSimpleLogRecord({ v: 2, kind: 'status', summary: 's', taskkey: 'local:1' }), false);
  assert.equal(isSimpleLogRecord({ v: 1, kind: 'status', summary: 's', taskkey: 'local:1' }), true);
});

test('parseSimpleLogPayloadText finds the record in prose, ignores fenced quotes', () => {
  const record = { v: 1, kind: 'close', summary: '任务收口', taskkey: 'local:184' };
  const message = `收口如下：\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n\n没有其他内容`;
  assert.equal(parseSimpleLogPayloadText(message), null, 'a fenced record example is documentation');
  assert.deepEqual(
    parseSimpleLogPayloadText(`正文前置 ${JSON.stringify(record)} 正文后置`),
    record,
  );
  assert.deepEqual(
    parseSimpleLogPayloadText(JSON.stringify({ ...record, content: '含 } 大括号的正文' })),
    { ...record, content: '含 } 大括号的正文' },
  );
  assert.equal(parseSimpleLogPayloadText('没有记录的纯文本'), null);
  assert.equal(simpleLogTaskAnchor(record), 'local:184');
  assert.equal(SIMPLELOG_PATH, '/protocols/simplelog');
});
