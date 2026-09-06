import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseDeliverableLines,
  parseDeliverableSegments,
  isTextDeliverable,
  hasDeliverableTagLine,
  extractPinidToken,
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

test('#7 msg92 (Lucy): tag line without URI + body table of TRUNCATED pinids/metafile URIs → text row only, junk body never mints rows', () => {
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

test('one line with TWO mid-line [DELIVERABLE] tags is prose, never candidates (round 6)', () => {
  // Round-4 fixture shape (task #7): both tags sit MID-LINE behind prose.
  // Round 6: the tag must LEAD the line — a mention after other words is a
  // citation; such a line records nothing. Tag-led lines (one artifact per
  // line) are the taught standard.
  const content = `任务完成：**[DELIVERABLE] metaapp: metaapp://${PIN_A}** 与 **[DELIVERABLE] 分享: https://openagentinternet.org/browser/metaapp/${PIN_A}**`;
  assert.deepEqual(parseDeliverableLines(content), []);
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

test('P0-1: buzz pinid wrapped in metaapp:// gets a non-blocking pin:// warning', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const result = validateDeliverableLines(
    `**[DELIVERABLE] buzz 交付: metaapp://${PIN_B}**`,
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].field, 'pinid');
  assert.match(result.warnings[0].message, /pin:\/\/<pinid>/);
});

test('pin:// deliverable lines record the scheme uri as a valid pinid candidate without warnings', () => {
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const result = validateDeliverableLines(
    `**[DELIVERABLE] buzz 交付: pin://${PIN_B}**`,
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].valid, true);
  assert.equal(result.candidates[0].kind, 'pinid');
  assert.equal(result.candidates[0].uri, `pin://${PIN_B}`);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
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

test('P2-2: parseWorkingAck accepts long-task heartbeat forms with the ETA inside the tag', () => {
  const { parseWorkingAck } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const zh = parseWorkingAck('[WORKING 长任务 预计剩余45分钟] VoxCPM synthesis running in background');
  assert.equal(zh.acknowledged, true);
  assert.equal(zh.estimatedMinutes, 45);

  const en = parseWorkingAck('[WORKING long-task, ETA 45 min] rendering scene 2');
  assert.equal(en.acknowledged, true);
  assert.equal(en.estimatedMinutes, 45);
  assert.match(en.taskDescription, /rendering scene 2/);

  // a qualifier without an ETA still ACKs, with no estimated minutes
  const bare = parseWorkingAck('[WORKING long-task] downloading the model');
  assert.equal(bare.acknowledged, true);
  assert.equal(bare.estimatedMinutes, null);

  // lookalikes without a real tag stay null
  assert.equal(parseWorkingAck('[WORKING'), null);
  assert.equal(parseWorkingAck('[WORKINGNESS] not a tag'), null);
});

test('P2-2: computeWorkingHeartbeatUntil adds the ETA plus the grace window', () => {
  const { computeWorkingHeartbeatUntil, WORKING_HEARTBEAT_GRACE_MS } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const nowMs = 1_700_000_000_000;
  assert.equal(
    computeWorkingHeartbeatUntil(45, nowMs),
    nowMs + 45 * 60_000 + WORKING_HEARTBEAT_GRACE_MS,
  );
  assert.equal(computeWorkingHeartbeatUntil(0, nowMs), nowMs + WORKING_HEARTBEAT_GRACE_MS);
  assert.equal(computeWorkingHeartbeatUntil(10, nowMs, 0), nowMs + 10 * 60_000);
});

// ---------------------------------------------------------------------------
// P0-8: integrity declarations
// ---------------------------------------------------------------------------

test('P0-8: isIntegrityDeclaration recognizes honest correction language', () => {
  const { isIntegrityDeclaration } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  assert.equal(isIntegrityDeclaration('更正：我此前的链接无效，正确预览如下'), true);
  assert.equal(isIntegrityDeclaration('如实说明：该 pinid 未发布成功'), true);
  assert.equal(isIntegrityDeclaration('Correction: the previous URI was invalid'), true);
  assert.equal(isIntegrityDeclaration('honest report: the pin was not published'), true);
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

// ---------------------------------------------------------------------------
// Multi-line delivery shape (task #62 msg c48d2eb6, 2026-09-05): description
// on the tag line, URI on the next non-blank line after a blank. The
// line-scoped round-4 scan dropped all three real artifacts (the description's
// sha256 hex even tripped the truncated-pinid invalidation); the bounded
// lookahead upgrade recovers them.
// ---------------------------------------------------------------------------

const SHA256_A = 'e8b56972b85a7d4afa725eadc78ca82131655ddbafe79d6b39643878296ba7d2';
const PIN_SKILL = '4c04e5ee4afca2c91cb4a21d58d609b58912c653f74d462b31ede7558c5aa3dai0';
const PIN_ZIP = '70cc6df2433ba85898578e7ee8ba9cb7bfa94b17eefe945d14168b33c4aa7a2ai0';
const PIN_APP = '020098ee0678125af7c2a1222b25d54699b3d52861249f11ff211612b691a8c9i0';

test('#62 c48d2eb6: description line + blank + URI line → three URIs recorded (upgrade, not drop)', () => {
  const content = [
    `[DELIVERABLE] metabot-skill 技能封装（vhs v1.0.0，zip 78,303B ≤4MB，sha256 ${SHA256_A}）：`,
    '',
    `pin://${PIN_SKILL}`,
    '',
    '[DELIVERABLE] 技能包 zip（skill-file，公网 HTTP 200 实测，sha256 与本地逐字节一致）：',
    '',
    `metafile://${PIN_ZIP}.zip`,
    '',
    '[DELIVERABLE] MetaApp 上链（v1.0.0，7 项质量门自检全过，Bot Browser 打开渲染回读正常）：',
    '',
    `metaapp://${PIN_APP}`,
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { kind: 'pinid', uri: `pin://${PIN_SKILL}`, valid: true, note: null });
  assert.deepEqual(parsed[1], { kind: 'metafile', uri: `metafile://${PIN_ZIP}.zip`, valid: true, note: null });
  assert.deepEqual(parsed[2], { kind: 'metaapp', uri: `metaapp://${PIN_APP}`, valid: true, note: null });
  // Segment alignment preserved for the daemon's local-file enhancement.
  assert.equal(parseDeliverableSegments(content).length, parsed.length);
});

test('#62 4th tag (install evidence, no URI line): stays dropped — lookahead prose cannot rescue sha256 prose', () => {
  const content = [
    `[DELIVERABLE] 闭环真装验证：skill_tool install_skill 真装成功（SKILL.md sha256 ${SHA256_A.slice(0, 64)} 与源一致）:`,
    '',
    '@AI_Sunny S3 工程上链交付完毕，证据摘要如下，待你核验：',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].valid, false, 'unchanged: sha256 on the tag line trips truncated-pinid');
});

test('lookahead never steals the next tag line', () => {
  const content = [
    '[DELIVERABLE] first part（本机留证）:',
    '[DELIVERABLE] second part:',
    '',
    `pin://${PIN_SKILL}`,
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 2);
  // First tag's window ends at the next tag line → stays text.
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
  // Second tag's window grabs the pin line.
  assert.equal(parsed[1].valid, true, parsed[1].note);
  assert.equal(parsed[1].kind, 'pinid');
  assert.equal(parsed[1].uri, `pin://${PIN_SKILL}`);
});

test('ambiguous lookahead line keeps the same-line verdict (local-file bullets stay text)', () => {
  const content = [
    '[DELIVERABLE] 真跑产物（本机留证，eleven 直接取用）:',
    '',
    `- hello.gif 22KB sha256 ${SHA256_A}`,
    '- 脚本：smoke.tape / hello.tape',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].valid, true);
  assert.equal(parsed[0].uri, null);
});

test('prose tag mention (mid-line) is a citation, never a candidate (task #63)', () => {
  const content = [
    '状态澄清，非误期：前置条件是 Builder 的 S3 上链产物，尚未落地，故此时不可能有 [DELIVERABLE]。',
    '',
    '当前我侧就绪度：buzz 终稿已落盘备好，仅剩 2 个链接回填位。',
  ].join('\n');
  // Round 6: only lines LED BY the tag count; a mid-line mention is prose.
  const parsed = parseDeliverableLines(content);
  assert.deepEqual(parsed, []);
  assert.equal(hasDeliverableTagLine(content), false);
});

// ---------------------------------------------------------------------------
// Round 6 (task #63): the body-line sweep is REMOVED. A deliverable is what
// the sender created and published on-chain for THIS task, announced with a
// tag-led line; URIs elsewhere in the message are citations (earlier tasks'
// products, other members' artifacts) and never mint rows. The EP28 (task
// #61) receipts that motivated the sweep are now a prompt-standard matter
// (one artifact per tag-led line) — under-recording a non-compliant receipt
// is preferred over absorbing foreign references into the ledger.
// ---------------------------------------------------------------------------

const EP28_METAAPP = 'bc26756ec9402be19caa867f081c315a387cc958d3bc6cd95c05545001afc0c6i0';
const EP28_VIDEO = 'a198f75c540020ac301f3d3253eb3220a2c8701e1e7eda5ffd6d5097ea7ae0b9i0';
const EP28_COVER = 'dc69d066a4453d6fe3bdf0c6d9e573ef131dfae0e091092c15f4b300b9afbc01i0';
const EP28_ZIP = '6b91194b368bb1ce69af7b86fe5ae9cde47583dce8e5f0443ed0c386bc25a6a5i0';
const EP28_PIN = '09aaf041607feaf64e85f3b3b2884d11285de80ff887e5fa5db233f4c5debaaai0';

test('round 6: EP28 reply-form receipt (URIs only on body lines) records the tag as text, body URIs stay citations', () => {
  // Verbatim shape of EP28 msg 0bd184e9: the tag line carries no URI; every
  // pin lives on body lines. Round 6 deliberately does NOT sweep them — the
  // standard is one artifact per tag-led line (taught in the worker prompt).
  const content = [
    '[DELIVERABLE] S3b MetaApp 组装上链完成 ✅ + 真装闭环验证完成 ✅（耗时约 17 分钟）',
    '',
    '✅ **交付物与验证**',
    '- metaapp://bc26756ec9402be19caa867f081c315a387cc958d3bc6cd95c05545001afc0c6i0',
    '- Bot Browser 实开渲染正常（resolved renderer: html-iframe）',
    '- payload 显式携带：icon=Hero metafile://dc69d066a4453d6fe3bdf0c6d9e573ef131dfae0e091092c15f4b300b9afbc01i0，coverImg=同一 Hero',
    '- `skill_tool install_skill zip=metafile://6b91194b368bb1ce69af7b86fe5ae9cde47583dce8e5f0443ed0c386bc25a6a5i0.zip` → ok:true',
    '',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
});

test('round 6: tag line + body table with URIs → text row only (no sweep)', () => {
  const content = [
    '[DELIVERABLE] S2b 演示视频完成 ✅ 上链 + 公网 HTTP 200 实测通过',
    '',
    '**交付物**',
    '- 视频 metafile://a198f75c540020ac301f3d3253eb3220a2c8701e1e7eda5ffd6d5097ea7ae0b9i0.mp4',
    '- 封面 metafile://dc69d066a4453d6fe3bdf0c6d9e573ef131dfae0e091092c15f4b300b9afbc01i0',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'text');
  assert.equal(parsed[0].uri, null);
});

test('round 6: adjacent URI line upgrades via #62 lookahead; alignment holds (1 entry, URI segment)', () => {
  // Tag line + URI on the NEXT line → the lookahead path upgrades in place
  // (one entry, not tag-text + body-append); parseDeliverableSegments stays
  // index-aligned with the upgraded candidate.
  const content = [
    '[DELIVERABLE] S4 推广发布完成 ✅ buzz 已上链',
    `- 封装 pin://${EP28_PIN}`,
  ].join('\n');
  const lines = parseDeliverableLines(content);
  const segments = parseDeliverableSegments(content);
  assert.equal(lines.length, segments.length);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'pinid');
  assert.equal(lines[0].uri, `pin://${EP28_PIN}`);
  // main-side contract: segments carry the SAME-LINE tag text (the lookahead
  // line is not merged into the segment — the daemon reads segments of text
  // candidates for local-file paths only).
  assert.equal(segments[0], 'S4 推广发布完成 ✅ buzz 已上链');
});

test('round 6: URI beyond the 3-line lookahead window stays unrecorded', () => {
  const content = [
    '[DELIVERABLE] S4 推广发布完成 ✅ buzz 已上链',
    '',
    '',
    '',
    `- 远端封装：pin://${EP28_PIN}`,
  ].join('\n');
  const lines = parseDeliverableLines(content);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'text');
  assert.equal(lines[0].uri, null);
});

test('round 6: negative — mid-line tag citation with a URI is never recorded (task #63 false-alarm shape)', () => {
  const content = '我上一条 [DELIVERABLE] 消息里的 metaapp://bc26756ec9402be19caa867f081c315a387cc958d3bc6cd95c05545001afc0c6i0 请查收';
  assert.deepEqual(parseDeliverableLines(content), []);
  assert.equal(hasDeliverableTagLine(content), false);
});

test('round 6: negative — prose URI in a NON-tagged message stays unrecorded', () => {
  const parsed = parseDeliverableLines(`回顾上期：metaapp://${EP28_METAAPP} 已经验收 5/5`);
  assert.deepEqual(parsed, []);
});

test('round 6: negative — body placeholders / truncated tokens never mint rows', () => {
  const content = [
    '[DELIVERABLE] 归档完成',
    '- 参考示例 metaapp://<pinId>（占位符）',
    '- 另见 metafile://6b91194b368bb1ce69af7b86fe5ae9cde47583dce8e5f0443ed0c386bc25a6a5…（截断）',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1); // only the text tag row; body junk skipped silently
  assert.equal(parsed[0].kind, 'text');
});

test('round 6: tag-line URI with a duplicate on a body line records once (body ignored)', () => {
  const content = [
    `[DELIVERABLE] metaapp://${EP28_METAAPP}`,
    '- 正本：metaapp://bc26756ec9402be19caa867f081c315a387cc958d3bc6cd95c05545001afc0c6i0（链上可解析）',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].uri, `metaapp://${EP28_METAAPP}`);
});

test('round 6: EP28-style body URIs do NOT leak into untagged deliverable validation', () => {
  // validateDeliverableLines is the send-path warning helper: an untagged
  // message must produce zero candidates (no false-positive warnings).
  const { validateDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');
  const validation = validateDeliverableLines(`普通消息提到 metaapp://${EP28_METAAPP}`);
  assert.equal(validation.candidates.length, 0);
  assert.equal(validation.errors.length, 0);
});

test('round 6: full-width CJK punctuation terminates a lookahead-line URI (icon=X metafile://…i0，coverImg=…)', () => {
  // The line right below the tag is the #62 lookahead; the URI is followed by
  // a full-width comma — the payload must stop there, never swallow the
  // annotation.
  const parsed = parseDeliverableLines([
    '[DELIVERABLE] S3b MetaApp 组装上链完成',
    'payload 显式携带：icon=Hero metafile://dc69d066a4453d6fe3bdf0c6d9e573ef131dfae0e091092c15f4b300b9afbc01i0，coverImg=同一 Hero',
  ].join('\n'));
  const cover = parsed.find((candidate) => candidate.uri?.startsWith('metafile://dc69d066'));
  assert.ok(cover, 'cover URI missing');
  assert.equal(cover.uri, 'metafile://dc69d066a4453d6fe3bdf0c6d9e573ef131dfae0e091092c15f4b300b9afbc01i0');
});

// ---------------------------------------------------------------------------
// Round 6 (task #63 regression): citation vs delivery at the parser level.
// ---------------------------------------------------------------------------

test('task #63 regression: Lucy\'s copy-delivery message records ONLY her own pin — the EP28 metaapp cited in testing notes stays out', () => {
  // Verbatim shape of GT#63 msg a6daa4c8: tag-led description line, HER new
  // pin on the next non-blank line, and yesterday's EP28 metaapp deep in the
  // 亲测口径 bullets. The round-5 sweep minted BOTH (row 1040 = the EP28
  // app attributed to Lucy).
  const lucyPin = '73730a32f39ca2683565c84195186f86b21cf9ca89e02b79b044af1821f1c4e6i0';
  const ep28App = '020098ee0678125af7c2a1222b25d54699b3d52861249f11ff211612b691a8c9i0';
  const content = [
    '[DELIVERABLE] 第29期 MetaApp 亲测文案终稿已上链（含六板块全文、装法段三处占位符、署名五名 metaid:// 齐）',
    '',
    `pin://${lucyPin}`,
    '',
    '亲测口径（全部一手实测，2026-09-06 07:14-07:22）：',
    `- 解剖对象为上期已上链应用 metaapp://${ep28App}：payload 读链 → zip 公网 200（26,154 B）`,
    '- 上期 skill 封装 zip 同样实测公网 200（78,303 B），直装路径可信',
  ].join('\n');
  const parsed = parseDeliverableLines(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'pinid');
  assert.equal(parsed[0].uri, `pin://${lucyPin}`);
});

test('task #63: backticked/fenced tag citations are documentation, never deliveries', () => {
  assert.deepEqual(parseDeliverableLines('用法：`[DELIVERABLE] <uri>` 一行一个成果。'), []);
  assert.deepEqual(parseDeliverableLines(`示例:\n\`\`\`\n[DELIVERABLE] metaapp://${EP28_METAAPP}\n\`\`\`\n如上。`), []);
  assert.equal(hasDeliverableTagLine('用法：`[DELIVERABLE] <uri>` 一行一个成果。'), false);
});

test('task #63: hasDeliverableTagLine agrees with the parser on leading-tag lines', () => {
  assert.equal(hasDeliverableTagLine('[DELIVERABLE] 第29期文案已上链'), true);
  assert.equal(hasDeliverableTagLine('  [DELIVERABLE] 缩进行的交付'), true); // trimmed lead
  assert.equal(hasDeliverableTagLine('上条 [DELIVERABLE] 即为回应'), false);
  assert.equal(hasDeliverableTagLine('无 [DELIVERABLE] 属正常等待，非超时'), false);
});

test('task #63: extractPinidToken treats scheme/suffix variants as ONE artifact identity', () => {
  const pin = 'd6155cf69f078c826e0db128d874673325bb5c6ae07348f75899a3621cdac497';
  assert.equal(extractPinidToken(`metaapp://${pin}i0`), `${pin}i0`);
  assert.equal(extractPinidToken(`metafile://${pin}i0.zip`), `${pin}i0`);
  assert.equal(extractPinidToken(`pin://${pin.toUpperCase()}I0`.toLowerCase()), `${pin}i0`);
  assert.equal(extractPinidToken('https://example.com/a'), null);
  assert.equal(extractPinidToken(null), null);
});
