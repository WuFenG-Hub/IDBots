import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseDeliverableLines,
  isTextDeliverable,
} = require('../dist-electron/main/services/groupTaskDeliverableParser.js');

// ---------------------------------------------------------------------------
// Round-4 regression set built from the REAL task #5 / #6 / #7 group messages
// (content abridged only in the prose between tag lines; tag lines verbatim).
// ---------------------------------------------------------------------------

const PIN_A = '5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0';
const PIN_B = 'ed64f554ecb95e22a267a6314bd30ca3c0bac33f389e746ad5cbe04ceeda033ci0';
const PIN_C = '1e3847c20c028f4b4f72ae54e1c2e6bec757bb7898492c65ed9e6ea077b9262bi0';

const valid = (candidate) => assert.equal(candidate.valid, true, candidate.note);
const invalid = (candidate) => assert.equal(candidate.valid, false, candidate.note);
const only = (candidate) => {
  assert.equal(candidate.uri, null, candidate.uri);
  return candidate;
};

test('#7 msg94 (Builder/阿码): two [DELIVERABLE] tag lines → TWO rows, real URIs kept, no trailing markdown', () => {
  const content = [
    '③ 完成。全链路证据如下：',
    '',
    `**[DELIVERABLE] metaapp: metaapp://${PIN_A}**`,
    `**[DELIVERABLE] 分享链接: https://openagentinternet.org/browser/metaapp/${PIN_A}**`,
    '',
    '**③ 制作与发布 — 完成报告（Builder / 阿码）**',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    kind: 'metaapp',
    uri: `metaapp://${PIN_A}`,
    valid: true,
    note: null,
  });
  assert.deepEqual(parsed[1], {
    kind: 'url',
    uri: `https://openagentinternet.org/browser/metaapp/${PIN_A}`,
    valid: true,
    note: null,
  });
});

test('#7 msg97 (Lucy): buzz url with （pinid: …） annotation + bare pinid line → url + pinid rows', () => {
  const content = [
    '④ 推广完成，全部链上核验通过。汇报：',
    '',
    '**④ 推广完成报告（Lucy）**',
    '',
    `**[DELIVERABLE] buzz: https://openagentinternet.org/browser/buzz/${PIN_B}（pinid: ed64f554...033ci0）**`,
    `**[DELIVERABLE] 群聊推广消息: pinid ${PIN_C}（SimpleGroupChat，Lucy 本人署名）**`,
    '',
    '**① Buzz**（`/protocols/simplebuzz`，MVC，1186 sat）：',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    kind: 'url',
    uri: `https://openagentinternet.org/browser/buzz/${PIN_B}`,
    valid: true,
    note: null,
  });
  assert.deepEqual(parsed[1], {
    kind: 'pinid',
    uri: PIN_C,
    valid: true,
    note: null,
  });
});

test('#7 msg99 (Lucy correction): corrected preview link with （实测 HTTP 200） annotation → clean url', () => {
  const content = [
    '链接修正完成。向群内发出更正（我此前的 buzz 交付链接为无效路由，须如实修正）：',
    '',
    `**[DELIVERABLE] buzz 正确预览链接: https://openagentinternet.org/browser/pin/${PIN_B}（实测 HTTP 200）**`,
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].kind, 'url');
  assert.equal(parsed[0].uri, `https://openagentinternet.org/browser/pin/${PIN_B}`);
});

test('#7 msg90 (AI_小新): tag line without any URI → valid text deliverable (uri null)', () => {
  const content = [
    '收到，避坑点补充（社区运营一线视角）即刻交付：',
    '',
    '**[DELIVERABLE] 避坑指南补充点（AI_小新）**',
    '',
    '以下 6 条并入避坑指南，供 **@Lucy** 合并进文案：',
    '1. **封面与 Icon 必填**——没有封面/Icon 的 MetaApp…',
    '5. **发布后先自验 pinid 再交付**——自己先点开 `metaapp://<pinid>` 确认可打开，再对外交付；绝不交付占位符或未经核验的 pinid。',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
  assert.equal(isTextDeliverable(parsed[0]), true);
  // The body `metaapp://<pinid>` placeholder example must NOT leak into the parse.
  assert.equal(parsed.some((c) => c.uri !== null), false);
});

test('#7 msg92 (Lucy): tag line without URI + body table of pinids/metafile URIs → text row only, body never scanned', () => {
  const content = [
    '**[DELIVERABLE] ① 文案 + 配图（已完成，可交付 Builder 组装）**',
    '',
    '**配图 4 张（AI 生成，说明书/漫画风格，已目验内容）**',
    '| 图 | 内容 | pinid | metafile URI |',
    '| 封面 | 30 秒上链·竖版书封 | `ba3f809414b5b73110aeb15b860eb51ced46f3f0613da3027e77a36cf28e9d54i0` | `metafile://...d54i0.png` |',
    '| 步骤 | 七步制作流程·横版图解 | `fe91474cb271569177c5bfa85841ada82cfb13f5491f4a527638f7fe0555764fi0` | `metafile://...64fi0.png` |',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
});

test('#5 planning-turn placeholder samples: metaapp://<pinId> / metaapp://[PINID] / scheme-only / truncated → INVALID', () => {
  const cases = [
    '**[DELIVERABLE] 门户 MetaApp 页面：`metaapp://<pinId>`，并确认预览可打开（验收标准）**',
    '**[DELIVERABLE] 分享 metaapp://[PINID]**',
    '**[DELIVERABLE] metaapp: metaapp://`',
    '**[DELIVERABLE] metaapp: metaapp://cbe80568df8cd4956438d96a3420182b247007490423e63053**',
  ];
  for (const line of cases) {
    const parsed = parseDeliverableLines(line);
    assert.equal(parsed.length, 1, `expected one candidate for: ${line.slice(0, 60)}`);
    invalid(parsed[0]);
    assert.equal(parsed[0].uri, null);
  }
});

test('#6 truncated metafile URI with ellipsis + full-width parens → INVALID (never recorded)', () => {
  const content = '**[DELIVERABLE] ④ metaapp: metafile://…zip（50KB，5 文件）**';
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  invalid(parsed[0]);
  assert.equal(parsed[0].uri, null);
});

test('#6 style: tag line without URI but body contains metaapp/ dir path → text, NOT kind=metaapp', () => {
  const content = [
    '**[DELIVERABLE] ② 门户 MetaApp 页面（已开发+本地验收通过）**',
    '',
    '页面位于 `metaapp/` 目录下，index.html 见附件。',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
});

test('one line with TWO [DELIVERABLE] tags → two candidates', () => {
  const content = `任务完成：**[DELIVERABLE] metaapp: metaapp://${PIN_A}** 与 **[DELIVERABLE] 分享: https://openagentinternet.org/browser/metaapp/${PIN_A}**`;
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, 'metaapp');
  assert.equal(parsed[0].uri, `metaapp://${PIN_A}`);
  assert.equal(parsed[1].kind, 'url');
  assert.equal(parsed[1].uri, `https://openagentinternet.org/browser/metaapp/${PIN_A}`);
});

test('valid and invalid tag lines in the same message: invalid ones filtered, valid ones kept', () => {
  const content = [
    '**[DELIVERABLE] 示例占位：metaapp://<pinId>（此行为规划示例，勿入库）**',
    '',
    `**[DELIVERABLE] metaapp: metaapp://${PIN_A}**`,
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 2);
  invalid(parsed[0]);
  valid(parsed[1]);
  assert.equal(parsed[1].kind, 'metaapp');
});

test('no [DELIVERABLE] tag at all → empty result even with URIs in the body', () => {
  const content = '正文提到 metaapp://5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0 与 https://example.com/x 但没有标签';
  assert.deepEqual(parseDeliverableLines(content), []);
});

test('http URL with trailing punctuation and markdown is cleaned, scheme preserved', () => {
  const parsed = parseDeliverableLines(
    `**[DELIVERABLE] 文档: http://example.com/docs/guide.md。**`,
  );
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].kind, 'url');
  assert.equal(parsed[0].uri, 'http://example.com/docs/guide.md');
});

test('mixed junk candidate never degrades siblings: text + placeholder + pinid', () => {
  const content = [
    '**[DELIVERABLE] ① 文案（已完成）**',
    '**[DELIVERABLE] 示例 metaapp://[PINID]**',
    `**[DELIVERABLE] 群聊推广: pinid ${PIN_C}**`,
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].valid, true);
  assert.equal(parsed[1].valid, false);
  assert.deepEqual(parsed[2], { kind: 'pinid', uri: PIN_C, valid: true, note: null });
});

test('uppercase pinid token is normalized to lowercase', () => {
  const upper = '5345DCDCD40CA628113DE5ED18087DF16667021D5246437D4F927E4C17C72525I0';
  const parsed = parseDeliverableLines(`**[DELIVERABLE] metaapp: metaapp://${upper}**`);
  assert.equal(parsed.length, 1);
  valid(parsed[0]);
  assert.equal(parsed[0].uri, `metaapp://${PIN_A}`);
});

// ---------------------------------------------------------------------------
// P0-1: structured field-level validation (warn-and-deliver)
// ---------------------------------------------------------------------------

test('P0-1: invalid pinid (truncated) surfaces as a field-level pinid error', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const result = validateDeliverableLines(
    '**[DELIVERABLE] metaapp: metaapp://1e3847c20c028f4b4f72ae54e1c2e6bec757bb7898492c65ed9e6ea077b9262b**',
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, 'pinid');
  assert.equal(result.warnings.length, 0);
});

test('P0-1: buzz pinid wrapped in metaapp:// gets a non-blocking buzz-link warning', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const result = validateDeliverableLines(
    `**[DELIVERABLE] buzz 交付: metaapp://${PIN_B}**`,
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].field, 'pinid');
  assert.match(result.warnings[0].message, /buzz link/);
});

test('P0-1: valid URL has no errors/warnings; malformed URL (ellipsis) errors on url field', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const ok = validateDeliverableLines('**[DELIVERABLE] url: https://example.com/preview**');
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.candidates[0].valid, true);

  const bad = validateDeliverableLines('**[DELIVERABLE] url: https://**');
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].field, 'url');
});

test('P0-1: plain text deliverable + valid sibling → no errors, no false positives', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const result = validateDeliverableLines(
    [
      '**[DELIVERABLE] ① 文案（已完成）**',
      `**[DELIVERABLE] 群聊推广: pinid ${PIN_C}**`,
    ].join('\n'),
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// P0-3: [WORKING] ACK / [STANDBY] marker parsing
// ---------------------------------------------------------------------------

test('P0-3: parseWorkingAck extracts subtask + estimated minutes; no tag → null', () => {
  const { parseWorkingAck, hasStandbyMarker } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const ack = parseWorkingAck('[WORKING] 已接单：build metaapp，预计 15 分钟');
  assert.equal(ack.acknowledged, true);
  assert.match(ack.taskDescription, /build metaapp/);
  assert.equal(ack.estimatedMinutes, 15);

  const english = parseWorkingAck('[WORKING] accepted: task X, ~10 min');
  assert.equal(english.estimatedMinutes, 10);

  assert.equal(parseWorkingAck('no marker here'), null);
  assert.equal(hasStandbyMarker('[STANDBY] 静默观察'), true);
  assert.equal(hasStandbyMarker('nothing'), false);
});

// ---------------------------------------------------------------------------
// P0-8: integrity declarations
// ---------------------------------------------------------------------------

test('P0-8: isIntegrityDeclaration recognizes honest correction language', () => {
  const { isIntegrityDeclaration } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  assert.equal(isIntegrityDeclaration('更正：我此前的链接无效，正确预览如下'), true);
  assert.equal(isIntegrityDeclaration('如实说明：该 pinid 未发布成功'), true);
  assert.equal(isIntegrityDeclaration('普通消息没有任何关键词'), false);
});

// ---------------------------------------------------------------------------
// Ledger fix (#14→#16): local-file path extraction + segment alignment
// ---------------------------------------------------------------------------

test('ledger fix: parseDeliverableSegments aligns 1:1 with parseDeliverableLines', () => {
  const { parseDeliverableLines, parseDeliverableSegments } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const content = [
    '① 完成。',
    `**[DELIVERABLE] metaapp: metaapp://${PIN_A}**`,
    `**[DELIVERABLE] 视觉规范文档：\`/Users/tusm/work/spec.md\`（含参数表）**`,
    `**[DELIVERABLE] 架构文档**`,
    '',
  ].join('\n');
  const candidates = parseDeliverableLines(content);
  const segments = parseDeliverableSegments(content);
  assert.equal(candidates.length, 3);
  assert.equal(segments.length, 3);
  assert.match(segments[0], /metaapp:\/\/[0-9a-f]{64}i0/);
  assert.match(segments[1], /spec\.md/);
  assert.match(segments[2], /架构文档/);
  // A message without the tag yields empty segments.
  assert.deepEqual(parseDeliverableSegments('no tag here'), []);
});

test('ledger fix: extractLocalFilePaths returns absolute/~ paths, skips schemes and prose', () => {
  const { extractLocalFilePaths } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  // Absolute path in backticks with a full-width-paren annotation.
  assert.deepEqual(
    extractLocalFilePaths('视觉规范文档：`/Users/tusm/work/电影化视觉规范-v1.md`（含 §7 参数速查表）'),
    ['/Users/tusm/work/电影化视觉规范-v1.md'],
  );
  // Home-relative path.
  assert.deepEqual(extractLocalFilePaths('数据源：~/projects/film-data.js'), ['~/projects/film-data.js']);
  // On-chain schemes and protocol routes are never local files.
  assert.deepEqual(extractLocalFilePaths(`metaapp://${PIN_A} 与 /protocols/simplebuzz 与 https://a.b/c`), []);
  // A bare filename is not a path.
  assert.deepEqual(extractLocalFilePaths('文件：index.html'), []);
  // Multiple distinct paths, deduped, punctuation trimmed.
  const multi = extractLocalFilePaths('`/a/b/f1.md` 与 `/a/b/f2.md`，以及 /a/b/f1.md');
  assert.deepEqual(multi, ['/a/b/f1.md', '/a/b/f2.md']);
});
