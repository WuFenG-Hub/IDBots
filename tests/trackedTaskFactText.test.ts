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

/** 从主进程源码里现取权威常量（现取 = 不落中间快照）。 */
function readMainProcessKeyTable(): Record<string, string> {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/main/services/trackedTaskBoard.ts'),
    'utf-8'
  );
  const block = src.match(/TRACKED_FACT_CODE_I18N_KEY[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, '未能在主进程源码里找到 TRACKED_FACT_CODE_I18N_KEY 常量');
  const table: Record<string, string> = {};
  for (const line of block![1].split('\n')) {
    const match = line.match(/^\s*([a-z_]+):\s*'([^']+)'/);
    if (match) table[match[1]] = match[2];
  }
  return table;
}

test('renderer 镜像与主进程常量逐条一致（code + key 名）', async () => {
  const main = readMainProcessKeyTable();
  const { TRACKED_FACT_CODE_I18N_KEY } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  assert.deepEqual(
    Object.keys(TRACKED_FACT_CODE_I18N_KEY).sort(),
    Object.keys(main).sort(),
    'code 集合不一致：主进程与 renderer 镜像必须同集合'
  );
  assert.deepEqual(TRACKED_FACT_CODE_I18N_KEY, main, 'code → i18n key 的映射必须逐条一致');
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
  const { TRACKED_FACT_CODE_I18N_KEY } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  const service = i18nService as unknown as { currentLanguage: string; t: (k: string) => string };

  for (const language of ['zh', 'en'] as const) {
    service.currentLanguage = language;
    for (const [code, key] of Object.entries(TRACKED_FACT_CODE_I18N_KEY)) {
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

  const { TRACKED_SUGGESTION_CODE_I18N_KEY, reasonText, suggestionText } = await import(
    '../src/renderer/components/trackedTasks/trackedTaskFactText'
  );
  assert.deepEqual(
    Object.keys(TRACKED_SUGGESTION_CODE_I18N_KEY).sort(),
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
