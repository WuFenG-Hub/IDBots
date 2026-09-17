/**
 * 结构化事实 → i18n 文案的**跨文件表驱动断言**（本条是 loop 附录 B 的 B-5.2 / B-5.4 落成判据）。
 *
 * 三处必须一起改，缺一处即红：
 *   ① 主进程常量 `TRACKED_FACT_CODE_I18N_KEY`（src/main/services/trackedTaskBoard.ts）
 *   ② renderer 镜像常量（src/renderer/components/trackedTasks/trackedTaskFactText.ts）
 *   ③ zh / en 两套文案（src/renderer/services/i18n.ts）
 *
 * 复跑：npx tsx --test tests/trackedTaskFactText.test.ts
 *
 * 注意：本文件是实现方的自测，不构成独立验收证据（独立验收由验收方另出脚本）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** 从主进程源码里现取权威表（现取 = 不落中间快照）。 */
function readMainProcessTable(constName: string): Record<string, string> {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/services/trackedTaskBoard.ts'), 'utf-8');
  const block = src.match(new RegExp(`^export const ${constName}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`, 'm'));
  assert.ok(block, `未能在主进程源码里找到 ${constName}`);
  const table: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const match = line.match(/^\s*([a-z_]+):\s*'([^']+)'/);
    if (match) table[match[1]] = match[2];
  }
  return table;
}

test('renderer 的按侧表与主进程的按侧表逐条一致（reason 10 + suggestion 5）', async () => {
  const mainReason = readMainProcessTable('TRACKED_REASON_I18N_KEY');
  const mainSuggestion = readMainProcessTable('TRACKED_SUGGESTION_I18N_KEY');
  assert.ok(Object.keys(mainReason).length >= 10, `主进程 reason 表异常：${Object.keys(mainReason).length}`);
  assert.ok(
    Object.keys(mainSuggestion).length >= 5,
    `主进程 suggestion 表异常：${Object.keys(mainSuggestion).length}`
  );

  const { TRACKED_REASON_I18N_KEY, TRACKED_SUGGESTION_I18N_KEY } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  assert.deepEqual(TRACKED_REASON_I18N_KEY, mainReason, '理由侧 code → key 必须逐条一致');
  assert.deepEqual(TRACKED_SUGGESTION_I18N_KEY, mainSuggestion, '建议侧 code → key 必须逐条一致');
});

test('每个 code 在 zh / en 两套文案里都有键（缺键即红）', async () => {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  const store = new Map<string, string>();
  if (!globalAny.localStorage) {
    globalAny.localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  }
  if (!globalAny.navigator) globalAny.navigator = { language: 'zh-CN' };

  const { i18nService } = await import('../src/renderer/services/i18n');
  const { TRACKED_REASON_I18N_KEY, TRACKED_SUGGESTION_I18N_KEY } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  const service = i18nService as unknown as { currentLanguage: string; t: (k: string) => string };
  const allKeys = {
    ...TRACKED_REASON_I18N_KEY,
    ...TRACKED_SUGGESTION_I18N_KEY,
  } as Record<string, string>;

  for (const language of ['zh', 'en'] as const) {
    service.currentLanguage = language;
    for (const [code, key] of Object.entries(allKeys)) {
      const text = service.t(key);
      assert.notEqual(text, key, `[${language}] 缺键：${code} → ${key}`);
      assert.ok(text.trim().length > 0, `[${language}] 空文案：${code} → ${key}`);
    }
  }
});

test('建议侧映射覆盖全部建议 code，且与理由侧措辞分开', async () => {
  // 权威的 SuggestionCode 封闭枚举 = 主进程源码里的联合类型（现取）
  const board = fs.readFileSync(path.join(ROOT, 'src/main/services/trackedTaskBoard.ts'), 'utf-8');
  const union = board.match(/export type TrackedSuggestionCode\s*=([\s\S]*?);/);
  assert.ok(union, '未能现取 TrackedSuggestionCode 联合类型');
  const suggestionCodes = (union![1].match(/'([a-z_]+)'/g) ?? [])
    .map((token) => token.replace(/'/g, ''))
    .sort();
  assert.ok(suggestionCodes.length >= 4, `建议 code 集合异常：${suggestionCodes.join(',')}`);

  const { TRACKED_SUGGESTION_I18N_KEY, reasonText, suggestionText } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  assert.deepEqual(
    Object.keys(TRACKED_SUGGESTION_I18N_KEY).sort(),
    suggestionCodes,
    '建议侧映射必须与主进程常量里的 suggestion.* 条目同集合'
  );

  const service = (await import('../src/renderer/services/i18n')).i18nService as unknown as {
    currentLanguage: string;
  };
  service.currentLanguage = 'zh';

  // 共用 code 的两侧措辞必须不同（否则就是把理由文案当建议输出）
  const shared = 'deliverables_verifiable';
  const asReason = reasonText({ code: shared as never, params: { count: 3 } });
  const asSuggestion = suggestionText(shared as never, { count: 3 });
  assert.notEqual(
    asReason,
    asSuggestion,
    '理由与建议共用一个 code 时，两侧措辞必须来自各自的映射'
  );
  assert.ok(asSuggestion.includes('3'), `建议侧参数未注入：${asSuggestion}`);
});

test('文案参数用 {name} 占位，且不把 code 名当文案', async () => {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  if (!globalAny.localStorage) {
    const store = new Map<string, string>();
    globalAny.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      __store: store,
    };
  }
  const { i18nService } = await import('../src/renderer/services/i18n');
  const { reasonText, suggestionText } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  const service = i18nService as unknown as { currentLanguage: string };
  service.currentLanguage = 'zh';

  const reason = reasonText({ code: 'open_checkpoints', params: { count: 2 } });
  assert.ok(reason.includes('2'), `计数参数未注入：${reason}`);
  assert.ok(!reason.includes('{'), `占位符未替换：${reason}`);
  assert.ok(!reason.includes('open_checkpoints'), `把 code 当文案渲染了：${reason}`);

  const suggestion = suggestionText('stale_inactivity', { days: 2.5 });
  assert.ok(suggestion.includes('2.5'), `天数参数未注入：${suggestion}`);
  assert.equal(suggestionText(null), '', '无 code 时必须为空串');
});


/**
 * 跨端字段名一致性 —— **行为断言**，不是词频统计。
 *
 * 做法：从主进程源码里读出 `TrackedFact` **接口声明位**上的字段名（`params` / `args`），
 * 用这个名字**构造载荷**再喂给 renderer 的 `reasonText`，断言参数被真正插值。
 * renderer 只要读错字段名，载荷就取不到值 → 模板残留 `{count}` → 本条即红。
 *
 * 为什么不用 grep 计数：`grep -c params` 命中的是全文词频，扫到别处的同名词就会给出
 * 假 PASS/假 FAIL（本组今天已实测过两次）。判据必须落在**声明位 ↔ 消费位**这一对上。
 */
test('跨端字段名一致：按主进程声明位构造载荷，renderer 必须真的取到值', async () => {
  const board = fs.readFileSync(path.join(ROOT, 'src/main/services/trackedTaskBoard.ts'), 'utf-8');
  const iface = board.match(/export interface TrackedFact\s*\{([\s\S]*?)\n\}/);
  assert.ok(iface, '未能现取 TrackedFact 接口声明');

  const declared = iface![1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('/') && !line.startsWith('*'))
    .map((line) => line.match(/^([A-Za-z_]+)\s*:/)?.[1])
    .filter((name): name is string => Boolean(name));

  assert.deepEqual(
    declared,
    ['code', 'params'],
    `主进程 TrackedFact 的声明位应为 [code, params]，实测 [${declared.join(', ')}]`
  );

  const globalAny = globalThis as unknown as Record<string, unknown>;
  if (!globalAny.localStorage) {
    globalAny.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined };
  }
  const { i18nService } = await import('../src/renderer/services/i18n');
  (i18nService as unknown as { currentLanguage: string }).currentLanguage = 'zh';
  const { reasonText, suggestionTextForCard } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );

  // 字段名按主进程声明位取用：BE 改名字，这里就跟着改名，renderer 不跟就是红。
  const payload = { code: 'open_checkpoints', [declared[1]]: { count: 4 } } as never;
  const text = reasonText(payload);
  assert.ok(text.includes('4'), `renderer 未读到主进程声明的「${declared[1]}」字段：${text}`);
  assert.ok(!text.includes('{'), `模板占位残留，说明字段名不匹配：${text}`);

  // 建议侧同理：closureSuggestionParams 是主进程声明位上的名字。
  const suggestionDocs = board.match(/closureSuggestionParams\s*:/g) ?? [];
  assert.ok(suggestionDocs.length > 0, '主进程未声明 closureSuggestionParams');
  const suggestion = suggestionTextForCard({
    closureSuggestionCode: 'stale_inactivity',
    closureSuggestionParams: { days: 3.5 },
    idleMs: null,
  } as never);
  assert.ok(suggestion.includes('3.5'), `建议侧未读到 closureSuggestionParams：${suggestion}`);
});
